import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from './markdown.js';

describe('parseInline', () => {
  it('reads code, bold, italic and links', () => {
    expect(parseInline('a `x` **b** *c* [d](https://e.com)')).toEqual([
      { t: 'text', v: 'a ' },
      { t: 'code', v: 'x' },
      { t: 'text', v: ' ' },
      { t: 'strong', v: [{ t: 'text', v: 'b' }] },
      { t: 'text', v: ' ' },
      { t: 'em', v: [{ t: 'text', v: 'c' }] },
      { t: 'text', v: ' ' },
      { t: 'link', href: 'https://e.com', v: [{ t: 'text', v: 'd' }] },
    ]);
  });

  it('turns a bare URL into a link and keeps trailing punctuation outside', () => {
    expect(parseInline('see https://a.example/x.')).toEqual([
      { t: 'text', v: 'see ' },
      { t: 'link', href: 'https://a.example/x', v: [{ t: 'text', v: 'https://a.example/x' }] },
      { t: 'text', v: '.' },
    ]);
  });

  it('does not make links out of javascript:, data: or other schemes', () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,<b>x</b>',
      'vbscript:x',
      'file:///etc/passwd',
    ]) {
      const out = parseInline(`[click](${bad})`);
      expect(out.some((n) => n.t === 'link')).toBe(false);
    }
  });

  it('keeps HTML as plain text', () => {
    const out = parseInline('<img src=x onerror=alert(1)> <script>x</script>');
    expect(out).toEqual([{ t: 'text', v: '<img src=x onerror=alert(1)> <script>x</script>' }]);
  });

  it('leaves snake_case words and lone stars alone', () => {
    expect(parseInline('use my_var_name and 2 * 3')).toEqual([{ t: 'text', v: 'use my_var_name and 2 * 3' }]);
  });
});

describe('parseMarkdown', () => {
  it('splits paragraphs, headings, lists, quotes and fenced code', () => {
    const md =
      '# Title\n\nHello\nworld\n\n- a\n- b\n\n1. one\n2. two\n\n> quoted\n\n```ts\nconst x = 1;\n\nfoo();\n```\nend';
    const b = parseMarkdown(md);
    expect(b.map((x) => x.t)).toEqual(['h', 'p', 'ul', 'ol', 'quote', 'code', 'p']);
    expect(b[5]).toEqual({ t: 'code', lang: 'ts', v: 'const x = 1;\n\nfoo();' });
    expect((b[2] as { v: unknown[] }).v).toHaveLength(2);
  });

  it('keeps one list across blank lines between items, so numbers go on counting', () => {
    const b = parseMarkdown('1. one\n\n2. two\n\n3. three\n\ntext');
    expect(b.map((x) => x.t)).toEqual(['ol', 'p']);
    expect(b[0]).toMatchObject({ t: 'ol', v: [expect.anything(), expect.anything(), expect.anything()] });
    expect(parseMarkdown('- a\n\n- b').map((x) => x.t)).toEqual(['ul']);
    expect(parseMarkdown('- a\n\ntext\n\n- b').map((x) => x.t)).toEqual(['ul', 'p', 'ul']);
  });

  it('keeps an unclosed code fence as code to the end', () => {
    expect(parseMarkdown('```\nopen')).toEqual([{ t: 'code', lang: '', v: 'open' }]);
  });

  it('handles empty and whitespace input', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('\n\n  \n')).toEqual([]);
  });

  it('is fast on a large input', () => {
    const big = 'word '.repeat(50_000);
    const t = Date.now();
    parseMarkdown(big);
    expect(Date.now() - t).toBeLessThan(1500);
  });
});
