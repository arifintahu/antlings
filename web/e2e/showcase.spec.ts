import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { addAuthenticator, firstRun, newSession, say, unlock } from './helpers.js';

// Writes the screenshots shown in the README. Run on its own with: pnpm e2e showcase
const SHOTS = new URL('../../docs/screens/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

test.beforeEach(async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await addAuthenticator(page);
  await unlock(page);
  await firstRun(page);
});

test('desktop screenshots', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 920 });
  await newSession(page);
  await say(page, 'showcase');
  await expect(page.locator('.card.warn')).toContainText('Edit /home/dev/app/src/range.ts');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}desktop-conversation.png` });

  await page.getByRole('button', { name: 'Security' }).click();
  await expect(page.getByRole('heading', { name: 'Server status' })).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}desktop-security.png` });
});

test('phone screenshots', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await newSession(page);
  await say(page, 'showcase');
  await expect(page.locator('.card.warn')).toContainText('Edit /home/dev/app/src/range.ts');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}phone-conversation.png` });
  await page.getByRole('button', { name: /Agents/ }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}phone-agents.png` });
  await page.getByRole('button', { name: 'Open sessions' }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}phone-sessions.png` });
});

test('connections screenshot', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 920 });
  await page.request.post('http://localhost:3199/__e2e/connections-reset', {
    headers: { origin: 'http://localhost:3199' },
  });
  await page.getByRole('button', { name: 'Connections' }).click();
  await page.getByRole('button', { name: 'Connect GitHub' }).click();
  await expect(page.getByLabel('One-time code')).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}desktop-connections.png` });
});
