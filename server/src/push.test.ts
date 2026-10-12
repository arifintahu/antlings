import { afterEach, describe, expect, it } from 'vitest';
import { makeKit, type Creds, type Kit } from './testkit.js';

let kit: Kit;
let creds: Creds;
afterEach(async () => {
  kit?.mgr.closeAll();
  await kit?.app.close();
});

const SUB = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
  keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) },
};
const until = async (pred: () => boolean, ms = 2000) => {
  const t = Date.now();
  while (!pred()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

async function setup() {
  kit = await makeKit();
  creds = await kit.signIn();
}

describe('push routes', () => {
  it('serves the public key to signed-in users only', async () => {
    await setup();
    expect((await kit.call({ method: 'GET', url: '/api/push/key' })).statusCode).toBe(401);
    expect((await kit.call({ method: 'GET', url: '/api/push/key', ...creds })).json()).toEqual({
      key: kit.push.publicKey,
    });
  });

  it('stores a subscription and removes it', async () => {
    await setup();
    const r = await kit.call({ method: 'POST', url: '/api/push/subscribe', ...creds, payload: SUB });
    expect(r.statusCode).toBe(200);
    expect(kit.push.count()).toBe(1);
    await kit.call({
      method: 'DELETE',
      url: `/api/push/subscribe?endpoint=${encodeURIComponent(SUB.endpoint)}`,
      ...creds,
    });
    expect(kit.push.count()).toBe(0);
  });

  it('rejects malformed or non-https subscriptions', async () => {
    await setup();
    for (const payload of [
      {},
      { ...SUB, endpoint: 'http://fcm.googleapis.com/x' },
      { ...SUB, keys: {} },
      { ...SUB, endpoint: 'https://evil.example/x' },
      { ...SUB, keys: { p256dh: 'a b', auth: 'x' } },
      { ...SUB, endpoint: 'x'.repeat(3000) },
    ]) {
      expect(
        (await kit.call({ method: 'POST', url: '/api/push/subscribe', ...creds, payload })).statusCode,
      ).toBe(400);
    }
    expect(kit.push.count()).toBe(0);
  });
});

describe('push notifications', () => {
  it('sends when an approval is waiting and when a turn finishes, without secrets in the payload', async () => {
    await setup();
    await kit.call({ method: 'POST', url: '/api/push/subscribe', ...creds, payload: SUB });
    const { id } = await kit.mgr.create({ cwd: kit.home, model: 'sonnet', mode: 'default' });
    await kit.mgr.send(id, 'tool');
    await until(() => kit.pushSent.length >= 1);
    expect(kit.pushSent[0]).toMatchObject({
      endpoint: SUB.endpoint,
      payload: { title: 'Approval needed', sessionId: id },
    });
    expect(JSON.stringify(kit.pushSent[0]!.payload)).not.toContain('ls');
    const req = kit.mgr.eventsAfter(id, 0).find((e) => e.event.k === 'approval_request')!.event as {
      requestId: string;
    };
    kit.mgr.approve(id, req.requestId);
    await until(() => kit.pushSent.some((p) => p.payload.title === 'Session finished'));
  });

  it('drops a subscription the push service reports as gone', async () => {
    await setup();
    await kit.call({ method: 'POST', url: '/api/push/subscribe', ...creds, payload: SUB });
    kit.pushFail.status = 410;
    await kit.push.notify({ title: 't', body: 'b', tag: 'x' });
    expect(kit.push.count()).toBe(0);
  });

  it('sends a sign-in alert unless the owner turned alerts off', async () => {
    await setup();
    await kit.call({ method: 'POST', url: '/api/push/subscribe', ...creds, payload: SUB });
    kit.auth.onSignin = () => kit.push.signedIn();
    const login = async () => {
      const o = (await kit.call({ method: 'POST', url: '/api/auth/passkey/options' })).json();
      return kit.call({
        method: 'POST',
        url: '/api/auth/passkey/verify',
        payload: {
          challengeId: o.challengeId,
          response: { id: 'key-1', challenge: kit.challengeOf(o.challengeId) },
        },
      });
    };
    await login();
    await until(() => kit.pushSent.some((p) => p.payload.title === 'New sign-in'));
    const before = kit.pushSent.length;
    await kit.stepUp(creds);
    await kit.call({
      method: 'PATCH',
      url: '/api/security/settings',
      ...creds,
      payload: { signinAlerts: false },
    });
    await login();
    await new Promise((r) => setTimeout(r, 30));
    expect(kit.pushSent.length).toBe(before);
  });
});
