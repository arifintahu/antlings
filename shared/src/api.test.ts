import { describe, expect, it } from 'vitest';
import { ClaudeApiKeyBody, ClaudeCodeBody, ClaudeModeBody, GitIdentityBody } from './api.js';

const KEY = 'sk-ant-api03-abcdefghijklmnop';

describe('ClaudeApiKeyBody', () => {
  it('accepts a key and trims a trailing newline', () => {
    expect(ClaudeApiKeyBody.parse({ apiKey: `${KEY}\n` }).apiKey).toBe(KEY);
  });
  it('rejects spaces, a wrong prefix, a short key and a 400 character key', () => {
    for (const apiKey of [
      'sk-ant-api03-abc def-ghijklmnop',
      'sk-other-abcdefghijklmnop',
      'sk-ant-x',
      `sk-ant-${'a'.repeat(400)}`,
    ]) {
      expect(ClaudeApiKeyBody.safeParse({ apiKey }).success, apiKey.slice(0, 20)).toBe(false);
    }
  });
  it('does not repeat the rejected value in its error', () => {
    const r = ClaudeApiKeyBody.safeParse({ apiKey: 'sk-ant-secret value with spaces' });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).not.toContain('secret value');
  });
});

describe('other connection bodies', () => {
  it('ClaudeModeBody takes only the two modes', () => {
    expect(ClaudeModeBody.safeParse({ mode: 'subscription', ack: true }).success).toBe(true);
    expect(ClaudeModeBody.safeParse({ mode: 'free' }).success).toBe(false);
  });
  it('ClaudeCodeBody accepts a pasted OAuth code and rejects control characters', () => {
    expect(ClaudeCodeBody.safeParse({ code: ' abc-DEF_123#xyz ' }).success).toBe(true);
    expect(ClaudeCodeBody.safeParse({ code: 'abc\ndef' }).success).toBe(false);
    expect(ClaudeCodeBody.safeParse({ code: 'ab' }).success).toBe(false);
  });
  it('GitIdentityBody needs a name without control characters and a real email', () => {
    expect(GitIdentityBody.safeParse({ name: 'Ada Lovelace', email: 'ada@example.com' }).success).toBe(true);
    expect(GitIdentityBody.safeParse({ name: 'Ada\nx', email: 'ada@example.com' }).success).toBe(false);
    expect(GitIdentityBody.safeParse({ name: 'Ada', email: 'not-an-email' }).success).toBe(false);
  });
});
