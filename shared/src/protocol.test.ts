import { describe, expect, it } from 'vitest';
import { ClientMessage } from './protocol.js';

describe('ClientMessage', () => {
  it('accepts a valid send', () => {
    expect(ClientMessage.safeParse({ t: 'send', sessionId: 's1', text: 'hi' }).success).toBe(true);
  });
  it('rejects unknown types, empty text and bad modes', () => {
    expect(ClientMessage.safeParse({ t: 'nope' }).success).toBe(false);
    expect(ClientMessage.safeParse({ t: 'send', sessionId: 's1', text: '' }).success).toBe(false);
    expect(ClientMessage.safeParse({ t: 'setPermissionMode', sessionId: 's1', mode: 'root' }).success).toBe(
      false,
    );
  });
  it('allows empty text only with attachments, and at most five', () => {
    const base = { t: 'send', sessionId: 's1' };
    expect(ClientMessage.safeParse({ ...base, text: '', attachmentIds: ['u1'] }).success).toBe(true);
    expect(ClientMessage.safeParse({ ...base, text: '   ' }).success).toBe(false);
    expect(
      ClientMessage.safeParse({ ...base, text: 'hi', attachmentIds: ['1', '2', '3', '4', '5'] }).success,
    ).toBe(true);
    expect(
      ClientMessage.safeParse({ ...base, text: 'hi', attachmentIds: ['1', '2', '3', '4', '5', '6'] }).success,
    ).toBe(false);
  });
  it('rejects a negative lastSeq', () => {
    expect(ClientMessage.safeParse({ t: 'hello', sessionId: 's1', lastSeq: -1 }).success).toBe(false);
  });
});
