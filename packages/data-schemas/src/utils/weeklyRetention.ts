import logger from '~/config/winston';

/**
 * Fixed weekly deletion boundary.
 *
 * The rolling window (`now + retentionHours`) is rewritten on every save, so a
 * conversation someone keeps using never expires. A boundary is absolute: every
 * record written during a week carries the same deadline, re-saving recomputes
 * the same instant, and the whole week's data goes at once.
 */

const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;

export type WeeklyReset = {
  /** 0 = Sunday, matching `Date.prototype.getDay`. */
  day: number;
  hour: number;
  minute: number;
  /** IANA zone name, e.g. `Europe/Berlin`. */
  timeZone: string;
};

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
};

const RESET_PATTERN = /^([A-Za-z]{3})\s+([01]?\d|2[0-3]):([0-5]\d)$/;

/**
 * Parses `SUN 23:00` plus an IANA zone. Returns null when unset, and logs and
 * returns null when set but unusable — callers then fall back to the rolling
 * window rather than losing the expiry altogether.
 */
export function parseWeeklyReset(
  value: string | undefined,
  timeZone: string | undefined,
): WeeklyReset | null {
  if (value == null || value.trim() === '') {
    return null;
  }

  const match = RESET_PATTERN.exec(value.trim());
  if (!match) {
    logger.error(
      `[weeklyRetention] RETENTION_WEEKLY_RESET must look like "SUN 23:00", got "${value}". Falling back to the rolling retention window.`,
    );
    return null;
  }

  const day = DAY_NAMES.indexOf(match[1].toUpperCase() as (typeof DAY_NAMES)[number]);
  if (day === -1) {
    logger.error(
      `[weeklyRetention] Unknown day "${match[1]}" in RETENTION_WEEKLY_RESET. Expected one of ${DAY_NAMES.join(', ')}. Falling back to the rolling retention window.`,
    );
    return null;
  }

  const zone = timeZone == null || timeZone.trim() === '' ? 'UTC' : timeZone.trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    logger.error(
      `[weeklyRetention] RETENTION_WEEKLY_RESET_TZ "${zone}" is not a known IANA time zone. Falling back to the rolling retention window.`,
    );
    return null;
  }

  return { day, hour: Number(match[2]), minute: Number(match[3]), timeZone: zone };
}

function getZonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const found: Record<string, string> = {};
  for (const part of parts) {
    found[part.type] = part.value;
  }

  return {
    year: Number(found.year),
    month: Number(found.month),
    day: Number(found.day),
    /* Some ICU builds render midnight as hour 24 under hour12: false. */
    hour: Number(found.hour) % 24,
    minute: Number(found.minute),
    second: Number(found.second),
    weekday: DAY_NAMES.indexOf(found.weekday.toUpperCase() as (typeof DAY_NAMES)[number]),
  };
}

/** Offset of `timeZone` at `instant`, in ms (zone time minus UTC). */
function getOffsetMs(instant: Date, timeZone: string): number {
  const parts = getZonedParts(instant, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  /* Drop sub-second precision on both sides; zone offsets are whole minutes. */
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Converts a wall-clock time in `timeZone` to the UTC instant it names. The
 * offset is resolved twice because the first guess is evaluated at the wrong
 * instant whenever the conversion crosses a DST transition.
 */
function fromZonedTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstGuess = getOffsetMs(new Date(naive), timeZone);
  let timestamp = naive - firstGuess;

  const corrected = getOffsetMs(new Date(timestamp), timeZone);
  if (corrected !== firstGuess) {
    timestamp = naive - corrected;
  }
  return new Date(timestamp);
}

/**
 * The next occurrence of the reset, strictly after `now`. A save one minute
 * before the boundary expires one minute later — that is the point of a fixed
 * weekly reset, not an edge case.
 */
export function nextWeeklyReset(reset: WeeklyReset, now: Date = new Date()): Date {
  const here = getZonedParts(now, reset.timeZone);
  const daysAhead = (reset.day - here.weekday + 7) % 7;

  const boundary = fromZonedTime(
    here.year,
    here.month,
    here.day + daysAhead,
    reset.hour,
    reset.minute,
    reset.timeZone,
  );
  if (boundary.getTime() > now.getTime()) {
    return boundary;
  }

  return fromZonedTime(
    here.year,
    here.month,
    here.day + daysAhead + 7,
    reset.hour,
    reset.minute,
    reset.timeZone,
  );
}

let cached: { key: string; reset: WeeklyReset | null } | undefined;

/** Reads the configured reset, parsing at most once per distinct env value. */
export function getWeeklyReset(): WeeklyReset | null {
  const value = process.env.RETENTION_WEEKLY_RESET;
  const timeZone = process.env.RETENTION_WEEKLY_RESET_TZ;
  const key = `${value ?? ''}|${timeZone ?? ''}`;

  if (cached?.key !== key) {
    cached = { key, reset: parseWeeklyReset(value, timeZone) };
  }
  return cached.reset;
}

/** Test seam: drops the parse cache. */
export function resetWeeklyRetentionCache(): void {
  cached = undefined;
}
