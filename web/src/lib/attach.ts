import {
  formatBytes,
  kindFromName,
  MAX_FILE_BYTES,
  MAX_FILES,
  sanitizeName,
  TEXT_EXTENSIONS,
  type AttachmentKind,
} from '@antlings/shared';

/** One chip in the composer. */
export interface TrayItem {
  key: string;
  name: string;
  size: number;
  kind?: AttachmentKind;
  state: 'uploading' | 'ready' | 'error';
  /** 0 to 1 while uploading. */
  progress: number;
  error?: string;
  /** Server id once the upload finished. */
  id?: string;
  /** blob: URL for an image thumbnail. */
  preview?: string;
}

/** Checks a file before it is uploaded. Returns the reason to show, or undefined when it may go. */
export function precheck(file: { name: string; size: number }, countSoFar: number): string | undefined {
  const name = sanitizeName(file.name);
  if (countSoFar >= MAX_FILES) return `Only ${MAX_FILES} files per message.`;
  if (file.size === 0) return `${name} is empty.`;
  if (file.size > MAX_FILE_BYTES)
    return `${name} is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_FILE_BYTES)} per file.`;
  if (!kindFromName(name)) return 'This file type is not supported.';
  return undefined;
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** A pasted image has no file name, so it gets one from the time. */
export function pastedName(file: { type: string }, now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `pasted-image-${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}.${EXT[file.type] ?? 'png'}`;
}

/**
 * The `accept` list of the file picker. Phones need MIME types to offer the photo library and camera;
 * extensions alone only open the file browser. HEIC is left out on purpose, so iOS converts photos to JPEG.
 * The server checks the content again.
 */
export const ACCEPT = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/*',
  ...['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', ...TEXT_EXTENSIONS].map((e) => `.${e}`),
].join(',');
