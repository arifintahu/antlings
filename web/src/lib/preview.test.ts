import { describe, expect, it } from 'vitest';
import { buildPreview } from './preview.js';

describe('buildPreview', () => {
  it('shows a Bash command as is', () => {
    const p = buildPreview('Bash', { command: 'rm -rf build\nls', description: 'Clean the build' });
    expect(p.summary).toBe('Clean the build');
    expect(p.lines).toEqual([
      { kind: 'ctx', text: 'rm -rf build' },
      { kind: 'ctx', text: 'ls' },
    ]);
  });

  it('shows the content of a Write as added lines', () => {
    const p = buildPreview('Write', { file_path: '/home/a/x.txt', content: 'hi\nthere' });
    expect(p.summary).toBe('Create or overwrite /home/a/x.txt');
    expect(p.lines.map((l) => l.kind)).toEqual(['add', 'add']);
  });

  it('shows an Edit as removed then added lines', () => {
    const p = buildPreview('Edit', { file_path: 'a.ts', old_string: 'foo', new_string: 'bar\nbaz' });
    expect(p.lines).toEqual([
      { kind: 'del', text: 'foo' },
      { kind: 'add', text: 'bar' },
      { kind: 'add', text: 'baz' },
    ]);
  });

  it('cuts a long body and long lines', () => {
    const p = buildPreview('Write', {
      file_path: 'a',
      content: Array.from({ length: 200 }, () => 'x'.repeat(500)).join('\n'),
    });
    expect(p.lines).toHaveLength(60);
    expect(p.truncated).toBe(true);
    expect(p.lines[0]!.text.length).toBeLessThanOrEqual(241);
  });

  it('falls back to a summary and JSON for unknown tools, and never throws on odd input', () => {
    expect(buildPreview('mcp__x__do', { path: '/a', n: 1 }).summary).toBe('mcp__x__do: /a');
    expect(buildPreview('Bash', null).lines).toEqual([{ kind: 'ctx', text: '' }]);
    expect(buildPreview('Whatever', undefined).summary).toBe('Whatever');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => buildPreview('Whatever', circular)).not.toThrow();
  });
});
