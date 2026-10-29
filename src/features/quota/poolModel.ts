/**
 * Quota pool: every account of a provider added together, over time.
 *
 * The pool is the sum of each account's weekly remaining percentage (6 Claude
 * accounts = 600%). The recorded part comes from the server's quota history
 * (readings taken from real responses); the projected part assumes usage goes
 * on at the recent burn rate, spread evenly over the accounts that still have
 * quota, and adds each account back to 100% when its window resets.
 *
 * The drain rate is the same pool seen as speed: percentage points used per
 * hour over a trailing window, recorded from history and projected from the
 * assumed burn.
 *
 * Every point also carries `parts`, each account's share in the order of the
 * accounts passed in, so a chart can stack the accounts under the pool line.
 *
 * Pure functions only: no React, no clock of its own (`now` is passed in).
 */

import type { ClaudeQuotaState, CodexQuotaState } from '@/types';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@/utils/time/durations';

export type PoolProvider = 'claude' | 'codex';
export const POOL_PROVIDERS: readonly PoolProvider[] = ['claude', 'codex'];

export const isPoolProvider = (value: string): value is PoolProvider =>
  (POOL_PROVIDERS as readonly string[]).includes(value);

/** One reading of an account's weekly window. */
export interface PoolReading {
  atMs: number;
  /** Percent remaining, 0-100. */
  remaining: number;
  /** When this window resets, or null when unknown. */
  resetAtMs: number | null;
  periodMs: number;
}

export interface PoolAccount {
  key: string;
  label: string;
  /** Oldest first. */
  readings: PoolReading[];
}

export interface PoolPoint {
  t: number;
  pool: number;
  /** Each account's remaining percentage, in the order of the accounts passed in. */
  parts: number[];
}

/** Percentage points used per hour at `t`. */
export interface RatePoint {
  t: number;
  /** The whole pool, or null while there is too little history to tell. */
  rate: number | null;
  /** Each account's rate, in the order of the accounts passed in. */
  parts: number[];
}

export interface PoolReset {
  t: number;
  key: string;
  /** Percentage points the pool gains at this reset. */
  gain: number;
}

export interface PoolProjection {
  points: PoolPoint[];
  /** Usage per hour at each step, as the projection spends it. */
  drain: RatePoint[];
  resets: PoolReset[];
  /** First time the whole pool reaches 0, or null when it stays above 0. */
  emptyAtMs: number | null;
  /** The first account to reach 0, or null when none does. */
  firstEmpty: { key: string; label: string; atMs: number } | null;
  /** Per account: remaining now, its next reset and when it is projected to run out. */
  accounts: {
    key: string;
    label: string;
    remainingNow: number;
    nextResetMs: number | null;
    emptyAtMs: number | null;
  }[];
}

/** A quota-history window as the server returns it. */
export interface HistoryWindow {
  id: string;
  used: number;
  reset_at?: number;
  minutes?: number;
}

export interface HistorySample {
  t: number;
  auth: string;
  auth_index?: string;
  name?: string;
  provider: string;
  windows: HistoryWindow[];
}

const WEEK_MS = 7 * DAY_MS;
/** A burn rate needs at least this much recorded history behind it. */
const MIN_HISTORY_MS = 15 * MINUTE_MS;
const clampPercent = (value: number) => Math.max(0, Math.min(100, value));

/**
 * The weekly window of one history sample. Claude calls it `7d`; Codex reports
 * windows by position, so the one whose length is a week is used (`primary` on
 * Pro, `secondary` on Plus). Additional per-model limits are ignored.
 */
export function weeklyReadingFromSample(
  provider: PoolProvider,
  sample: HistorySample
): PoolReading | null {
  const atMs = sample.t * 1000;
  let window: HistoryWindow | undefined;
  if (provider === 'claude') {
    window = sample.windows.find((item) => item.id === '7d');
  } else {
    window = sample.windows
      .filter((item) => item.id === 'primary' || item.id === 'secondary')
      .filter((item) => (item.minutes ?? 0) * MINUTE_MS >= 6 * DAY_MS)
      .sort((a, b) => (b.minutes ?? 0) - (a.minutes ?? 0))[0];
  }
  if (!window || !Number.isFinite(window.used)) return null;
  return {
    atMs,
    remaining: clampPercent(100 - window.used),
    resetAtMs: window.reset_at ? window.reset_at * 1000 : null,
    periodMs: window.minutes ? window.minutes * MINUTE_MS : WEEK_MS,
  };
}

/**
 * The weekly window of a quota the panel loaded itself (Refresh quota), so
 * accounts with no recorded traffic still count toward the pool.
 */
export function weeklyReadingFromQuota(
  provider: PoolProvider,
  quota: ClaudeQuotaState | CodexQuotaState | undefined,
  atMs: number
): PoolReading | null {
  if (!quota || quota.status !== 'success') return null;
  const windows = quota.windows ?? [];
  const window =
    provider === 'claude'
      ? windows.find((item) => item.id === 'seven-day')
      : windows.find((item) => item.id === 'weekly');
  if (!window || window.usedPercent === null || !Number.isFinite(window.usedPercent)) return null;
  return {
    atMs,
    remaining: clampPercent(100 - window.usedPercent),
    resetAtMs: window.resetAtMs ?? null,
    periodMs: window.periodHours ? window.periodHours * HOUR_MS : WEEK_MS,
  };
}

/**
 * An account's remaining percentage at `t`, or null before anything is known.
 * Before the first reading the first reading is assumed; once a reading's
 * reset instant has passed, the window has renewed and counts as 100%.
 */
export function remainingAt(account: PoolAccount, t: number): number | null {
  const { readings } = account;
  if (readings.length === 0) return null;
  // The last reading taken at or before t (binary search: readings are sorted).
  let low = 0;
  let high = readings.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (readings[mid].atMs <= t) low = mid;
    else high = mid - 1;
  }
  const current = readings[low];
  if (current.atMs <= t && current.resetAtMs !== null && t >= current.resetAtMs) return 100;
  return current.remaining;
}

/** The recorded pool between `fromMs` and `toMs`, one point per step. */
export function recordedSeries(
  accounts: PoolAccount[],
  fromMs: number,
  toMs: number,
  stepMs: number
): PoolPoint[] {
  const firstReading = firstReadingMs(accounts);
  if (firstReading === null || toMs < fromMs) return [];
  return stepTimes(Math.max(fromMs, firstReading), toMs, stepMs).map((t) => {
    const parts = accounts.map((account) => remainingAt(account, t) ?? 0);
    return { t, pool: sum(parts), parts };
  });
}

/** When the oldest reading of any account was taken, or null with none. */
export function firstReadingMs(accounts: PoolAccount[]): number | null {
  let first = Infinity;
  for (const account of accounts) {
    if (account.readings.length) first = Math.min(first, account.readings[0].atMs);
  }
  return Number.isFinite(first) ? first : null;
}

/** `fromMs`, then every `stepMs`, always ending exactly on `toMs`. */
const stepTimes = (fromMs: number, toMs: number, stepMs: number) => {
  const times: number[] = [];
  if (toMs < fromMs) return times;
  for (let t = fromMs; t <= toMs; t += stepMs) times.push(t);
  if (times[times.length - 1] < toMs) times.push(toMs);
  return times;
};

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/**
 * Percentage points used per hour across the pool over the last `windowHours`,
 * or null when there is under 15 minutes of history.
 */
export function burnRate(
  accounts: PoolAccount[],
  nowMs: number,
  windowHours: number
): number | null {
  return drainSeries(accounts, nowMs, nowMs, HOUR_MS, windowHours)[0]?.rate ?? null;
}

/**
 * The drain rate from `fromMs` to `toMs`: at each step, the usage in the
 * `windowHours` before it, per hour. Only drops between two readings of the
 * same window cycle count, so a reset never reads as negative usage. The
 * server records only readings that changed, so a quiet stretch with no
 * readings counts as no usage. Null until 15 minutes of history exist.
 */
export function drainSeries(
  accounts: PoolAccount[],
  fromMs: number,
  toMs: number,
  stepMs: number,
  windowHours: number
): RatePoint[] {
  const firstReading = firstReadingMs(accounts);
  if (firstReading === null) return [];
  const windowMs = windowHours * HOUR_MS;
  const events = accounts.map(usageEvents);
  // A sliding window per account: events in (t - window, t] are summed.
  const lo = events.map(() => 0);
  const hi = events.map(() => 0);
  const used = events.map(() => 0);
  return stepTimes(fromMs, toMs, stepMs).map((t) => {
    events.forEach((list, i) => {
      while (hi[i] < list.length && list[hi[i]].t <= t) used[i] += list[hi[i]++].amount;
      while (lo[i] < hi[i] && list[lo[i]].t <= t - windowMs) used[i] -= list[lo[i]++].amount;
    });
    const coveredMs = t - Math.max(t - windowMs, firstReading);
    if (coveredMs < MIN_HISTORY_MS) return { t, rate: null, parts: accounts.map(() => 0) };
    const hours = coveredMs / HOUR_MS;
    // Clear float dust left by adding and removing the same amounts.
    const parts = used.map((value) => (value > 1e-9 ? value / hours : 0));
    return { t, rate: sum(parts), parts };
  });
}

/** One account's usage: each drop between two readings of the same cycle. */
function usageEvents(account: PoolAccount): { t: number; amount: number }[] {
  const events: { t: number; amount: number }[] = [];
  const { readings } = account;
  for (let i = 1; i < readings.length; i++) {
    const previous = readings[i - 1];
    const reading = readings[i];
    if (sameCycle(previous, reading) && previous.remaining > reading.remaining) {
      events.push({ t: reading.atMs, amount: previous.remaining - reading.remaining });
    }
  }
  return events;
}

const sameCycle = (a: PoolReading, b: PoolReading) =>
  a.resetAtMs === null || b.resetAtMs === null
    ? b.remaining <= a.remaining
    : Math.abs(a.resetAtMs - b.resetAtMs) < 10 * MINUTE_MS;

/**
 * Project the pool from `nowMs` to `untilMs`: the burn is shared evenly by the
 * accounts that still have quota, and each account returns to 100% at its
 * reset, then again every period after it.
 */
export function projectPool(
  accounts: PoolAccount[],
  nowMs: number,
  untilMs: number,
  burnPerHour: number,
  stepMs: number
): PoolProjection {
  // An account with no reading stays in place (so `parts` line up with the
  // accounts passed in) but holds nothing and is left out of the results.
  const state = accounts.map((account, index) => {
    const last = account.readings[account.readings.length - 1];
    const remaining = remainingAt(account, nowMs);
    const known = Boolean(last) && remaining !== null;
    let nextResetMs = known ? last.resetAtMs : null;
    while (nextResetMs !== null && nextResetMs <= nowMs) nextResetMs += last.periodMs;
    return {
      index,
      known,
      key: account.key,
      label: account.label,
      remaining: remaining ?? 0,
      remainingNow: remaining ?? 0,
      firstResetMs: nextResetMs,
      nextResetMs,
      periodMs: known ? last.periodMs : WEEK_MS,
      emptyAtMs: known && (remaining ?? 0) <= 0 ? nowMs : (null as number | null),
    };
  });

  const points: PoolPoint[] = [];
  const drain: RatePoint[] = [];
  const resets: PoolReset[] = [];
  let emptyAtMs: number | null = null;
  const snapshot = (t: number): PoolPoint => {
    const parts = state.map((item) => item.remaining);
    return { t, pool: sum(parts), parts };
  };
  const total = () => state.reduce((value, item) => value + item.remaining, 0);
  points.push(snapshot(nowMs));
  if (total() <= 0) emptyAtMs = nowMs;
  const stepHours = stepMs / HOUR_MS;

  for (let t = nowMs + stepMs; t <= untilMs; t += stepMs) {
    const stepStart = t - stepMs;
    // Resets inside this step happen first, at their own instant.
    for (const item of state) {
      while (item.nextResetMs !== null && item.nextResetMs <= t) {
        const before = snapshot(item.nextResetMs);
        const gain = 100 - item.remaining;
        item.remaining = 100;
        if (gain > 0.05) {
          points.push(before);
          points.push(snapshot(item.nextResetMs));
          resets.push({ t: item.nextResetMs, key: item.key, gain });
        }
        item.nextResetMs += item.periodMs;
      }
    }
    const takenBy = state.map(() => 0);
    let toBurn = (burnPerHour * stepMs) / HOUR_MS;
    // Spread the step's usage over the accounts with quota left; what an
    // account cannot absorb moves to the others (the proxy rotates past it).
    for (let guard = 0; toBurn > 1e-9 && guard < 8; guard++) {
      const active = state.filter((item) => item.remaining > 0);
      if (active.length === 0) break;
      const share = toBurn / active.length;
      toBurn = 0;
      for (const item of active) {
        const taken = Math.min(item.remaining, share);
        item.remaining -= taken;
        takenBy[item.index] += taken;
        toBurn += share - taken;
        if (item.remaining <= 1e-9) {
          item.remaining = 0;
          if (item.emptyAtMs === null) item.emptyAtMs = interpolate(stepStart, t, share, taken);
        }
      }
    }
    const point = snapshot(t);
    points.push(point);
    const parts = takenBy.map((taken) => taken / stepHours);
    // The step's rate also stands for its start, so the line begins at now.
    if (drain.length === 0) drain.push({ t: nowMs, rate: sum(parts), parts });
    drain.push({ t, rate: sum(parts), parts });
    if (emptyAtMs === null && point.pool <= 1e-9) emptyAtMs = t;
  }

  const empties = state.filter((item) => item.known && item.emptyAtMs !== null);
  empties.sort((a, b) => (a.emptyAtMs ?? 0) - (b.emptyAtMs ?? 0));
  const first = empties[0];
  points.sort((a, b) => a.t - b.t);
  return {
    points,
    drain,
    resets,
    emptyAtMs,
    firstEmpty: first
      ? { key: first.key, label: first.label, atMs: first.emptyAtMs ?? nowMs }
      : null,
    accounts: state
      .filter((item) => item.known)
      .map((item) => ({
        key: item.key,
        label: item.label,
        remainingNow: item.remainingNow,
        nextResetMs: item.firstResetMs,
        emptyAtMs: item.emptyAtMs,
      })),
  };
}

/** Where inside a step an account ran out, assuming steady use across the step. */
const interpolate = (startMs: number, endMs: number, share: number, taken: number) =>
  share <= 0 ? endMs : startMs + ((endMs - startMs) * taken) / share;

/** Group history samples into accounts for one provider (oldest reading first). */
export function accountsFromHistory(
  provider: PoolProvider,
  samples: HistorySample[]
): Map<string, PoolReading[]> {
  const byName = new Map<string, PoolReading[]>();
  for (const sample of samples) {
    if (sample.provider !== provider) continue;
    const reading = weeklyReadingFromSample(provider, sample);
    if (!reading) continue;
    const key = sample.name || sample.auth;
    const list = byName.get(key);
    if (list) list.push(reading);
    else byName.set(key, [reading]);
  }
  for (const list of byName.values()) list.sort((a, b) => a.atMs - b.atMs);
  return byName;
}
