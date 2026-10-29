import type { QuotaProviderType } from './providers/types';

/** tab 顺序 = 旧页五分区的纵向顺序，'全部' tab 下卡片也按此分组排列。 */
export const QUOTA_TAB_ORDER: readonly QuotaProviderType[] = [
  'claude',
  'antigravity',
  'codex',
  'xai',
  'kimi',
  'devin',
  'meta',
  'plugin',
];

export type QuotaTabId = 'all' | QuotaProviderType;

/** 页级分页固定 20/页，同时把「刷新全部」的上游并发限制在 20。 */
export const QUOTA_PAGE_SIZE = 20;

/** 卡片排序：默认 = provider 分组序；soonest = 最快恢复优先。 */
export const QUOTA_SORT_MODES = ['default', 'soonest'] as const;

export type QuotaSortMode = (typeof QUOTA_SORT_MODES)[number];

/**
 * Page layout: the card grid, one row per credential grouped by provider, or the
 * pool chart (every account of a provider added together over time).
 */
export const QUOTA_LAYOUTS = ['cards', 'list', 'pool'] as const;

export type QuotaLayout = (typeof QUOTA_LAYOUTS)[number];

/** Pool view: what the chart shows, and the burn windows it can average over. */
export const QUOTA_POOL_MODES = ['remaining', 'drain'] as const;
export type QuotaPoolMode = (typeof QUOTA_POOL_MODES)[number];
export const QUOTA_POOL_BURN_HOURS = [1, 3, 6] as const;
export type QuotaPoolBurnHours = (typeof QUOTA_POOL_BURN_HOURS)[number];

/** 与 useRevealGroup 的 GROUP_MAX_TOTAL 一致：卡片级联总预算 360ms。 */
export const CARD_ENTRANCE_BUDGET_MS = 360;
