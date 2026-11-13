import axios from 'axios';
import {
  request,
  apiBaseUrl,
  dataService,
  setTokenHeader,
  buildLoginRedirectUrl,
} from 'librechat-data-provider';

/** Idle window before a signed-in user is logged out. */
const IDLE_LIMIT_MS = 2 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 10 * 1000;
const ACTIVITY_THROTTLE_MS = 15 * 1000;
const EXPIRED_PROBE_INTERVAL_MS = 500;
const EXPIRED_PROBE_LIMIT_MS = 20 * 1000;
const ACTIVITY_KEY = 'librechat.lastActivity';
const LOGOUT_KEY = 'librechat.inactivityLogout';
const ACTIVITY_EVENTS: readonly string[] = [
  'wheel',
  'keydown',
  'mousemove',
  'touchstart',
  'pointerdown',
];

let lastActivity = 0;
let lastWrite = 0;
let isLoggingOut = false;
let checkTimer: ReturnType<typeof setInterval> | null = null;
let probeTimer: ReturnType<typeof setInterval> | null = null;

const readStoredActivity = (): number => {
  try {
    const stored = window.localStorage.getItem(ACTIVITY_KEY);
    const parsed = stored != null ? Number(stored) : 0;
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
};

const writeStoredActivity = (timestamp: number): void => {
  try {
    window.localStorage.setItem(ACTIVITY_KEY, String(timestamp));
  } catch {
    // localStorage can be blocked in embedded/private contexts.
  }
};

/** Cleared only on a confirmed revoke, so a failed attempt retries on the next load. */
const clearStoredActivity = (): void => {
  try {
    window.localStorage.removeItem(ACTIVITY_KEY);
  } catch {
    // Ignore unavailable storage.
  }
};

const broadcastLogout = (): void => {
  try {
    window.localStorage.setItem(LOGOUT_KEY, String(Date.now()));
  } catch {
    // Other tabs fall back to their own idle check.
  }
};

const hasBearerToken = (): boolean => {
  const authorization = axios.defaults.headers.common['Authorization'];
  return typeof authorization === 'string' && authorization.startsWith('Bearer ');
};

/** Wall-clock rather than timer-based, so a suspended machine still expires the session. */
const idleDuration = (): number => Date.now() - Math.max(lastActivity, readStoredActivity());

const recordActivity = (): void => {
  const now = Date.now();
  /** An expired window must not be resurrected by the interaction that wakes a stale tab. */
  if (isLoggingOut || (now - lastActivity >= IDLE_LIMIT_MS && idleDuration() >= IDLE_LIMIT_MS)) {
    return;
  }
  lastActivity = now;
  if (now - lastWrite < ACTIVITY_THROTTLE_MS) {
    return;
  }
  lastWrite = now;
  writeStoredActivity(now);
};

const redirectToLogin = (): void => {
  window.location.assign(apiBaseUrl() + buildLoginRedirectUrl());
};

type RevokeResult = {
  revoked: boolean;
  redirect?: string;
};

const revokeSession = async (): Promise<RevokeResult> => {
  try {
    const { redirect } = await dataService.logout();
    return { revoked: true, redirect };
  } catch {
    return { revoked: false };
  }
};

const renewToken = async (): Promise<boolean> => {
  try {
    const { token = '' } = (await request.refreshToken()) ?? {};
    if (!token) {
      return false;
    }
    request.dispatchTokenUpdatedEvent(token);
    return true;
  } catch {
    return false;
  }
};

const logoutForInactivity = async (): Promise<void> => {
  if (isLoggingOut) {
    return;
  }
  isLoggingOut = true;
  stopInactivityLogout();
  broadcastLogout();

  /** A token that expired mid-idle 401s the logout, and the interceptor skips recovery there. */
  let result = await revokeSession();
  if (!result.revoked && (await renewToken())) {
    result = await revokeSession();
  }

  setTokenHeader(undefined);
  if (result.revoked) {
    clearStoredActivity();
  }
  if (result.redirect != null && result.redirect) {
    window.location.assign(result.redirect);
    return;
  }

  redirectToLogin();
};

const stopProbe = (): void => {
  if (probeTimer === null) {
    return;
  }
  clearInterval(probeTimer);
  probeTimer = null;
};

const checkIdle = (): void => {
  if (isLoggingOut || !hasBearerToken() || idleDuration() < IDLE_LIMIT_MS) {
    return;
  }
  void logoutForInactivity();
};

/** Becoming visible is treated as a checkpoint, not as activity, so waking a laptop expires. */
const handleVisibility = (): void => {
  if (document.visibilityState !== 'visible') {
    return;
  }
  checkIdle();
};

const handleStorage = (event: StorageEvent): void => {
  if (event.key !== LOGOUT_KEY || isLoggingOut) {
    return;
  }
  isLoggingOut = true;
  stopInactivityLogout();
  setTokenHeader(undefined);
  redirectToLogin();
};

export function startInactivityLogout(): void {
  if (checkTimer !== null) {
    return;
  }
  lastActivity = readStoredActivity() || Date.now();
  lastWrite = lastActivity;

  for (const eventName of ACTIVITY_EVENTS) {
    document.addEventListener(eventName, recordActivity, { passive: true, capture: true });
  }
  document.addEventListener('visibilitychange', handleVisibility);
  window.addEventListener('storage', handleStorage);
  checkTimer = setInterval(checkIdle, CHECK_INTERVAL_MS);

  if (idleDuration() < IDLE_LIMIT_MS) {
    return;
  }

  /** Already expired on load: watch for the token the app is about to restore. */
  const probeStartedAt = Date.now();
  probeTimer = setInterval(() => {
    if (Date.now() - probeStartedAt > EXPIRED_PROBE_LIMIT_MS) {
      stopProbe();
      return;
    }
    checkIdle();
  }, EXPIRED_PROBE_INTERVAL_MS);
}

export function stopInactivityLogout(): void {
  stopProbe();
  if (checkTimer !== null) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
  for (const eventName of ACTIVITY_EVENTS) {
    document.removeEventListener(eventName, recordActivity, { capture: true });
  }
  document.removeEventListener('visibilitychange', handleVisibility);
  window.removeEventListener('storage', handleStorage);
}

if (typeof window !== 'undefined') {
  startInactivityLogout();
}
