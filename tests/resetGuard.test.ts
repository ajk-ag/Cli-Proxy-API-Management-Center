import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { GuardedConfirmation } from '@/components/common/GuardedConfirmation';
import {
  guardPhraseMatches,
  holdProgress,
  isHoldKey,
} from '@/components/common/guardedConfirmationLogic';
import {
  buildAdapterResetGuard,
  buildClaudeResetGuard,
  buildCodexResetGuard,
  RESET_GUARD_HOLD_MS,
  RESET_GUARD_PHRASE,
} from '@/features/quota/resetGuard';
import type {
  AnthropicResetGrant,
  AnthropicResetGrantStatus,
} from '@/services/api/claudeResetGrants';
import type { CodexQuotaState, CodexQuotaWindow } from '@/types';

const NOW = Date.parse('2026-10-22T08:00:00Z');
const HOUR = 3600_000;
const t = i18n.t.bind(i18n);

let previousLanguage = '';

beforeAll(async () => {
  previousLanguage = i18n.language;
  await i18n.changeLanguage('en');
});

// i18n is a shared singleton across test files; leave it as we found it.
afterAll(async () => {
  if (previousLanguage) await i18n.changeLanguage(previousLanguage);
});

const weekly = (overrides: Partial<CodexQuotaWindow> = {}): CodexQuotaWindow => ({
  id: 'weekly',
  label: 'Weekly limit',
  usedPercent: 90,
  resetLabel: '',
  resetAtMs: NOW + 4 * 24 * HOUR,
  ...overrides,
});

const codexQuota = (overrides: Partial<CodexQuotaState> = {}): CodexQuotaState => ({
  status: 'success',
  windows: [weekly()],
  rateLimitResetCreditsAvailableCount: 3,
  rateLimitResetCredits: [
    {
      id: 'b',
      status: 'available',
      grantedAt: '',
      expiresAt: new Date(NOW + 7 * 24 * HOUR).toISOString(),
    },
    {
      id: 'a',
      status: 'available',
      grantedAt: '',
      expiresAt: new Date(NOW + 12 * HOUR).toISOString(),
    },
  ],
  ...overrides,
});

const grant = (overrides: Partial<AnthropicResetGrant> = {}): AnthropicResetGrant => ({
  id: 'launch',
  label: 'Launch reset',
  resetsTotal: 1,
  resetsLeft: 1,
  startsAt: null,
  endsAt: new Date(NOW + 8 * HOUR).toISOString(),
  clears: ['five_hour'],
  paused: false,
  usableNow: true,
  useRequiresLimit: true,
  percentUsed: { five_hour: 100 },
  ...overrides,
});

const grantStatus = (
  overrides: Partial<AnthropicResetGrantStatus> = {}
): AnthropicResetGrantStatus => ({
  eligible: true,
  ineligibleReason: null,
  atLimit: true,
  grants: [grant()],
  nextGrantId: 'launch',
  weeklyResetsAt: new Date(NOW + 3 * 24 * HOUR).toISOString(),
  cooldownUntil: null,
  ...overrides,
});

describe('guarded confirmation logic', () => {
  test('phrase must match exactly, ignoring case and outer spaces', () => {
    expect(guardPhraseMatches('RESET', 'RESET')).toBe(true);
    expect(guardPhraseMatches('  reset ', 'RESET')).toBe(true);
    expect(guardPhraseMatches('RESE', 'RESET')).toBe(false);
    expect(guardPhraseMatches('RESETT', 'RESET')).toBe(false);
    expect(guardPhraseMatches('', 'RESET')).toBe(false);
    expect(guardPhraseMatches('', '')).toBe(false);
  });

  test('hold progress grows to 1 only after the full hold', () => {
    expect(holdProgress(0, 1500)).toBe(0);
    expect(holdProgress(-5, 1500)).toBe(0);
    expect(holdProgress(750, 1500)).toBe(0.5);
    expect(holdProgress(1499, 1500)).toBeLessThan(1);
    expect(holdProgress(1500, 1500)).toBe(1);
    expect(holdProgress(9000, 1500)).toBe(1);
  });

  test('only Space and Enter start a keyboard hold', () => {
    expect(isHoldKey(' ')).toBe(true);
    expect(isHoldKey('Enter')).toBe(true);
    expect(isHoldKey('a')).toBe(false);
    expect(isHoldKey('Escape')).toBe(false);
  });
});

describe('Codex reset review', () => {
  test('lists account, limit left, resets before/after and the soonest expiry', () => {
    const guard = buildCodexResetGuard({
      fileName: 'codex-a.json',
      quota: codexQuota(),
      now: NOW,
      t,
    });
    const text = guard.facts.map((fact) => `${fact.label}: ${fact.value}`).join('\n');
    expect(text).toContain('Account: codex-a.json');
    expect(text).toContain('Weekly limit: 10% left');
    expect(text).toContain('Manual resets left: 3 now, 2 after this');
    expect(text).toContain('Next reset expires: in 12 hours');
    expect(guard.phrase).toBe(RESET_GUARD_PHRASE);
    expect(guard.holdMs).toBe(RESET_GUARD_HOLD_MS);
    expect(guard.warnings).toEqual([]);
  });

  test('warns when little of the limit is used', () => {
    const guard = buildCodexResetGuard({
      fileName: 'codex-a.json',
      quota: codexQuota({ windows: [weekly({ usedPercent: 27 })] }),
      now: NOW,
      t,
    });
    expect(guard.warnings.join('\n')).toContain('Only 27% of this limit is used');
  });

  test('warns when the limit refills on its own within a day', () => {
    const guard = buildCodexResetGuard({
      fileName: 'codex-a.json',
      quota: codexQuota({ windows: [weekly({ usedPercent: 95, resetAtMs: NOW + 5 * HOUR })] }),
      now: NOW,
      t,
    });
    expect(guard.warnings.join('\n')).toContain('refills on its own in 5 hours');
  });

  test('warns when usage is unknown, and ignores code-review windows for the judgement', () => {
    const unknown = buildCodexResetGuard({ fileName: 'x', quota: undefined, now: NOW, t });
    expect(unknown.warnings.join('\n')).toContain('could not be read');
    const reviewOnly = buildCodexResetGuard({
      fileName: 'x',
      quota: codexQuota({ windows: [weekly({ id: 'code-review-weekly', usedPercent: 100 })] }),
      now: NOW,
      t,
    });
    expect(reviewOnly.warnings.join('\n')).toContain('could not be read');
  });

  test('adapter helper uses Codex content for codex and a plain review otherwise', () => {
    const codex = buildAdapterResetGuard('codex', {
      fileName: 'c',
      quota: codexQuota(),
      now: NOW,
      t,
    });
    expect(codex.facts.length).toBeGreaterThan(1);
    const other = buildAdapterResetGuard('kimi', { fileName: 'k', quota: undefined, now: NOW, t });
    expect(other.facts).toEqual([{ label: 'Account', value: 'k' }]);
    expect(other.phrase).toBe(RESET_GUARD_PHRASE);
  });
});

describe('Claude reset review', () => {
  test('lists the grant, resets before/after, expiry and the limit it clears', () => {
    const status = grantStatus();
    const guard = buildClaudeResetGuard({
      fileName: 'claude-a.json',
      status,
      grant: status.grants[0],
      now: NOW,
      t,
    });
    const text = guard.facts.map((fact) => `${fact.label}: ${fact.value}`).join('\n');
    expect(text).toContain('Reset grant: Launch reset');
    expect(text).toContain('Manual resets left: 1 now, 0 after this');
    expect(text).toContain('Next reset expires: in 8 hours');
    expect(text).toContain('5-hour limit: 0% left');
    expect(guard.warnings).toEqual([]);
  });

  test('warns when Anthropic would refuse because the account is not at its limit', () => {
    const status = grantStatus({ atLimit: false });
    const guard = buildClaudeResetGuard({
      fileName: 'claude-a.json',
      status,
      grant: grant({ percentUsed: { five_hour: 2 } }),
      now: NOW,
      t,
    });
    expect(guard.warnings.join('\n')).toContain('only while the account is at its limit');
  });

  test('warns when the weekly limit refills within a day', () => {
    const status = grantStatus({ weeklyResetsAt: new Date(NOW + 2 * HOUR).toISOString() });
    const guard = buildClaudeResetGuard({
      fileName: 'c',
      status,
      grant: status.grants[0],
      now: NOW,
      t,
    });
    expect(guard.warnings.join('\n')).toContain('refills on its own in 2 hours');
  });
});

describe('guarded confirmation UI', () => {
  test('opens on the review step: facts and warnings shown, no way to spend yet', () => {
    const guard = buildCodexResetGuard({
      fileName: 'codex-a.json',
      quota: codexQuota({ windows: [weekly({ usedPercent: 27 })] }),
      now: NOW,
      t,
    });
    const markup = renderToStaticMarkup(
      createElement(GuardedConfirmation, {
        message: 'Reset this account?',
        guard,
        isLoading: false,
        onCancel: () => {},
        onConfirm: () => {},
      })
    );
    expect(markup).toContain('Step 1 of 2');
    expect(markup).toContain('codex-a.json');
    expect(markup).toContain('Only 27% of this limit is used');
    expect(markup).toContain('Continue');
    expect(markup).not.toContain('Hold to reset');
    expect(markup).not.toContain('<input');
  });

  test('every reset entry point passes a guard to the shared confirmation', () => {
    const sources = [
      'src/features/quota/hooks/useQuotaActions.ts',
      'src/features/authFiles/components/AuthFileQuotaSection.tsx',
      'src/features/quota/providers/claude/ClaudeResetGrants.tsx',
    ].map((path) => readFileSync(path, 'utf8'));
    for (const source of sources) {
      expect(source).toContain('showConfirmation({');
      expect(source).toMatch(/guard: build(Adapter|Claude)ResetGuard\(/);
    }
    const modal = readFileSync('src/components/common/ConfirmationModal.tsx', 'utf8');
    expect(modal).toContain('<GuardedConfirmation');
  });

  test('reset_guard text exists with the same keys and placeholders in all six locales', () => {
    const read = (locale: string) =>
      JSON.parse(readFileSync(`src/i18n/locales/${locale}.json`, 'utf8')).reset_guard as Record<
        string,
        string
      >;
    const english = read('en');
    const placeholders = (value: string) => (value.match(/\{\{\w+\}\}/g) ?? []).sort();
    for (const locale of ['zh-CN', 'zh-TW', 'ru', 'vi', 'ko']) {
      const other = read(locale);
      expect(Object.keys(other).sort()).toEqual(Object.keys(english).sort());
      for (const [key, value] of Object.entries(english)) {
        expect(placeholders(other[key])).toEqual(placeholders(value));
      }
    }
  });
});
