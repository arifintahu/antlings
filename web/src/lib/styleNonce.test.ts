import { describe, expect, it } from 'vitest';
import { installStyleNonce } from './styleNonce';

function fakeDoc(nonce: string | null) {
  const made: { tag: string; attrs: Record<string, string>; setAttribute(k: string, v: string): void }[] = [];
  const doc = {
    querySelector: () => (nonce === null ? null : { getAttribute: () => nonce }),
    createElement(tag: string) {
      const el = {
        tag,
        attrs: {} as Record<string, string>,
        setAttribute(k: string, v: string) {
          this.attrs[k] = v;
        },
      };
      made.push(el);
      return el;
    },
  };
  return { doc: doc as unknown as Document, made };
}

describe('installStyleNonce', () => {
  it('tags style elements and nothing else', () => {
    const { doc, made } = fakeDoc('abc123');
    installStyleNonce(doc);
    doc.createElement('style');
    doc.createElement('STYLE');
    doc.createElement('div');
    expect(made.map((m) => m.attrs.nonce)).toEqual(['abc123', 'abc123', undefined]);
  });

  it('does nothing without a real nonce (dev server, placeholder, missing meta)', () => {
    for (const n of [null, '', '__CSP_NONCE__']) {
      const { doc, made } = fakeDoc(n);
      installStyleNonce(doc);
      doc.createElement('style');
      expect(made[0]!.attrs.nonce, String(n)).toBeUndefined();
    }
  });
});
