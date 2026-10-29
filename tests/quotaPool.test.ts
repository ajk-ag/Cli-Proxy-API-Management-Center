import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  accountsFromHistory,
  burnRate,
  projectPool,
  recordedSeries,
  remainingAt,
  weeklyReadingFromQuota,
  weeklyReadingFromSample,
  type HistorySample,
  type PoolAccount,
} from '@/features/quota/poolModel';
import type { CodexQuotaState } from '@/types';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@/utils/time/durations';

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const sec = (ms: number) => Math.round(ms / 1000);

const account = (key: string, readings: PoolAccount['readings']): PoolAccount => ({
  key,
  label: key,
  readings,
});
const reading = (atMs: number, remaining: number, resetAtMs: number | null = null) => ({
  atMs,
  remaining,
  resetAtMs,
  periodMs: 7 * DAY_MS,
});

describe('weekly window selection', () => {
  test('Claude uses the 7d window', () => {
    const sample: HistorySample = {
      t: sec(NOW),
      auth: 'a',
      provider: 'claude',
      windows: [
        { id: '5h', used: 2, reset_at: sec(NOW + HOUR_MS) },
        { id: '7d', used: 46, reset_at: sec(NOW + 2 * DAY_MS) },
      ],
    };
    expect(weeklyReadingFromSample('claude', sample)).toEqual({
      atMs: sec(NOW) * 1000,
      remaining: 54,
      resetAtMs: sec(NOW + 2 * DAY_MS) * 1000,
      periodMs: 7 * DAY_MS,
    });
  });

  test('Codex uses whichever position holds the week-long window', () => {
    const pro: HistorySample = {
      t: sec(NOW),
      auth: 'pro',
      provider: 'codex',
      windows: [{ id: 'primary', used: 21, minutes: 10080, reset_at: sec(NOW + DAY_MS) }],
    };
    const plus: HistorySample = {
      t: sec(NOW),
      auth: 'plus',
      provider: 'codex',
      windows: [
        { id: 'bengalfox-primary', used: 90, minutes: 10080 },
        { id: 'primary', used: 70, minutes: 300 },
        { id: 'secondary', used: 30, minutes: 10080 },
      ],
    };
    expect(weeklyReadingFromSample('codex', pro)?.remaining).toBe(79);
    expect(weeklyReadingFromSample('codex', plus)?.remaining).toBe(70);
  });

  test('a quota loaded by the panel counts as a reading', () => {
    const quota = {
      status: 'success',
      windows: [
        { id: 'five-hour', label: '', usedPercent: 50, resetLabel: '', periodHours: 5 },
        {
          id: 'weekly',
          label: '',
          usedPercent: 11,
          resetLabel: '',
          resetAtMs: NOW + DAY_MS,
          periodHours: 168,
        },
      ],
    } as CodexQuotaState;
    expect(weeklyReadingFromQuota('codex', quota, NOW)).toEqual({
      atMs: NOW,
      remaining: 89,
      resetAtMs: NOW + DAY_MS,
      periodMs: 168 * HOUR_MS,
    });
    expect(weeklyReadingFromQuota('codex', { ...quota, status: 'error' }, NOW)).toBeNull();
  });
});

describe('recorded pool', () => {
  const a = account('a', [
    reading(NOW - 4 * HOUR_MS, 80, NOW - HOUR_MS),
    reading(NOW - 30 * MINUTE_MS, 95),
  ]);

  test('holds the last reading, back-fills before the first, and renews after a reset', () => {
    expect(remainingAt(a, NOW - 10 * HOUR_MS)).toBe(80);
    expect(remainingAt(a, NOW - 2 * HOUR_MS)).toBe(80);
    expect(remainingAt(a, NOW - 50 * MINUTE_MS)).toBe(100);
    expect(remainingAt(a, NOW)).toBe(95);
    expect(remainingAt(account('none', []), NOW)).toBeNull();
  });

  test('sums accounts from the first reading on', () => {
    const b = account('b', [reading(NOW - 2 * HOUR_MS, 40)]);
    const series = recordedSeries([a, b], NOW - 6 * HOUR_MS, NOW, HOUR_MS);
    expect(series[0]).toEqual({ t: NOW - 4 * HOUR_MS, pool: 120 });
    expect(series[series.length - 1]).toEqual({ t: NOW, pool: 135 });
  });
});

describe('burn rate', () => {
  test('counts drops within a window cycle per hour of history', () => {
    const reset = NOW + DAY_MS;
    const accounts = [
      account('a', [
        reading(NOW - 2 * HOUR_MS, 60, reset),
        reading(NOW - HOUR_MS, 55, reset),
        reading(NOW, 50, reset),
      ]),
      account('b', [reading(NOW - 2 * HOUR_MS, 30, reset), reading(NOW, 20, reset)]),
    ];
    expect(burnRate(accounts, NOW, 3)).toBeCloseTo(10, 5);
  });

  test('a reset between readings is not negative usage', () => {
    const accounts = [
      account('a', [
        reading(NOW - 2 * HOUR_MS, 10, NOW - HOUR_MS),
        reading(NOW, 96, NOW + 7 * DAY_MS),
      ]),
    ];
    expect(burnRate(accounts, NOW, 3)).toBe(0);
  });

  test('needs at least 15 minutes of history', () => {
    expect(burnRate([account('a', [reading(NOW - 5 * MINUTE_MS, 50)])], NOW, 3)).toBeNull();
  });
});

describe('projection', () => {
  test('shares the burn, then moves it to the accounts that still have quota', () => {
    const accounts = [account('big', [reading(NOW, 50)]), account('small', [reading(NOW, 10)])];
    const projection = projectPool(accounts, NOW, NOW + DAY_MS, 10, 10 * MINUTE_MS);
    expect(projection.firstEmpty?.key).toBe('small');
    expect(Math.abs((projection.firstEmpty?.atMs ?? 0) - (NOW + 2 * HOUR_MS))).toBeLessThanOrEqual(
      10 * MINUTE_MS
    );
    expect(Math.abs((projection.emptyAtMs ?? 0) - (NOW + 6 * HOUR_MS))).toBeLessThanOrEqual(
      10 * MINUTE_MS
    );
    expect(projection.points[0]).toEqual({ t: NOW, pool: 60 });
  });

  test('adds an account back to 100% at its reset, then every period after', () => {
    const accounts = [account('a', [reading(NOW, 20, NOW + HOUR_MS)])];
    const projection = projectPool(accounts, NOW, NOW + 8 * DAY_MS, 0, HOUR_MS);
    expect(projection.resets.map((item) => item.t)).toEqual([NOW + HOUR_MS]);
    expect(projection.resets[0].gain).toBeCloseTo(80, 5);
    const withBurn = projectPool(accounts, NOW, NOW + 8 * DAY_MS, 0.5, HOUR_MS);
    expect(withBurn.resets.map((item) => item.t)).toEqual([
      NOW + HOUR_MS,
      NOW + HOUR_MS + 7 * DAY_MS,
    ]);
    expect(withBurn.emptyAtMs).toBeNull();
  });

  test('a stale reset instant is rolled forward by whole periods', () => {
    const accounts = [account('a', [reading(NOW - 8 * DAY_MS, 40, NOW - 7.5 * DAY_MS)])];
    const projection = projectPool(accounts, NOW, NOW + 7 * DAY_MS, 1, HOUR_MS);
    expect(projection.points[0].pool).toBe(100);
    expect(projection.resets).toHaveLength(1);
    expect(Math.abs(projection.resets[0].t - (NOW + 6.5 * DAY_MS))).toBeLessThan(MINUTE_MS);
  });
});

describe('history grouping', () => {
  test('groups one provider by file name, oldest first', () => {
    const samples: HistorySample[] = [
      {
        t: sec(NOW),
        auth: 'id-1',
        name: 'claude-a.json',
        provider: 'claude',
        windows: [{ id: '7d', used: 50 }],
      },
      {
        t: sec(NOW - HOUR_MS),
        auth: 'id-1',
        name: 'claude-a.json',
        provider: 'claude',
        windows: [{ id: '7d', used: 40 }],
      },
      {
        t: sec(NOW),
        auth: 'id-2',
        name: 'codex-a.json',
        provider: 'codex',
        windows: [{ id: 'primary', used: 5, minutes: 10080 }],
      },
      {
        t: sec(NOW),
        auth: 'id-3',
        name: 'claude-b.json',
        provider: 'claude',
        windows: [{ id: '5h', used: 9 }],
      },
    ];
    const grouped = accountsFromHistory('claude', samples);
    expect([...grouped.keys()]).toEqual(['claude-a.json']);
    expect(grouped.get('claude-a.json')?.map((item) => item.remaining)).toEqual([60, 50]);
  });
});

describe('pool view wiring', () => {
  const page = readFileSync('src/features/quota/QuotaPage.tsx', 'utf8');
  const view = readFileSync('src/features/quota/components/QuotaPool.tsx', 'utf8');

  test('the page offers a Pool layout fed by the filtered credentials', () => {
    expect(page).toContain("layout === 'pool' ? (");
    expect(page).toContain('<QuotaPool');
    expect(page).toContain('entries={filteredEntries}');
    expect(page).toContain("{layout !== 'pool' && (");
  });

  test('the view reads recorded history and offers a table of every account', () => {
    expect(view).toContain('quotaHistoryApi.list');
    expect(view).toContain('<details className={styles.table}>');
    expect(view).toContain('role="img"');
  });
});
