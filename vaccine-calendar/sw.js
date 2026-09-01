// 서비스워커 — 홈 화면 설치(PWA) 요건 + 오프라인 캐시
// 전략: stale-while-revalidate (캐시 먼저 보여주고 뒤에서 갱신)
const CACHE = 'uriday-vc-v1';
const CORE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './schedule-data.js',
  './schedule-logic.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  '../shared/css/base.css',
  '../shared/js/brand.js',
  '../shared/js/date-utils.js',
  '../shared/js/ics.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // 캘린더 서버 함수 등 외부 요청은 건드리지 않는다
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const cached = await c.match(e.request);
      const fetched = fetch(e.request)
        .then((res) => {
          if (res.ok) c.put(e.request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || fetched;
    })
  );
});
