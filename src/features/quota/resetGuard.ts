/**
 * Review content for the guarded reset confirmation. Manual quota resets are scarce, so the
 * review step states what is left, what the reset spends, and why it may be a waste right now.
 * React-free so tests can call it directly.
 */

import type { TFunction } from 'i18next';
import type {
  AnthropicResetGrant,
  AnthropicResetGrantStatus,
  AnthropicResetWindow,
} from '@/services/api/claudeResetGrants';
import type { ConfirmationGuard, ConfirmationGuardFact } from '@/stores/useNotificationStore';
import type { CodexQuotaState } from '@/types';
import { formatInstantShort, formatRelativeInstant } from '@/utils/quota';

export const RESET_GUARD_PHRASE = 'RESET';
export const RESET_GUARD_HOLD_MS = 1500;
/** With less than this share used, a reset gives back too little to be worth spending. */
export const RESET_GUARD_LOW_USAGE_PERCENT = 50;
/** A limit that refills on its own within this long rarely needs a manual reset. */
export const RESET_GUARD_SOON_MS = 24 * 60 * 60 * 1000;

interface GuardInput {
  fileName: string;
  now: number;
  t: TFunction;
  locale?: string;
}

const clampPercent = (value: number) => Math.max(0, Math.min(100, value));

const finiteMs = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const parseInstant = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

const describeInstant = (ms: number, now: number, locale?: string) =>
  `${formatRelativeInstant(ms, now, locale)} · ${formatInstantShort(ms)}`;

const refillsSoon = (ms: number | null, now: number) =>
  ms !== null && ms > now && ms - now <= RESET_GUARD_SOON_MS;

const guardWith = (
  t: TFunction,
  facts: ConfirmationGuardFact[],
  warnings: string[],
  finalNote: string
): ConfirmationGuard => ({
  facts,
  warnings,
  finalNote,
  phrase: RESET_GUARD_PHRASE,
  holdMs: RESET_GUARD_HOLD_MS,
  holdLabel: t('reset_guard.hold_button'),
});

const resetsLeftFact = (t: TFunction, before: number): ConfirmationGuardFact => ({
  label: t('reset_guard.fact_resets_left'),
  value: t('reset_guard.resets_left_value', { before, after: Math.max(0, before - 1) }),
});

export function buildCodexResetGuard({
  fileName,
  quota,
  now,
  t,
  locale,
}: GuardInput & { quota: CodexQuotaState | undefined }): ConfirmationGuard {
  const facts: ConfirmationGuardFact[] = [
    { label: t('reset_guard.fact_account'), value: fileName },
  ];
  const warnings: string[] = [];
  const windows = (quota?.windows ?? []).flatMap((window) => {
    const used = window.usedPercent;
    return typeof used === 'number' && Number.isFinite(used)
      ? [{ ...window, used: clampPercent(used), resetMs: finiteMs(window.resetAtMs) }]
      : [];
  });

  for (const window of windows) {
    const left = Math.round(100 - window.used);
    facts.push({
      label: window.labelKey
        ? t(window.labelKey, window.labelParams as Record<string, string | number>)
        : window.label,
      value:
        window.resetMs === null
          ? t('reset_guard.window_left', { left })
          : t('reset_guard.window_left_until', {
              left,
              when: describeInstant(window.resetMs, now, locale),
            }),
    });
  }

  const available = quota?.rateLimitResetCreditsAvailableCount;
  if (typeof available === 'number' && Number.isFinite(available)) {
    facts.push(resetsLeftFact(t, available));
  }
  const nextExpiry = (quota?.rateLimitResetCredits ?? [])
    .map((credit) => parseInstant(credit.expiresAt))
    .filter((ms): ms is number => ms !== null && ms > now)
    .sort((a, b) => a - b)[0];
  if (nextExpiry !== undefined) {
    facts.push({
      label: t('reset_guard.fact_next_expiry'),
      value: describeInstant(nextExpiry, now, locale),
    });
  }

  // Code-review windows do not gate normal Codex use; judge the reset on the main limits.
  const mainWindows = windows.filter((window) => !window.id.startsWith('code-review'));
  if (mainWindows.length === 0) {
    warnings.push(t('reset_guard.warn_usage_unknown'));
  } else {
    const busiest = mainWindows.reduce((a, b) => (b.used > a.used ? b : a));
    const used = Math.round(busiest.used);
    if (used < RESET_GUARD_LOW_USAGE_PERCENT) {
      warnings.push(t('reset_guard.warn_low_usage', { used }));
    }
    if (refillsSoon(busiest.resetMs, now)) {
      warnings.push(
        t('reset_guard.warn_refills_soon', {
          when: formatRelativeInstant(busiest.resetMs as number, now, locale),
        })
      );
    }
  }

  return guardWith(t, facts, warnings, t('reset_guard.final_note'));
}

const CLAUDE_WINDOW_LABEL_KEYS: Partial<Record<AnthropicResetWindow, string>> = {
  five_hour: 'claude_quota.five_hour',
  seven_day: 'claude_quota.seven_day',
};

export function buildClaudeResetGuard({
  fileName,
  status,
  grant,
  now,
  t,
  locale,
}: GuardInput & {
  status: AnthropicResetGrantStatus | null;
  grant: AnthropicResetGrant | undefined;
}): ConfirmationGuard {
  const facts: ConfirmationGuardFact[] = [
    { label: t('reset_guard.fact_account'), value: fileName },
  ];
  const warnings: string[] = [];

  if (grant) {
    if (grant.label) facts.push({ label: t('reset_guard.fact_grant'), value: grant.label });
    facts.push(resetsLeftFact(t, grant.resetsLeft));
    const expiry = parseInstant(grant.endsAt);
    if (expiry !== null && expiry > now) {
      facts.push({
        label: t('reset_guard.fact_next_expiry'),
        value: describeInstant(expiry, now, locale),
      });
    }
    const usedValues: number[] = [];
    for (const window of grant.clears) {
      const used = grant.percentUsed[window];
      if (typeof used !== 'number') continue;
      usedValues.push(used);
      const labelKey = CLAUDE_WINDOW_LABEL_KEYS[window];
      facts.push({
        label: labelKey ? t(labelKey) : window,
        value: t('reset_guard.window_left', { left: Math.round(100 - clampPercent(used)) }),
      });
    }
    if (grant.useRequiresLimit && status && !status.atLimit) {
      warnings.push(t('reset_guard.warn_not_limited'));
    } else if (usedValues.length > 0) {
      const used = Math.round(Math.max(...usedValues.map(clampPercent)));
      if (used < RESET_GUARD_LOW_USAGE_PERCENT) {
        warnings.push(t('reset_guard.warn_low_usage', { used }));
      }
    }
  } else {
    warnings.push(t('reset_guard.warn_usage_unknown'));
  }

  const weeklyReset = parseInstant(status?.weeklyResetsAt);
  if (refillsSoon(weeklyReset, now)) {
    warnings.push(
      t('reset_guard.warn_refills_soon', {
        when: formatRelativeInstant(weeklyReset as number, now, locale),
      })
    );
  }

  return guardWith(t, facts, warnings, t('reset_guard.final_note'));
}

/** Fallback for providers that gain a reset action later without their own review content. */
export function buildBasicResetGuard({ fileName, t }: GuardInput): ConfirmationGuard {
  return guardWith(
    t,
    [{ label: t('reset_guard.fact_account'), value: fileName }],
    [],
    t('reset_guard.final_note')
  );
}

/** Picks the review content for a quota adapter's reset action. */
export function buildAdapterResetGuard(
  type: string,
  input: GuardInput & { quota: unknown }
): ConfirmationGuard {
  return type === 'codex'
    ? buildCodexResetGuard({ ...input, quota: input.quota as CodexQuotaState | undefined })
    : buildBasicResetGuard(input);
}
