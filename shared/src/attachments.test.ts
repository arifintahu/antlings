import { describe, expect, it } from 'vitest';
import { formatBytes, kindFromName, MAX_FILE_BYTES, sanitizeName } from './attachments.js';

describe('kindFromName', () => {
  it('maps extensions to kinds, ignoring case', () => {
    expect(kindFromName('a.PNG')).toBe('image');
    expect(kindFromName('x.pdf')).toBe('pdf');
    expect(kindFromName('x.ts')).toBe('text');
  });
  it('returns undefined for unsupported names', () => {
    expect(kindFromName('x.exe')).toBeUndefined();
    expect(kindFromName('x.svg')).toBeUndefined();
    expect(kindFromName('noext')).toBeUndefined();
  });
});

describe('sanitizeName', () => {
  it('drops path parts', () => {
    expect(sanitizeName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeName('C:\\a\\b.txt')).toBe('b.txt');
  });
  it('drops control characters and newlines', () => {
    expect(sanitizeName('a\nb\u0000c.txt')).toBe('abc.txt');
  });
  it('cuts to 120 characters and falls back to "file"', () => {
    expect(sanitizeName('x'.repeat(200) + '.txt')).toHaveLength(120);
    expect(sanitizeName('  ')).toBe('file');
  });
  it('keeps emoji', () => {
    expect(sanitizeName('🐜 notes.md')).toBe('🐜 notes.md');
  });
});

describe('formatBytes', () => {
  it('formats B, KB and MB', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(312 * 1024)).toBe('312 KB');
    expect(formatBytes(1.2 * 1024 * 1024)).toBe('1.2 MB');
    expect(formatBytes(MAX_FILE_BYTES)).toBe('5 MB');
  });
});
