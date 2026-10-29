/**
 * Quota pool: every account of a provider added together, over time.
 *
 * The pool is the sum of each account's weekly remaining percentage (6 Claude
 * accounts = 600%). The recorded part comes from the server's quota history
 * (readings taken from real responses); the projected part assumes usage goes
 * on at the recent burn rate, spread evenly over the accounts that still have
 * quota, and adds each account back to 100% when its window resets.
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
}

export interface PoolReset {
  t: number;
  key: string;
  /** Percentage points the pool gains at this reset. */
  gain: number;
}

export interface PoolProjection {
  points: PoolPoint[];
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
  let current = readings[0];
  for (const reading of readings) {
    if (reading.atMs > t) break;
    current = reading;
  }
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
  const firstReading = Math.min(
    ...accounts.flatMap((account) => account.readings.map((reading) => reading.atMs))
  );
  if (!Number.isFinite(firstReading) || toMs < fromMs) return [];
  const start = Math.max(fromMs, firstReading);
  const points: PoolPoint[] = [];
  for (let t = start; t <= toMs; t += stepMs) {
    points.push({ t, pool: poolAt(accounts, t) });
  }
  if (points.length === 0 || points[points.length - 1].t < toMs) {
    points.push({ t: toMs, pool: poolAt(accounts, toMs) });
  }
  return points;
}

const poolAt = (accounts: PoolAccount[], t: number) =>
  accounts.reduce((sum, account) => sum + (remainingAt(account, t) ?? 0), 0);

/**
 * Percentage points used per hour across the pool over the last `windowHours`.
 * Only drops between two readings of the same window cycle count, so a reset
 * never reads as negative usage. Null when there is under 15 minutes of history.
 */
export function burnRate(
  accounts: PoolAccount[],
  nowMs: number,
  windowHours: number
): number | null {
  const fromMs = nowMs - windowHours * HOUR_MS;
  let used = 0;
  let earliest = Infinity;
  for (const account of accounts) {
    let previous: PoolReading | null = null;
    for (const reading of account.readings) {
      if (reading.atMs > nowMs) break;
      if (reading.atMs >= fromMs) {
        earliest = Math.min(earliest, previous && previous.atMs < fromMs ? fromMs : reading.atMs);
        if (previous && sameCycle(previous, reading)) {
          used += Math.max(0, previous.remaining - reading.remaining);
        }
      }
      previous = reading;
    }
  }
  const coveredMs = nowMs - Math.max(fromMs, earliest);
  if (!Number.isFinite(coveredMs) || coveredMs < 15 * MINUTE_MS) return null;
  return used / (coveredMs / HOUR_MS);
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
  const state = accounts
    .map((account) => {
      const last = account.readings[account.readings.length - 1];
      const remaining = remainingAt(account, nowMs);
      if (!last || remaining === null) return null;
      let nextResetMs = last.resetAtMs;
      while (nextResetMs !== null && nextResetMs <= nowMs) nextResetMs += last.periodMs;
      return {
        key: account.key,
        label: account.label,
        remaining,
        remainingNow: remaining,
        firstResetMs: nextResetMs,
        nextResetMs,
        periodMs: last.periodMs,
        emptyAtMs: remaining <= 0 ? nowMs : (null as number | null),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  const points: PoolPoint[] = [];
  const resets: PoolReset[] = [];
  let emptyAtMs: number | null = null;
  const total = () => state.reduce((sum, item) => sum + item.remaining, 0);
  points.push({ t: nowMs, pool: total() });
  if (total() <= 0) emptyAtMs = nowMs;

  for (let t = nowMs + stepMs; t <= untilMs; t += stepMs) {
    const stepStart = t - stepMs;
    // Resets inside this step happen first, at their own instant.
    for (const item of state) {
      while (item.nextResetMs !== null && item.nextResetMs <= t) {
        const before = total();
        const gain = 100 - item.remaining;
        item.remaining = 100;
        if (gain > 0.05) {
          points.push({ t: item.nextResetMs, pool: before });
          points.push({ t: item.nextResetMs, pool: before + gain });
          resets.push({ t: item.nextResetMs, key: item.key, gain });
        }
        item.nextResetMs += item.periodMs;
      }
    }
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
        toBurn += share - taken;
        if (item.remaining <= 1e-9) {
          item.remaining = 0;
          if (item.emptyAtMs === null) item.emptyAtMs = interpolate(stepStart, t, share, taken);
        }
      }
    }
    const pool = total();
    points.push({ t, pool });
    if (emptyAtMs === null && pool <= 1e-9) emptyAtMs = t;
  }

  const empties = state.filter((item) => item.emptyAtMs !== null);
  empties.sort((a, b) => (a.emptyAtMs ?? 0) - (b.emptyAtMs ?? 0));
  const first = empties[0];
  points.sort((a, b) => a.t - b.t);
  return {
    points,
    resets,
    emptyAtMs,
    firstEmpty: first
      ? { key: first.key, label: first.label, atMs: first.emptyAtMs ?? nowMs }
      : null,
    accounts: state.map((item) => ({
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
