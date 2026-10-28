import { kindFromName, sanitizeName, type AttachmentRef } from '@antlings/shared';
import { ApiError, del, upload } from './api.js';
import { precheck, type TrayItem } from './attach.js';

/** The files attached to the message being written. Each file uploads as soon as it is added. */
export class AttachmentTray {
  items = $state<TrayItem[]>([]);
  /** The latest reason a file was refused or failed, shown under the chips. */
  error = $state('');
  private aborts = new Map<string, AbortController>();
  private owner = new Map<string, string>();
  private n = 0;

  get busy(): boolean {
    return this.items.some((i) => i.state === 'uploading');
  }
  get ready(): TrayItem[] {
    return this.items.filter((i) => i.state === 'ready');
  }
  get ids(): string[] {
    return this.ready.map((i) => i.id!);
  }

  add(files: File[], sessionId: string, onReady: (name: string) => void = () => undefined): void {
    for (const file of files) {
      const key = `a${++this.n}`;
      const name = sanitizeName(file.name);
      const why = precheck(file, this.items.filter((i) => i.state !== 'error').length);
      if (why) {
        this.items.push({ key, name, size: file.size, state: 'error', progress: 0, error: why });
        this.error = why;
        continue;
      }
      this.items.push({
        key,
        name,
        size: file.size,
        kind: kindFromName(name),
        state: 'uploading',
        progress: 0,
        preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
      });
      const ac = new AbortController();
      this.aborts.set(key, ac);
      this.owner.set(key, sessionId);
      upload<{ attachment: AttachmentRef }>(
        `/api/sessions/${sessionId}/uploads`,
        file,
        name,
        (f) => this.patch(key, { progress: f }),
        ac.signal,
      )
        .then((r) => {
          this.patch(key, { state: 'ready', progress: 1, id: r.attachment.id });
          onReady(name);
        })
        .catch((e: unknown) => {
          if (e instanceof DOMException && e.name === 'AbortError') return;
          const msg = e instanceof ApiError ? e.message : 'The upload failed. Remove the file and try again.';
          this.patch(key, { state: 'error', error: msg });
          this.error = msg;
        })
        .finally(() => this.aborts.delete(key));
    }
  }

  /** Takes a chip away. An upload in flight is cancelled; a finished one is deleted on the server. */
  remove(key: string): void {
    const item = this.items.find((i) => i.key === key);
    if (!item) return;
    this.aborts.get(key)?.abort();
    this.aborts.delete(key);
    const session = this.owner.get(key);
    if (item.state === 'ready' && item.id && session)
      void del(`/api/sessions/${session}/uploads/${item.id}`).catch(() => undefined);
    if (item.preview) URL.revokeObjectURL(item.preview);
    this.owner.delete(key);
    this.items = this.items.filter((i) => i.key !== key);
    this.error = this.items.find((i) => i.state === 'error')?.error ?? '';
  }

  /** After a send: the files belong to the message now, so nothing is deleted on the server. */
  clear(): void {
    for (const i of this.items) if (i.preview) URL.revokeObjectURL(i.preview);
    this.items = [];
    this.error = '';
    this.owner.clear();
  }

  /** On leaving the session: drop everything that was not sent. */
  reset(): void {
    for (const i of [...this.items]) this.remove(i.key);
  }

  private patch(key: string, change: Partial<TrayItem>): void {
    const item = this.items.find((i) => i.key === key);
    if (item) Object.assign(item, change);
  }
}
