// 서비스 워커: 앱 껍데기(같은 출처의 정적 파일)만 캐시한다. Supabase API 응답은 캐시하지 않는다.
const CACHE = 'shell-v3';
const SHELL = [
  './',
  './index.html',
  './config.js',
  './manifest.webmanifest',
  './icon.svg',
  './css/app.css',
  './js/main.js',
  './js/api.js',
  './js/auth.js',
  './js/dom.js',
  './js/format.js',
  './js/screens/home.js',
  './js/screens/login.js',
  './js/screens/funds.js',
  './js/screens/search.js',
  './js/screens/chart.js',
  './js/chart-data.js',
  './js/market-time.js',
  './js/market-api.js',
  './js/order-api.js',
  './js/order-format.js',
  './js/screens/order.js',
  './js/screens/portfolio.js',
  './vendor/klinecharts-10.1.0.umd.min.js',
  './vendor/supabase-2.118.0.umd.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return; // API 는 그대로 통과
  // 네트워크 우선, 실패하면 캐시(오프라인 셸)
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r ?? caches.match('./index.html'))),
  );
});
