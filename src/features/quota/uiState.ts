import {
  QUOTA_LAYOUTS,
  QUOTA_POOL_BURN_HOURS,
  QUOTA_POOL_MODES,
  QUOTA_SORT_MODES,
  QUOTA_TAB_ORDER,
  type QuotaLayout,
  type QuotaPoolBurnHours,
  type QuotaPoolMode,
  type QuotaSortMode,
  type QuotaTabId,
} from './constants';

/** 额度页 UI 偏好：会话级持久化（sessionStorage），跨会话不携带。 */
export type QuotaUiState = {
  tab?: QuotaTabId;
  sortMode?: QuotaSortMode;
};

const QUOTA_UI_STATE_KEY = 'quotaPage.uiState';

const QUOTA_TAB_ID_SET = new Set<string>(['all', ...QUOTA_TAB_ORDER]);
const QUOTA_SORT_MODE_SET = new Set<string>(QUOTA_SORT_MODES);

export const isQuotaTabId = (value: unknown): value is QuotaTabId =>
  typeof value === 'string' && QUOTA_TAB_ID_SET.has(value);

export const isQuotaSortMode = (value: unknown): value is QuotaSortMode =>
  typeof value === 'string' && QUOTA_SORT_MODE_SET.has(value);

export const readQuotaUiState = (): QuotaUiState | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(QUOTA_UI_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as QuotaUiState;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      tab: isQuotaTabId(parsed.tab) ? parsed.tab : undefined,
      sortMode: isQuotaSortMode(parsed.sortMode) ? parsed.sortMode : undefined,
    };
  } catch {
    return null;
  }
};

/**
 * Merge into whatever is already stored.
 *
 * Callers write one preference at a time — the tab strip knows nothing about
 * the sort control — so a whole-object write would silently drop the other
 * field every time either one changed.
 */
export const writeQuotaUiState = (state: QuotaUiState) => {
  if (typeof window === 'undefined') return;
  try {
    const next = { ...readQuotaUiState(), ...state };
    window.sessionStorage.setItem(QUOTA_UI_STATE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
};

/**
 * Cards vs list is a lasting preference, so it lives in localStorage, unlike the
 * session-scoped tab and sort above (same split as the auth files compact mode).
 */
const QUOTA_LAYOUT_KEY = 'quotaPage.layout';
const QUOTA_LAYOUT_SET = new Set<string>(QUOTA_LAYOUTS);

export const isQuotaLayout = (value: unknown): value is QuotaLayout =>
  typeof value === 'string' && QUOTA_LAYOUT_SET.has(value);

export const readQuotaLayout = (): QuotaLayout | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(QUOTA_LAYOUT_KEY);
    return isQuotaLayout(raw) ? raw : null;
  } catch {
    return null;
  }
};

export const writeQuotaLayout = (layout: QuotaLayout) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(QUOTA_LAYOUT_KEY, layout);
  } catch {
    // ignore
  }
};

/** The pool view's chart choices, a lasting preference like the layout. */
export type QuotaPoolPrefs = {
  mode?: QuotaPoolMode;
  accounts?: boolean;
  burnHours?: QuotaPoolBurnHours;
};

const QUOTA_POOL_PREFS_KEY = 'quotaPage.pool';

export const readQuotaPoolPrefs = (): QuotaPoolPrefs => {
  if (typeof window === 'undefined') return {};
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(QUOTA_POOL_PREFS_KEY) ?? '{}');
    if (!raw || typeof raw !== 'object') return {};
    const { mode, accounts, burnHours } = raw as Record<string, unknown>;
    return {
      mode: (QUOTA_POOL_MODES as readonly unknown[]).includes(mode)
        ? (mode as QuotaPoolMode)
        : undefined,
      accounts: typeof accounts === 'boolean' ? accounts : undefined,
      burnHours: (QUOTA_POOL_BURN_HOURS as readonly unknown[]).includes(burnHours)
        ? (burnHours as QuotaPoolBurnHours)
        : undefined,
    };
  } catch {
    return {};
  }
};

export const writeQuotaPoolPrefs = (prefs: QuotaPoolPrefs) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(QUOTA_POOL_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
};
