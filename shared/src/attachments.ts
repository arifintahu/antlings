export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_FILES = 5;
export const SESSION_QUOTA_BYTES = 200 * 1024 * 1024;
/** Images of one message sent inline as image blocks; anything beyond this is sent as a path line. */
export const IMAGE_BLOCK_TOTAL_BYTES = 20 * 1024 * 1024;
export const NAME_MAX = 120;

export type AttachmentKind = 'image' | 'pdf' | 'text';

export interface AttachmentRef {
  id: string;
  name: string;
  size: number;
  kind: AttachmentKind;
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

export const TEXT_EXTENSIONS: readonly string[] = [
  'txt',
  'md',
  'json',
  'jsonl',
  'csv',
  'tsv',
  'log',
  'yaml',
  'yml',
  'toml',
  'xml',
  'html',
  'css',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'svelte',
  'vue',
  'py',
  'go',
  'rs',
  'java',
  'kt',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'rb',
  'php',
  'sh',
  'sql',
  'ini',
  'conf',
  'diff',
  'patch',
];

/** The extension of a file name, lower case, without the dot. */
export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

/** Kind by extension only. The server also checks the content. */
export function kindFromName(name: string): AttachmentKind | undefined {
  const ext = extensionOf(name);
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (TEXT_EXTENSIONS.includes(ext)) return 'text';
  return undefined;
}

/** Display name: no path parts, no control characters, at most NAME_MAX characters. */
export function sanitizeName(raw: string): string {
  const base = raw.slice(Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\')) + 1);
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return clean.slice(0, NAME_MAX) || 'file';
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
}
