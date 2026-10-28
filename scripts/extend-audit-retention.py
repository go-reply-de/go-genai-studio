#!/usr/bin/env python3
"""Extend the lock and delete date of the existing audit files to a new agreement end.

Moving AUDIT_EXPORT_RETAIN_UNTIL later only reaches files exported from then on. This brings
the files already in the bucket up to the same rule: locked and kept until one year after
their export, but never past the new end. A lock can only be extended, so nothing is ever
shortened, and no file content is read.

Run it before the old end date: after it, the database copies are already wiped and Google
deletes the files within about a day. Prints what it would do; --apply makes the changes.
Needs storage.objects.list, storage.objects.update and storage.objects.setRetention.

    scripts/extend-audit-retention.py --bucket my-audit-bucket --new-end 2029-03-31T21:59:59Z
"""
import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

ENDPOINT = "https://storage.googleapis.com"
LIST_FIELDS = "items(name,timeCreated,customTime,retention,metageneration),nextPageToken"


def parse_time(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def format_time(value):
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class StorageApi:
    """The two Cloud Storage JSON API calls the extension needs."""

    def __init__(self, token, endpoint=ENDPOINT):
        self.token = token
        self.endpoint = endpoint

    def _call(self, method, url, body=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(url, data=data, method=method)
        request.add_header("Authorization", f"Bearer {self.token}")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(request) as response:
            return json.load(response)

    def _objects_url(self, bucket):
        return f"{self.endpoint}/storage/v1/b/{urllib.parse.quote(bucket, safe='')}/o"

    def list_objects(self, bucket):
        page_token = None
        while True:
            query = {"fields": LIST_FIELDS}
            if page_token:
                query["pageToken"] = page_token
            page = self._call("GET", f"{self._objects_url(bucket)}?{urllib.parse.urlencode(query)}")
            yield from page.get("items", [])
            page_token = page.get("nextPageToken")
            if not page_token:
                return

    def patch_object(self, bucket, name, metageneration, body):
        # ifMetagenerationMatch: a file changed since the listing is reported, not overwritten.
        query = urllib.parse.urlencode({"ifMetagenerationMatch": metageneration, "fields": "name"})
        url = f"{self._objects_url(bucket)}/{urllib.parse.quote(name, safe='')}?{query}"
        return self._call("PATCH", url, body)


def plan(objects, new_end, retention_days, now, include_expired=False):
    """Yields (object, new date or None, reason) for every file."""
    for obj in objects:
        locked_until = (obj.get("retention") or {}).get("retainUntilTime")
        if not locked_until:
            yield obj, None, "no lock"
            continue
        current = parse_time(locked_until)
        if current <= now and not include_expired:
            yield obj, None, "lock already ended"
            continue
        target = min(parse_time(obj["timeCreated"]) + timedelta(days=retention_days), new_end)
        if target <= now:
            yield obj, None, "its new date has passed"
        elif target <= current:
            yield obj, None, "already at or past its new date"
        else:
            yield obj, target, "extend"


def patch_body(obj, target):
    body = {"retention": {"mode": "Locked", "retainUntilTime": format_time(target)}}
    # customTime drives the lifecycle deletion and can only move forward.
    custom_time = obj.get("customTime")
    if not custom_time or parse_time(custom_time) < target:
        body["customTime"] = format_time(target)
    return body


def run(api, bucket, new_end, retention_days, apply=False, include_expired=False, now=None, out=print):
    now = now or datetime.now(timezone.utc)
    extended = skipped = failed = 0
    for obj, target, reason in plan(api.list_objects(bucket), new_end, retention_days, now, include_expired):
        current = (obj.get("retention") or {}).get("retainUntilTime", "-")
        if target is None:
            skipped += 1
            out(f"skip    {obj['name']}  ({reason}; locked until {current})")
            continue
        if not apply:
            extended += 1
            out(f"would   {obj['name']}  {current} -> {format_time(target)}")
            continue
        try:
            api.patch_object(bucket, obj["name"], obj["metageneration"], patch_body(obj, target))
        except urllib.error.HTTPError as error:
            failed += 1
            detail = error.read().decode(errors="replace")[:200]
            out(f"FAILED  {obj['name']}  HTTP {error.code}: {detail}")
            continue
        extended += 1
        out(f"done    {obj['name']}  {current} -> {format_time(target)}")
    out(f"{'extended' if apply else 'would extend'} {extended}, skipped {skipped}, failed {failed}")
    return 1 if failed else 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--bucket", required=True, help="the audit bucket the api exports to (AUDIT_EXPORT_BUCKET)")
    parser.add_argument("--new-end", required=True, help="the new AUDIT_EXPORT_RETAIN_UNTIL, RFC 3339 with a time zone")
    parser.add_argument("--retention-days", type=int, default=365, help="as AUDIT_EXPORT_RETENTION_DAYS (default 365)")
    parser.add_argument("--include-expired", action="store_true", help="also re-lock files whose lock has already ended")
    parser.add_argument("--apply", action="store_true", help="make the changes; without it, only print them")
    args = parser.parse_args(argv)

    new_end = parse_time(args.new_end)
    if new_end.tzinfo is None:
        parser.error("--new-end needs a time zone, e.g. 2029-03-31T21:59:59Z")
    if new_end <= datetime.now(timezone.utc):
        parser.error("--new-end must be in the future")

    token = subprocess.run(
        ["gcloud", "auth", "print-access-token"], check=True, capture_output=True, text=True
    ).stdout.strip()
    return run(StorageApi(token), args.bucket, new_end, args.retention_days, args.apply, args.include_expired)


if __name__ == "__main__":
    sys.exit(main())
