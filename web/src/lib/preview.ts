/** Turns a tool request into something a person can check before approving it. */

export interface PreviewLine {
  kind: 'add' | 'del' | 'ctx';
  text: string;
}

export interface Preview {
  /** One line: what is about to happen. */
  summary: string;
  /** The body to show: command, file content, or a diff. */
  lines: PreviewLine[];
  /** True when the body was cut. */
  truncated: boolean;
}

const MAX_LINES = 60;
const MAX_LINE = 240;

const cut = (s: string): string => (s.length > MAX_LINE ? `${s.slice(0, MAX_LINE)}…` : s);

function asLines(text: string, kind: PreviewLine['kind']): PreviewLine[] {
  return text.split('\n').map((t) => ({ kind, text: cut(t) }));
}

function limit(lines: PreviewLine[]): { lines: PreviewLine[]; truncated: boolean } {
  return lines.length > MAX_LINES
    ? { lines: lines.slice(0, MAX_LINES), truncated: true }
    : { lines, truncated: false };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function buildPreview(toolName: string, input: unknown): Preview {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  let summary: string;
  let lines: PreviewLine[] = [];
  switch (toolName) {
    case 'Bash':
      summary = str(o.description) || 'Run this command';
      lines = asLines(str(o.command), 'ctx');
      break;
    case 'Write':
      summary = `Create or overwrite ${str(o.file_path)}`;
      lines = asLines(str(o.content), 'add');
      break;
    case 'Edit':
      summary = `Edit ${str(o.file_path)}${o.replace_all === true ? ' (every match)' : ''}`;
      lines = [...asLines(str(o.old_string), 'del'), ...asLines(str(o.new_string), 'add')];
      break;
    case 'MultiEdit': {
      summary = `Edit ${str(o.file_path)}`;
      const edits = Array.isArray(o.edits) ? (o.edits as Record<string, unknown>[]) : [];
      for (const e of edits)
        lines.push(...asLines(str(e.old_string), 'del'), ...asLines(str(e.new_string), 'add'));
      break;
    }
    case 'Read':
      summary = `Read ${str(o.file_path)}`;
      break;
    case 'WebFetch':
      summary = `Fetch ${str(o.url)}`;
      lines = asLines(str(o.prompt), 'ctx');
      break;
    case 'WebSearch':
      summary = `Search the web for: ${str(o.query)}`;
      break;
    default: {
      const first = ['file_path', 'path', 'pattern', 'command', 'url', 'query', 'description'].find(
        (k) => typeof o[k] === 'string',
      );
      summary = first ? `${toolName}: ${cut(str(o[first]))}` : toolName;
      try {
        const json = JSON.stringify(input, null, 2);
        if (json && json !== '{}') lines = asLines(json, 'ctx');
      } catch {
        /* not serialisable: summary only */
      }
    }
  }
  const { lines: l, truncated } = limit(lines);
  return { summary, lines: l, truncated };
}
