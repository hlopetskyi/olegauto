const CACHE = 'olegauto-v2';
const PRECACHE = ['/', '/manifest.json', '/favicon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if(e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Не перехоплювати запити до API та адмін-панелі: /admin під HTTP Basic Auth,
  // а перехоплення навігації service worker'ом ламає діалог логіна (сторінка
  // циклічно перезавантажується). Хай браузер обробляє їх напряму.
  if(url.pathname.startsWith('/api/')) return;
  if(url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : { title: 'OlegAvto', body: 'Нове повідомлення' };
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      tag: data.tag || 'olegauto',
      vibrate: [200, 100, 200],
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow('/'));
});
