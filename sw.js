// オフライン対応(Service Worker)
// - 版は登録時の sw.js?v=… から取る(index.html のキャッシュバスターと同じ値)。版が変わるとキャッシュを作り直し、古い版のキャッシュは消す
// - 画面(index.html)はネット優先:つながれば最新、つながらなければキャッシュ。古い版に固定されないように
// - css / js / vendor(文字認識一式)/ icons / manifest はキャッシュ優先
// - events.json はネット優先、読めなければ最後に読めたもの
// - 記録(localStorage)には触れない
// index.html で読み込むファイルを増やしたら、下の ASSETS にも足すこと
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const PREFIX = 'sleep-type-tool-';
const CACHE = PREFIX + VERSION;
const EVENTS_CACHE = PREFIX + 'events';
const q = '?v=' + VERSION;
const ASSETS = [
  './', 'index.html',
  'css/style.css' + q,
  'js/store.js' + q, 'js/calc.js' + q, 'js/events.js' + q, 'js/moon.js' + q, 'js/ocr.js' + q, 'js/app.js' + q,
  'manifest.webmanifest' + q,
  'icons/apple-touch-icon.png' + q, 'icons/icon-192.png' + q, 'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/tesseract.min.js', 'vendor/worker.min.js',
  'vendor/core/tesseract-core-simd-lstm.wasm.js', 'vendor/core/tesseract-core-lstm.wasm.js',
  'vendor/lang/eng.traineddata.gz', 'vendor/lang/jpn.traineddata.gz',
];
const scoped = p => new URL(p, self.registration.scope).href;

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(ASSETS.map(p => new Request(scoped(p), { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== CACHE && k !== EVENTS_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// ネット優先。読めたらキャッシュを更新し、だめならキャッシュ(key)。電波が弱くて返事がないときも NET_WAIT_MS でキャッシュに切り替える
const NET_WAIT_MS = 5000;
async function networkFirst(req, cacheName, key) {
  const c = await caches.open(cacheName);
  const net = fetch(req).then(async res => { if (res.ok) await c.put(key, res.clone()); return res; });
  net.catch(() => {}); // 先にキャッシュを返したあとの失敗は無視
  const cached = () => c.match(key);
  try {
    return await Promise.race([net, new Promise((_, ng) => setTimeout(() => ng(new Error('timeout')), NET_WAIT_MS))]);
  } catch (err) {
    const hit = await cached();
    if (hit) return hit;
    return net; // キャッシュも無ければネットの結果を待つ
  }
}

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.type === 'basic') (await caches.open(CACHE)).put(req, res.clone());
  return res;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;
  const path = url.href.slice(self.registration.scope.length).split(/[?#]/)[0];
  if (req.mode === 'navigate' || path === '' || path === 'index.html') {
    e.respondWith(networkFirst(req, CACHE, scoped('index.html')));
  } else if (path === 'events.json') {
    e.respondWith(networkFirst(req, EVENTS_CACHE, scoped('events.json')));
  } else if (path === 'sw.js') {
    return;
  } else {
    e.respondWith(cacheFirst(req));
  }
});
