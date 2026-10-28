/**
 * Quota page list layout (one row per credential, grouped by provider).
 *
 * QuotaCard imports stylesheets, so like the toolbar suite this checks the
 * row wiring as source contracts; grouping and the saved preference are pure.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { groupQuotaEntries, type QuotaFileEntry } from '@/features/quota/logic';
import { readQuotaLayout, writeQuotaLayout } from '@/features/quota/uiState';
import type { AuthFileItem } from '@/types';

const entry = (name: string, type: QuotaFileEntry['type']): QuotaFileEntry => ({
  file: { name } as AuthFileItem,
  type,
});

describe('groupQuotaEntries', () => {
  test('groups by provider in order of first appearance, keeping order inside a group', () => {
    const sorted = [
      entry('codex-b', 'codex'),
      entry('claude-a', 'claude'),
      entry('codex-a', 'codex'),
      entry('xai-a', 'xai'),
      entry('claude-b', 'claude'),
    ];
    const groups = groupQuotaEntries(sorted);
    expect(groups.map((group) => group.type)).toEqual(['codex', 'claude', 'xai']);
    expect(groups[0].entries.map((item) => item.file.name)).toEqual(['codex-b', 'codex-a']);
    expect(groups[1].entries.map((item) => item.file.name)).toEqual(['claude-a', 'claude-b']);
    expect(groups.flatMap((group) => group.entries)).toHaveLength(sorted.length);
  });

  test('returns no groups for an empty page', () => {
    expect(groupQuotaEntries([])).toEqual([]);
  });
});

describe('saved layout preference', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

  const installStorage = (store: Map<string, string>, throwing = false) => {
    const storage = {
      getItem: (key: string) => {
        if (throwing) throw new Error('blocked');
        return store.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (throwing) throw new Error('blocked');
        store.set(key, value);
      },
    };
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { localStorage: storage },
    });
  };

  afterEach(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  test('round-trips through localStorage and ignores unknown values', () => {
    const store = new Map<string, string>();
    installStorage(store);
    expect(readQuotaLayout()).toBeNull();
    writeQuotaLayout('list');
    expect(readQuotaLayout()).toBe('list');
    store.set('quotaPage.layout', 'grid-of-doom');
    expect(readQuotaLayout()).toBeNull();
  });

  test('falls back quietly when storage is blocked', () => {
    installStorage(new Map(), true);
    expect(() => writeQuotaLayout('list')).not.toThrow();
    expect(readQuotaLayout()).toBeNull();
  });
});

describe('list rows reuse the card, including its guarded reset actions', () => {
  const page = readFileSync('src/features/quota/QuotaPage.tsx', 'utf8');
  const card = readFileSync('src/features/quota/components/QuotaCard.tsx', 'utf8');

  test('the list renders QuotaCard rows wired to the same refresh and reset handlers', () => {
    const listStart = page.indexOf("layout === 'list' ? (\n          <div className={styles.list}>");
    const gridStart = page.indexOf('<div className={styles.grid}>', listStart);
    expect(listStart).toBeGreaterThan(-1);
    const listBranch = page.slice(listStart, gridStart);
    expect(listBranch).toContain('<QuotaCard');
    expect(listBranch).toContain('layout="row"');
    expect(listBranch).toContain(
      'onReset={() => resetQuota(entry.file, QUOTA_ADAPTERS[entry.type])}'
    );
    expect(listBranch).toContain(
      'onRefresh={() => void refreshQuota(entry.file, QUOTA_ADAPTERS[entry.type])}'
    );
  });

  test('the card has one action footer for both layouts', () => {
    expect(card.match(/<footer /g)).toHaveLength(1);
    expect(card).toContain('onClick={claudeReset.confirm}');
    expect(card).toContain('onClick={onReset}');
    expect(card).not.toMatch(/isRow \? \(\s*<footer/);
  });

  test('the layout switch is a labelled group of pressed-state buttons', () => {
    expect(page).toContain('role="group"');
    expect(page).toContain("aria-label={t('quota_management.layout_label')}");
    expect(page).toContain('aria-pressed={layout === value}');
  });
});

describe('frozen plan badge styles', () => {
  test('the list layout leaves the plan badge block byte-identical', () => {
    const marker = '套餐徽章定稿区块';
    const path = 'src/features/quota/components/QuotaBody.module.scss';
    const current = readFileSync(path, 'utf8');
    const committed = execFileSync('git', ['show', `HEAD:${path}`], { encoding: 'utf8' });
    const tail = (text: string) => text.slice(text.indexOf(marker));
    expect(current.indexOf(marker)).toBeGreaterThan(-1);
    expect(tail(current)).toBe(tail(committed));
  });
});
