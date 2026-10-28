import { describe, expect, it } from 'vitest';
import { MAX_FILE_BYTES } from '@antlings/shared';
import { buildContent, type ContentBlock } from './promptContent.js';
import type { StoredUpload } from './uploads.js';

const MB = 1024 * 1024;
const file = (over: Partial<StoredUpload> & { name: string }): StoredUpload => ({
  id: over.name,
  sessionId: 's',
  size: 1024,
  kind: 'image',
  mime: 'image/png',
  path: `/data/uploads/s/${over.name}`,
  sent: false,
  ...over,
});
const read = (f: StoredUpload) => Buffer.alloc(Math.min(f.size, 16), 1);
const blocks = (c: string | ContentBlock[]) => c as ContentBlock[];

describe('buildContent', () => {
  it('returns the text unchanged when there are no files', () => {
    expect(buildContent('hello', [], read)).toBe('hello');
  });

  it('sends an image as an image block before the text', () => {
    const c = blocks(buildContent('what is this', [file({ name: 'a.png' })], read));
    expect(c).toEqual([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: read(file({ name: 'a.png' })).toString('base64'),
        },
      },
      { type: 'text', text: 'what is this' },
    ]);
  });

  it('adds a default sentence when there is no text', () => {
    const c = blocks(buildContent('  ', [file({ name: 'a.png' })], read));
    expect(c.at(-1)).toEqual({ type: 'text', text: 'See the attached file(s).' });
  });

  it('lists a pdf as a path line with its name and size', () => {
    const pdf = file({
      name: 'spec-v3.pdf',
      kind: 'pdf',
      mime: 'application/pdf',
      size: Math.round(1.2 * MB),
    });
    const c = blocks(buildContent('read it', [pdf], read));
    expect(c).toEqual([
      { type: 'text', text: 'read it' },
      {
        type: 'text',
        text: 'Attached files (saved on the server, open them with the Read tool):\n- /data/uploads/s/spec-v3.pdf (spec-v3.pdf, 1.2 MB)',
      },
    ]);
  });

  it('keeps inline images within 20 MB and sends the rest as path lines', () => {
    const five = [1, 2, 3, 4, 5].map((n) => file({ name: `${n}.png`, size: MAX_FILE_BYTES }));
    const c = blocks(buildContent('look', five, read));
    expect(c.filter((b) => b.type === 'image')).toHaveLength(4);
    const list = c.at(-1) as { text: string };
    expect(list.text).toContain('- /data/uploads/s/5.png (5.png, 5 MB)');
    expect(list.text).not.toContain('1.png');
  });

  it('sends an image over the file limit as a path line', () => {
    const c = blocks(buildContent('x', [file({ name: 'huge.png', size: MAX_FILE_BYTES + 1 })], read));
    expect(c.some((b) => b.type === 'image')).toBe(false);
    expect((c.at(-1) as { text: string }).text).toContain('huge.png');
  });

  it('keeps each path line on one line', () => {
    const f = file({ name: 'a b.txt', kind: 'text', mime: 'text/plain' });
    const text = (blocks(buildContent('x', [f], read)).at(-1) as { text: string }).text;
    expect(text.split('\n')).toHaveLength(2);
  });
});
