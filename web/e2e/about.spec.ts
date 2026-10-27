import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { addAuthenticator, expectAccessible, firstRun, unlock } from './helpers.js';

// The label follows the server's package.json, the same source as the Security page.
const VERSION = (
  JSON.parse(readFileSync(new URL('../../server/package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

test.beforeEach(async ({ page }) => {
  await addAuthenticator(page);
  await unlock(page);
  await firstRun(page);
});

test('the sidebar shows the version and opens About, which closes with Escape or Close', async ({ page }) => {
  const trigger = page.getByRole('button', { name: `About Antlings, version ${VERSION}` });
  await expect(trigger).toHaveText(`About · v${VERSION}`);
  await trigger.click();

  const dlg = page.getByRole('dialog', { name: 'About Antlings' });
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText(`Version ${VERSION}`);
  await expect(dlg.getByRole('link', { name: 'Release notes' })).toHaveAttribute(
    'href',
    `https://github.com/arifintahu/antlings/releases/tag/v${VERSION}`,
  );
  await expect(dlg.getByRole('link', { name: 'Source code' })).toHaveAttribute(
    'href',
    'https://github.com/arifintahu/antlings',
  );
  await expect(dlg.getByRole('link', { name: 'Release notes' })).toHaveAttribute('rel', /noopener/);

  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await dlg.getByRole('button', { name: 'Close' }).click();
  await expect(dlg).toBeHidden();
});

test('light and dark: the label and the dialog pass the accessibility checks', async ({ page }) => {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectAccessible(page, `sidebar footer, ${scheme}`);
  }
  await page.getByRole('button', { name: /^About Antlings/ }).click();
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectAccessible(page, `About dialog, ${scheme}`);
  }
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 800 } });

  test('About is in the drawer, fits the screen and has 44 px targets', async ({ page }) => {
    await page.getByRole('button', { name: 'Open sessions' }).click();
    const trigger = page.getByRole('button', { name: /^About Antlings/ });
    await expect(trigger).toBeVisible();
    expect((await trigger.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await trigger.click();

    const dlg = page.getByRole('dialog', { name: 'About Antlings' });
    await expect(dlg).toBeVisible();
    const box = (await dlg.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    for (const name of ['Release notes', 'Source code', 'Close']) {
      const el = dlg.getByRole(name === 'Close' ? 'button' : 'link', { name });
      expect((await el.boundingBox())!.height, name).toBeGreaterThanOrEqual(44);
    }
    await expectAccessible(page, 'About on a phone');
  });
});
