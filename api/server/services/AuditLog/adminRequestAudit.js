const crypto = require('crypto');
const { logger } = require('@librechat/data-schemas');
const { SystemRoles } = require('librechat-data-provider');
const defaultStore = require('./adminAuditStore');

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LOCAL_LOGIN = '/api/admin/login/local';
/** Login, SSO and token routes: their bodies and queries carry credentials. */
const AUTH_PATH = /^\/api\/admin\/(login|oauth)\//;
/** Where an admin panel SSO login completes. */
const LOGIN_CALLBACK = /^\/api\/admin\/oauth\/[^/]+\/callback$/;
/** Token upkeep behind an open panel, not an admin action. */
const SKIPPED = new Set(['/api/admin/oauth/refresh', '/api/admin/oauth/exchange']);

const SECRET_KEY =
  /password|passphrase|secret|token$|api[-_]?key|private[-_]?key|access[-_]?key|authorization|cookie|credential|signature|saml|verifier/i;
/** Every value inside is treated as secret; the names stay visible. */
const SECRET_CONTAINER = /^(headers|env)$/i;
const SECRET_VALUE =
  /^(bearer\s|basic\s|sk-|AIza|gh[pousr]_|xox[abpr]-|eyJ[\w-]+\.[\w-]+\.)|-----BEGIN /i;
const ENV_REFERENCE = /^\$\{[A-Za-z0-9_]+\}$/;
const REDACTED = '[redacted]';
const MAX_BODY_BYTES = 32 * 1024;
const MAX_DEPTH = 20;

/** Lower-cased and decoded, because Express routes `/API/Admin/Login/…` the same way. */
function normalizePath(originalUrl) {
  const path = originalUrl.split('?')[0];
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    /* malformed escapes: match on the raw path */
  }
  return decoded.toLowerCase().replace(/\/+$/, '') || '/';
}

function shouldRecord(method, path) {
  if (SKIPPED.has(path)) {
    return false;
  }
  return MUTATING.has(method) || (method === 'GET' && LOGIN_CALLBACK.test(path));
}

function isSecretKey(key) {
  return SECRET_KEY.test(key) || SECRET_CONTAINER.test(key);
}

function hide(value) {
  return typeof value === 'string' && ENV_REFERENCE.test(value) ? value : REDACTED;
}

/** Deep copy with secrets replaced, so a later mutation of req.body cannot change the record. */
function redact(value, depth = 0) {
  if (typeof value === 'string') {
    return SECRET_VALUE.test(value) ? REDACTED : value;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth >= MAX_DEPTH) {
    return '[too deep]';
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }
  // Config field edits arrive as { fieldPath: 'mcpServers.x.headers.Authorization', value }.
  const secretField =
    typeof value.fieldPath === 'string' && value.fieldPath.split('.').some(isSecretKey);
  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    if (secretField && key === 'value') {
      copy[key] = hide(item);
    } else if (SECRET_CONTAINER.test(key) && item && typeof item === 'object') {
      copy[key] = Object.fromEntries(Object.entries(item).map(([name, v]) => [name, hide(v)]));
    } else if (isSecretKey(key)) {
      copy[key] = hide(item);
    } else {
      copy[key] = redact(item, depth + 1);
    }
  }
  return copy;
}

function capture(value) {
  if (value == null || (typeof value === 'object' && Object.keys(value).length === 0)) {
    return undefined;
  }
  const clean = redact(value);
  const bytes = Buffer.byteLength(JSON.stringify(clean));
  if (bytes <= MAX_BODY_BYTES) {
    return clean;
  }
  return { truncated: true, bytes, keys: Object.keys(clean) };
}

function outcomeOf(statusCode, finished, isLoginCallback, user) {
  if (!finished) {
    return 'aborted';
  }
  if (statusCode === 401 || statusCode === 403) {
    return 'denied';
  }
  if (statusCode >= 400) {
    return 'failure';
  }
  // A failed SSO login also ends in a redirect; only an identified user got through.
  return isLoginCallback && !user ? 'failure' : 'success';
}

/** The matched route pattern, or nothing when it cannot be trusted. */
function routeOf(req, urlPath) {
  if (req.route?.path == null) {
    return undefined;
  }
  const route = `${req.baseUrl}${req.route.path}`;
  // A request that left its router through next(err) has lost the router's prefix.
  return route.split('/').length === urlPath.split('/').length ? route : undefined;
}

/** Admins may be named. Anyone else who reaches these routes stays an id. */
function actorOf(user, outcome) {
  if (!user) {
    return null;
  }
  const actor = { id: user._id?.toString() ?? user.id, role: user.role };
  if (outcome === 'success' || user.role === SystemRoles.ADMIN) {
    actor.name = user.name || user.username;
    actor.email = user.email;
  }
  return actor;
}

/** Recording runs only while an export target is configured and its retention period lasts. */
function isRecording(bucket, retainUntil, now) {
  const until = Date.parse(retainUntil ?? '');
  return Boolean(bucket) && Number.isFinite(until) && now < until;
}

/**
 * Records every admin change request on the routes it is mounted on in MongoDB before the request
 * runs, and refuses the request when that write fails, so no admin change happens unrecorded.
 * The export job ships the records to the locked audit bucket. Inert unless AUDIT_EXPORT_BUCKET
 * is set; ADMIN_LOCAL_LOGIN=false additionally refuses the admin panel's password login.
 */
function createAdminRequestAudit({
  bucket = process.env.AUDIT_EXPORT_BUCKET,
  retainUntil = process.env.AUDIT_EXPORT_RETAIN_UNTIL,
  localLoginAllowed = process.env.ADMIN_LOCAL_LOGIN?.toLowerCase() !== 'false',
  store = defaultStore,
  now = () => Date.now(),
} = {}) {
  return async function adminRequestAudit(req, res, next) {
    const path = normalizePath(req.originalUrl);
    const blocked = !localLoginAllowed && req.method === 'POST' && path === LOCAL_LOGIN;
    const recording = isRecording(bucket, retainUntil, now());
    if (!blocked && (!recording || !shouldRecord(req.method, path))) {
      return next();
    }
    const refuseLocalLogin = () =>
      res
        .status(403)
        .json({ error: 'Password login is disabled for the admin panel. Sign in with SSO.' });
    if (!recording) {
      return refuseLocalLogin();
    }

    const startedAt = new Date(now());
    const isAuth = AUTH_PATH.test(path);
    const urlPath = req.originalUrl.split('?')[0];
    const id = crypto.randomUUID();
    let seq;
    try {
      seq = await store.nextSeq();
      await store.recordStart({
        _id: id,
        seq,
        schemaVersion: 2,
        outcome: 'pending',
        method: req.method,
        path: urlPath,
        query: isAuth ? undefined : capture(req.query),
        body: isAuth ? undefined : capture(req.body),
        context: {
          ip: req.ip,
          userAgent: req.get('user-agent'),
          requestId: req.get('x-request-id') ?? req.get('x-correlation-id'),
        },
        createdAt: startedAt,
      });
    } catch (error) {
      const unused = seq == null ? '' : ` (sequence number ${seq} stays unused)`;
      logger.error(
        `[adminRequestAudit] could not record an admin request, refusing it${unused}`,
        error,
      );
      return res
        .status(503)
        .json({ error: 'The audit log is unavailable. The request was not run.' });
    }

    let completed = false;
    const complete = (finished) => {
      if (completed) {
        return;
      }
      completed = true;
      const outcome = outcomeOf(res.statusCode, finished, LOGIN_CALLBACK.test(path), req.user);
      store
        .recordEnd(id, {
          outcome,
          status: finished ? res.statusCode : null,
          route: routeOf(req, urlPath) ?? null,
          params:
            isAuth || !req.params || !Object.keys(req.params).length ? null : { ...req.params },
          actor: actorOf(req.user, outcome),
          tenantId: req.user?.tenantId ?? null,
          reason: blocked ? 'password login disabled' : null,
          completedAt: new Date(now()),
          durationMs: now() - startedAt.getTime(),
        })
        .catch((error) =>
          logger.error(
            `[adminRequestAudit] could not store the outcome of admin request ${seq}`,
            error,
          ),
        );
    };
    res.once('finish', () => complete(true));
    res.once('close', () => complete(res.writableFinished));

    if (blocked) {
      return refuseLocalLogin();
    }
    next();
  };
}

module.exports = { createAdminRequestAudit, isRecording };
