import AxeBuilder from '@axe-core/playwright';
import { expect, type CDPSession, type Page } from '@playwright/test';
import * as OTPAuth from 'otpauth';

const ORIGIN = 'http://localhost:3199';

const devices = new WeakMap<Page, { cdp: CDPSession; id: string }>();

/** Adds a virtual passkey authenticator that approves every prompt (browser-side WebAuthn). */
export async function addAuthenticator(page: Page): Promise<void> {
  const cdp = devices.get(page)?.cdp ?? (await page.context().newCDPSession(page));
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  devices.set(page, { cdp, id: authenticatorId });
}

/** Swaps in a second, empty authenticator, like registering a passkey on another device. */
export async function switchToNewDevice(page: Page): Promise<void> {
  const old = devices.get(page);
  if (old) await old.cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: old.id }); // Chrome allows one internal device
  await addAuthenticator(page);
}

export async function resetServer(page: Page): Promise<string> {
  await page.request.post(`${ORIGIN}/__e2e/unlock`, { headers: { origin: ORIGIN } });
  const r = await page.request.post(`${ORIGIN}/__e2e/reset`, { headers: { origin: ORIGIN } });
  return ((await r.json()) as { code: string }).code;
}

export const unlock = (page: Page) =>
  page.request.post(`${ORIGIN}/__e2e/unlock`, { headers: { origin: ORIGIN } });
export const dropSockets = (page: Page) =>
  page.request.post(`${ORIGIN}/__e2e/drop-sockets`, { headers: { origin: ORIGIN } });

/** First-run: setup code, passkey, skip the fallback, open the app. */
export async function firstRun(
  page: Page,
  opts: { fallback?: { password: string } } = {},
): Promise<{ secret?: string }> {
  const code = await resetServer(page);
  await page.goto('/');
  await page.getByLabel('Setup code').fill(code);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Name this device').fill('Test laptop');
  await page.getByRole('button', { name: 'Create passkey' }).click();
  let secret: string | undefined;
  if (opts.fallback) {
    await page.getByLabel(/Backup password/).fill(opts.fallback.password);
    await page.getByRole('button', { name: 'Set password' }).click();
    secret = (await page.locator('code.secret').innerText()).trim();
    await page.getByLabel('Code from the app').fill(totp(secret));
    await page.getByRole('button', { name: 'Confirm' }).click();
  } else {
    await page.getByRole('button', { name: /Skip/ }).click();
  }
  await page.getByRole('button', { name: 'Open Antlings' }).click();
  await expect(page.getByText('No session open')).toBeVisible();
  return { secret };
}

export function totp(secret: string, offsetSteps = 0): string {
  return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 }).generate({
    timestamp: Date.now() + offsetSteps * 30_000,
  });
}

/** Chooses ~/proj in the new-session dialog (it may already be the default). */
export async function pickProj(page: Page): Promise<void> {
  const dlg = page.getByRole('dialog', { name: 'New session' });
  if ((await dlg.locator('.pathbox').innerText()).includes('~/proj')) return;
  await dlg.getByRole('button', { name: /Change/ }).click();
  await page.getByRole('button', { name: 'proj', exact: true }).click();
  await page.getByRole('button', { name: 'Use this folder' }).click();
}

/** Starts a session in ~/proj through the dialog. */
export async function newSession(page: Page, mode?: string): Promise<void> {
  // on a phone the New button lives in the sessions drawer
  if ((page.viewportSize()?.width ?? 1280) < 900)
    await page.getByRole('button', { name: 'Open sessions' }).click();
  await page.getByRole('button', { name: 'New session' }).first().click();
  const dlg = page.getByRole('dialog', { name: 'New session' });
  await pickProj(page);
  if (mode) await dlg.getByLabel('Mode').selectOption(mode);
  await dlg.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByLabel('Message')).toBeEnabled();
}

export async function say(page: Page, text: string): Promise<void> {
  await page.getByLabel('Message').fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
}

/** Fails the test when axe finds a serious or critical problem. */
export async function expectAccessible(page: Page, context: string): Promise<void> {
  const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const bad = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    bad.map(
      (v) =>
        `${v.id}: ${v.help} (${v.nodes
          .slice(0, 3)
          .map((n) => `${n.target.join(' ')} ${JSON.stringify(n.any[0]?.data ?? {}).slice(0, 160)}`)
          .join(' | ')})`,
    ),
    `axe on ${context}`,
  ).toEqual([]);
}
