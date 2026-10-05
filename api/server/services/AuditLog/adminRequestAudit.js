const { isEnabled } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { SystemRoles } = require('librechat-data-provider');

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
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

/**
 * Prints one JSON line per admin change request on the routes it is mounted on, whatever its
 * outcome, for the log sink to route off-cluster. Inert unless AUDIT_LOG_STDOUT is set.
 */
function createAdminRequestAudit({
  enabled = isEnabled(process.env.AUDIT_LOG_STDOUT),
  write = (line) => process.stdout.write(line),
} = {}) {
  return function adminRequestAudit(req, res, next) {
    const path = normalizePath(req.originalUrl);
    if (!enabled || !shouldRecord(req.method, path)) {
      return next();
    }

    const startedAt = new Date();
    const isAuth = AUTH_PATH.test(path);
    const query = isAuth ? undefined : capture(req.query);
    const body = isAuth ? undefined : capture(req.body);
    let printed = false;

    const print = (finished) => {
      if (printed) {
        return;
      }
      printed = true;
      try {
        const outcome = outcomeOf(res.statusCode, finished, LOGIN_CALLBACK.test(path), req.user);
        const urlPath = req.originalUrl.split('?')[0];
        const route = routeOf(req, urlPath);
        const entry = {
          schemaVersion: 1,
          outcome,
          status: finished ? res.statusCode : undefined,
          method: req.method,
          route,
          path: urlPath,
          params: isAuth || !req.params || !Object.keys(req.params).length ? undefined : req.params,
          query,
          body,
          actor: actorOf(req.user, outcome),
          tenantId: req.user?.tenantId,
          context: {
            ip: req.ip,
            userAgent: req.get('user-agent'),
            requestId: req.get('x-request-id') ?? req.get('x-correlation-id'),
          },
          startedAt: startedAt.toISOString(),
          durationMs: Date.now() - startedAt.getTime(),
        };
        const line = {
          severity: outcome === 'success' ? 'NOTICE' : 'WARNING',
          message: `admin ${req.method} ${route ?? entry.path} ${entry.status ?? outcome}`,
          adminRequest: entry,
        };
        write(`${JSON.stringify(line)}\n`);
      } catch (error) {
        logger.error('[adminRequestAudit] failed to print admin request', error);
      }
    };

    res.once('finish', () => print(true));
    res.once('close', () => print(res.writableFinished));
    next();
  };
}

module.exports = { createAdminRequestAudit };
