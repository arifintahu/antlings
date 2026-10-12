import { expect, test } from '@playwright/test';
import { addAuthenticator, expectAccessible, firstRun, resetServer, totp, unlock } from './helpers.js';

test.beforeEach(async ({ page }) => {
  await addAuthenticator(page);
  await unlock(page);
});

test('first run: setup code, passkey, then the app opens', async ({ page }) => {
  const code = await resetServer(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to Antlings' })).toBeVisible();
  await expectAccessible(page, 'first-run step 1');
  // a wrong code is refused
  await page.getByLabel('Setup code').fill('ANT-0000-0000');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'not valid' })).toBeVisible();
  await page.getByLabel('Setup code').fill(code);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Step 2 of 3')).toBeVisible();
  await page.getByRole('button', { name: 'Create passkey' }).click();
  await expect(page.getByText('Step 3 of 3')).toBeVisible();
  await expectAccessible(page, 'first-run step 3');
  await page.getByRole('button', { name: /Skip/ }).click();
  await expect(page.getByRole('heading', { name: 'Your colony is ready' })).toBeVisible();
  await page.getByRole('button', { name: 'Open Antlings' }).click();
  await expect(page.getByText('No session open')).toBeVisible();
  await expectAccessible(page, 'empty app');
});

test('first-run closes once a credential exists', async ({ page }) => {
  await firstRun(page);
  const res = await page.request.post('http://localhost:3199/api/setup/options', {
    headers: { origin: 'http://localhost:3199' },
    data: { code: 'ANT-AAAA-BBBB' },
  });
  expect(res.status()).toBe(404);
});

test('passkey sign-in after signing out', async ({ page }) => {
  await firstRun(page);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Antlings', level: 1 })).toBeVisible();
  await expectAccessible(page, 'login');
  await page.getByRole('button', { name: 'Sign in with passkey' }).click();
  await expect(page.getByText('No session open')).toBeVisible();
  // a reload keeps the session
  await page.reload();
  await expect(page.getByText('No session open')).toBeVisible();
});

test('password then one-time code', async ({ page }) => {
  const { secret } = await firstRun(page, { fallback: { password: 'correct horse battery staple' } });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Use password instead' }).click();
  await page.getByLabel('Password').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByLabel('6-digit code from your authenticator app')).toBeVisible();
  await expectAccessible(page, 'login code step');
  // the code used during setup is spent; the next 30 s window is accepted
  await page.getByLabel('6-digit code from your authenticator app').fill(totp(secret!, 1));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByText('No session open')).toBeVisible();
});

test('five wrong passwords lock sign-in with a countdown', async ({ page }) => {
  await firstRun(page, { fallback: { password: 'correct horse battery staple' } });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Use password instead' }).click();
  for (let i = 0; i < 5; i++) {
    await page.getByLabel('Password').fill('wrong wrong wrong');
    await page.getByRole('button', { name: 'Continue' }).click();
    if (i < 4) await expect(page.getByRole('alert').filter({ hasText: 'Wrong password' })).toBeVisible();
  }
  await page.getByLabel('Password').fill('wrong wrong wrong');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Too many attempts')).toBeVisible();
  await expect(page.getByText(/1[45]:\d\d/)).toBeVisible();
  await expectAccessible(page, 'locked');
  await unlock(page);
});

test('a signed-out API call sends the page back to the login screen', async ({ page }) => {
  await firstRun(page);
  await page.context().clearCookies();
  await page.getByRole('button', { name: 'New session' }).first().click();
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByRole('button', { name: 'Sign in with passkey' })).toBeVisible();
});
