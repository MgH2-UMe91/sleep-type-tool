// オフライン対応(Service Worker)
// - 版は登録時の sw.js?v=… から取る(index.html のキャッシュバスターと同じ値)。版が変わると画面・css・js のキャッシュを作り直し、古い版のキャッシュは消す
// - vendor(文字認識一式。約13MB)は版と別のキャッシュ(VENDOR_VERSION)に入れる。アプリの版を上げても取り直さず、消さない。
//   vendor のファイルを差し替えたときだけ VENDOR_VERSION を上げる(新しいキャッシュを作り、古い vendor のキャッシュは消す)
// - 画面(index.html)はネット優先:つながれば最新、つながらなければキャッシュ。古い版に固定されないように
// - css / js / vendor(文字認識一式)/ icons / manifest はキャッシュ優先
// - events.json はネット優先、読めなければ最後に読めたもの
// - 記録(localStorage)には触れない
// 外部API(zipcloud・国土地理院・Open-Meteo)は同じ配信元ではないので、下の fetch の先頭で素通しされ、キャッシュしない
// index.html で読み込むファイルを増やしたら、下の ASSETS にも足すこと
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const PREFIX = 'sleep-type-tool-';
const CACHE = PREFIX + VERSION;
const EVENTS_CACHE = PREFIX + 'events';
const q = '?v=' + VERSION;
const ASSETS = [
  './', 'index.html',
  'css/style.css' + q, 'css/bedding.css' + q,
  'js/store.js' + q, 'js/calc.js' + q, 'js/events.js' + q, 'js/moon.js' + q, 'js/ocr.js' + q, 'js/bedding.js' + q, 'js/app.js' + q,
  'manifest.webmanifest' + q,
  'icons/apple-touch-icon.png' + q, 'icons/icon-192.png' + q, 'icons/icon-192.png', 'icons/icon-512.png',
];
const VENDOR_VERSION = '1';        // vendor/ の中身を変えたら上げる
const LEGACY_VENDOR_VERSION = '1'; // この分離より前の版は、vendor を版ごとのキャッシュに入れていた(その中身が VENDOR_VERSION と同じ間は、そこから写して再取得しない)
const VENDOR_CACHE = PREFIX + 'vendor-' + VENDOR_VERSION;
const VENDOR_ASSETS = [
  'vendor/tesseract.min.js', 'vendor/worker.min.js',
  'vendor/core/tesseract-core-simd-lstm.wasm.js', 'vendor/core/tesseract-core-lstm.wasm.js',
  'vendor/lang/eng.traineddata.gz', 'vendor/lang/jpn.traineddata.gz',
];
const scoped = p => new URL(p, self.registration.scope).href;

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(ASSETS.map(p => new Request(scoped(p), { cache: 'reload' })));
    // vendor は、なければ足すだけ(版を上げても取り直さない)。古い版のキャッシュに同じ中身があれば、そこから写す
    const v = await caches.open(VENDOR_CACHE);
    for (const p of VENDOR_ASSETS) {
      const url = scoped(p);
      if (await v.match(url)) continue;
      let res = null;
      if (VENDOR_VERSION === LEGACY_VENDOR_VERSION) {
        for (const k of await caches.keys()) {
          if (!k.startsWith(PREFIX) || k === CACHE || k === EVENTS_CACHE || k === VENDOR_CACHE || k.startsWith(PREFIX + 'vendor-')) continue;
          res = await (await caches.open(k)).match(url);
          if (res && res.ok) break;
          res = null;
        }
      }
      if (res) await v.put(url, res); else await v.add(url);
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== CACHE && k !== EVENTS_CACHE && k !== VENDOR_CACHE).map(k => caches.delete(k)));
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
