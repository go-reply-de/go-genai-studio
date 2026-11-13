"""Tests for extend-audit-retention.py against a local fake of the Cloud Storage JSON API.

    python3 -m unittest discover -s scripts -p 'test_*.py'
"""
import contextlib
import importlib.util
import io
import json
import os
import threading
import unittest
import urllib.parse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_spec = importlib.util.spec_from_file_location(
    "extend_audit_retention", os.path.join(os.path.dirname(__file__), "extend-audit-retention.py")
)
ext = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ext)

NOW = datetime(2026, 11, 1, tzinfo=timezone.utc)
OLD_END = "2027-03-31T21:59:59.000Z"
NEW_END = ext.parse_time("2029-03-31T21:59:59Z")


def audit_file(name, created, locked_until=OLD_END):
    return {
        "name": name,
        "timeCreated": created,
        "customTime": locked_until,
        "retention": {"mode": "Locked", "retainUntilTime": locked_until},
        "metageneration": "1",
    }


def bucket_files():
    return [
        audit_file("admin-requests/2026/10/15/000000000001-000000000010.ndjson", "2026-10-15T10:00:00.000Z"),
        audit_file("admin-requests/2027/03/01/000000000011-000000000012.ndjson", "2027-03-01T08:30:00.000Z"),
        audit_file("grant-log/__platform__/2026/10/20/000000000001-000000000004.ndjson", "2026-10-20T12:00:00.000Z"),
        {"name": "stray/without-lock.txt", "timeCreated": "2026-10-20T12:00:00.000Z", "metageneration": "1"},
    ]


class FakeStorage(BaseHTTPRequestHandler):
    """Enforces what matters here: locks only extend, customTime only moves forward, preconditions hold."""

    objects = {}
    page_size = 2
    patched = []
    changed_meanwhile = set()

    def _send(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _error(self, status, message):
        self._send(status, {"error": {"code": status, "message": message}})

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(url.query)
        start = int(query.get("pageToken", ["0"])[0])
        names = sorted(self.objects)
        page = {"items": [self.objects[n] for n in names[start : start + self.page_size]]}
        if start + self.page_size < len(names):
            page["nextPageToken"] = str(start + self.page_size)
        self._send(200, page)

    def do_PATCH(self):
        if self.headers.get("Authorization") != "Bearer test-token":
            return self._error(401, "no token")
        url = urllib.parse.urlparse(self.path)
        name = urllib.parse.unquote(url.path.split("/o/", 1)[1])
        query = urllib.parse.parse_qs(url.query)
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        obj = self.objects.get(name)
        if obj is None:
            return self._error(404, "no such object")
        if name in self.changed_meanwhile:
            obj["metageneration"] = str(int(obj["metageneration"]) + 1)
        if query.get("ifMetagenerationMatch", [""])[0] != obj["metageneration"]:
            return self._error(412, "conditionNotMet")
        new_until = ext.parse_time(body["retention"]["retainUntilTime"])
        current = (obj.get("retention") or {}).get("retainUntilTime")
        if current and new_until < ext.parse_time(current):
            return self._error(403, "The locked object retention cannot be removed.")
        if "customTime" in body and obj.get("customTime"):
            if ext.parse_time(body["customTime"]) < ext.parse_time(obj["customTime"]):
                return self._error(400, "customTime can only move forward")
        obj["retention"] = body["retention"]
        obj.update({k: v for k, v in body.items() if k == "customTime"})
        obj["metageneration"] = str(int(obj["metageneration"]) + 1)
        self.patched.append(name)
        self._send(200, {"name": name})

    def log_message(self, *args):
        pass


class PlanTest(unittest.TestCase):
    def targets(self, files, new_end=NEW_END, include_expired=False):
        return {o["name"]: (t and ext.format_time(t), r) for o, t, r in ext.plan(files, new_end, 365, NOW, include_expired)}

    def test_one_year_after_export_but_never_past_the_new_end(self):
        result = self.targets(bucket_files())
        self.assertEqual(result["admin-requests/2026/10/15/000000000001-000000000010.ndjson"], ("2027-10-15T10:00:00.000Z", "extend"))
        self.assertEqual(result["admin-requests/2027/03/01/000000000011-000000000012.ndjson"], ("2028-02-29T08:30:00.000Z", "extend"))
        capped = self.targets(bucket_files(), new_end=ext.parse_time("2027-06-30T21:59:59Z"))
        self.assertEqual(capped["admin-requests/2026/10/15/000000000001-000000000010.ndjson"], ("2027-06-30T21:59:59.000Z", "extend"))

    def test_never_shortens(self):
        result = self.targets(bucket_files(), new_end=ext.parse_time("2027-01-31T22:59:59Z"))
        self.assertEqual({r for _, r in result.values()}, {"already at or past its new date", "no lock"})

    def test_skips_files_without_a_lock(self):
        self.assertEqual(self.targets(bucket_files())["stray/without-lock.txt"], (None, "no lock"))

    def test_ended_locks_only_on_request(self):
        ended = [audit_file("admin-requests/2025/10/30/000000000001-000000000002.ndjson", "2025-10-30T09:00:00.000Z", "2026-10-30T09:00:00.000Z")]
        self.assertEqual(self.targets(ended)[ended[0]["name"]], (None, "lock already ended"))
        self.assertEqual(self.targets(ended, include_expired=True)[ended[0]["name"]], (None, "its new date has passed"))
        recent = [audit_file("admin-requests/2026/10/30/000000000001-000000000002.ndjson", "2026-10-30T09:00:00.000Z", "2026-10-31T09:00:00.000Z")]
        self.assertEqual(self.targets(recent, include_expired=True)[recent[0]["name"]], ("2027-10-30T09:00:00.000Z", "extend"))


class AgainstFakeStorageTest(unittest.TestCase):
    def setUp(self):
        FakeStorage.objects = {o["name"]: o for o in bucket_files()}
        FakeStorage.patched = []
        FakeStorage.changed_meanwhile = set()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeStorage)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.api = ext.StorageApi("test-token", endpoint=f"http://127.0.0.1:{self.server.server_port}")
        self.lines = []

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def run_script(self, apply):
        return ext.run(self.api, "audit-bucket", NEW_END, 365, apply=apply, now=NOW, out=self.lines.append)

    def test_dry_run_changes_nothing(self):
        self.assertEqual(self.run_script(apply=False), 0)
        self.assertEqual(FakeStorage.patched, [])
        self.assertEqual(self.lines[-1], "would extend 3, skipped 1, failed 0")

    def test_apply_extends_lock_and_delete_date_once(self):
        self.assertEqual(self.run_script(apply=True), 0)
        self.assertEqual(self.lines[-1], "extended 3, skipped 1, failed 0")
        obj = FakeStorage.objects["grant-log/__platform__/2026/10/20/000000000001-000000000004.ndjson"]
        self.assertEqual(obj["retention"], {"mode": "Locked", "retainUntilTime": "2027-10-20T12:00:00.000Z"})
        self.assertEqual(obj["customTime"], "2027-10-20T12:00:00.000Z")
        self.assertNotIn("retention", FakeStorage.objects["stray/without-lock.txt"])
        self.lines.clear()
        self.assertEqual(self.run_script(apply=True), 0)
        self.assertEqual(self.lines[-1], "extended 0, skipped 4, failed 0")

    def test_file_changed_meanwhile_is_reported_not_overwritten(self):
        name = "admin-requests/2026/10/15/000000000001-000000000010.ndjson"
        FakeStorage.changed_meanwhile = {name}
        self.assertEqual(self.run_script(apply=True), 1)
        self.assertTrue(any(line.startswith(f"FAILED  {name}  HTTP 412") for line in self.lines))
        self.assertEqual(FakeStorage.objects[name]["retention"]["retainUntilTime"], OLD_END)
        self.assertEqual(self.lines[-1], "extended 2, skipped 1, failed 1")


class ArgumentTest(unittest.TestCase):
    def test_new_end_needs_a_time_zone_and_the_future(self):
        for value in ("2029-03-31T21:59:59", "2020-03-31T21:59:59Z"):
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                ext.main(["--bucket", "b", "--new-end", value])


if __name__ == "__main__":
    unittest.main()
