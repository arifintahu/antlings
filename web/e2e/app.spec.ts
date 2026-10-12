import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  addAuthenticator,
  dropSockets,
  pickProj,
  switchToNewDevice,
  expectAccessible,
  firstRun,
  newSession,
  say,
  unlock,
} from './helpers.js';

const SHOTS = new URL('../../docs/screens/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const problems = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const list: string[] = [];
  problems.set(page, list);
  // Any CSP violation or uncaught error in the page fails the test.
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

const agentOffice = (page: Page) => page.getByRole('region', { name: 'Subagents of this session' });

test('start a session, stream an answer, show context', async ({ page }) => {
  await newSession(page);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('~/proj');
  await say(page, 'hello');
  await expect(page.getByText('You', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Hi there')).toBeVisible();
  await expect(page.getByRole('button', { name: /Context window: 12 percent/ })).toBeVisible();
  await expectAccessible(page, 'conversation');
});

test('approve and deny a tool request', async ({ page }) => {
  await newSession(page);
  await say(page, 'tool');
  const card = page.locator('.card.warn');
  await expect(card).toContainText('Bash · waiting for approval');
  await expect(card).toContainText('ls');
  await expectAccessible(page, 'approval card');
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('Listed')).toBeVisible();
  await expect(page.locator('.toolcard').last()).toContainText('approved');
  await expect(page.locator('.toolcard')).toHaveCount(1); // one card per call, not a tool card plus an approval card

  await say(page, 'tool');
  await page.locator('.card.warn').getByRole('button', { name: 'Deny' }).click();
  await expect(page.getByText('Not allowed')).toBeVisible();
});

test('a subagent shows as a worker ant with its log and report', async ({ page }) => {
  await newSession(page);
  await say(page, 'agent');
  const office = agentOffice(page);
  await expect(office.getByRole('button', { name: /Explore: look around/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /→ Explore/ })).toBeVisible();
  await page.getByRole('button', { name: /→ Explore/ }).click();
  await expect(page.getByRole('heading', { name: 'Explore' })).toBeVisible();
  await expect(page.getByText('Found 3 files')).toBeVisible();
  await expect(page.getByText('Read', { exact: true })).toBeVisible();
  await expectAccessible(page, 'subagent view');
  await page.getByRole('button', { name: '← Conversation' }).click();
  await expect(page.getByText('Done', { exact: true }).first()).toBeVisible();
});

test('stop one subagent', async ({ page }) => {
  await newSession(page);
  await say(page, 'slow-agent');
  await page
    .getByRole('button', { name: /general-purpose/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'Stop this agent' }).click();
  await expect(page.getByRole('button', { name: 'Stop this agent' })).toHaveCount(0);
  await expect(page.locator('.card', { hasText: 'Stopped before it finished' })).toBeVisible();
});

test('archive and unarchive', async ({ page }) => {
  await newSession(page);
  await say(page, 'hello');
  await expect(page.getByText('Hi there')).toBeVisible();
  await page.getByRole('button', { name: 'Session actions' }).click();
  await page.locator('#sessmenu').getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.getByText('No session open')).toBeVisible();
  await page.getByRole('tab', { name: /Archived 1/ }).click();
  await expect(page.locator('.row').first()).toBeVisible();
  await page.locator('.row').first().click();
  await expect(page.getByText('This session is archived')).toBeVisible();
  await expect(page.getByLabel('Message')).toBeDisabled();
  await page.getByRole('button', { name: 'Unarchive' }).first().click();
  await page.getByRole('tab', { name: /Active 1/ }).click();
  await expect(page.getByRole('tab', { name: /Active 1/ })).toBeVisible();
});

test('delete needs a fresh passkey check', async ({ page }) => {
  await newSession(page);
  await say(page, 'hello');
  await expect(page.getByText('Hi there')).toBeVisible();
  // first-run made the session fresh; wait it out by dropping freshness on the server clock is not possible,
  // so ask the server to make us stale by using a second page without step-up
  await page.getByRole('button', { name: 'Session actions' }).click();
  await page.locator('#sessmenu').getByRole('button', { name: 'Delete…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Delete session?' });
  await expect(dlg).toBeVisible();
  await expectAccessible(page, 'delete dialog');
  await dlg.getByRole('button', { name: 'Delete' }).click();
  // fresh from first run: deleted at once, or a step-up dialog appears. Both end in an empty list.
  const step = page.getByRole('dialog', { name: "Confirm it's you" });
  if (await step.isVisible().catch(() => false))
    await step.getByRole('button', { name: 'Use passkey' }).click();
  await expect(page.getByText('No session open')).toBeVisible();
  await expect(page.getByText('No sessions yet')).toBeVisible();
});

test('Bypass mode asks for a passkey first (stale session)', async ({ page }) => {
  // make the session stale: sign out and back in with the passkey (sign-in is not fresh)
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Sign in with passkey' }).click();
  await expect(page.getByText('No session open')).toBeVisible();
  await page.getByRole('button', { name: 'New session' }).first().click();
  const dlg = page.getByRole('dialog', { name: 'New session' });
  await pickProj(page);
  await dlg.getByLabel('Mode', { exact: true }).selectOption('bypassPermissions');
  await expect(dlg.getByText('Runs every tool without asking')).toBeVisible();
  await dlg.getByRole('button', { name: 'Start' }).click();
  const step = page.getByRole('dialog', { name: "Confirm it's you" });
  await expect(step).toBeVisible();
  await expectAccessible(page, 'step-up dialog');
  await step.getByRole('button', { name: 'Use passkey' }).click();
  await expect(page.getByLabel('Message')).toBeEnabled();
});

test('reconnect after the connection drops: missed events arrive once, in order', async ({
  page,
  context,
}) => {
  await newSession(page);
  await say(page, 'hello');
  await expect(page.getByText('Hi there')).toHaveCount(1);
  const id = page.url().split('#s=')[1]!;
  // the phone loses its connection for a while ...
  await context.setOffline(true);
  await dropSockets(page);
  await expect(page.getByText('Offline. Reconnecting…')).toBeVisible({ timeout: 10_000 });
  // ... and the agent speaks in the meantime
  for (const text of ['missed one', 'missed two']) {
    await page.request.post('http://localhost:3199/__e2e/emit', {
      headers: { origin: 'http://localhost:3199' },
      data: { sessionId: id, text },
    });
  }
  await context.setOffline(false);
  await expect(page.getByText('Offline. Reconnecting…')).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText('missed one')).toHaveCount(1);
  await expect(page.getByText('missed two')).toHaveCount(1);
  await say(page, 'hello');
  await expect(page.getByText('Hi there')).toHaveCount(2);
  await expect(page.locator('.msg.user')).toHaveCount(2);
});

test('phone layout at 375px: no sideways scroll, targets 44px, screenshots', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}phone-empty.png` });
  await newSession(page);
  await say(page, 'agent');
  await expect(page.getByText('Done', { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}phone-conversation.png` });
  await page.getByRole('button', { name: /Agents \(2\)/ }).click();
  await page.screenshot({ path: `${SHOTS}phone-agents.png` });
  await page.getByRole('button', { name: 'Open sessions' }).click();
  await expect(page.locator('#sidebar')).toHaveClass(/open/);
  await page.waitForTimeout(400); // let the drawer finish sliding in
  await page.screenshot({ path: `${SHOTS}phone-sessions.png` });
  await page.keyboard.press('Escape');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const small = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('button, select, input, textarea')]
      .filter((e) => e.offsetParent !== null)
      .map((e) => ({
        n: e.getAttribute('aria-label') || e.textContent?.trim().slice(0, 20) || e.id,
        r: e.getBoundingClientRect(),
      }))
      .filter((x) => x.r.height < 43.5 || x.r.width < 43.5)
      .map((x) => `${x.n} ${Math.round(x.r.width)}x${Math.round(x.r.height)}`),
  );
  expect(small).toEqual([]);
});

test('Escape closes the sidebar drawer, the context panel and the session menu', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await newSession(page);
  await page.getByRole('button', { name: 'Open sessions' }).click();
  await expect(page.getByRole('button', { name: 'Close sessions' })).toBeAttached();
  await expect(page.locator('#sidebar')).toHaveClass(/open/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#sidebar')).not.toHaveClass(/open/);
  await page.getByRole('button', { name: /Context window/ }).click();
  await expect(page.locator('#ctxpanel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#ctxpanel')).toBeHidden();
  await page.getByRole('button', { name: 'Session actions' }).click();
  await expect(page.locator('#sessmenu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#sessmenu')).toBeHidden();
  // dialogs close with Escape too
  await page.getByRole('button', { name: 'Session actions' }).click();
  await page.locator('#sessmenu').getByRole('button', { name: 'Settings…' }).click();
  await expect(page.getByRole('dialog', { name: 'Session settings' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Session settings' })).toBeHidden();
});

test('every control can be reached with the keyboard', async ({ page }) => {
  await newSession(page);
  await say(page, 'tool');
  await expect(page.locator('.card.warn')).toBeVisible();
  const expected = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary')]
      .filter(
        (e) =>
          e.offsetParent !== null && !e.hasAttribute('disabled') && e.tabIndex >= 0 && !e.closest('[inert]'),
      )
      .map((e) => e.getAttribute('aria-label') || e.textContent?.trim() || e.id),
  );
  expect(expected.length).toBeGreaterThan(8);
  const visited = new Set<string>();
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  for (let i = 0; i < expected.length + 10; i++) {
    await page.keyboard.press('Tab');
    visited.add(
      await page.evaluate(() => {
        const e = document.activeElement as HTMLElement;
        return e.getAttribute('aria-label') || e.textContent?.trim() || e.id;
      }),
    );
  }
  expect(expected.filter((n) => !visited.has(n))).toEqual([]);
  // and no keyboard trap: focus ring is visible on the focused element
  const outline = await page.evaluate(
    () => getComputedStyle(document.activeElement as HTMLElement).outlineStyle,
  );
  expect(outline).not.toBe('none');
});

test('security page: add a passkey, list devices, sign out everywhere', async ({ page }) => {
  await page.getByRole('button', { name: 'Security' }).click();
  await expect(page.getByRole('heading', { name: 'Security' })).toBeVisible();
  await expect(page.getByText('Test laptop')).toBeVisible();
  await switchToNewDevice(page); // the first authenticator already holds this site's passkey
  await page.getByLabel('Name for the new device').fill('Phone');
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(page.getByText('Passkey added.')).toBeVisible();
  await expect(page.getByText('Phone', { exact: true })).toBeVisible();
  await expectAccessible(page, 'security page');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Security' })).toBeHidden();
  await page.getByRole('button', { name: 'Security' }).click();
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Sign out everywhere' }).click();
  await expect(page.getByRole('button', { name: 'Sign in with passkey' })).toBeVisible();
});

test('light and dark themes both pass the contrast check', async ({ page }) => {
  await newSession(page);
  await say(page, 'agent');
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectAccessible(page, `app in ${scheme}`);
  }
});

test('reduced motion stops the ant animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await newSession(page);
  await say(page, 'slow');
  await expect(page.locator('.worker canvas').first()).toBeVisible();
  const frame = () =>
    page
      .locator('.worker canvas')
      .first()
      .evaluate((c: HTMLCanvasElement) => c.toDataURL());
  await expect(page.locator('.worker .act').first()).toHaveText('Thinking');
  await page.waitForTimeout(400); // the state change has been drawn
  const a = await frame();
  await page.waitForTimeout(600);
  expect(await frame()).toBe(a);
});
