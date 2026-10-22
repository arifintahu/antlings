import { expect, test, type Page } from '@playwright/test';
import { addAuthenticator, expectAccessible, firstRun, unlock } from './helpers.js';

const ORIGIN = 'http://localhost:3199';

async function openConnections(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Connections' }).click();
  await expect(page.getByRole('heading', { name: 'Connections', level: 1 })).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await addAuthenticator(page);
  await unlock(page);
  await firstRun(page);
  await page.request.post(`${ORIGIN}/__e2e/connections-reset`, { headers: { origin: ORIGIN } });
  await openConnections(page);
});

test('GitHub: shows the device code, connects, disconnects', async ({ page }) => {
  await expect(page.getByText('Not connected')).toBeVisible();
  await page.getByRole('button', { name: 'Connect GitHub' }).click();
  await expect(page.getByLabel('One-time code')).toHaveText('ABCD-1234');
  const open = page.getByRole('link', { name: 'Open GitHub' });
  await expect(open).toHaveAttribute('href', 'https://github.com/login/device');
  await expect(open).toHaveAttribute('rel', /noopener/);
  await expect(page.getByText('Connected as octo')).toBeVisible();
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Disconnect GitHub' }).click();
  await expect(page.getByText('Not connected')).toBeVisible();
});

test('Claude API key: a refused key is not echoed, a good key is saved then removed', async ({ page }) => {
  const key = page.getByLabel('Anthropic API key');
  await expect(key).toHaveAttribute('type', 'password');
  await key.fill('sk-ant-bad-key-1234567890');
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'did not accept' })).toBeVisible();
  expect(await page.locator('body').innerText()).not.toContain('sk-ant-bad');

  await key.fill('sk-ant-good-key-1234567890');
  await page.getByRole('button', { name: 'Save key' }).click();
  await expect(page.getByText('API key saved and checked.')).toBeVisible();
  await expect(page.getByText('Using a saved API key')).toBeVisible();
  await expect(page.getByLabel('Replace the API key')).toHaveValue('');
  expect(await page.locator('body').innerText()).not.toContain('sk-ant-good');

  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Remove key' }).click();
  await expect(page.getByText('No API key yet')).toBeVisible();
});

test('Claude subscription: the terms box gates the switch, then the code signs in', async ({ page }) => {
  await page.getByRole('radio', { name: 'Claude subscription' }).check();
  const use = page.getByRole('button', { name: 'Use my subscription' });
  await expect(use).toBeDisabled();
  await page.getByLabel('I have read this and accept the risk').check();
  await use.click();
  await page.getByRole('button', { name: 'Sign in with Claude' }).click();
  const link = page.getByRole('link', { name: 'Open Claude sign-in' });
  await expect(link).toHaveAttribute('href', /^https:\/\/claude\.com\//);
  await page.getByLabel('Code from Claude').fill('goodcode1');
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByText('Signed in with your Claude subscription (max)')).toBeVisible();
  expect(await page.locator('body').innerText()).not.toContain('example.com');

  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Sign out of Claude' }).click();
  await expect(page.getByText('Subscription selected, not signed in')).toBeVisible();
});

test('passes the contrast check in light and dark', async ({ page }) => {
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectAccessible(page, `connections in ${scheme}`);
  }
  await page.getByRole('radio', { name: 'Claude subscription' }).check();
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectAccessible(page, `connections (subscription) in ${scheme}`);
  }
});

test('fits a 375 px phone and animates nothing under reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 375, height: 800 });
  const sec = page.locator('section.sec');
  expect(await sec.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.getByRole('button', { name: 'Connect GitHub' }).click();
  await expect(page.getByLabel('One-time code')).toBeVisible();
  expect(await sec.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  for (const b of await page.locator('section.sec button:visible, section.sec a.btn:visible').all()) {
    const box = await b.boundingBox();
    expect(box?.height ?? 0, await b.innerText()).toBeGreaterThanOrEqual(44);
  }
});
