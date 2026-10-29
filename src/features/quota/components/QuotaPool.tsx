/**
 * Quota pool view, modelled on Theo's pool dashboard: for Claude and Codex, every
 * account's weekly remaining quota added together. The solid line is what the
 * server recorded from real responses; the dashed line projects it ahead at the
 * recent burn rate, with each account's resets added back in.
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
import type { QuotaFileEntry } from '../logic';
import type { QuotaCardState } from '../providers';
import {
  POOL_PROVIDERS,
  accountsFromHistory,
  burnRate,
  isPoolProvider,
  projectPool,
  recordedSeries,
  remainingAt,
  weeklyReadingFromQuota,
  type HistorySample,
  type PoolAccount,
  type PoolPoint,
  type PoolProjection,
  type PoolProvider,
} from '../poolModel';
import styles from './QuotaPool.module.scss';

const BURN_WINDOWS = [1, 3, 6] as const;
type BurnWindow = (typeof BURN_WINDOWS)[number];

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

const startOfLocalDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const formatPercent = (value: number) => `${Math.round(value)}%`;

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
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  resolvedTheme: ResolvedTheme;
  /** Changes when the page's "Refresh all" runs, to reload the history. */
  refreshKey: number;
}

interface PoolData {
  provider: PoolProvider;
  accounts: PoolAccount[];
  notLoaded: number;
}

export function QuotaPool({ entries, quotaFor, resolvedTheme, refreshKey }: QuotaPoolProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const now = useNow();
  const [burnHours, setBurnHours] = useState<BurnWindow>(3);
  const [offset, setOffset] = useState(0);

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

  const pools = useMemo<PoolData[]>(() => {
    const result: PoolData[] = [];
    for (const provider of POOL_PROVIDERS) {
      const providerEntries = entries.filter(
        (entry) => entry.type === provider && !entry.file.disabled
      );
      if (providerEntries.length === 0) continue;
      const recorded = accountsFromHistory(provider, history.samples);
      const accounts: PoolAccount[] = [];
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
        accounts.push({ key, label: getQuotaDisplayName(entry.file), readings });
      }
      result.push({ provider, accounts, notLoaded });
    }
    return result;
  }, [entries, history.samples, quotaFor, now]);

  const unsupported = useMemo(() => {
    const types = new Set(
      entries.filter((entry) => !isPoolProvider(entry.type)).map((entry) => entry.type)
    );
    return [...types].map((type) => getTypeLabel(t, type));
  }, [entries, t]);

  return (
    <div className={styles.view}>
      <div className={styles.controls}>
        <div className={styles.control}>
          <span className={styles.controlLabel} id="quota-pool-burn-label">
            {t('quota_management.pool_burn_label')}
          </span>
          <div className={styles.segmented} role="group" aria-labelledby="quota-pool-burn-label">
            {BURN_WINDOWS.map((hours) => (
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

interface PoolCardProps {
  pool: PoolData;
  now: number;
  rangeStart: number;
  rangeEnd: number;
  burnHours: BurnWindow;
  resolvedTheme: ResolvedTheme;
  formats: Formats;
}

function PoolCard({
  pool,
  now,
  rangeStart,
  rangeEnd,
  burnHours,
  resolvedTheme,
  formats,
}: PoolCardProps) {
  const { t } = useTranslation();
  const { provider, accounts } = pool;
  const color = LINE_COLORS[provider][resolvedTheme];
  const max = accounts.length * 100;
  const headingId = `quota-pool-${provider}`;
  const iconSrc = getAuthFileIcon(provider, resolvedTheme);

  const model = useMemo(() => {
    const current = accounts.reduce((sum, account) => sum + (remainingAt(account, now) ?? 0), 0);
    const burn = burnRate(accounts, now, burnHours);
    const projection = projectPool(
      accounts,
      now,
      Math.max(now, rangeEnd),
      burn ?? 0,
      PROJECTION_STEP_MS
    );
    const recorded = recordedSeries(
      accounts,
      rangeStart,
      Math.min(now, rangeEnd),
      RECORDED_STEP_MS
    );
    const firstReading = Math.min(
      ...accounts.flatMap((account) => account.readings.map((reading) => reading.atMs))
    );
    return { current, burn, projection, recorded, firstReading };
  }, [accounts, now, burnHours, rangeStart, rangeEnd]);

  const { current, burn, projection, recorded, firstReading } = model;
  const endLabel = formats.date(rangeEnd - 1);
  const nextReset = projection.resets[0];
  const firstEmpty = projection.firstEmpty;

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
            {getTypeLabel(t, provider)}
          </h2>
          <span className={styles.count}>
            {t('quota_management.pool_accounts', { count: accounts.length })}
          </span>
        </div>

        <div className={styles.hero}>
          <span className={styles.heroValue}>
            {accounts.length ? formatPercent(current) : '--'}
          </span>
          <span className={styles.heroOf}>
            {t('quota_management.pool_of', { max: formatPercent(max) })}
          </span>
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
          <div>
            <dt>{t('quota_management.pool_burn_stat_label', { hours: burnHours })}</dt>
            <dd>
              {burn === null
                ? t('quota_management.pool_burn_unknown')
                : t('quota_management.pool_burn_value', { value: burn.toFixed(1) })}
            </dd>
          </div>
        </dl>
      </header>

      {accounts.length > 0 && (
        <PoolChart
          recorded={recorded}
          projection={projection}
          startMs={rangeStart}
          endMs={rangeEnd}
          nowMs={now}
          max={max}
          formats={formats}
          label={t('quota_management.pool_chart_label', {
            provider: getTypeLabel(t, provider),
            value: formatPercent(current),
            max: formatPercent(max),
          })}
        />
      )}

      <footer className={styles.foot}>
        <span className={styles.legend}>
          <span className={styles.keyRecorded} aria-hidden="true" />
          {t('quota_management.pool_recorded')}
          <span className={styles.keyProjected} aria-hidden="true" />
          {t('quota_management.pool_projected')}
        </span>
        <span className={styles.note}>
          {Number.isFinite(firstReading) && firstReading > rangeStart
            ? t('quota_management.pool_recorded_since', { when: formats.when(firstReading) }) +
              ' · '
            : ''}
          {t('quota_management.pool_assumption', { hours: burnHours })}
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
                <th scope="col">{t('quota_management.pool_table_reset')}</th>
                <th scope="col">{t('quota_management.pool_table_runs_out')}</th>
              </tr>
            </thead>
            <tbody>
              {projection.accounts.map((account) => (
                <tr key={account.key}>
                  <th scope="row" title={account.label}>
                    {account.label}
                  </th>
                  <td>{formatPercent(account.remainingNow)}</td>
                  <td>{account.nextResetMs === null ? '--' : formats.when(account.nextResetMs)}</td>
                  <td>
                    {account.emptyAtMs === null
                      ? t('quota_management.pool_not_by', { date: endLabel })
                      : formats.when(account.emptyAtMs)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}

interface PoolChartProps {
  recorded: PoolPoint[];
  projection: PoolProjection;
  startMs: number;
  endMs: number;
  nowMs: number;
  max: number;
  formats: Formats;
  label: string;
}

const CHART_HEIGHT = 240;
const MARGIN = { top: 24, right: 14, bottom: 26, left: 46 };
const MIN_LABEL_GAP_PX = 34;
const MIN_DAY_LABEL_GAP_PX = 56;

/** Pool jumps worth a "+N%" label: resets that add at least 5 points. */
function jumpsOf(points: PoolPoint[]): { t: number; top: number; gain: number }[] {
  const jumps: { t: number; top: number; gain: number }[] = [];
  for (let i = 1; i < points.length; i++) {
    const gain = points[i].pool - points[i - 1].pool;
    if (gain >= 5) jumps.push({ t: points[i].t, top: points[i].pool, gain });
  }
  return jumps;
}

function PoolChart({
  recorded,
  projection,
  startMs,
  endMs,
  nowMs,
  max,
  formats,
  label,
}: PoolChartProps) {
  const { t } = useTranslation();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<{ t: number; value: number; projected: boolean } | null>(null);

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
    MARGIN.top + plotH - (Math.max(0, Math.min(max, value)) / Math.max(1, max)) * plotH;
  const baseline = y(0);

  const inRange = (points: PoolPoint[]) =>
    points.filter((point) => point.t >= startMs && point.t <= endMs);
  const recordedPts = inRange(recorded);
  const projectedPts = inRange(projection.points.filter((point) => point.t >= nowMs));

  const linePath = (points: PoolPoint[]) =>
    points
      .map((point, i) => `${i ? 'L' : 'M'}${x(point.t).toFixed(1)},${y(point.pool).toFixed(1)}`)
      .join('');
  const areaPath = (points: PoolPoint[]) =>
    points.length < 2
      ? ''
      : `${linePath(points)}L${x(points[points.length - 1].t).toFixed(1)},${baseline.toFixed(1)}` +
        `L${x(points[0].t).toFixed(1)},${baseline.toFixed(1)}Z`;

  const nowVisible = nowMs >= startMs && nowMs <= endMs;
  const currentValue = projection.points[0]?.pool ?? 0;

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
  const projectedJumps = jumpsOf(projectedPts).filter((jump) => jump.t > nowMs);
  for (const jump of [...jumpsOf(recordedPts), ...projectedJumps]) {
    const px = x(jump.t);
    if (jumpLabels.some((item) => Math.abs(item.x - px) < MIN_LABEL_GAP_PX)) continue;
    jumpLabels.push({ x: px, y: y(jump.top) - 7, text: `+${Math.round(jump.gain)}%` });
  }

  const empty = projection.emptyAtMs;
  const emptyVisible = empty !== null && empty > nowMs && empty <= endMs;

  const onPointerMove = (event: ReactPointerEvent<SVGRectElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
    const ms = startMs + ratio * span;
    const projected = ms > nowMs;
    const source = projected ? projectedPts : recordedPts;
    if (source.length === 0) {
      setHover(null);
      return;
    }
    let nearest = source[0];
    for (const point of source) {
      if (Math.abs(point.t - ms) < Math.abs(nearest.t - ms)) nearest = point;
    }
    setHover({ t: nearest.t, value: nearest.pool, projected });
  };

  const tooltipLeft = hover ? Math.min(Math.max(x(hover.t), 70), width - 70) : 0;

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
              {formatPercent(value)}
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

        <path className={styles.areaRecorded} d={areaPath(recordedPts)} />
        <path className={styles.areaProjected} d={areaPath(projectedPts)} />
        <path className={styles.lineRecorded} d={linePath(recordedPts)} />
        <path className={styles.lineProjected} d={linePath(projectedPts)} />

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
            <circle className={styles.dot} cx={x(nowMs)} cy={y(currentValue)} r={4} />
          </g>
        )}

        {emptyVisible && empty !== null && (
          <g>
            <circle className={styles.emptyDot} cx={x(empty)} cy={baseline} r={5} />
            <text
              className={styles.emptyText}
              x={x(empty)}
              y={baseline - 12}
              textAnchor={x(empty) > width - 120 ? 'end' : 'middle'}
            >
              {t('quota_management.pool_empty_at', { when: formats.when(empty) })}
            </text>
          </g>
        )}

        {hover && (
          <line
            className={styles.crosshair}
            x1={x(hover.t)}
            x2={x(hover.t)}
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
        <div className={styles.tooltip} style={{ left: tooltipLeft }} role="presentation">
          <strong>{formatPercent(hover.value)}</strong>
          <span>
            {hover.projected
              ? t('quota_management.pool_projected')
              : t('quota_management.pool_recorded')}{' '}
            · {formats.when(hover.t)}
          </span>
        </div>
      )}
    </div>
  );
}
