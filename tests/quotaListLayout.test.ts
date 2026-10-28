/**
 * Quota page list layout (one row per credential, grouped by provider).
 *
 * QuotaCard imports stylesheets, so like the toolbar suite this checks the
 * row wiring as source contracts; grouping and the saved preference are pure.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { groupQuotaEntries, type QuotaFileEntry } from '@/features/quota/logic';
import { CodexQuotaBody } from '@/features/quota/providers/codex/CodexQuotaBody';
import { QUOTA_CLASS_KEYS, bindQuotaClasses } from '@/features/quota/types';
import { readQuotaLayout, writeQuotaLayout } from '@/features/quota/uiState';
import type { AuthFileItem, CodexQuotaState } from '@/types';

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
    const listStart = page.indexOf(
      "layout === 'list' ? (\n          <div className={styles.list}>"
    );
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

describe('list cell styles', () => {
  const body = readFileSync('src/features/quota/components/QuotaBody.module.scss', 'utf8');
  const rule = (selector: string) => {
    const start = body.indexOf(`${selector} {`);
    expect(start).toBeGreaterThan(-1);
    return body.slice(start, body.indexOf('\n}', start));
  };

  test('limit cells lay out as a wrapping row, not the stacked card column', () => {
    // The base .quotaRow is flex-direction: column; without the override the bar
    // collapses to zero width and every part lands on its own line.
    const row = rule('.listLayout .quotaRow');
    expect(row).toContain('flex-direction: row;');
    expect(row).toContain('flex-wrap: wrap;');
  });

  test('cells can shrink to their column and long statuses wrap inside them', () => {
    expect(rule('.listLayout')).toContain('min-width: 0;');
    expect(rule('.listLayout .quotaRowHeader > .quotaMeta > .quotaPercent')).toContain(
      'max-width: 60%;'
    );
  });
});

describe('plan row placement', () => {
  const classes = bindQuotaClasses(
    Object.fromEntries(QUOTA_CLASS_KEYS.map((key) => [key, key])),
    'test-host'
  );
  const quota: CodexQuotaState = {
    status: 'success',
    planType: 'pro',
    windows: [
      {
        id: 'weekly',
        label: 'Weekly limit',
        usedPercent: 10,
        resetLabel: '11-04 14:35',
        resetAtMs: Date.now() + 6 * 24 * 3600 * 1000,
        periodHours: 168,
      },
    ],
  };
  const render = (planContainer?: HTMLElement | null) =>
    renderToStaticMarkup(createElement(CodexQuotaBody, { quota, classes, planContainer }));

  test('cards keep the plan row inline at the top of the body', () => {
    const html = render(undefined);
    expect(html).toContain('class="codexPlan"');
    expect(html.indexOf('codexPlan')).toBeLessThan(html.indexOf('quotaRow'));
  });

  test('list rows leave it out of the body until the slot under the name exists', () => {
    const html = render(null);
    expect(html).not.toContain('codexPlan');
    expect(html).toContain('quotaRow');
  });

  test('every provider that draws a plan row routes it through the slot', () => {
    for (const provider of ['claude', 'antigravity', 'codex', 'devin', 'meta', 'plugin', 'xai']) {
      const name = provider[0].toUpperCase() + provider.slice(1);
      const source = readFileSync(
        `src/features/quota/providers/${provider}/${name}QuotaBody.tsx`,
        'utf8'
      );
      const plans = source.match(/className=\{classes\.codexPlan\}/g) ?? [];
      const slots = source.match(/<QuotaPlanSlot container=\{planContainer\}>/g) ?? [];
      expect(plans.length).toBeGreaterThan(0);
      expect(slots.length).toBe(plans.length);
    }
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
