import { describe, expect, it } from 'vitest';
import { MAX_FILE_BYTES } from '@antlings/shared';
import { ACCEPT, pastedName, precheck } from './attach.js';

describe('precheck', () => {
  it('accepts a file of exactly 5 MB', () => {
    expect(precheck({ name: 'a.txt', size: MAX_FILE_BYTES }, 0)).toBeUndefined();
  });
  it('rejects a file over 5 MB with the size and the limit', () => {
    expect(precheck({ name: 'big.txt', size: 6 * 1024 * 1024 }, 0)).toBe(
      'big.txt is 6 MB. The limit is 5 MB per file.',
    );
    expect(precheck({ name: 'big.txt', size: MAX_FILE_BYTES + 1 }, 0)).toMatch(/limit is 5 MB per file/);
  });
  it('rejects an empty file', () => {
    expect(precheck({ name: 'e.txt', size: 0 }, 0)).toBe('e.txt is empty.');
  });
  it('rejects an unsupported type', () => {
    expect(precheck({ name: 'run.exe', size: 10 }, 0)).toBe('This file type is not supported.');
    expect(precheck({ name: 'pic.svg', size: 10 }, 0)).toBe('This file type is not supported.');
  });
  it('rejects the sixth file', () => {
    expect(precheck({ name: 'a.png', size: 10 }, 4)).toBeUndefined();
    expect(precheck({ name: 'a.png', size: 10 }, 5)).toBe('Only 5 files per message.');
  });
  it('shows a cleaned name in the message', () => {
    expect(precheck({ name: '../x\ny.exe', size: 10 }, 0)).toBe('This file type is not supported.');
    expect(precheck({ name: 'dir/big.txt', size: 6 * 1024 * 1024 }, 0)).toMatch(/^big\.txt is/);
  });
});

describe('pastedName', () => {
  it('names a pasted image by the time and type', () => {
    const now = new Date(2026, 9, 28, 14, 2, 3);
    expect(pastedName({ type: 'image/png' }, now)).toBe('pasted-image-14-02-03.png');
    expect(pastedName({ type: 'image/jpeg' }, now)).toBe('pasted-image-14-02-03.jpg');
    expect(pastedName({ type: 'image/webp' }, now)).toBe('pasted-image-14-02-03.webp');
    expect(pastedName({ type: '' }, now)).toBe('pasted-image-14-02-03.png');
  });
});

describe('ACCEPT', () => {
  it('names image and pdf types, so a phone offers its photo library, as well as extensions', () => {
    const parts = ACCEPT.split(',');
    for (const t of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/*'])
      expect(parts).toContain(t);
    expect(parts).toContain('.md');
    expect(parts).toContain('.ts');
  });
});
