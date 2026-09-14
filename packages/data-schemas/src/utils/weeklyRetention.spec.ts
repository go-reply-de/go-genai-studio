import {
  parseWeeklyReset,
  nextWeeklyReset,
  getWeeklyReset,
  resetWeeklyRetentionCache,
} from './weeklyRetention';

jest.mock('~/config/winston', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const BERLIN = 'Europe/Berlin';
const SUNDAY_2300 = { day: 0, hour: 23, minute: 0, timeZone: BERLIN };

/** How the instant actually reads on a clock in Berlin. */
function inBerlin(instant: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: BERLIN,
    hour12: false,
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(instant);
}

describe('parseWeeklyReset', () => {
  it('parses a day and time', () => {
    expect(parseWeeklyReset('SUN 23:00', BERLIN)).toEqual(SUNDAY_2300);
    expect(parseWeeklyReset('wed 07:30', BERLIN)).toEqual({
      day: 3,
      hour: 7,
      minute: 30,
      timeZone: BERLIN,
    });
  });

  it('defaults to UTC when no zone is given', () => {
    expect(parseWeeklyReset('SUN 23:00', undefined)?.timeZone).toBe('UTC');
    expect(parseWeeklyReset('SUN 23:00', '  ')?.timeZone).toBe('UTC');
  });

  it('returns null when unset', () => {
    expect(parseWeeklyReset(undefined, BERLIN)).toBeNull();
    expect(parseWeeklyReset('', BERLIN)).toBeNull();
  });

  it('rejects malformed input rather than guessing', () => {
    expect(parseWeeklyReset('SUNDAY 23:00', BERLIN)).toBeNull();
    expect(parseWeeklyReset('SUN 25:00', BERLIN)).toBeNull();
    expect(parseWeeklyReset('SUN 23:60', BERLIN)).toBeNull();
    expect(parseWeeklyReset('23:00', BERLIN)).toBeNull();
    expect(parseWeeklyReset('XYZ 23:00', BERLIN)).toBeNull();
  });

  it('rejects an unknown time zone', () => {
    expect(parseWeeklyReset('SUN 23:00', 'Europe/Atlantis')).toBeNull();
  });
});

describe('nextWeeklyReset', () => {
  it('lands on the coming Sunday from midweek', () => {
    // Wednesday 16 September 2026, summer time (CEST, UTC+2).
    const now = new Date('2026-09-16T12:00:00Z');
    expect(nextWeeklyReset(SUNDAY_2300, now).toISOString()).toBe('2026-09-20T21:00:00.000Z');
  });

  it('uses the winter offset in winter', () => {
    // Wednesday 18 November 2026, standard time (CET, UTC+1).
    const now = new Date('2026-11-18T12:00:00Z');
    expect(nextWeeklyReset(SUNDAY_2300, now).toISOString()).toBe('2026-11-22T22:00:00.000Z');
  });

  it('expires a save made shortly before the boundary at that boundary', () => {
    const now = new Date('2026-09-20T20:59:00Z'); // 22:59 in Berlin
    expect(nextWeeklyReset(SUNDAY_2300, now).toISOString()).toBe('2026-09-20T21:00:00.000Z');
  });

  it('rolls to the following week for a save just after the boundary', () => {
    const now = new Date('2026-09-20T21:00:30Z'); // 23:00:30 in Berlin
    expect(nextWeeklyReset(SUNDAY_2300, now).toISOString()).toBe('2026-09-27T21:00:00.000Z');
  });

  it('treats the boundary instant itself as already passed', () => {
    const now = new Date('2026-09-20T21:00:00Z');
    expect(nextWeeklyReset(SUNDAY_2300, now).toISOString()).toBe('2026-09-27T21:00:00.000Z');
  });

  it('always lands on Sunday 23:00 Berlin time, through both DST transitions', () => {
    // Every six hours across a year covers both transition weekends and the
    // conversions that cross one.
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 6 * 3600 * 1000) {
      const boundary = nextWeeklyReset(SUNDAY_2300, new Date(t));
      const rendered = inBerlin(boundary);
      expect(rendered).toContain('Sunday');
      expect(rendered).toContain('23:00');
    }
  });

  it('never grants more than seven days of retention', () => {
    const week = 7 * 24 * 3600 * 1000;
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 6 * 3600 * 1000) {
      const lifetime = nextWeeklyReset(SUNDAY_2300, new Date(t)).getTime() - t;
      expect(lifetime).toBeGreaterThan(0);
      expect(lifetime).toBeLessThanOrEqual(week);
    }
  });

  it('resolves a boundary that sits on the far side of a DST change', () => {
    // Spring forward is a Sunday in late March; a save the Monday before is in
    // CET while the boundary that evening is already in CEST.
    const beforeSpring = new Date('2026-03-23T09:00:00Z');
    expect(inBerlin(nextWeeklyReset(SUNDAY_2300, beforeSpring))).toContain('29/03/2026');
    expect(inBerlin(nextWeeklyReset(SUNDAY_2300, beforeSpring))).toContain('23:00');

    const beforeAutumn = new Date('2026-10-19T09:00:00Z');
    expect(inBerlin(nextWeeklyReset(SUNDAY_2300, beforeAutumn))).toContain('25/10/2026');
    expect(inBerlin(nextWeeklyReset(SUNDAY_2300, beforeAutumn))).toContain('23:00');
  });

  it('works in UTC too', () => {
    const utc = { day: 0, hour: 23, minute: 0, timeZone: 'UTC' };
    const now = new Date('2026-09-16T12:00:00Z');
    expect(nextWeeklyReset(utc, now).toISOString()).toBe('2026-09-20T23:00:00.000Z');
  });
});

describe('getWeeklyReset', () => {
  const original = { ...process.env };

  beforeEach(() => {
    resetWeeklyRetentionCache();
    delete process.env.RETENTION_WEEKLY_RESET;
    delete process.env.RETENTION_WEEKLY_RESET_TZ;
  });

  afterAll(() => {
    process.env = original;
  });

  it('is disabled when the env var is unset or blank', () => {
    expect(getWeeklyReset()).toBeNull();
    process.env.RETENTION_WEEKLY_RESET = '';
    resetWeeklyRetentionCache();
    expect(getWeeklyReset()).toBeNull();
  });

  it('reads the configured reset', () => {
    process.env.RETENTION_WEEKLY_RESET = 'SUN 23:00';
    process.env.RETENTION_WEEKLY_RESET_TZ = BERLIN;
    expect(getWeeklyReset()).toEqual(SUNDAY_2300);
  });

  it('re-parses when the configuration changes', () => {
    process.env.RETENTION_WEEKLY_RESET = 'SUN 23:00';
    process.env.RETENTION_WEEKLY_RESET_TZ = BERLIN;
    expect(getWeeklyReset()?.day).toBe(0);

    process.env.RETENTION_WEEKLY_RESET = 'MON 06:00';
    expect(getWeeklyReset()?.day).toBe(1);
  });
});
