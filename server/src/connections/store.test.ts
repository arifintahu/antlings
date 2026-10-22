import { afterEach, describe, expect, it } from 'vitest';
import { Auth } from '../auth/service.js';
import { openDb } from '../db.js';
import { fakeWebAuthn, FakeClock, makeKit, testConfig, type Kit } from '../testkit.js';
import { ConnectionSettings } from './store.js';

const KEY = 'sk-ant-test-123456789012345';
let kit: Kit;
afterEach(async () => {
  kit?.mgr.closeAll();
  await kit?.app.close();
});

describe('ConnectionSettings', () => {
  it('stores the API key encrypted and reads it back', async () => {
    kit = await makeKit();
    const s = new ConnectionSettings(kit.auth);
    expect(s.hasApiKey()).toBe(false);
    s.setApiKey(KEY);
    expect(s.hasApiKey()).toBe(true);
    expect(s.apiKey()).toBe(KEY);
    const raw = kit.auth.db.prepare("SELECT value FROM settings WHERE key = 'anthropic_key'").get() as {
      value: string;
    };
    expect(raw.value).not.toContain('sk-ant');
  });

  it('returns undefined, not an error, when the secret key changed', async () => {
    kit = await makeKit();
    new ConnectionSettings(kit.auth).setApiKey(KEY);
    const other = new Auth(kit.auth.db, new FakeClock(), testConfig(), fakeWebAuthn, () => undefined);
    const s = new ConnectionSettings(other);
    expect(s.apiKey()).toBeUndefined();
    expect(s.hasApiKey()).toBe(false);
  });

  it('clears the key', async () => {
    kit = await makeKit();
    const s = new ConnectionSettings(kit.auth);
    s.setApiKey(KEY);
    s.clearApiKey();
    expect(s.hasApiKey()).toBe(false);
    expect(s.apiKey()).toBeUndefined();
  });

  it('falls back to the configured mode and stores a change', async () => {
    kit = await makeKit();
    const s = new ConnectionSettings(kit.auth);
    expect(s.mode()).toBe('apikey');
    s.setMode('subscription');
    expect(s.mode()).toBe('subscription');
  });

  it('keeps the terms acknowledgement time', async () => {
    kit = await makeKit();
    const s = new ConnectionSettings(kit.auth);
    expect(s.ackAt()).toBeUndefined();
    s.setAck(1_800_000_000_000);
    expect(s.ackAt()).toBe(1_800_000_000_000);
  });

  it('uses the config default for a db with no stored mode', () => {
    const cfg = testConfig({ ANTLINGS_AUTH_MODE: 'subscription', ANTLINGS_SUBSCRIPTION_OK: '1' });
    const auth = new Auth(openDb(':memory:'), new FakeClock(), cfg, fakeWebAuthn, () => undefined);
    expect(new ConnectionSettings(auth).mode()).toBe('subscription');
  });
});
