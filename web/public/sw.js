// Antlings service worker.
// Caches only the static app shell (page, built assets, icons). API responses and the
// WebSocket are never cached or touched. Also shows push notifications.
const SHELL = 'antlings-shell-v1';

self.addEventListener('install', () => self.skipWaiting());

// Drops cached /assets files that the current page no longer uses, so old builds do not pile up.
async function pruneAssets() {
  try {
    const html = await (await fetch('/', { cache: 'no-store' })).text();
    const keep = new Set();
    const scan = (text) => {
      for (const m of text.matchAll(/\/assets\/[^"'\s)?#]+/g)) keep.add(m[0]);
    };
    scan(html);
    for (const css of [...keep].filter((p) => p.endsWith('.css'))) scan(await (await fetch(css)).text());
    const cache = await caches.open(SHELL);
    for (const req of await cache.keys()) {
      const p = new URL(req.url).pathname;
      if (p.startsWith('/assets/') && !keep.has(p)) await cache.delete(req);
    }
  } catch (e) {
    /* offline during activation: nothing is pruned this time */
  }
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(pruneAssets)
      .then(() => self.clients.claim()),
  );
});

function cacheable(url) {
  if (url.origin !== self.location.origin) return false;
  const p = url.pathname;
  if (p.startsWith('/api/') || p === '/ws' || p === '/health') return false;
  return p === '/' || p === '/index.html' || p.startsWith('/assets/') || p.startsWith('/icons/') || p === '/manifest.webmanifest';
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!cacheable(url)) return;
  const immutable = url.pathname.startsWith('/assets/');
  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL);
      if (immutable) {
        const hit = await cache.match(req);
        if (hit) return hit;
      }
      try {
        const res = await fetch(req);
        if (res.ok) event.waitUntil(cache.put(req, res.clone()));
        return res;
      } catch (e) {
        const hit = (await cache.match(req)) || (req.mode === 'navigate' ? await cache.match('/') : undefined);
        if (hit) return hit;
        throw e;
      }
    })(),
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }
  const title = data.title || 'Antlings';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      tag: data.tag || 'antlings',
      data: { sessionId: data.sessionId || null },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const id = event.notification.data && event.notification.data.sessionId;
  const target = id ? '/#s=' + id : '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          c.navigate(target).catch(() => undefined);
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
