import { expect, test, type Page } from '@playwright/test';
import { addAuthenticator, expectAccessible, firstRun, newSession, say, unlock } from './helpers.js';

const problems = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const list: string[] = [];
  problems.set(page, list);
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Refused to/.test(m.text())) list.push(m.text());
  });
  page.on('pageerror', (e) => list.push(`pageerror: ${e.message}`));
  await addAuthenticator(page);
  await unlock(page);
  await firstRun(page);
});

test.afterEach(async ({ page }) => {
  expect(problems.get(page)).toEqual([]);
});

test('answers stream in and end as one formatted message', async ({ page }) => {
  await newSession(page);
  await say(page, 'stream');
  await expect(page.locator('.msg.agent').filter({ hasText: 'Hello world' })).toHaveCount(1);
  await expect(page.locator('.msg.streaming')).toHaveCount(0);
});

test('markdown renders as text nodes, and unsafe links are not links', async ({ page }) => {
  await newSession(page);
  await say(page, 'md');
  const msg = page.locator('.msg.agent').filter({ hasText: 'Here is' });
  await expect(msg.locator('strong')).toHaveText('bold');
  await expect(msg.locator('p code')).toHaveText('code');
  await expect(msg.locator('li')).toHaveCount(2);
  await expect(msg.locator('pre.mdcode')).toContainText('const a = 1;');
  await expect(msg.locator('a[href="https://example.com/x"]')).toHaveAttribute('rel', /noopener/);
  expect(await msg.locator('a[href^="javascript"]').count()).toBe(0);
  await expect(msg).toContainText('[bad](javascript:alert(1))');
  await expectAccessible(page, 'markdown message');
});

test('an Edit approval shows what will change', async ({ page }) => {
  await newSession(page);
  await say(page, 'edit');
  const card = page.locator('.card.warn');
  await expect(card).toContainText('Edit /home/u/a.ts');
  await expect(card.locator('.pl.del')).toContainText('foo()');
  await expect(card.locator('.pl.add')).toContainText('bar()');
  await expectAccessible(page, 'edit preview');
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Edited')).toBeVisible();
});

test('the header shows model and mode and opens the settings', async ({ page }) => {
  await newSession(page);
  const badge = page.getByRole('button', { name: /Model and mode/ });
  await expect(badge).toContainText('Ask');
  await badge.click();
  await expect(page.getByRole('dialog', { name: 'Session settings' })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('rename a session in place, pin it, and find it by search', async ({ page }) => {
  await newSession(page);
  await say(page, 'hello');
  await expect(page.getByText('Hi there')).toBeVisible();
  await page.getByRole('button', { name: /^Rename / }).click();
  const input = page.getByLabel('Session name');
  await input.fill('Nice name');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Rename Nice name' })).toHaveText('Nice name');
  await page.getByRole('button', { name: /^Pin Nice name/ }).click();
  await expect(page.getByText('Pinned', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Unpin Nice name/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('a session is listed before its first message, with the folder in its title', async ({ page }) => {
  await newSession(page);
  await expect(page.locator('.row').first()).toContainText('New session in proj');
  await expect(page.locator('.grp').first()).toContainText('~/proj');
});

test('a waiting approval in another session is shown at the top', async ({ page }) => {
  await newSession(page);
  await say(page, 'tool');
  await expect(page.locator('.card.warn')).toBeVisible();
  await newSession(page);
  await expect(page.locator('.waitbar')).toContainText('is waiting for your approval');
  await page.locator('.waitbar button').click();
  await expect(page.locator('.card.warn')).toBeVisible();
});

test('new session remembers the last folder and model, and Alt+N opens the dialog', async ({ page }) => {
  await newSession(page);
  await page.getByRole('button', { name: 'Interrupt the current turn' }).count();
  await page.keyboard.press('Alt+n');
  const dlg = page.getByRole('dialog', { name: 'New session' });
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('.pathbox')).toContainText('~/proj');
  await dlg.getByRole('button', { name: 'Cancel' }).click();
});

test('folder name field is focused when New folder is chosen', async ({ page }) => {
  await page.getByRole('button', { name: 'New session' }).first().click();
  const dlg = page.getByRole('dialog', { name: 'New session' });
  await dlg.getByRole('button', { name: /Change/ }).click();
  await page.getByRole('button', { name: 'New folder' }).click();
  await expect(page.getByLabel('Folder name')).toBeFocused();
  await page.keyboard.type('made-here');
  await page.keyboard.press('Enter');
  await expect(page.locator('.pathline')).toContainText('made-here');
});

test('the welcome screen explains the modes, and the security page shows server status', async ({ page }) => {
  await expect(page.getByText('How it works')).toBeVisible();
  await expect(page.getByText(/Bypass.*needs your passkey/)).toBeVisible();
  await expectAccessible(page, 'welcome');
  await page.getByRole('button', { name: 'Security' }).click();
  await expect(page.getByRole('heading', { name: 'Server status' })).toBeVisible();
  await expect(page.getByText(/^Version \d/)).toBeVisible();
  await expect(page.getByText(/of \d+ allowed/)).toBeVisible();
  await expectAccessible(page, 'security with status');
});
