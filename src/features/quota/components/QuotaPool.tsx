/**
 * Quota pool view, modelled on Theo's pool dashboard: for Claude and Codex, every
 * account's weekly remaining quota added together. The solid line is what the
 * server recorded from real responses; the dashed line projects it ahead at the
 * recent burn rate, with each account's resets added back in.
 *
 * "Drain rate" shows the same pool as speed (percentage points used per hour),
 * and "Accounts" splits either chart into one stacked band per account.
 *
 * All maths lives in poolModel.ts; this file fetches history and draws.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { quotaHistoryApi } from '@/services/api';
import { useNow } from '@/hooks/useNow';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import { formatRelativeInstant } from '@/utils/quota';
import { getQuotaDisplayName } from '@/utils/quota/identity';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@/utils/time/durations';
import type { ClaudeQuotaState, CodexQuotaState, ResolvedTheme } from '@/types';
import {
  QUOTA_POOL_BURN_HOURS,
  QUOTA_POOL_MODES,
  type QuotaPoolBurnHours,
  type QuotaPoolMode,
} from '../constants';
import type { QuotaFileEntry } from '../logic';
import type { QuotaCardState } from '../providers';
import { readQuotaPoolPrefs, writeQuotaPoolPrefs } from '../uiState';
import {
  POOL_PROVIDERS,
  accountsFromHistory,
  drainSeries,
  firstReadingMs,
  isPoolProvider,
  projectPool,
  recordedSeries,
  remainingAt,
  weeklyReadingFromQuota,
  type HistorySample,
  type PoolAccount,
  type PoolProvider,
} from '../poolModel';
import styles from './QuotaPool.module.scss';

/** The visible range: 3 days back and 11 ahead, moved a week at a time. */
const RANGE_BEFORE_MS = 3 * DAY_MS;
const RANGE_MS = 14 * DAY_MS;
/** Readings before the range still decide where its line starts. */
const HISTORY_LOOKBACK_MS = 8 * DAY_MS;
const HISTORY_REFRESH_MS = 5 * MINUTE_MS;
const PROJECTION_STEP_MS = 10 * MINUTE_MS;
const RECORDED_STEP_MS = 20 * MINUTE_MS;

/** Line colours, validated against both chart surfaces (dataviz palette check). */
const LINE_COLORS: Record<PoolProvider, Record<ResolvedTheme, string>> = {
  claude: { light: '#c05621', dark: '#d9773f' },
  codex: { light: '#3538d4', dark: '#7b83f5' },
};

/**
 * Account band colours in a fixed order (the dataviz reference categorical
 * palette), validated as stacked neighbours on the light, white and dark card
 * surfaces. Light slots 2-5 sit under 3:1 contrast, so bands carry direct
 * labels and the account table lists every value.
 */
const ACCOUNT_COLORS: Record<ResolvedTheme, readonly string[]> = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
};
/** Accounts past the eighth share one neutral band instead of a ninth hue. */
const OTHER_COLOR = '#898781';
/** Bands are named on the chart itself only while there are this few. */
const MAX_DIRECT_LABELS = 4;

const startOfLocalDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const formatPercent = (value: number) => `${Math.round(value)}%`;
/** Axis ticks: whole numbers from 10 up, one decimal below, no trailing ".0". */
const formatRateTick = (value: number) =>
  value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');

/** The smallest 1, 2, 3, 4, 5, 6 or 8 × a power of ten at or above `value`; its half reads cleanly. */
const niceCeil = (value: number) => {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 3, 4, 5, 6, 8, 10])
    if (step * power >= value - 1e-9) return step * power;
  return 10 * power;
};

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

interface HistoryState {
  samples: HistorySample[];
  /** null until the first answer; false when the server has no quota history. */
  enabled: boolean | null;
  error: string;
}

function useQuotaHistory(sinceMs: number, untilMs: number, refreshKey: number): HistoryState {
  const [state, setState] = useState<HistoryState>({ samples: [], enabled: null, error: '' });
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await quotaHistoryApi.list({ sinceMs, untilMs });
        if (cancelled) return;
        setState({
          samples: Array.isArray(response?.samples) ? response.samples : [],
          enabled: response?.enabled !== false,
          error: '',
        });
      } catch (err: unknown) {
        if (cancelled) return;
        const status = (err as { status?: number })?.status;
        if (status === 404) {
          setState({ samples: [], enabled: false, error: '' });
          return;
        }
        setState((prev) => ({
          ...prev,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), HISTORY_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sinceMs, untilMs, refreshKey]);
  return state;
}

export interface QuotaPoolProps {
  /** The page's filtered credentials (provider tab and search apply here too). */
  entries: QuotaFileEntry[];
  /**
   * Every credential, unfiltered. Account colours follow this list, so a search
   * that hides some accounts never repaints the others.
   */
  allEntries: QuotaFileEntry[];
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  resolvedTheme: ResolvedTheme;
  /** Changes when the page's "Refresh all" runs, to reload the history. */
  refreshKey: number;
}

interface PoolData {
  provider: PoolProvider;
  /** Ordered by colour slot, which is also the stacking order (first at the bottom). */
  accounts: PoolAccount[];
  /** Each account's colour slot: its place among all of the provider's credentials. */
  slots: number[];
  notLoaded: number;
}

export function QuotaPool({
  entries,
  allEntries,
  quotaFor,
  resolvedTheme,
  refreshKey,
}: QuotaPoolProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const now = useNow();
  const [saved] = useState(readQuotaPoolPrefs);
  const [burnHours, setBurnHours] = useState<QuotaPoolBurnHours>(saved.burnHours ?? 3);
  const [mode, setMode] = useState<QuotaPoolMode>(saved.mode ?? 'remaining');
  const [showAccounts, setShowAccounts] = useState(saved.accounts ?? false);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    writeQuotaPoolPrefs({ mode, accounts: showAccounts, burnHours });
  }, [mode, showAccounts, burnHours]);

  // Anchored to the start of today so the range (and the history request) only
  // moves once a day, not with every clock tick.
  const today = startOfLocalDay(now);
  const rangeStart = today - RANGE_BEFORE_MS + offset * 7 * DAY_MS;
  const rangeEnd = rangeStart + RANGE_MS;
  const history = useQuotaHistory(rangeStart - HISTORY_LOOKBACK_MS, rangeEnd, refreshKey);

  const formats = useMemo(() => {
    const when = new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
    // Weekday first ("Mon 26"), as the axis reads left to right in days.
    const weekday = new Intl.DateTimeFormat(locale, { weekday: 'short' });
    const dayOfMonth = new Intl.DateTimeFormat(locale, { day: 'numeric' });
    const date = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' });
    return {
      when: (ms: number) => when.format(ms),
      day: (ms: number) => `${weekday.format(ms)} ${dayOfMonth.format(ms)}`,
      date: (ms: number) => date.format(ms),
      relative: (ms: number) => formatRelativeInstant(ms, now, locale),
    };
  }, [locale, now]);

  const colorSlots = useMemo(() => {
    const slots = new Map<string, number>();
    for (const provider of POOL_PROVIDERS) {
      allEntries
        .filter((entry) => entry.type === provider)
        .map((entry) => entry.file.name)
        .sort()
        .forEach((name, index) => slots.set(`${provider}/${name}`, index));
    }
    return slots;
  }, [allEntries]);

  const pools = useMemo<PoolData[]>(() => {
    const result: PoolData[] = [];
    for (const provider of POOL_PROVIDERS) {
      const providerEntries = entries.filter(
        (entry) => entry.type === provider && !entry.file.disabled
      );
      if (providerEntries.length === 0) continue;
      const recorded = accountsFromHistory(provider, history.samples);
      const found: { account: PoolAccount; slot: number }[] = [];
      let notLoaded = 0;
      for (const entry of providerEntries) {
        const key = entry.file.name;
        let readings = recorded.get(key) ?? [];
        // An account with no recorded traffic can still count once the panel has
        // loaded its quota. Recorded readings win otherwise: they are timestamped.
        if (readings.length === 0) {
          const live = weeklyReadingFromQuota(
            provider,
            quotaFor(entry) as ClaudeQuotaState | CodexQuotaState | undefined,
            now
          );
          if (live) readings = [live];
        }
        if (readings.length === 0) {
          notLoaded += 1;
          continue;
        }
        found.push({
          account: { key, label: getQuotaDisplayName(entry.file), readings },
          slot: colorSlots.get(`${provider}/${key}`) ?? Number.MAX_SAFE_INTEGER,
        });
      }
      found.sort((a, b) => a.slot - b.slot);
      result.push({
        provider,
        accounts: found.map((item) => item.account),
        slots: found.map((item) => item.slot),
        notLoaded,
      });
    }
    return result;
  }, [entries, history.samples, quotaFor, now, colorSlots]);

  const unsupported = useMemo(() => {
    const types = new Set(
      entries.filter((entry) => !isPoolProvider(entry.type)).map((entry) => entry.type)
    );
    return [...types].map((type) => getTypeLabel(t, type));
  }, [entries, t]);

  return (
    <div className={styles.view}>
      <div className={styles.controls}>
        <div className={styles.controlGroup}>
          <div
            className={styles.segmented}
            role="group"
            aria-label={t('quota_management.pool_mode_label')}
          >
            {QUOTA_POOL_MODES.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
              >
                {t(`quota_management.pool_mode_${value}`)}
              </button>
            ))}
          </div>
          <div className={styles.control}>
            <span className={styles.controlLabel} id="quota-pool-burn-label">
              {t('quota_management.pool_burn_label')}
            </span>
            <div className={styles.segmented} role="group" aria-labelledby="quota-pool-burn-label">
              {QUOTA_POOL_BURN_HOURS.map((hours) => (
                <button
                  key={hours}
                  type="button"
                  aria-pressed={burnHours === hours}
                  onClick={() => setBurnHours(hours)}
                >
                  {t('quota_management.pool_hours', { hours })}
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            className={styles.toggle}
            aria-pressed={showAccounts}
            onClick={() => setShowAccounts((value) => !value)}
            title={t('quota_management.pool_accounts_toggle_hint')}
          >
            {t('quota_management.pool_accounts_toggle')}
          </button>
        </div>
        <div className={styles.rangeNav}>
          <span className={styles.rangeLabel}>
            {t('quota_management.pool_range', {
              from: formats.date(rangeStart),
              to: formats.date(rangeEnd - 1),
            })}
          </span>
          <button
            type="button"
            className={styles.navButton}
            onClick={() => setOffset((value) => value - 1)}
            aria-label={t('quota_management.pool_prev_week')}
          >
            ‹
          </button>
          <button
            type="button"
            className={styles.navButton}
            onClick={() => setOffset(0)}
            disabled={offset === 0}
          >
            {t('quota_management.pool_today')}
          </button>
          <button
            type="button"
            className={styles.navButton}
            onClick={() => setOffset((value) => value + 1)}
            aria-label={t('quota_management.pool_next_week')}
          >
            ›
          </button>
        </div>
      </div>

      {history.enabled === false && (
        <div className={styles.notice} role="status">
          {t('quota_management.pool_history_off')}
        </div>
      )}
      {history.error && (
        <div className={styles.notice} role="alert">
          {t('quota_management.pool_history_error', { message: history.error })}
        </div>
      )}

      {pools.length === 0 ? (
        <div className={styles.notice}>{t('quota_management.pool_none')}</div>
      ) : (
        pools.map((pool) => (
          <PoolCard
            key={pool.provider}
            pool={pool}
            now={now}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            burnHours={burnHours}
            mode={mode}
            showAccounts={showAccounts}
            resolvedTheme={resolvedTheme}
            formats={formats}
          />
        ))
      )}

      {unsupported.length > 0 && (
        <p className={styles.footnote}>
          {t('quota_management.pool_unsupported', { providers: unsupported.join(', ') })}
        </p>
      )}
    </div>
  );
}

type Formats = {
  when: (ms: number) => string;
  day: (ms: number) => string;
  date: (ms: number) => string;
  relative: (ms: number) => string;
};

/** One stacked account band: a colour and the accounts (by index) it adds up. */
interface Band {
  key: string;
  label: string;
  color: string;
  members: number[];
}

/** A chart point in either mode; `value` null leaves a gap in the line. */
interface ChartPoint {
  t: number;
  value: number | null;
  parts: number[];
}

interface PoolCardProps {
  pool: PoolData;
  now: number;
  rangeStart: number;
  rangeEnd: number;
  burnHours: QuotaPoolBurnHours;
  mode: QuotaPoolMode;
  showAccounts: boolean;
  resolvedTheme: ResolvedTheme;
  formats: Formats;
}

function PoolCard({
  pool,
  now,
  rangeStart,
  rangeEnd,
  burnHours,
  mode,
  showAccounts,
  resolvedTheme,
  formats,
}: PoolCardProps) {
  const { t } = useTranslation();
  const { provider, accounts, slots } = pool;
  const color = LINE_COLORS[provider][resolvedTheme];
  const capacity = accounts.length * 100;
  const headingId = `quota-pool-${provider}`;
  const iconSrc = getAuthFileIcon(provider, resolvedTheme);
  const providerLabel = getTypeLabel(t, provider);

  const model = useMemo(() => {
    const current = sum(accounts.map((account) => remainingAt(account, now) ?? 0));
    const burnNow = drainSeries(accounts, now, now, HOUR_MS, burnHours)[0] ?? null;
    const burn = burnNow?.rate ?? null;
    const projection = projectPool(
      accounts,
      now,
      Math.max(now, rangeEnd),
      burn ?? 0,
      PROJECTION_STEP_MS
    );
    const firstReading = firstReadingMs(accounts);
    const recordedEnd = Math.min(now, rangeEnd);
    let recorded: ChartPoint[];
    let projected: ChartPoint[];
    if (mode === 'drain') {
      recorded =
        firstReading === null
          ? []
          : drainSeries(
              accounts,
              Math.max(rangeStart, firstReading),
              recordedEnd,
              RECORDED_STEP_MS,
              burnHours
            ).map((point) => ({ t: point.t, value: point.rate, parts: point.parts }));
      projected = projection.drain.map((point) => ({
        t: point.t,
        value: point.rate,
        parts: point.parts,
      }));
    } else {
      recorded = recordedSeries(accounts, rangeStart, recordedEnd, RECORDED_STEP_MS).map(
        (point) => ({ t: point.t, value: point.pool, parts: point.parts })
      );
      projected = projection.points
        .filter((point) => point.t >= now)
        .map((point) => ({ t: point.t, value: point.pool, parts: point.parts }));
    }
    const burnByAccount = new Map(
      accounts.map((account, index) => [
        account.key,
        burnNow?.rate == null ? null : burnNow.parts[index],
      ])
    );
    return { current, burn, projection, recorded, projected, firstReading, burnByAccount };
  }, [accounts, now, burnHours, rangeStart, rangeEnd, mode]);

  const { current, burn, projection, recorded, projected, firstReading, burnByAccount } = model;

  const bands = useMemo<Band[] | null>(() => {
    if (!showAccounts || accounts.length === 0) return null;
    const palette = ACCOUNT_COLORS[resolvedTheme];
    const result: Band[] = [];
    const rest: number[] = [];
    accounts.forEach((account, index) => {
      const slot = slots[index];
      if (slot < palette.length) {
        result.push({
          key: account.key,
          label: account.label,
          color: palette[slot],
          members: [index],
        });
      } else rest.push(index);
    });
    if (rest.length) {
      result.push({
        key: 'other',
        label: t('quota_management.pool_other', { count: rest.length }),
        color: OTHER_COLOR,
        members: rest,
      });
    }
    return result;
  }, [showAccounts, accounts, slots, resolvedTheme, t]);

  const colorByKey = useMemo(() => {
    const map = new Map<string, string>();
    bands?.forEach((band) => {
      band.members.forEach((index) => map.set(accounts[index].key, band.color));
    });
    return map;
  }, [bands, accounts]);

  const endLabel = formats.date(rangeEnd - 1);
  const nextReset = projection.resets[0];
  const firstEmpty = projection.firstEmpty;
  const isDrain = mode === 'drain';
  const burnText =
    burn === null
      ? t('quota_management.pool_burn_unknown')
      : t('quota_management.pool_burn_value', { value: burn.toFixed(1) });
  const formatRate = (value: number) =>
    t('quota_management.pool_burn_value', { value: value.toFixed(1) });

  const chartMax = isDrain
    ? niceCeil(
        Math.max(1, ...[...recorded, ...projected].map((point) => (point.value ?? 0) * 1.15))
      )
    : capacity;

  return (
    <section
      className={styles.card}
      aria-labelledby={headingId}
      style={{ '--pool-color': color } as CSSProperties}
    >
      <header className={styles.head}>
        <div className={styles.identity}>
          {iconSrc && (
            <span
              className={styles.icon}
              style={
                isThemeSurfaceIconProvider(provider)
                  ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
                  : undefined
              }
            >
              <img src={iconSrc} alt="" />
            </span>
          )}
          <h2 id={headingId} className={styles.title}>
            {providerLabel}
          </h2>
          <span className={styles.count}>
            {t('quota_management.pool_accounts', { count: accounts.length })}
          </span>
        </div>

        <div className={styles.hero}>
          {isDrain ? (
            <>
              <span className={styles.heroValue}>{burn === null ? '--' : formatRate(burn)}</span>
              <span className={styles.heroOf}>
                {t('quota_management.pool_drain_of', { hours: burnHours })}
              </span>
            </>
          ) : (
            <>
              <span className={styles.heroValue}>
                {accounts.length ? formatPercent(current) : '--'}
              </span>
              <span className={styles.heroOf}>
                {t('quota_management.pool_of', { max: formatPercent(capacity) })}
              </span>
            </>
          )}
        </div>

        <dl className={styles.stats}>
          <div>
            <dt>{t('quota_management.pool_empty_label')}</dt>
            <dd>
              {projection.emptyAtMs === null
                ? t('quota_management.pool_not_by', { date: endLabel })
                : formats.when(projection.emptyAtMs)}
            </dd>
          </div>
          <div>
            <dt>{t('quota_management.pool_first_empty_label')}</dt>
            <dd>
              {firstEmpty ? (
                <>
                  <span className={styles.statName} title={firstEmpty.label}>
                    {firstEmpty.label}
                  </span>{' '}
                  {formats.relative(firstEmpty.atMs)}
                </>
              ) : (
                t('quota_management.pool_not_by', { date: endLabel })
              )}
            </dd>
          </div>
          <div>
            <dt>{t('quota_management.pool_next_reset_label')}</dt>
            <dd>
              {nextReset ? (
                <>
                  <strong>+{formatPercent(nextReset.gain)}</strong> {formats.when(nextReset.t)}
                </>
              ) : (
                t('quota_management.pool_not_by', { date: endLabel })
              )}
            </dd>
          </div>
          {isDrain ? (
            <div>
              <dt>{t('quota_management.pool_remaining_label')}</dt>
              <dd>
                {t('quota_management.pool_remaining_value', {
                  value: formatPercent(current),
                  max: formatPercent(capacity),
                })}
              </dd>
            </div>
          ) : (
            <div>
              <dt>{t('quota_management.pool_burn_stat_label', { hours: burnHours })}</dt>
              <dd>{burnText}</dd>
            </div>
          )}
        </dl>
      </header>

      {accounts.length > 0 && (
        <PoolChart
          recorded={recorded}
          projected={projected}
          startMs={rangeStart}
          endMs={rangeEnd}
          nowMs={now}
          max={chartMax}
          formatValue={isDrain ? formatRate : formatPercent}
          formatTick={isDrain ? (value) => `${formatRateTick(value)}%/h` : formatPercent}
          bands={bands}
          showJumps={!isDrain}
          emptyAtMs={isDrain ? null : projection.emptyAtMs}
          formats={formats}
          label={
            isDrain
              ? t('quota_management.pool_drain_chart_label', {
                  provider: providerLabel,
                  value: burnText,
                  hours: burnHours,
                })
              : t('quota_management.pool_chart_label', {
                  provider: providerLabel,
                  value: formatPercent(current),
                  max: formatPercent(capacity),
                })
          }
        />
      )}

      <footer className={styles.foot}>
        <span className={styles.legend}>
          {bands && <span className={styles.legendTitle}>{t('quota_management.pool_pool')}</span>}
          <span className={styles.keyRecorded} aria-hidden="true" />
          {t('quota_management.pool_recorded')}
          <span className={styles.keyProjected} aria-hidden="true" />
          {t('quota_management.pool_projected')}
        </span>
        {bands && (
          <span className={styles.legendBands}>
            {bands.map((band) => (
              <span key={band.key} className={styles.legendItem} title={band.label}>
                <span
                  className={styles.swatch}
                  style={{ background: band.color }}
                  aria-hidden="true"
                />
                <span className={styles.legendLabel}>{band.label}</span>
              </span>
            ))}
          </span>
        )}
        <span className={styles.note}>
          {firstReading !== null && firstReading > rangeStart
            ? t('quota_management.pool_recorded_since', { when: formats.when(firstReading) }) +
              ' · '
            : ''}
          {isDrain
            ? t('quota_management.pool_drain_assumption', { hours: burnHours })
            : t('quota_management.pool_assumption', { hours: burnHours })}
          {pool.notLoaded > 0 &&
            ' · ' + t('quota_management.pool_not_loaded', { count: pool.notLoaded })}
        </span>
      </footer>

      {accounts.length > 0 && (
        <details className={styles.table}>
          <summary>{t('quota_management.pool_table_toggle')}</summary>
          <table>
            <thead>
              <tr>
                <th scope="col">{t('quota_management.pool_table_account')}</th>
                <th scope="col">{t('quota_management.pool_table_remaining')}</th>
                <th scope="col">{t('quota_management.pool_table_burn', { hours: burnHours })}</th>
                <th scope="col">{t('quota_management.pool_table_reset')}</th>
                <th scope="col">{t('quota_management.pool_table_runs_out')}</th>
              </tr>
            </thead>
            <tbody>
              {projection.accounts.map((account) => {
                const swatch = colorByKey.get(account.key);
                const accountBurn = burnByAccount.get(account.key);
                return (
                  <tr key={account.key}>
                    <th scope="row" title={account.label}>
                      {swatch && (
                        <span
                          className={styles.swatch}
                          style={{ background: swatch }}
                          aria-hidden="true"
                        />
                      )}
                      {account.label}
                    </th>
                    <td>{formatPercent(account.remainingNow)}</td>
                    <td>{accountBurn == null ? '--' : formatRate(accountBurn)}</td>
                    <td>
                      {account.nextResetMs === null ? '--' : formats.when(account.nextResetMs)}
                    </td>
                    <td>
                      {account.emptyAtMs === null
                        ? t('quota_management.pool_not_by', { date: endLabel })
                        : formats.when(account.emptyAtMs)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}

interface PoolChartProps {
  recorded: ChartPoint[];
  projected: ChartPoint[];
  startMs: number;
  endMs: number;
  nowMs: number;
  max: number;
  formatValue: (value: number) => string;
  formatTick: (value: number) => string;
  /** Stack one band per account under the line, or null for the line alone. */
  bands: Band[] | null;
  /** Label resets with "+N%" (the remaining chart only). */
  showJumps: boolean;
  /** Mark when the pool runs out, or null for no marker. */
  emptyAtMs: number | null;
  formats: Formats;
  label: string;
}

const CHART_HEIGHT = 240;
const MARGIN = { top: 24, right: 14, bottom: 26, left: 52 };
const MIN_LABEL_GAP_PX = 34;
const MIN_DAY_LABEL_GAP_PX = 56;
/** A band gets its name on the chart only when it is at least this tall. */
const MIN_BAND_LABEL_PX = 15;
const BAND_LABEL_CHARS = 22;

/** Pool jumps worth a "+N%" label: resets that add at least 5 points. */
function jumpsOf(points: ChartPoint[]): { t: number; top: number; gain: number }[] {
  const jumps: { t: number; top: number; gain: number }[] = [];
  for (let i = 1; i < points.length; i++) {
    const before = points[i - 1].value;
    const after = points[i].value;
    if (before === null || after === null) continue;
    if (after - before >= 5) jumps.push({ t: points[i].t, top: after, gain: after - before });
  }
  return jumps;
}

/** Runs of points with a value; a null value ends a run. */
function segmentsOf(points: ChartPoint[]): ChartPoint[][] {
  const segments: ChartPoint[][] = [];
  let current: ChartPoint[] = [];
  for (const point of points) {
    if (point.value === null) {
      if (current.length) segments.push(current);
      current = [];
    } else current.push(point);
  }
  if (current.length) segments.push(current);
  return segments;
}

const bandValue = (point: ChartPoint, band: Band) =>
  band.members.reduce((total, index) => total + (point.parts[index] ?? 0), 0);

/** For each point, the running total up to and including each band. */
const stackOf = (point: ChartPoint, bands: Band[]) => {
  let total = 0;
  return bands.map((band) => (total += bandValue(point, band)));
};

const shorten = (text: string) =>
  text.length > BAND_LABEL_CHARS ? `${text.slice(0, BAND_LABEL_CHARS - 1)}…` : text;

function PoolChart({
  recorded,
  projected,
  startMs,
  endMs,
  nowMs,
  max,
  formatValue,
  formatTick,
  bands,
  showJumps,
  emptyAtMs,
  formats,
  label,
}: PoolChartProps) {
  const { t } = useTranslation();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<{ point: ChartPoint; projected: boolean } | null>(null);

  useEffect(() => {
    const element = wrapRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.max(280, Math.round(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;
  const span = endMs - startMs;
  const x = (ms: number) => MARGIN.left + ((ms - startMs) / span) * plotW;
  const y = (value: number) =>
    MARGIN.top + plotH - (Math.max(0, Math.min(max, value)) / Math.max(1e-9, max)) * plotH;
  const baseline = y(0);

  const inRange = (points: ChartPoint[]) =>
    points.filter((point) => point.t >= startMs && point.t <= endMs);
  const recordedPts = inRange(recorded);
  const projectedPts = inRange(projected.filter((point) => point.t >= nowMs));
  const recordedRuns = segmentsOf(recordedPts);
  const projectedRuns = segmentsOf(projectedPts);

  const coords = (points: ChartPoint[], valueOf: (point: ChartPoint) => number) =>
    points.map((point) => `${x(point.t).toFixed(1)},${y(valueOf(point)).toFixed(1)}`);
  const valueOf = (point: ChartPoint) => point.value ?? 0;
  const linePath = (runs: ChartPoint[][]) =>
    runs.map((run) => `M${coords(run, valueOf).join('L')}`).join('');
  const areaPath = (runs: ChartPoint[][]) =>
    runs
      .filter((run) => run.length >= 2)
      .map(
        (run) =>
          `M${coords(run, valueOf).join('L')}` +
          `L${x(run[run.length - 1].t).toFixed(1)},${baseline.toFixed(1)}` +
          `L${x(run[0].t).toFixed(1)},${baseline.toFixed(1)}Z`
      )
      .join('');
  /** One closed shape per band: along its top, then back along the band below. */
  const bandPaths = (runs: ChartPoint[][]) => {
    if (!bands) return [];
    const paths = bands.map(() => '');
    for (const run of runs) {
      if (run.length < 2) continue;
      const xs = run.map((point) => x(point.t).toFixed(1));
      const stacks = run.map((point) => stackOf(point, bands));
      paths.forEach((_, b) => {
        const top = run.map((_point, i) => `${xs[i]},${y(stacks[i][b]).toFixed(1)}`);
        const bottom = run
          .map((_point, i) => `${xs[i]},${y(b ? stacks[i][b - 1] : 0).toFixed(1)}`)
          .reverse();
        paths[b] += `M${top.join('L')}L${bottom.join('L')}Z`;
      });
    }
    return paths;
  };
  const recordedBands = bandPaths(recordedRuns);
  const projectedBands = bandPaths(projectedRuns);

  const nowVisible = nowMs >= startMs && nowMs <= endMs;
  const nowPoint = projectedPts[0] ?? recordedPts[recordedPts.length - 1];
  const currentValue = nowPoint?.value ?? null;

  // Day labels at midday, thinned so they never collide.
  const dayLabels: { ms: number; x: number }[] = [];
  for (let day = startOfLocalDay(startMs); day < endMs; day += DAY_MS) {
    const mid = startOfLocalDay(day) + 12 * HOUR_MS;
    if (mid < startMs || mid > endMs) continue;
    const px = x(mid);
    if (dayLabels.length && px - dayLabels[dayLabels.length - 1].x < MIN_DAY_LABEL_GAP_PX) continue;
    dayLabels.push({ ms: mid, x: px });
  }

  // "+N%" labels on resets, recorded and projected, skipping crowded ones.
  const jumpLabels: { x: number; y: number; text: string }[] = [];
  if (showJumps) {
    const projectedJumps = jumpsOf(projectedPts).filter((jump) => jump.t > nowMs);
    for (const jump of [...jumpsOf(recordedPts), ...projectedJumps]) {
      const px = x(jump.t);
      if (jumpLabels.some((item) => Math.abs(item.x - px) < MIN_LABEL_GAP_PX)) continue;
      jumpLabels.push({ x: px, y: y(jump.top) - 7, text: `+${Math.round(jump.gain)}%` });
    }
  }

  // Band names at the right edge, inside bands tall enough to hold them.
  const bandLabels: { key: string; y: number; text: string }[] = [];
  const lastPoint = [...recordedPts, ...projectedPts].filter((point) => point.value !== null).pop();
  if (bands && bands.length <= MAX_DIRECT_LABELS && lastPoint) {
    const stack = stackOf(lastPoint, bands);
    bands.forEach((band, b) => {
      const top = y(stack[b]);
      const bottom = y(b ? stack[b - 1] : 0);
      if (bottom - top < MIN_BAND_LABEL_PX) return;
      const mid = (top + bottom) / 2 + 4;
      if (bandLabels.some((item) => Math.abs(item.y - mid) < 13)) return;
      bandLabels.push({ key: band.key, y: mid, text: shorten(band.label) });
    });
  }

  const emptyVisible = emptyAtMs !== null && emptyAtMs > nowMs && emptyAtMs <= endMs;

  const onPointerMove = (event: ReactPointerEvent<SVGRectElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
    const ms = startMs + ratio * span;
    const isProjected = ms > nowMs;
    const source = (isProjected ? projectedPts : recordedPts).filter(
      (point) => point.value !== null
    );
    if (source.length === 0) {
      setHover(null);
      return;
    }
    let nearest = source[0];
    for (const point of source) {
      if (Math.abs(point.t - ms) < Math.abs(nearest.t - ms)) nearest = point;
    }
    setHover({ point: nearest, projected: isProjected });
  };

  const hoverX = hover ? x(hover.point.t) : 0;
  // The tooltip sits beside the crosshair, on whichever side has room.
  const tooltipStyle: CSSProperties = hover
    ? hoverX > width / 2
      ? { right: width - hoverX + 10 }
      : { left: hoverX + 10 }
    : {};

  return (
    <div className={styles.chart} ref={wrapRef}>
      <svg
        width={width}
        height={CHART_HEIGHT}
        viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
        role="img"
        aria-label={label}
      >
        {[0, max / 2, max].map((value) => (
          <g key={value}>
            <line
              className={styles.grid}
              x1={MARGIN.left}
              x2={width - MARGIN.right}
              y1={y(value)}
              y2={y(value)}
            />
            <text className={styles.axisText} x={MARGIN.left - 8} y={y(value) + 4} textAnchor="end">
              {formatTick(value)}
            </text>
          </g>
        ))}
        {dayLabels.map((day) => (
          <text
            key={day.ms}
            className={styles.axisText}
            x={day.x}
            y={CHART_HEIGHT - 8}
            textAnchor="middle"
          >
            {formats.day(day.ms)}
          </text>
        ))}

        {bands ? (
          <g>
            {bands.map((band, b) => (
              <g key={band.key} style={{ '--band-color': band.color } as CSSProperties}>
                <path className={styles.bandRecorded} d={recordedBands[b]} />
                <path className={styles.bandProjected} d={projectedBands[b]} />
              </g>
            ))}
          </g>
        ) : (
          <g>
            <path className={styles.areaRecorded} d={areaPath(recordedRuns)} />
            <path className={styles.areaProjected} d={areaPath(projectedRuns)} />
          </g>
        )}
        {bands && (
          <g>
            <path className={styles.lineHalo} d={linePath(recordedRuns)} />
            <path className={styles.lineHalo} d={linePath(projectedRuns)} />
          </g>
        )}
        <path className={styles.lineRecorded} d={linePath(recordedRuns)} />
        <path className={styles.lineProjected} d={linePath(projectedRuns)} />

        {bandLabels.map((item) => (
          <text
            key={item.key}
            className={styles.bandText}
            x={width - MARGIN.right - 6}
            y={item.y}
            textAnchor="end"
          >
            {item.text}
          </text>
        ))}

        {jumpLabels.map((item) => (
          <text
            key={`${item.x}-${item.text}`}
            className={styles.jumpText}
            x={item.x}
            y={Math.max(11, item.y)}
            textAnchor="middle"
          >
            {item.text}
          </text>
        ))}

        {nowVisible && (
          <g>
            <line
              className={styles.nowLine}
              x1={x(nowMs)}
              x2={x(nowMs)}
              y1={MARGIN.top - 6}
              y2={baseline}
            />
            <text className={styles.axisText} x={x(nowMs)} y={MARGIN.top - 10} textAnchor="middle">
              {t('quota_management.pool_now')}
            </text>
            {currentValue !== null && (
              <circle className={styles.dot} cx={x(nowMs)} cy={y(currentValue)} r={4} />
            )}
          </g>
        )}

        {emptyVisible && emptyAtMs !== null && (
          <g>
            <circle className={styles.emptyDot} cx={x(emptyAtMs)} cy={baseline} r={5} />
            <text
              className={styles.emptyText}
              x={x(emptyAtMs)}
              y={baseline - 12}
              textAnchor={x(emptyAtMs) > width - 120 ? 'end' : 'middle'}
            >
              {t('quota_management.pool_empty_at', { when: formats.when(emptyAtMs) })}
            </text>
          </g>
        )}

        {hover && (
          <line
            className={styles.crosshair}
            x1={hoverX}
            x2={hoverX}
            y1={MARGIN.top}
            y2={baseline}
          />
        )}
        <rect
          className={styles.hit}
          x={MARGIN.left}
          y={MARGIN.top}
          width={plotW}
          height={plotH}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHover(null)}
        />
      </svg>
      {hover && (
        <div className={styles.tooltip} style={tooltipStyle} role="presentation">
          <strong>{formatValue(hover.point.value ?? 0)}</strong>
          <span>
            {hover.projected
              ? t('quota_management.pool_projected')
              : t('quota_management.pool_recorded')}{' '}
            · {formats.when(hover.point.t)}
          </span>
          {bands && (
            <ul className={styles.tooltipBands}>
              {[...bands].reverse().map((band) => (
                <li key={band.key}>
                  <span
                    className={styles.swatch}
                    style={{ background: band.color }}
                    aria-hidden="true"
                  />
                  <span className={styles.tooltipLabel}>{band.label}</span>
                  <span className={styles.tooltipValue}>
                    {formatValue(bandValue(hover.point, band))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
