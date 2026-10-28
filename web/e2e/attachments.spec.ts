import { expect, test, type Page } from '@playwright/test';
import { addAuthenticator, expectAccessible, firstRun, newSession, say, unlock } from './helpers.js';

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const png = (name = 'shot.png') => ({ name, mimeType: 'image/png', buffer: Buffer.from(PNG_B64, 'base64') });
const text = (name: string, body = 'hello') => ({ name, mimeType: 'text/plain', buffer: Buffer.from(body) });

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
  await newSession(page);
});

test.afterEach(async ({ page }) => {
  expect(problems.get(page)).toEqual([]);
});

const attach = (page: Page, files: Parameters<ReturnType<Page['locator']>['setInputFiles']>[0]) =>
  page.locator('input[type=file]').setInputFiles(files);
const chip = (page: Page, name: string) => page.locator('.tray .file-chip', { hasText: name });

/** Dispatches a paste carrying a PNG file, and optionally text. Returns whether the page cancelled the event. */
const pasteImage = (page: Page, withText: boolean) =>
  page.getByLabel('Message').evaluate(
    (el, args) => {
      const dt = new DataTransfer();
      const bytes = Uint8Array.from(atob(args.b64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
      if (args.withText) dt.setData('text/plain', 'copied words');
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    },
    { b64: PNG_B64, withText },
  );

test('the picker adds an image, and sending shows it in the conversation', async ({ page }) => {
  await attach(page, png());
  await expect(chip(page, 'shot.png')).toContainText('Ready');
  await say(page, 'describe this');
  await expect(page.getByText('I got 1 image(s) and 0 file(s)')).toBeVisible();
  await expect(page.locator('.msg.user .file-chip', { hasText: 'shot.png' })).toBeVisible();
  await expect(page.locator('.composer .file-chip')).toHaveCount(0);
});

test('a text file is sent as a path line', async ({ page }) => {
  await attach(page, text('notes.md'));
  await expect(chip(page, 'notes.md')).toContainText('Ready');
  await say(page, 'describe the file');
  await expect(page.getByText('I got 0 image(s) and 1 file(s)')).toBeVisible();
});

test('pasting an image adds a named chip', async ({ page }) => {
  expect(await pasteImage(page, false)).toBe(true);
  await expect(page.locator('.tray .file-chip .nm').first()).toHaveText(/^pasted-image-\d\d-\d\d-\d\d\.png$/);
  await expect(page.locator('.tray .file-chip').first()).toContainText('Ready');
});

test('pasting text together with an image keeps the text paste', async ({ page }) => {
  expect(await pasteImage(page, true)).toBe(false); // the page did not cancel, so the text still pastes
  await expect(page.locator('.tray .file-chip')).toHaveCount(1);
});

test('send works with only a file', async ({ page }) => {
  await attach(page, png());
  await expect(chip(page, 'shot.png')).toContainText('Ready');
  const send = page.getByRole('button', { name: 'Send' });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByText('echo See the attached file(s).')).toBeVisible();
});

test('send waits while no file is ready and no text is typed', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
});

test('refused files show a red chip and a reason, and never upload', async ({ page }) => {
  const uploads: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/uploads')) uploads.push(r.url());
  });
  await attach(page, [
    { name: 'big.txt', mimeType: 'text/plain', buffer: Buffer.alloc(6 * 1024 * 1024, 'a') },
    { name: 'run.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ') },
  ]);
  await expect(chip(page, 'big.txt')).toContainText('Not attached');
  await expect(chip(page, 'run.exe')).toContainText('Not attached');
  await expect(page.getByRole('alert')).toHaveText('This file type is not supported.');
  await attach(page, text('ok.txt'));
  await expect(chip(page, 'ok.txt')).toContainText('Ready');
  expect(uploads).toHaveLength(1);
  await page.getByRole('button', { name: 'Remove run.exe' }).click();
  await expect(page.getByRole('alert')).toHaveText('big.txt is 6 MB. The limit is 5 MB per file.');
});

test('a sixth file is refused', async ({ page }) => {
  await attach(
    page,
    [1, 2, 3, 4, 5, 6].map((n) => text(`f${n}.txt`)),
  );
  await expect(chip(page, 'f6.txt')).toContainText('Not attached');
  await expect(page.getByRole('alert')).toHaveText('Only 5 files per message.');
  await expect(page.locator('.tray .file-chip', { hasText: 'Ready' })).toHaveCount(5);
});

test('removing a chip clears it and disables Send again', async ({ page }) => {
  await attach(page, png());
  await expect(chip(page, 'shot.png')).toContainText('Ready');
  await page.getByRole('button', { name: 'Remove shot.png' }).click();
  await expect(page.locator('.tray .file-chip')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
});

test('going offline keeps the chips and the typed text', async ({ page, context }) => {
  await attach(page, png());
  await expect(chip(page, 'shot.png')).toContainText('Ready');
  await page.getByLabel('Message').fill('keep me');
  await context.setOffline(true);
  await page.request.post('http://localhost:3199/__e2e/drop-sockets', {
    headers: { origin: 'http://localhost:3199' },
  });
  await expect(page.getByText('Offline. Reconnecting…')).toBeVisible({ timeout: 10_000 });
  await expect(chip(page, 'shot.png')).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText('Offline. Reconnecting…')).toBeHidden({ timeout: 15_000 });
  await expect(page.getByLabel('Message')).toHaveValue('keep me');
  await expect(chip(page, 'shot.png')).toContainText('Ready');
});

test('dropping a file shows the overlay and attaches it', async ({ page }) => {
  const dt = await page.evaluateHandle((b64) => {
    const d = new DataTransfer();
    d.items.add(
      new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'dropped.png', { type: 'image/png' }),
    );
    return d;
  }, PNG_B64);
  await page.locator('.col').dispatchEvent('dragenter', { dataTransfer: dt });
  await expect(page.getByText('Drop to attach')).toBeVisible();
  await page.locator('.col').dispatchEvent('drop', { dataTransfer: dt });
  await expect(page.getByText('Drop to attach')).toBeHidden();
  await expect(chip(page, 'dropped.png')).toContainText('Ready');
});

test('chips and errors pass the contrast check in light and dark, and do not animate', async ({ page }) => {
  await attach(page, [png(), text('run.exe', 'MZ')]);
  await expect(chip(page, 'shot.png')).toContainText('Ready');
  await expect(page.getByRole('alert')).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await expectAccessible(page, `attachments in ${scheme}`);
  }
  const moving = await page
    .locator('.tray .file-chip')
    .evaluateAll((els) =>
      els.filter(
        (e) =>
          getComputedStyle(e).animationName !== 'none' || getComputedStyle(e).transitionDuration !== '0s',
      ),
    );
  expect(moving).toHaveLength(0);
});

test('file chips have no state marker square', async ({ page }) => {
  await attach(page, png());
  await expect(chip(page, 'shot.png')).toContainText('Ready');
  const marker = await page
    .locator('.tray [class*="chip"]')
    .first()
    .evaluate((el) => getComputedStyle(el, '::before').content);
  expect(marker).toBe('none');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test('the paperclip is on screen, opens the picker and the file uploads', async ({ page }) => {
    const btn = page.getByRole('button', { name: 'Attach file' });
    await expect(btn).toBeVisible();
    const box = (await btn.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    expect(box.height).toBeGreaterThanOrEqual(44);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), btn.tap()]);
    await chooser.setFiles(png());
    await expect(chip(page, 'shot.png')).toContainText('Ready');
  });
});

test('a file picked while the connection is down is still attached', async ({ page, context }) => {
  // On a phone the page is suspended while the system picker is open and the socket drops.
  await context.setOffline(true);
  await page.request.post('http://localhost:3199/__e2e/drop-sockets', {
    headers: { origin: 'http://localhost:3199' },
  });
  await expect(page.getByText('Offline. Reconnecting…')).toBeVisible({ timeout: 10_000 });
  await attach(page, png());
  await expect(chip(page, 'shot.png')).toBeVisible();
  await context.setOffline(false);
});
