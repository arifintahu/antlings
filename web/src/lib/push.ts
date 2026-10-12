import { del, get, post } from './api.js';

export type PushState = 'unsupported' | 'denied' | 'off' | 'on';

const supported = (): boolean =>
  typeof navigator !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window;

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function pushState(): Promise<PushState> {
  if (!supported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    return (await reg?.pushManager.getSubscription()) ? 'on' : 'off';
  } catch {
    return 'unsupported';
  }
}

export async function enablePush(): Promise<PushState> {
  if (!supported()) return 'unsupported';
  // Ask first, while the tap is fresh (Safari rejects the prompt after an await).
  if ((await Notification.requestPermission()) !== 'granted') return 'denied';
  const { key } = await get<{ key: string | null }>('/api/push/key');
  if (!key) return 'unsupported';
  const reg = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('no service worker')), 5000)),
  ]);
  const old = await reg.pushManager.getSubscription();
  if (old) await old.unsubscribe(); // a subscription made with another key would throw
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  try {
    await post('/api/push/subscribe', sub.toJSON());
  } catch (e) {
    await sub.unsubscribe(); // keep the browser and the server in step
    throw e;
  }
  return 'on';
}

export async function disablePush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await del(`/api/push/subscribe?endpoint=${encodeURIComponent(sub.endpoint)}`);
    await sub.unsubscribe();
  }
  return 'off';
}
