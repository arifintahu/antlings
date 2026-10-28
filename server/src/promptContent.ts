import { formatBytes, IMAGE_BLOCK_TOTAL_BYTES, MAX_FILE_BYTES } from '@antlings/shared';
import type { StoredUpload } from './uploads.js';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

const DEFAULT_TEXT = 'See the attached file(s).';
const LIST_HEAD = 'Attached files (saved on the server, open them with the Read tool):';

/**
 * The user turn for the agent. Images that fit go inline as image blocks; every other file
 * (and any image over the limits) is listed by path so Claude opens it with its Read tool.
 */
export function buildContent(
  text: string,
  files: StoredUpload[],
  read: (f: StoredUpload) => Buffer,
): string | ContentBlock[] {
  if (files.length === 0) return text;
  const images: ContentBlock[] = [];
  const listed: StoredUpload[] = [];
  let inline = 0;
  for (const f of files) {
    if (f.kind === 'image' && f.size <= MAX_FILE_BYTES && inline + f.size <= IMAGE_BLOCK_TOTAL_BYTES) {
      inline += f.size;
      images.push({
        type: 'image',
        source: { type: 'base64', media_type: f.mime, data: read(f).toString('base64') },
      });
    } else listed.push(f);
  }
  const out: ContentBlock[] = [...images, { type: 'text', text: text.trim() ? text : DEFAULT_TEXT }];
  if (listed.length > 0) {
    const lines = listed.map((f) => `- ${f.path} (${f.name}, ${formatBytes(f.size)})`);
    out.push({ type: 'text', text: [LIST_HEAD, ...lines].join('\n') });
  }
  return out;
}
