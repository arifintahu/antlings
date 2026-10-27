/**
 * A small markdown reader for assistant text. It produces a tree of plain data that Svelte renders as text
 * nodes, so nothing is ever inserted as HTML. Links are limited to http, https and mailto.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; v: Inline[] }
  | { t: 'em'; v: Inline[] }
  | { t: 'link'; href: string; v: Inline[] };

export type Block =
  | { t: 'p'; v: Inline[] }
  | { t: 'h'; level: 1 | 2 | 3; v: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'ul'; v: Inline[][] }
  | { t: 'ol'; v: Inline[][] }
  | { t: 'quote'; v: Inline[] };

const SAFE_HREF = /^(https?:\/\/|mailto:)[^\s<>"']+$/i;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ t: 'text', v: text });
    text = '';
  };
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    let m: RegExpExecArray | null;
    if (rest.startsWith('`') && (m = /^`([^`\n]+)`/.exec(rest))) {
      flush();
      out.push({ t: 'code', v: m[1]! });
      i += m[0].length;
    } else if ((m = /^\*\*([^\n]+?)\*\*/.exec(rest)) || (m = /^__([^\n]+?)__/.exec(rest))) {
      flush();
      out.push({ t: 'strong', v: parseInline(m[1]!) });
      i += m[0].length;
    } else if ((m = /^\*([^*\s][^*\n]*?)\*/.exec(rest)) || (m = /^_([^_\s][^_\n]*?)_(?![\w])/.exec(rest))) {
      flush();
      out.push({ t: 'em', v: parseInline(m[1]!) });
      i += m[0].length;
    } else if ((m = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest)) && SAFE_HREF.test(m[2]!)) {
      flush();
      out.push({ t: 'link', href: m[2]!, v: parseInline(m[1]!) });
      i += m[0].length;
    } else if ((m = /^(https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?])/.exec(rest))) {
      flush();
      out.push({ t: 'link', href: m[1]!, v: [{ t: 'text', v: m[1]! }] });
      i += m[1]!.length;
    } else {
      text += src[i];
      i += 1;
    }
  }
  flush();
  return out;
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const endPara = () => {
    if (para.length) blocks.push({ t: 'p', v: parseInline(para.join('\n')) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      endPara();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      blocks.push({ t: 'code', lang: fence[1] ?? '', v: body.join('\n') });
      continue;
    }
    const h = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      endPara();
      blocks.push({ t: 'h', level: h[1]!.length as 1 | 2 | 3, v: parseInline(h[2]!) });
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      endPara();
      const kind = ul ? 'ul' : 'ol';
      const items: Inline[][] = [];
      const itemRe = kind === 'ul' ? /^\s*[-*+]\s+(.*)$/ : /^\s*\d+[.)]\s+(.*)$/;
      while (i < lines.length) {
        const m = itemRe.exec(lines[i]!);
        if (!m) break;
        items.push(parseInline(m[1]!));
        i++;
        // A loose list has blank lines between items. Step over them only if another item follows.
        let j = i;
        while (j < lines.length && lines[j]!.trim() === '') j++;
        if (j > i && j < lines.length && itemRe.test(lines[j]!)) i = j;
      }
      i--;
      blocks.push({ t: kind, v: items });
      continue;
    }
    const q = /^>\s?(.*)$/.exec(line);
    if (q) {
      endPara();
      const quoted: string[] = [q[1]!];
      while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1]!))
        quoted.push(lines[++i]!.replace(/^>\s?/, ''));
      blocks.push({ t: 'quote', v: parseInline(quoted.join('\n')) });
      continue;
    }
    if (line.trim() === '') endPara();
    else para.push(line);
  }
  endPara();
  return blocks;
}
