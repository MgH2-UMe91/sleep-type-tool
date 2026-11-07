// 今夜の寝具:郵便番号と寝る・起きる時刻から、昨夜と比べた毛布・エアコン・パジャマの目安を出す
// - 通信はこの画面を開いたとき(保存済みの郵便番号があるとき)と「表示」を押したときだけ。アプリの起動時には通信しない
//   郵便番号 → zipcloud / 住所 → 国土地理院 / 緯度経度 → Open-Meteo。睡眠の記録は送らない
//   地名で探すときは、入れた地名だけを国土地理院に送る(zipcloud は使わない)
// - 郵便番号と時刻は別のキー(BEDDING_KEY)に保存する。記録(sleep-type-tool)とバックアップJSONには入れない
// - 本体の $ や esc とぶつからないよう、全体を即時関数に閉じて window.viewBedding だけを出す
(() => {
  'use strict';
  const BEDDING_KEY = 'sleep-type-tool-bedding';
  const NET_TIMEOUT_MS = 10000;
  // 外部から受け取る値の範囲(これを外れた値は使わない)
  const JP_RANGE = { latMin: 20, latMax: 46, lonMin: 122, lonMax: 154 };   // 日本の緯度・経度
  const AMEDAS_MAX_KM = 40;     // これより遠い観測地点は使わない
  const AMEDAS_MAX_TRY = 3;     // 要素ごとに、近い順に何地点まで試すか
  const JMA_BASE = 'https://www.jma.go.jp/bosai/amedas/';
  // 表示する文字(住所・地点名)は、日本語の文字と数字・記号の短いものだけ。textContent で入れる
  const SAFE_TEXT = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々〆ヶ・（）() 　0-9０-９A-Za-zＡ-Ｚａ-ｚ、。~〜－-]+$/u;
  const safeText = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && SAFE_TEXT.test(v) ? v : null;
  const inRange = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  const inJapan = (lat, lon) => inRange(lat, JP_RANGE.latMin, JP_RANGE.latMax) && inRange(lon, JP_RANGE.lonMin, JP_RANGE.lonMax);

  // 保存するのは、郵便番号、または地名検索で選んだ場所(名前と緯度経度)。どちらか一方
  const load = () => {
    const none = { zip: '', place: null, query: '', bed: 23, wake: 6 };
    try {
      const o = JSON.parse(localStorage.getItem(BEDDING_KEY) || '{}') || {};
      const zip = typeof o.zip === 'string' && /^\d{7}$/.test(o.zip) ? o.zip : '';
      let place = null;
      if (!zip && o.place && typeof o.place === 'object') {
        const name = safeText(o.place.name, 40);
        if (name && inJapan(o.place.lat, o.place.lon)) place = { name, lat: o.place.lat, lon: o.place.lon };
      }
      const query = place ? safeText(o.query, 40) || '' : '';
      const bed = Number.isInteger(o.bed) && o.bed >= 0 && o.bed <= 23 ? o.bed : 23;
      const wake = Number.isInteger(o.wake) && o.wake >= 0 && o.wake <= 23 ? o.wake : 6;
      return { zip, place: query ? place : null, query, bed, wake };
    } catch (e) { return none; }
  };
  const save = v => { try { localStorage.setItem(BEDDING_KEY, JSON.stringify(v)); } catch (e) { /* 保存できなくても動く */ } };

  // 天気コード → 絵と言葉
  const WMO = c => {
    if (c === 0) return ['🌙', '晴れ'];
    if (c <= 2) return ['🌤️', '晴れ時々くもり'];
    if (c === 3) return ['☁️', 'くもり'];
    if (c <= 48) return ['🌫️', '霧'];
    if (c <= 57) return ['🌦️', '霧雨'];
    if (c <= 67) return ['🌧️', '雨'];
    if (c <= 77) return ['🌨️', '雪'];
    if (c <= 82) return ['🌧️', 'にわか雨'];
    if (c <= 86) return ['🌨️', 'にわか雪'];
    return ['⛈️', '雷雨'];
  };

  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const fmt = v => (Math.round(v * 10) / 10).toFixed(1);
  const avg = a => a.reduce((s, v) => s + v, 0) / a.length;
  const toHalf = s => s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));

  class NetError extends Error {}   // 通信できない(オフライン・タイムアウト・サーバー不調)
  class InputError extends Error {} // 入力や結果の問題(通信とは別)

  async function getJSON(url, signal) {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal) signal.addEventListener('abort', onAbort);
    const timer = setTimeout(() => ctl.abort(), NET_TIMEOUT_MS);
    try {
      const r = await fetch(url, { signal: ctl.signal, referrerPolicy: 'no-referrer', credentials: 'omit' });
      if (!r.ok) throw new NetError(`サーバーが応答しませんでした(${r.status})`);
      return await r.json();
    } catch (e) {
      if (signal && signal.aborted) throw e;                     // 画面を離れた
      if (e instanceof NetError) throw e;
      throw new NetError('通信できません。電波のあるところで、もう一度「表示」を押してください。');
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  // 位置は小数2桁(約1km)に丸めて天気の取得先に送る。予報の精度は変わらず、町の代表点より粗くなる
  const round2 = v => Math.round(v * 100) / 100;
  const placeKey = p => `place:${round2(p.lat).toFixed(2)},${round2(p.lon).toFixed(2)}`;
  // 地名で探す(国土地理院)。使える候補だけを最大6件返す
  async function searchPlace(text, signal) {
    const g = await getJSON(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(text)}`, signal);
    const out = [];
    if (Array.isArray(g)) for (const it of g) {
      const c = it && it.geometry && it.geometry.coordinates;
      const name = it && it.properties && safeText(it.properties.title, 40);
      if (!Array.isArray(c) || !name || !inJapan(c[1], c[0]) || out.some(o => o.name === name)) continue;
      out.push({ name, lat: c[1], lon: c[0] });
      if (out.length >= 6) break;
    }
    return out;
  }

  async function lookupZip(zip, signal) {
    const z = await getJSON(`https://zipcloud.ibsnet.co.jp/api/search?zipcode=${zip}`, signal);
    if (!z || !Array.isArray(z.results) || !z.results.length) throw new InputError('その郵便番号は見つかりませんでした。番号を確かめてください');
    const a = z.results[0];
    const parts = a ? [a.address1, a.address2, a.address3].map(v => v == null || v === '' ? '' : safeText(v, 30)) : [null];
    if (parts.some(v => v === null) || !parts[0]) throw new InputError('住所の形式が想定外でした');
    const addr = parts.join('');
    // 住所 → 緯度経度(国土地理院)。町名で見つからなければ市区町村で
    for (const q of [addr, parts[0] + parts[1]]) {
      const g = await getJSON(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q)}`, signal);
      if (Array.isArray(g) && g.length && g[0].geometry && Array.isArray(g[0].geometry.coordinates)) {
        const [lon, lat] = g[0].geometry.coordinates;
        if (inJapan(lat, lon)) return { addr, lat, lon };
      }
    }
    throw new InputError('場所の位置がわかりませんでした');
  }

  // ---- 昨夜の値を気象庁アメダスの実測に替える(最寄り地点は端末の中で計算。気象庁へ緯度経度は送らない)
  const pad2 = n => String(n).padStart(2, '0');
  const ymdKey = d => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  const rad = x => x * Math.PI / 180;
  const distKm = (a, b) => {
    const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(h));
  };
  function parseStations(t) {
    const out = [];
    if (!t || typeof t !== 'object') return out;
    for (const [id, s] of Object.entries(t)) {
      if (!/^\d{5}$/.test(id) || !s || typeof s !== 'object') continue;
      const la = s.lat, lo = s.lon;
      if (!Array.isArray(la) || !Array.isArray(lo)) continue;
      const lat = la[0] + la[1] / 60, lon = lo[0] + lo[1] / 60;
      const name = safeText(s.kjName, 20);
      if (!inJapan(lat, lon) || !name || typeof s.elems !== 'string' || !/^[0-9]{8}$/.test(s.elems)) continue;
      out.push({ id, name, lat, lon, el: s.elems });
    }
    return out;
  }
  // 観測の要素 → elems の位置(気温・風・湿度)。持っていても欠測のことがあるので、実際の値で確かめる
  const ELEM = { temp: 0, wind: 2, hum: 5 };
  const ELEM_NAME = { temp: '気温', hum: '湿度', wind: '風' };
  // 1地点の、必要な時刻の観測(10分ごとの正時の値)を読む。欠測・品質が正常でない値は入れない
  async function loadObs(id, hours, signal, memo) {
    if (memo.has(id)) return memo.get(id);
    const files = new Set(hours.map(h => `${ymdKey(h.t)}_${pad2(Math.floor(h.t.getHours() / 3) * 3)}`));
    const data = {};
    await Promise.all([...files].map(async f => {
      try { const j = await getJSON(`${JMA_BASE}data/point/${id}/${f}.json`, signal); if (j && typeof j === 'object') Object.assign(data, j); }
      catch (e) { if (signal && signal.aborted) throw e; /* そのファイルは欠測扱い */ }
    }));
    const ok = (a, lo, hi) => Array.isArray(a) && a[1] === 0 && inRange(a[0], lo, hi) ? a[0] : null;
    const obs = new Map();
    for (const h of hours) {
      const o = data[`${ymdKey(h.t)}${pad2(h.t.getHours())}0000`];
      if (o && typeof o === 'object') obs.set(h.t.getTime(), { temp: ok(o.temp, -60, 60), hum: ok(o.humidity, 0, 100), wind: ok(o.wind, 0, 100) });
    }
    memo.set(id, obs);
    return obs;
  }
  // 体感温度(Open-Meteo と同じ式。夜は日射なし): 気温・湿度・風速(m/s)から計算
  const feelOf = (ta, rh, ws) => ta + 0.348 * (rh / 100 * 6.105 * Math.exp(17.27 * ta / (237.7 + ta))) - 0.70 * ws - 4.25;
  // 昨夜の各時刻を、気温・湿度・風それぞれ「近い順に、全時刻の値がそろう地点」から集める。そろわなければ why を返す
  async function amedasNight(loc, nLast, signal) {
    let table;
    try { table = await getJSON(`${JMA_BASE}const/amedastable.json`, signal); }
    catch (e) { if (signal && signal.aborted) throw e; return { why: '気象庁に通信できなかった' }; }
    const stations = parseStations(table);
    const memo = new Map();
    const names = {}, picked = {};
    for (const key of ['temp', 'hum', 'wind']) {
      const cands = stations.filter(s => s.el[ELEM[key]] === '1')
        .map(s => ({ s, d: distKm(loc, s) })).filter(c => c.d <= AMEDAS_MAX_KM)
        .sort((a, b) => a.d - b.d).slice(0, AMEDAS_MAX_TRY);
      if (!cands.length) return { why: `${AMEDAS_MAX_KM}km以内に${ELEM_NAME[key]}の観測地点がない` };
      let found = null;
      for (const c of cands) {
        const obs = await loadObs(c.s.id, nLast, signal, memo);
        if (nLast.every(h => obs.get(h.t.getTime()) && obs.get(h.t.getTime())[key] !== null)) { found = { c, obs }; break; }
      }
      if (!found) return { why: `${ELEM_NAME[key]}の観測に欠測がある` };
      picked[key] = found.obs; names[key] = found.c.s.name;
    }
    // 計算式のずれを、同じ時刻の Open-Meteo の体感温度との差(平均)で補正する。今夜(予報)との比べが片寄らないように
    const bias = avg(nLast.map(h => h.feel - feelOf(h.temp, h.hum, h.wind / 3.6)));
    const hours = nLast.map(h => {
      const t = h.t.getTime();
      const temp = picked.temp.get(t).temp, hum = picked.hum.get(t).hum, ws = picked.wind.get(t).wind;
      return { t: h.t, temp, feel: feelOf(temp, hum, ws) + (Number.isFinite(bias) ? bias : 0), hum, wind: ws * 3.6, pop: null, code: h.code };
    });
    return { hours, names };
  }

  // 「夜」=寝る時刻〜起きる時刻(日をまたぐ)
  function nightSlice(H, startDate, bed, wake) {
    const start = new Date(startDate); start.setHours(bed, 0, 0, 0);
    if (bed < 12) start.setDate(start.getDate() + 1); // 0時以降に寝る設定
    const end = new Date(startDate); end.setDate(end.getDate() + 1); end.setHours(wake, 0, 0, 0);
    return H.filter(h => h.t >= start && h.t <= end);
  }

  function summarize(n) {
    const temps = n.map(h => h.temp), feels = n.map(h => h.feel);
    let minI = 0; temps.forEach((v, i) => { if (v < temps[minI]) minI = i; });
    return {
      bed: n[0].temp, wake: n[n.length - 1].temp,
      min: temps[minI], minAt: n[minI].t,
      earlyFeel: avg(feels.slice(0, 2)),   // 寝てから2時間の体感
      lateFeel: Math.min(...feels),        // 明け方いちばん冷えるときの体感
      avg: avg(temps), feelAvg: avg(feels),
      hum: avg(n.map(h => h.hum)),
      rain: Math.max(...n.map(h => h.pop ?? 0)),
      wind: Math.max(...n.map(h => h.wind))
    };
  }

  // 寝るとき(寝てから2時間)と明け方(いちばん冷えるとき)を別々に昨夜と比べる
  function decide(now, prev, bed, hours) {
    const T = 1.5;
    const e = now.earlyFeel - prev.earlyFeel;   // +なら寝るときが暖かい
    const l = now.lateFeel - prev.lateFeel;     // −なら明け方が寒い
    const sgn = d => d >= T ? 1 : d <= -T ? -1 : 0;
    const E = sgn(e), L = sgn(l);
    const sd = d => `<small>(体感 昨夜より ${d > 0 ? '+' : ''}${fmt(d)}℃)</small>`;

    // エアコン入りタイマー:冷え始める時刻の1時間前
    //  冷え始める=体感が「寝たときの体感」から2℃下がる最初の時刻
    //  (下がらない夜は、いちばん冷える時刻を使う。寝て1時間後より前にはしない)
    const coldH = now.minAt.getHours();
    const bedFeel = hours[0].feel;
    let iCold = hours.findIndex((h, i) => i >= 1 && h.feel <= bedFeel - 2);
    const found = iCold >= 0;
    if (!found) iCold = hours.findIndex(h => h.t.getTime() === now.minAt.getTime());
    const startH = hours[iCold].t.getHours();
    const iTimer = Math.max(1, iCold - 1);
    const timerH = hours[Math.min(iTimer, hours.length - 1)].t.getHours();
    const after = Math.round((hours[Math.min(iTimer, hours.length - 1)].t - hours[0].t) / 3600000);
    const startTxt = found ? `${startH}時ごろから寝たときより2℃以上冷える` : `${startH}時ごろがいちばん冷える`;
    const timer = `エアコン入りタイマー ${timerH}時<br><small>(${startTxt}ので、その1時間前。${bed}時に寝るなら リモコンで「${after}時間後に入」)</small>`;

    let kind, icon, main;
    if (E === 1 && L === -1) { kind = 'split'; icon = '🛏️➖ → 🌅➕'; main = '寝るときは1枚減らして、明け方に備える'; }
    else if (E === 1)        { kind = 'less';  icon = '🛏️➖'; main = e >= 4 ? '毛布を1枚減らす＋α' : '毛布を1枚減らす'; }
    else if (E === -1)       { kind = 'more';  icon = '🛏️➕'; main = e <= -4 ? '毛布を1枚増やす＋α' : '毛布を1枚増やす'; }
    else if (L === -1)       { kind = 'same';  icon = '🛏️✅ → 🌅➕'; main = '寝るときは昨日と同じ。明け方に備える'; }
    else                     { kind = 'same';  icon = '🛏️✅'; main = '昨日と同じでOK'; }

    const bedTxt = E === 1 ? `1枚減らす${e >= 4 ? '＋α' : ''}` : E === -1 ? `1枚増やす${e <= -4 ? '＋α' : ''}` : '昨日と同じ';
    // 役割分担:
    //  毛布 … 昨夜との差に合わせる(寝るときに決める)
    //  エアコン … 寝ているあいだの冷え込み(寝たときの体感 → いちばん低い体感)を埋める。3℃以上のときだけ
    const nightDrop = bedFeel - now.lateFeel;
    const needAC = nightDrop >= 3;
    let lateTxt;
    if (needAC) {
      lateTxt = timer.replace('(', `(寝ているあいだに ${fmt(nightDrop)}℃ 下がる分を埋める。`);
    } else if (L === -1 && E !== -1) {
      lateTxt = `足元に1枚置いておく<br><small>(寝ているあいだの冷え込みは ${fmt(nightDrop)}℃ なので、エアコンはいらない)</small>`;
    } else if (L === -1) {
      lateTxt = `そのままでOK<br><small>(寝ているあいだの冷え込みは ${fmt(nightDrop)}℃ だけ。寝るときに増やした分で足りる)</small>`;
    } else if (L === 1) {
      lateTxt = E === -1 ? '暖かめ。暑ければ1枚はずす' : '暖かめ。そのままでOK';
    } else {
      lateTxt = `そのままでOK<br><small>(寝ているあいだの冷え込みは ${fmt(nightDrop)}℃ だけ)</small>`;
    }

    const plan = [
      ['🛏️ 寝るとき', `${bedTxt} ${sd(e)}`],
      [`🌅 明け方<br>${coldH}時ごろ`, `${lateTxt} ${sd(l)}`]
    ];
    // 起きたとき:起きる時刻の天気。晴れならカーテンをしっかり閉める
    const w = hours[hours.length - 1];
    let [wIcon, wName] = WMO(w.code);
    if (w.code === 0) wIcon = '☀️';
    const sunny = w.code <= 1;
    plan.push([`⏰ 起きたとき<br>${w.t.getHours()}時`,
      `${wIcon} ${wName}　${fmt(w.temp)}℃`
      + (sunny ? '<br><small>晴れなので、カーテンをしっかり閉めて寝る</small>' : '')]);
    const why = (E === 0 && L === 0)
      ? '寝るときも明け方も、体感は昨夜とほとんど変わりません。'
      : '風や湿度を含めた「体感温度」で昨夜と比べています。';

    const tips = [];
    if (now.hum < 40) tips.push(`湿度 ${Math.round(now.hum)}% と乾燥しています。加湿器や濡れタオルを。`);
    if (now.hum > 75 && now.avg > 20) tips.push(`湿度 ${Math.round(now.hum)}% で蒸し暑い夜。除湿がおすすめ。`);
    if (now.rain >= 50) tips.push(`夜のうちに雨の確率 ${now.rain}%。窓は閉めて寝ましょう。`);
    if (now.wind >= 30) tips.push(`風が強め(最大 ${Math.round(now.wind)}km/h)。音で起きやすいかも。`);
    if (now.wake <= 8) tips.push(`起きる時刻は ${fmt(now.wake)}℃。暖房のタイマー予約がおすすめ。`);
    // 見出し:寝るとき・明け方のどちらかが昨夜より3℃以上違えば一言
    const coldest = Math.min(e, l), warmest = Math.max(e, l);
    const head = coldest <= -3 ? `❄️ 今夜は冷え込みます(体感 最大 ${fmt(coldest)}℃)`
               : warmest >= 3  ? `🌡️ 今夜は暖かくなります(体感 最大 +${fmt(warmest)}℃)`
               : '';
    return { kind, icon, main, why, plan, tips, head };
  }

  // ---- 最後に取得した結果の保存(端末の localStorage だけ。バックアップのJSONには入らない)
  const RESULT_KEY = 'sleep-type-tool-bedding-result';
  const RESULT_VER = 2;
  // 1時間ぶんの値を確かめて作り直す(通信で受け取った値にも、保存から読んだ値にも同じ限定をかける)
  function cleanHour(h) {
    if (!h || typeof h !== 'object') return null;
    const t = h.t instanceof Date ? h.t.getTime() : h.t;
    if (!inRange(t, 0, 4e12) || !inRange(h.temp, -90, 60) || !inRange(h.feel, -130, 80) || !inRange(h.hum, 0, 100)
      || !inRange(h.wind, 0, 400) || !Number.isInteger(h.code) || h.code < 0 || h.code > 99) return null;
    return { t: new Date(t), temp: h.temp, feel: h.feel, hum: h.hum, wind: h.wind, code: h.code,
      pop: inRange(h.pop, 0, 100) ? Math.round(h.pop) : null };
  }
  const dumpHour = h => ({ t: h.t.getTime(), temp: h.temp, feel: h.feel, hum: h.hum, wind: h.wind, code: h.code, pop: h.pop });
  const cleanHours = a => {
    if (!Array.isArray(a) || a.length < 2 || a.length > 40) return null;
    const out = a.map(cleanHour);
    return out.every(Boolean) ? out : null;
  };
  function loadResult() {
    try {
      const o = JSON.parse(localStorage.getItem(RESULT_KEY) || 'null');
      if (!o || typeof o !== 'object' || o.v !== RESULT_VER) return null;
      if (typeof o.key !== 'string' || !/^(zip:\d{7}|place:-?\d{1,3}\.\d{2},-?\d{1,3}\.\d{2})$/.test(o.key) || !(o.zip === '' || /^\d{7}$/.test(o.zip)) || !Number.isInteger(o.bed) || o.bed < 0 || o.bed > 23 || !Number.isInteger(o.wake) || o.wake < 0 || o.wake > 23) return null;
      if (!inRange(o.at, 0, 4e12) || !inRange(o.t0, 0, 4e12) || typeof o.day !== 'string' || !/^\d{8}$/.test(o.day)) return null;
      const addr = safeText(o.addr, 90), tonight = cleanHours(o.tonight), last = cleanHours(o.last);
      if (!addr || !tonight || !last) return null;
      let real = null;
      if (o.real !== null) {
        const r = o.real && typeof o.real === 'object' ? { temp: safeText(o.real.temp, 20), hum: safeText(o.real.hum, 20), wind: safeText(o.real.wind, 20) } : null;
        if (!r || !r.temp || !r.hum || !r.wind) return null;
        real = r;
      }
      const why = o.why === '' ? '' : safeText(o.why, 80);
      if (why === null) return null;
      if (!Array.isArray(o.avgs) || o.avgs.length !== 4 || !o.avgs.every(v => v === null || inRange(v, -90, 60))) return null;
      return { v: RESULT_VER, key: o.key, zip: o.zip, bed: o.bed, wake: o.wake, at: o.at, day: o.day, t0: o.t0, addr, tonight, last, real, why, avgs: o.avgs };
    } catch (e) { return null; }
  }
  function saveResult(d) {
    try {
      localStorage.setItem(RESULT_KEY, JSON.stringify({ v: RESULT_VER, key: d.key, zip: d.zip, bed: d.bed, wake: d.wake, at: d.at, day: d.day, t0: d.t0, addr: d.addr,
        tonight: d.tonight.map(dumpHour), last: d.last.map(dumpHour), real: d.real, why: d.why, avgs: d.avgs }));
    } catch (e) { /* 保存できなくても動く */ }
  }
  // 「昼12時より前に見たら『今夜』は昨日の夜から始まった夜」。その基準の日(0時)
  const tonightBase = now => { const b = new Date(now.getHours() < 12 ? addDays(now, -1) : now); b.setHours(0, 0, 0, 0); return b; };
  // 同じ日で、同じ郵便番号・時刻で、「今夜」の基準日も同じなら、保存した結果をそのまま使える
  const isFresh = (d, key, bed, wake, now) => d.key === key && d.bed === bed && d.wake === wake
    && d.day === ymdKey(now) && d.at <= now.getTime() + 60000 && d.t0 === tonightBase(now).getTime();
  // 全データ削除から呼ぶ。寝具の郵便番号・時刻・保存した結果を消す
  window.beddingClear = () => { try { localStorage.removeItem(BEDDING_KEY); localStorage.removeItem(RESULT_KEY); } catch (e) { /* 何もしない */ } };

  window.viewBedding = function viewBedding(root) {
    const saved = load();
    const hopt = (from, to, wrap) => { let s = ''; for (let h = from; h <= to; h++) s += `<option value="${wrap ? h % 24 : h}">${wrap ? h % 24 : h}:00</option>`; return s; };
    root.innerHTML = `<div class="bd">
      <p class="bd-lead">昨夜と比べて、毛布をどうするか。郵便番号か地名の天気予報から目安を出します。</p>
      <section class="card">
        <form class="bd-form" novalidate>
          <label class="f bd-locl">郵便番号 か 地名
            <input class="bd-zip" inputmode="text" enterkeyhint="search" autocomplete="off" placeholder="例 150-0002 / 渋谷区" maxlength="40">
          </label>
          <label class="f">寝る時刻<select class="bd-bed">${hopt(19, 26, true)}</select></label>
          <label class="f">起きる時刻<select class="bd-wake">${hopt(4, 10, false)}</select></label>
          <button class="btn bd-go" type="submit">表示</button>
        </form>
        <div class="bd-place" role="status"></div>
        <div class="bd-msg" role="alert"></div>
        <div class="bd-cands" hidden></div>
      </section>
      <div class="bd-result" hidden>
        <div class="bd-status"><span class="bd-stext" role="status"></span><button type="button" class="btn ghost small bd-refresh" title="天気を取り直す">更新</button></div>
        <div class="bd-verdict">
          <div class="bd-head" hidden></div>
          <div class="bd-icon"></div>
          <div class="bd-main"></div>
          <div class="bd-why"></div>
          <div class="bd-plan"></div>
          <ul class="bd-tips"></ul>
        </div>
        <section class="card"><h2>夜のあいだの天気</h2>
          <div class="bd-hours"></div>
          <div class="bd-note">青枠が最低気温の時間。☔ は雨の確率。</div>
        </section>
        <section class="card"><h2>今夜と昨夜の比べ</h2>
          <div class="bd-note bd-srcline"></div>
          <div class="bd-chart"></div>
          <table class="bd-cmp"><thead><tr><th></th><th class="bd-lastth">昨夜</th><th>今夜</th><th>差</th></tr></thead><tbody></tbody></table>
          <div class="bd-note pre bd-nightlabel"></div>
        </section>
        <section class="card bd-pj"></section>
        <p class="bd-night">🌙 良い夢を　おやすみなさい</p>
      </div>
      <p class="bd-foot"><a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">Weather data by Open-Meteo.com</a></p>
    </div>`;

    const q = s => root.querySelector(s);
    const zipEl = q('.bd-zip'), bedEl = q('.bd-bed'), wakeEl = q('.bd-wake'), goEl = q('.bd-go');
    zipEl.value = saved.zip ? `${saved.zip.slice(0, 3)}-${saved.zip.slice(3)}` : saved.query;
    let place = saved.place, placeQuery = saved.query;   // 地名検索で選んだ場所と、そのとき入れた文字
    bedEl.value = String(saved.bed);
    wakeEl.value = String(saved.wake);
    if (bedEl.value === '') bedEl.value = '23';
    if (wakeEl.value === '') wakeEl.value = '6';

    let ctl = null, lastChart = null, rt = null, left = false;

    function drawChart(nT, nL, real) {
      const chart = q('.bd-chart');
      const n = Math.min(nT.length, nL.length);
      const T = nT.slice(0, n), L = nL.slice(0, n);
      const W = Math.max(280, chart.clientWidth || 340), H = 200, pl = 36, pr = 44, pt = 12, pb = 26;
      const all = [...T, ...L].map(h => h.temp);
      let lo = Math.floor(Math.min(...all)) - 1, hi = Math.ceil(Math.max(...all)) + 1;
      const step = (hi - lo) > 10 ? 4 : 2;
      lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
      const x = i => pl + (W - pl - pr) * (n === 1 ? 0 : i / (n - 1));
      const y = v => pt + (H - pt - pb) * (hi - v) / (hi - lo);
      const path = arr => arr.map((h, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(h.temp).toFixed(1)}`).join('');
      let g = '';
      for (let v = lo; v <= hi; v += step) {
        g += `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/>`
           + `<text x="${pl - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${v}℃</text>`;
      }
      const xl = T.map((h, i) => `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--muted)">${h.t.getHours()}時</text>`).join('');
      // 終わりのラベルが重ならないように少しずらす
      let yT = y(T[n - 1].temp), yL = y(L[n - 1].temp);
      if (Math.abs(yT - yL) < 12) { if (yT <= yL) { yT -= 6; yL += 6; } else { yT += 6; yL -= 6; } }
      chart.innerHTML = `<div class="bd-legend">
          <span><svg width="22" height="6" aria-hidden="true"><line x1="1" x2="21" y1="3" y2="3" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"/></svg>今夜(予報)</span>
          <span><svg width="22" height="6" aria-hidden="true"><line x1="1" x2="21" y1="3" y2="3" stroke="var(--muted)" stroke-width="2" stroke-dasharray="5 4"/></svg>${real ? '昨夜(実測)' : '昨夜'}</span>
        </div>
        <svg class="plot" viewBox="0 0 ${W} ${H}" role="img" aria-label="昨夜と今夜の気温の推移">
          ${g}${xl}
          <line class="cx" x1="0" x2="0" y1="${pt}" y2="${H - pb}" stroke="var(--muted)" stroke-width="1" visibility="hidden"/>
          <path d="${path(L)}" fill="none" stroke="var(--muted)" stroke-width="2" stroke-dasharray="5 4" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="${path(T)}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <circle class="dL" r="4" fill="var(--muted)" stroke="var(--surface)" stroke-width="2" visibility="hidden"/>
          <circle class="dT" r="4" fill="var(--accent)" stroke="var(--surface)" stroke-width="2" visibility="hidden"/>
          <text x="${x(n - 1) + 6}" y="${yT + 4}" font-size="11" fill="var(--ink)">今夜</text>
          <text x="${x(n - 1) + 6}" y="${yL + 4}" font-size="11" fill="var(--muted)">昨夜</text>
          <rect x="${pl}" y="0" width="${W - pl - pr}" height="${H}" fill="transparent"/>
        </svg><div class="bd-tip" hidden></div>`;

      const s = chart.querySelector('svg.plot'), tip = chart.querySelector('.bd-tip');
      const cx = s.querySelector('.cx'), dT = s.querySelector('.dT'), dL = s.querySelector('.dL');
      const show = ev => {
        const r = s.getBoundingClientRect();
        const px = (ev.clientX - r.left) * W / r.width;
        const i = Math.max(0, Math.min(n - 1, Math.round((px - pl) / ((W - pl - pr) / Math.max(1, n - 1)))));
        const X = x(i);
        cx.setAttribute('x1', X); cx.setAttribute('x2', X);
        dT.setAttribute('cx', X); dT.setAttribute('cy', y(T[i].temp));
        dL.setAttribute('cx', X); dL.setAttribute('cy', y(L[i].temp));
        [cx, dT, dL].forEach(el => el.setAttribute('visibility', 'visible'));
        const d = T[i].temp - L[i].temp;
        tip.innerHTML = `<b>${T[i].t.getHours()}時</b>　今夜 ${fmt(T[i].temp)}℃ ／ 昨夜 ${fmt(L[i].temp)}℃(${d > 0 ? '+' : ''}${fmt(d)}℃)`;
        tip.hidden = false;
        const left = X / W * r.width;
        const half = tip.offsetWidth / 2;
        tip.style.left = Math.max(half, Math.min(r.width - half, left)) + 'px';
      };
      const hide = () => { [cx, dT, dL].forEach(el => el.setAttribute('visibility', 'hidden')); tip.hidden = true; };
      s.addEventListener('pointermove', show);
      s.addEventListener('pointerdown', show);
      // 指は離しても表示を残す(マウスだけ、外へ出たら消す)。縦スクロールが始まったら消す
      s.addEventListener('pointerleave', ev => { if (ev.pointerType === 'mouse') hide(); });
      s.addEventListener('pointercancel', hide);
    }

    const onResize = () => { clearTimeout(rt); rt = setTimeout(() => lastChart && drawChart(...lastChart), 150); };
    window.addEventListener('resize', onResize);

    function showError(text) {
      q('.bd-place').textContent = '';
      q('.bd-msg').textContent = text;
    }

    // 通信して、描くのに必要な値をそろえる(保存できる形で返す)
    async function fetchData(target, bed, wake, signal) {
      const loc = target.place ? { addr: target.place.name, lat: target.place.lat, lon: target.place.lon } : await lookupZip(target.zip, signal);
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${round2(loc.lat)}&longitude=${round2(loc.lon)}`
        + `&hourly=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation_probability,weather_code,wind_speed_10m`
        + `&past_days=5&forecast_days=3&timezone=Asia%2FTokyo`;
      const w = await getJSON(url, signal);
      const hr = w && w.hourly;
      if (!hr || !Array.isArray(hr.time) || !Array.isArray(hr.temperature_2m) || hr.time.length > 400) throw new NetError('天気のデータを受け取れませんでした。しばらくしてからもう一度');
      const arr = k => Array.isArray(hr[k]) ? hr[k] : [];
      const H = hr.time.map((t, i) => cleanHour({
        t: typeof t === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t) ? new Date(t).getTime() : NaN,
        temp: arr('temperature_2m')[i], feel: arr('apparent_temperature')[i], hum: arr('relative_humidity_2m')[i],
        pop: arr('precipitation_probability')[i], code: arr('weather_code')[i], wind: arr('wind_speed_10m')[i]
      })).filter(Boolean);

      const now = new Date();
      const t0 = tonightBase(now);
      const nTonight = nightSlice(H, t0, bed, wake);
      let nLast = nightSlice(H, addDays(t0, -1), bed, wake);
      if (nTonight.length < 2 || nLast.length < 2) throw new InputError('天気のデータが足りませんでした');
      // 昨夜は気象庁アメダスの実測に替える。取れない・欠測のときは Open-Meteo の値のまま
      let real = null, why = '';
      try {
        const am = await amedasNight(loc, nLast, signal);
        if (am.hours) { nLast = am.hours.map(cleanHour); real = am.names; } else why = am.why;
        if (nLast.some(h => !h)) { nLast = nightSlice(H, addDays(t0, -1), bed, wake); real = null; why = '実測の値が範囲外だった'; }
      } catch (err) { if (signal.aborted) throw err; why = '取得できなかった'; }
      // パジャマ:最近3晩(今夜を含む)の夜の平均気温。0〜3晩前
      const avgs = [0, 1, 2, 3].map(k => { const n = nightSlice(H, addDays(t0, -k), bed, wake); return n.length ? avg(n.map(h => h.temp)) : null; });
      return { v: RESULT_VER, key: target.key, zip: target.zip || '', bed, wake, at: now.getTime(), day: ymdKey(now), t0: t0.getTime(), addr: loc.addr, tonight: nTonight, last: nLast, real, why, avgs };
    }

    const hm = d => `${d.getHours()}:${pad2(d.getMinutes())}`;

    // 取得結果を画面に出す。stale があれば、更新できなかった理由つきの「古い情報」表示にする
    function render(d, stale) {
      const { bed, wake, tonight: nTonight, last: nLast, real, why } = d;
      q('.bd-msg').textContent = '';
      q('.bd-place').textContent = `📍 ${d.addr}${d.zip ? `(〒${d.zip.slice(0, 3)}-${d.zip.slice(3)})` : ''}`;
      const at = new Date(d.at), isToday = d.day === ymdKey(new Date());
      const when = isToday ? `今日 ${hm(at)}` : `${at.getMonth() + 1}/${at.getDate()}`;
      q('.bd-stext').textContent = stale ? `${when} の情報です。更新できませんでした(${stale})` : `${when} 更新`;
      q('.bd-status').classList.toggle('stale', !!stale);

      const a = summarize(nTonight), b = summarize(nLast);
      const v = decide(a, b, bed, nTonight);
      const pj = t => t >= 22 ? ['夏用', '半袖・薄手', '🩳'] : t >= 15 ? ['春秋用', '長袖・薄手', '👕'] : ['冬用', '長袖・厚手', '🧥'];
      const cur3 = avg(d.avgs.slice(0, 3).filter(x => x != null));
      const old3 = avg(d.avgs.slice(1, 4).filter(x => x != null));
      const [pName, pDesc, pIcon] = pj(cur3), [oName] = pj(Number.isFinite(old3) ? old3 : cur3);
      const changed = pName !== oName;
      const pjEl = q('.bd-pj');
      pjEl.className = 'card bd-pj' + (changed ? ' change' : '');
      pjEl.innerHTML = `<h2>${pIcon} パジャマ</h2>`
        + (changed ? `<div class="bd-pmain">そろそろ${pName}パジャマに切り替え</div>` : `<div class="bd-pmain">${pName}パジャマ(${pDesc})</div>`)
        + `<div class="bd-note">最近3晩の夜の平均気温 ${fmt(cur3)}℃(外の気温)。目安:22℃以上は夏用、15〜22℃は春秋用、15℃未満は冬用。部屋が暖かい家なら1段薄手でもOK。</div>`;
      q('.bd-verdict').className = 'bd-verdict ' + v.kind;
      q('.bd-head').textContent = v.head;
      q('.bd-head').hidden = !v.head;
      q('.bd-icon').textContent = v.icon;
      q('.bd-main').textContent = v.main;
      q('.bd-why').textContent = v.why;
      q('.bd-plan').innerHTML = v.plan.map(([k, val]) => `<div><span class="k">${k}</span><span class="v">${val}</span></div>`).join('');
      q('.bd-tips').innerHTML = v.tips.map(s => `<li>${s}</li>`).join('');

      const diff = (x, y) => {
        const dd = x - y, cls = dd >= 0.5 ? 'up' : dd <= -0.5 ? 'down' : 'flat';
        const arrow = dd >= 0.5 ? '↑' : dd <= -0.5 ? '↓' : '→';
        return `<td class="${cls}">${arrow} ${dd > 0 ? '+' : ''}${fmt(dd)}℃</td>`;
      };
      const row = (name, x, y) => `<tr><td>${name}</td><td>${fmt(y)}℃</td><td>${fmt(x)}℃</td>${diff(x, y)}</tr>`;
      // 最低は時刻も添える(昨夜と今夜で時刻が違うことがあるため)
      const atH = t => `<br><small class="flat">${t.getHours()}時ごろ</small>`;
      const rowT = (name, x, y, xt, yt) => `<tr><td>${name}</td><td>${fmt(y)}℃${atH(yt)}</td><td>${fmt(x)}℃${atH(xt)}</td>${diff(x, y)}</tr>`;
      const dh = Math.round(a.hum - b.hum);
      q('.bd-cmp tbody').innerHTML =
          row(`寝るとき(${bed}時)`, a.bed, b.bed)
        + row('入眠2時間平均(体感)', a.earlyFeel, b.earlyFeel)
        + rowT('最低気温', a.min, b.min, a.minAt, b.minAt)
        + row(`起きるとき(${wake}時)`, a.wake, b.wake)
        + `<tr><td>湿度(平均)</td><td>${Math.round(b.hum)}%</td><td>${Math.round(a.hum)}%</td><td class="flat">${dh > 0 ? '+' : ''}${dh}%</td></tr>`;
      const md = t => `${t.getMonth() + 1}/${t.getDate()}`;
      q('.bd-nightlabel').textContent = `今夜=${md(nTonight[0].t)} ${bed}時〜${md(nTonight[nTonight.length - 1].t)} ${wake}時 ／ 昨夜=${md(nLast[0].t)}〜${md(nLast[nLast.length - 1].t)}。${real ? '昨夜は気象庁アメダスの実測' : '昨夜は予報元(Open-Meteo)の値'}、今夜は予報です。\n※体感温度は、気温に風や湿度の影響を加えた「人が感じる温度」です。風が強いときや乾燥しているときは、気温より低く出ます。`;
      const srcEl = q('.bd-srcline');
      if (real) {
        srcEl.textContent = `昨夜は実測:気象庁アメダス(${real.hum === real.temp && real.wind === real.temp ? real.temp : `気温 ${real.temp}・湿度 ${real.hum}・風 ${real.wind}`})。体感温度は気温・湿度・風から計算。`;
      } else {
        srcEl.textContent = `昨夜の実測(アメダス)は使えなかったので、予報元(Open-Meteo)の値です(${why})。`;
      }
      q('.bd-lastth').textContent = real ? '昨夜(実測)' : '昨夜';
      q('.bd-hours').innerHTML = nTonight.map(h => {
        const [ic, nm] = WMO(h.code);
        const isMin = h.t.getTime() === a.minAt.getTime();
        return `<div class="bd-hr${isMin ? ' min' : ''}" title="${nm}">
          <div class="t">${h.t.getHours()}時</div>
          <div class="w">${ic}</div>
          <div class="c">${Math.round(h.temp)}℃</div>
          <div class="r">☔${h.pop === null ? '-' : h.pop}%</div></div>`;
      }).join('');
      q('.bd-result').hidden = false;
      lastChart = [nTonight, nLast, !!real];
      drawChart(nTonight, nLast, !!real);
    }

    const refreshEl = q('.bd-refresh');
    let busy = false;
    // mode: 'open'(画面を開いた) / 'show'(「表示」) / 'refresh'(「更新」)
    const candsEl = q('.bd-cands');
    const hideCands = () => { candsEl.hidden = true; candsEl.textContent = ''; };
    // 入れた文字から、取得する場所を決める。郵便番号(7桁)か、地名(国土地理院で探す)
    // 返り値: { target } / { cands } (候補が複数: 選んでもらう) / { error }
    async function resolveTarget(text, mode) {
      const digits = text.replace(/[-ー－\s]/g, '');
      if (/^\d{7}$/.test(digits)) return { target: { key: `zip:${digits}`, zip: digits, place: null } };
      if (/^\d+$/.test(digits)) return { error: '郵便番号は7桁の数字で入れてください(地名でも探せます)' };
      if (text.length < 2) return { error: '地名は2文字以上で入れてください' };
      if (!safeText(text, 40)) return { error: '地名に使えない文字があります。漢字・ひらがな・カタカナで入れてください' };
      if (place && placeQuery === text) return { target: { key: placeKey(place), zip: '', place } };   // 前に選んだ場所
      const list = await searchPlace(text, ctl.signal);
      if (!list.length) return { error: 'その地名は見つかりませんでした。市区町村名などで試してください' };
      if (list.length === 1) { place = list[0]; placeQuery = text; return { target: { key: placeKey(place), zip: '', place } }; }
      return { cands: list };
    }

    // mode: 'open'(画面を開いた) / 'show'(「表示」) / 'refresh'(「更新」)。chosen: 候補から選んだ場所
    async function run(mode, chosen) {
      const text = toHalf(zipEl.value).trim();
      if (!text) { q('.bd-msg').textContent = '郵便番号か地名を入れてください'; zipEl.focus(); return; }
      const bed = +bedEl.value, wake = +wakeEl.value;
      hideCands();
      if (busy) return;   // 通信中の二重実行を防ぐ
      const cached = loadResult();
      let target = null;
      // 通信しなくても場所が決まる場合(郵便番号、前に選んだ場所)は、同じ日の保存結果をそのまま出す
      const digits = text.replace(/[-ー－\s]/g, '');
      if (chosen) { place = chosen; placeQuery = text; target = { key: placeKey(chosen), zip: '', place: chosen }; }
      else if (/^\d{7}$/.test(digits)) target = { key: `zip:${digits}`, zip: digits, place: null };
      else if (place && placeQuery === text) target = { key: placeKey(place), zip: '', place };
      const same = !!(target && cached && cached.key === target.key && cached.bed === bed && cached.wake === wake);
      if (mode !== 'refresh' && same && isFresh(cached, target.key, bed, wake, new Date())) { render(cached, null); return; }
      busy = true; goEl.disabled = true; refreshEl.disabled = true;
      ctl = new AbortController();
      q('.bd-msg').textContent = ''; q('.bd-place').textContent = '調べています…';
      try {
        if (!target) {
          const r = await resolveTarget(text, mode);
          if (left) return;
          if (r.error) { showError(r.error); q('.bd-result').hidden = true; lastChart = null; return; }
          if (r.cands) {
            q('.bd-place').textContent = '';
            q('.bd-msg').textContent = '';
            candsEl.textContent = '';
            const lead = document.createElement('div'); lead.className = 'bd-note'; lead.textContent = 'どの場所ですか?'; candsEl.append(lead);
            for (const c of r.cands) {
              const b = document.createElement('button'); b.type = 'button'; b.className = 'btn ghost small'; b.textContent = c.name;
              b.addEventListener('click', () => run('show', c));
              candsEl.append(b);
            }
            candsEl.hidden = false;
            q('.bd-result').hidden = true; lastChart = null;
            return;
          }
          target = r.target;
        }
        const data = await fetchData(target, bed, wake, ctl.signal);
        if (left) return;
        save({ zip: target.zip, place: target.place, query: target.place ? placeQuery : '', bed, wake });   // 取得できた内容だけ保存する
        saveResult(data);
        render(data, null);
      } catch (err) {
        if (left) return;  // 画面を離れた
        const text2 = err instanceof NetError || err instanceof InputError ? err.message : '表示できませんでした。もう一度お試しください';
        if (same) { render(cached, text2.split('。')[0]); }   // 前の結果を残し、古いことが分かる表示にする
        else { showError(text2); q('.bd-result').hidden = true; lastChart = null; }
      } finally {
        busy = false; goEl.disabled = false; refreshEl.disabled = false;
      }
    }

    q('.bd-form').addEventListener('submit', e => { e.preventDefault(); run('show'); });
    refreshEl.addEventListener('click', () => run('refresh'));
    if (saved.zip || saved.place) run('open');   // 保存済みの郵便番号があれば、この画面を開いたときに(同じ日の保存結果がなければ)取得する

    return () => { left = true; window.removeEventListener('resize', onResize); clearTimeout(rt); if (ctl) ctl.abort(); };
  };
})();
