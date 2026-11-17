const TEXTS = require('./public/i18n');
const {
  weeksIn,
  openingWeek,
  groupName,
  groupRange,
  headline,
  statusOf,
} = require('./public/groups');

const T = TEXTS.de;
/** The page's numbers carry a narrow no-break space before %; compared as a plain space. */
const plain = (html) => html.replace(/[\u00a0\u202f]/g, ' ');

const week = (monday, running = false) => ({ week: monday, running, groups: [] });
const group = (top, bottom, min, max, users, conversations, tokens) => ({
  top,
  bottom,
  min,
  max,
  users,
  conversations,
  tokens,
});

describe('the weeks of a month or interval', () => {
  const WEEKS = [
    week('2026-09-21'),
    week('2026-09-28'),
    week('2026-10-05'),
    week('2026-10-12'),
    week('2026-10-19'),
    week('2026-10-26'),
    week('2026-11-02', true),
  ];
  /** A month as its first and last day. */
  const month = (m) => [
    `${m}-01`,
    new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5)), 0)).toISOString().slice(0, 10),
  ];
  const mondays = (list) => list.map((w) => w.week);

  it('holds only the weeks whose Thursday falls in the month', () => {
    expect(mondays(weeksIn(WEEKS, ...month('2026-10')))).toEqual([
      '2026-09-28',
      '2026-10-05',
      '2026-10-12',
      '2026-10-19',
      '2026-10-26',
    ]);
  });

  it('holds only the weeks whose Thursday falls in an interval', () => {
    expect(mondays(weeksIn(WEEKS, '2026-09-15', '2026-10-20'))).toEqual([
      '2026-09-21',
      '2026-09-28',
      '2026-10-05',
      '2026-10-12',
    ]);
  });

  it('is empty for a month without stored weeks', () => {
    expect(weeksIn(WEEKS, ...month('2026-08'))).toEqual([]);
  });

  it('opens a finished month on its last week', () => {
    expect(openingWeek(weeksIn(WEEKS, ...month('2026-10')))).toEqual({ index: 4, scope: 'full' });
  });

  it('opens on the running week, even when the month has full weeks before it', () => {
    const november = [week('2026-11-02'), week('2026-11-09'), week('2026-11-16', true)];
    expect(openingWeek(november)).toEqual({ index: 2, scope: 'running' });
  });

  it('opens on the running week while there is no full week yet', () => {
    expect(openingWeek(weeksIn(WEEKS, ...month('2026-11')))).toEqual({
      index: 0,
      scope: 'running',
    });
  });

  it('opens on nothing without weeks', () => {
    expect(openingWeek([])).toEqual({ index: -1, scope: 'none' });
  });
});

describe('group names', () => {
  it('names each group and its range of conversations', () => {
    expect(groupName(group('power', 'power', 10, null), T)).toBe('Power-User');
    expect(groupName(group('occasional', 'occasional', 1, 2), T)).toBe('Gelegentlich');
    expect(groupRange(group('power', 'power', 10, null), T)).toBe('10+ Unterhaltungen');
    expect(groupRange(group('regular', 'regular', 3, 9), T)).toBe('3–9 Unterhaltungen');
  });

  it('names a merged group after the group it reaches into', () => {
    expect(groupName(group('power', 'regular', 3, null), T)).toBe('Regelmäßig oder mehr');
    expect(groupName(group('regular', 'occasional', 1, 9), T)).toBe('Regelmäßig oder weniger');
  });
});

describe('headline', () => {
  it('leads with the power users and their shares', () => {
    const groups = [
      group('power', 'power', 10, null, 6, 52, 65),
      group('regular', 'regular', 3, 9, 12, 37, 29),
      group('occasional', 'occasional', 1, 2, 16, 11, 6),
    ];
    expect(plain(headline(groups, T))).toBe(
      '<b>6 Power-User</b> (18 % der Nutzer) erzeugen <b>52 %</b> der Unterhaltungen und ' +
        '<b>65 %</b> des Tokenverbrauchs.',
    );
  });

  it('says what the top group covers when the power users were merged', () => {
    const groups = [
      group('power', 'regular', 3, null, 8, 70, 80),
      group('occasional', 'occasional', 1, 2, 7, 30, 20),
    ];
    expect(plain(headline(groups, T))).toBe(
      '<b>8 Nutzer</b> mit 3 oder mehr Unterhaltungen (53 % der Nutzer) erzeugen <b>70 %</b> ' +
        'der Unterhaltungen und <b>80 %</b> des Tokenverbrauchs.',
    );
  });

  it('reads in English too', () => {
    const groups = [
      group('power', 'power', 10, null, 6, 52, 65),
      group('occasional', 'regular', 1, 9, 28, 48, 35),
    ];
    expect(plain(headline(groups, TEXTS.en))).toBe(
      '<b>6 power users</b> (18% of users) account for <b>52%</b> of conversations and ' +
        '<b>65%</b> of token use.',
    );
  });
});

describe('statusOf', () => {
  it('shows groups only when a week was split', () => {
    expect(statusOf([group('power', 'occasional', 1, null, 9, 100, 100)])).toBe('tooFew');
    expect(statusOf([group('power', 'occasional', 1, null, 12, 100, 100)])).toBe('oneGroup');
    expect(
      statusOf([
        group('power', 'regular', 3, null, 8, 70, 80),
        group('occasional', 'occasional', 1, 2, 7, 30, 20),
      ]),
    ).toBe('groups');
  });
});
