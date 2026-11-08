/* Gymclo: keep all authenticated requests network-only. No private data caching. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate' || event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).catch(() => new Response(
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#100e12"><title>Gymclo</title><body style="background:#100e12;color:#f6f3f5;font:16px system-ui;text-align:center;padding:25vh 24px"><h1 style="color:#fa9aa2">gymclo.</h1><p>You’re offline. Reconnect to view your crew.</p><button onclick="location.reload()" style="background:#eb6975;border:0;padding:12px 22px;border-radius:12px">Try again</button></body>',
    {status:200,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}}
  )));
});
