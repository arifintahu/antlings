import { expect, test, type Page } from '@playwright/test';
import { addAuthenticator, dropSockets, expectAccessible, firstRun, newSession, unlock } from './helpers.js';

const ORIGIN = 'http://localhost:3199';
const problems = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const list: string[] = [];
  problems.set(page, list);
  // A CSP violation or an uncaught error fails the test: xterm.js must stay inside the page's policy.
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Refused to/.test(m.text())) list.push(m.text());
  });
  page.on('pageerror', (e) => list.push(`pageerror: ${e.message}`));
  await addAuthenticator(page);
  await unlock(page);
  await firstRun(page);
  await newSession(page);
});

test.afterEach(async ({ page }) => {
  expect(problems.get(page)).toEqual([]);
});

const panel = (page: Page) => page.getByRole('region', { name: 'Terminal' });
const termButton = (page: Page) => page.getByRole('button', { name: /^Terminal/ });
const written = async (page: Page): Promise<string[]> =>
  ((await (await page.request.get(`${ORIGIN}/__e2e/terminal-written`)).json()) as { written: string[] })
    .written;

async function openPanel(page: Page): Promise<void> {
  await termButton(page).click();
  await expect(panel(page).getByRole('button', { name: /^Shell 1/ })).toContainText('Running');
}

async function run(page: Page, cmd: string): Promise<void> {
  await panel(page).locator('.termview:not([hidden]) .xterm-helper-textarea').focus();
  await page.keyboard.type(cmd);
  await page.keyboard.press('Enter');
}

test('opens a shell, labels it Running, and shows what is typed and echoed', async ({ page }) => {
  await openPanel(page);
  await run(page, 'echo hello');
  await expect(panel(page).locator('.xterm-rows')).toContainText('hello');
  await expect(termButton(page)).toHaveAccessibleName('Terminal, 1 running');
});

test('a reload and a dropped connection keep the shell and its output', async ({ page }) => {
  await openPanel(page);
  await run(page, 'echo before');
  await expect(panel(page).locator('.xterm-rows')).toContainText('before');

  await page.reload();
  await termButton(page).click();
  await expect(panel(page).getByRole('button', { name: /^Shell 1/ })).toContainText('Running');
  await expect(panel(page).locator('.xterm-rows')).toContainText('before');

  await dropSockets(page);
  await expect(panel(page).getByRole('button', { name: /^Shell 1/ })).toContainText(/Reconnecting|Running/);
  await expect(panel(page).getByRole('button', { name: /^Shell 1/ })).toContainText('Running');
  await run(page, 'echo after');
  await expect(panel(page).locator('.xterm-rows')).toContainText('after');
  // Replay on reconnect must not print the earlier line twice.
  expect(
    (await panel(page).locator('.xterm-rows').innerText()).match(/before/g)?.length ?? 0,
  ).toBeLessThanOrEqual(2);
});

test('tabs: add a shell, exit one, close one', async ({ page }) => {
  await openPanel(page);
  await panel(page).getByRole('button', { name: 'New terminal' }).click();
  await expect(panel(page).getByRole('button', { name: /^Shell 2/ })).toContainText('Running');
  await run(page, 'exit');
  await expect(panel(page).getByRole('button', { name: /^Shell 2/ })).toContainText('Exited (code 0)');
  await panel(page).getByRole('button', { name: 'Close Shell 1' }).click();
  await expect(panel(page).getByRole('button', { name: /^Shell 1/ })).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: /^Shell 2/ })).toContainText('Exited (code 0)');
  await panel(page).getByRole('button', { name: 'Close Shell 2' }).click();
  await expect(panel(page).getByText('No terminal is open in this session.')).toBeVisible();
});

test('hiding the panel keeps the shell running', async ({ page }) => {
  await openPanel(page);
  await termButton(page).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(termButton(page)).toHaveAccessibleName('Terminal, 1 running');
});

test('archiving the session closes the panel (the server ends the shells)', async ({ page }) => {
  await openPanel(page);
  await page.getByRole('button', { name: 'Session actions' }).click();
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(termButton(page)).toHaveCount(0);
  await expect(panel(page)).toHaveCount(0);
});

test('light and dark: the open panel passes the accessibility checks', async ({ page }) => {
  await openPanel(page);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectAccessible(page, `terminal panel, ${scheme}`);
  }
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 800 } });

  test('Chat | Terminal switch and the key bar reach the shell', async ({ page }) => {
    await page.getByRole('button', { name: /^Terminal/ }).click();
    const tabs = page.getByRole('tablist', { name: 'View' });
    await expect(tabs.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true');
    const keys = page.getByRole('toolbar', { name: 'Terminal keys' });
    await expect(keys).toBeVisible();
    await expect(panel(page).getByRole('button', { name: /^Shell 1/ })).toContainText('Running');

    await keys.getByRole('button', { name: 'Esc' }).click();
    await keys.getByRole('button', { name: 'Tab' }).click();
    await keys.getByRole('button', { name: 'Up' }).click();
    await keys.getByRole('button', { name: 'Control C' }).click();
    const ctrl = keys.getByRole('button', { name: 'Ctrl', exact: true });
    await ctrl.click();
    await expect(ctrl).toHaveAttribute('aria-pressed', 'true');
    await panel(page).locator('.termview:not([hidden]) .xterm-helper-textarea').focus();
    await page.keyboard.type('d');
    await expect(ctrl).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => written(page)).toEqual(['\x1b', '\t', '\x1b[A', '\x03', '\x04']);

    await expectAccessible(page, 'terminal on a phone');
    await tabs.getByRole('tab', { name: 'Chat' }).click();
    await expect(page.getByLabel('Message')).toBeVisible();
  });
});
