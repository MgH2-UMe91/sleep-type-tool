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

  // エアコン・暑さの判定に使う気温のしきい値(端末の localStorage だけ。バックアップには入れない)
  const AC_BORDER_C = 0.5;                                  // しきい値の±これ以内なら「微妙」と言う(寒い側・暑い側どちらも)
  const TH_DEFAULT = { cold: 10, hot: 25, lead: 2 };         // 寒くて起きる気温 / 暑くて起きる気温 / エアコンを何時間前に入れるか
  const TH_RANGE = { cold: [-10, 30], hot: [10, 45], lead: [0, 6] };
  // 値を確かめて作り直す(読んだ保存値にも、入力にも同じ限定をかける)。範囲外・順序の誤りは null
  const cleanTh = t => {
    if (!t || typeof t !== 'object') return null;
    const { cold, hot, lead } = t;
    if (!inRange(cold, ...TH_RANGE.cold) || !inRange(hot, ...TH_RANGE.hot) || !Number.isInteger(lead) || !inRange(lead, ...TH_RANGE.lead) || !(cold < hot)) return null;
    return { cold: Math.round(cold * 10) / 10, hot: Math.round(hot * 10) / 10, lead };
  };
  // 入力欄の文字を確かめる。返り値: { th } か { error, bad: ['cold'|'hot'|'lead'] }
  function checkTh(coldText, hotText, leadText) {
    const num = t => { const x = toHalf(String(t)).trim(); return x !== '' && /^-?\d+(\.\d+)?$/.test(x) ? Number(x) : NaN; };
    const cold = num(coldText), hot = num(hotText), lead = num(leadText);
    if (!Number.isFinite(cold) || !inRange(cold, ...TH_RANGE.cold)) return { error: `寒い気温は ${TH_RANGE.cold[0]}〜${TH_RANGE.cold[1]}℃ の数字で入れてください`, bad: ['cold'] };
    if (!Number.isFinite(hot) || !inRange(hot, ...TH_RANGE.hot)) return { error: `暑い気温は ${TH_RANGE.hot[0]}〜${TH_RANGE.hot[1]}℃ の数字で入れてください`, bad: ['hot'] };
    if (!(cold < hot)) return { error: `寒い気温(${fmt(cold)}℃)は、暑い気温(${fmt(hot)}℃)より低くしてください`, bad: ['cold', 'hot'] };
    if (!Number.isInteger(lead) || !inRange(lead, ...TH_RANGE.lead)) return { error: `エアコンを入れるタイミングは ${TH_RANGE.lead[0]}〜${TH_RANGE.lead[1]} 時間前の整数で入れてください`, bad: ['lead'] };
    return { th: cleanTh({ cold, hot, lead }) };
  }

  // 保存するのは、郵便番号、または地名検索で選んだ場所(名前と緯度経度)。どちらか一方
  const load = () => {
    const none = { zip: '', place: null, query: '', bed: 23, wake: 6, th: { ...TH_DEFAULT }, thSaved: false };
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
      return { zip, place: query ? place : null, query, bed, wake, th: cleanTh(o.th) || { ...TH_DEFAULT }, thSaved: !!cleanTh(o.th) };
    } catch (e) { return none; }
  };
  const save = v => { try { const { thSaved, ...rest } = v; localStorage.setItem(BEDDING_KEY, JSON.stringify(rest)); } catch (e) { /* 保存できなくても動く */ } };

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
  // エアコンと暑さの判定(気温のしきい値で見る。体感温度ではなく、寝る〜起きる時刻の時間別の予報気温)
  //  寒い側: 寝る時点でしきい値未満 → 最初からON / 途中で初めて下回る → その lead 時間前にONタイマー(寝る時刻より前になるなら寝るときにON) / 下回らない → 勧めない
  //  最低気温がしきい値の ±AC_BORDER_C 以内なら断定せず「微妙。タイマー付きがおすすめ」。暑い側(最高気温)も同じ扱い
  function acAdvice(hours, th) {
    const hr = t => `${new Date(t).getHours()}時`;
    const bedT = hours[0].t.getTime();
    const temps = hours.map(h => h.temp);
    const min = Math.min(...temps), max = Math.max(...temps);
    const near = (v, th0) => Math.abs(v - th0) <= AC_BORDER_C + 1e-9;
    const rows = [];

    const iCold = temps.findIndex(v => v < th.cold);
    let on = '', timing = '';
    if (iCold >= 0) {
      const crossT = hours[iCold].t.getTime();
      const timerT = crossT - th.lead * 3600000;
      if (iCold === 0) { on = '最初からエアコンON'; timing = `寝る${hr(bedT)}の予報が ${fmt(temps[0])}℃ で、${fmt(th.cold)}℃を下回っています`; }
      else if (timerT <= bedT) { on = '寝るときにエアコンON'; timing = `${hr(crossT)}に ${fmt(th.cold)}℃を下回る予報。${th.lead}時間前は寝る時刻より前になるので、寝るときから`; }
      else { on = `${hr(timerT)}にエアコンONタイマー`; timing = `${hr(crossT)}に ${fmt(th.cold)}℃を下回る予報の${th.lead ? `${th.lead}時間前` : 'ちょうどその時刻'}。寝てから${Math.round((timerT - bedT) / 3600000)}時間後に入`; }
    }
    if (near(min, th.cold)) {
      rows.push(['❄️ エアコン', `微妙。タイマー付きがおすすめ<br><small>(最低 ${fmt(min)}℃(${hr(hours[temps.indexOf(min)].t)})で、しきい値 ${fmt(th.cold)}℃のすぐそば${on ? `。入れるなら:${on}。${timing}` : '。下回る予報ではありませんが、冷えたら入るように'})</small>`]);
    } else if (iCold >= 0) {
      rows.push(['❄️ エアコン', `${on}<br><small>(${timing})</small>`]);
    } else {
      rows.push(['❄️ エアコン', `勧めません<br><small>(最低 ${fmt(min)}℃(${hr(hours[temps.indexOf(min)].t)})は、しきい値 ${fmt(th.cold)}℃以上)</small>`]);
    }

    if (near(max, th.hot)) {
      rows.push(['🔥 暑さ', `暑くなるかも(微妙)。寝具を薄めに/冷房を検討<br><small>(最高 ${fmt(max)}℃(${hr(hours[temps.indexOf(max)].t)})で、しきい値 ${fmt(th.hot)}℃のすぐそば)</small>`]);
    } else if (max > th.hot) {
      const iHot = temps.findIndex(v => v > th.hot);
      rows.push(['🔥 暑さ', `暑くなる予報。寝具を薄めに/冷房を検討<br><small>(${hr(hours[iHot].t)}に ${fmt(th.hot)}℃を超え、最高 ${fmt(max)}℃)</small>`]);
    }
    return rows;
  }

  function decide(now, prev, bed, hours, th) {
    const T = 1.5;
    const e = now.earlyFeel - prev.earlyFeel;   // +なら寝るときが暖かい
    const l = now.lateFeel - prev.lateFeel;     // −なら明け方が寒い
    const sgn = d => d >= T ? 1 : d <= -T ? -1 : 0;
    const E = sgn(e), L = sgn(l);
    const sd = d => `<small>(体感 昨夜より ${d > 0 ? '+' : ''}${fmt(d)}℃)</small>`;

    const coldH = now.minAt.getHours();
    const bedFeel = hours[0].feel;

    let kind, icon, main;
    if (E === 1 && L === -1) { kind = 'split'; icon = '🛏️➖ → 🌅➕'; main = '寝るときは1枚減らして、明け方に備える'; }
    else if (E === 1)        { kind = 'less';  icon = '🛏️➖'; main = e >= 4 ? '毛布を1枚減らす＋α' : '毛布を1枚減らす'; }
    else if (E === -1)       { kind = 'more';  icon = '🛏️➕'; main = e <= -4 ? '毛布を1枚増やす＋α' : '毛布を1枚増やす'; }
    else if (L === -1)       { kind = 'same';  icon = '🛏️✅ → 🌅➕'; main = '寝るときは昨日と同じ。明け方に備える'; }
    else                     { kind = 'same';  icon = '🛏️✅'; main = '昨日と同じでOK'; }

    const bedTxt = E === 1 ? `1枚減らす${e >= 4 ? '＋α' : ''}` : E === -1 ? `1枚増やす${e <= -4 ? '＋α' : ''}` : '昨日と同じ';
    // 役割分担:
    //  毛布 … 昨夜との差に合わせる(寝るときに決める)
    //  エアコン … 気温のしきい値で別に判定する(acAdvice)。ここでは毛布の話だけ
    const nightDrop = bedFeel - now.lateFeel;
    let lateTxt;
    if (L === -1 && E !== -1) {
      lateTxt = `足元に1枚置いておく<br><small>(寝ているあいだの冷え込みは 体感 ${fmt(nightDrop)}℃)</small>`;
    } else if (L === -1) {
      lateTxt = `そのままでOK<br><small>(寝ているあいだの冷え込みは 体感 ${fmt(nightDrop)}℃。寝るときに増やした分で足りる)</small>`;
    } else if (L === 1) {
      lateTxt = E === -1 ? '暖かめ。暑ければ1枚はずす' : '暖かめ。そのままでOK';
    } else {
      lateTxt = `そのままでOK<br><small>(寝ているあいだの冷え込みは 体感 ${fmt(nightDrop)}℃)</small>`;
    }

    const plan = [
      ['🛏️ 寝るとき', `${bedTxt} ${sd(e)}`],
      [`🌅 明け方<br>${coldH}時ごろ`, `${lateTxt} ${sd(l)}`],
      ...acAdvice(hours, th)
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
    // 見出し:寝るとき・明け方のどちらかが昨夜より3℃以上違えば一言
    const coldest = Math.min(e, l), warmest = Math.max(e, l);
    const head = coldest <= -3 ? `❄️ 今夜は冷え込みます(体感 最大 ${fmt(coldest)}℃)`
               : warmest >= 3  ? `🌡️ 今夜は暖かくなります(体感 最大 +${fmt(warmest)}℃)`
               : '';
    return { kind, icon, main, why, plan, tips, head };
  }

  // ---- 最後に取得した結果の保存(端末の localStorage だけ。バックアップのJSONには入らない)
  const RESULT_KEY = 'sleep-type-tool-bedding-result';
  const RESULT_VER = 3;
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
      if (!addr || !tonight || !last || !inJapan(o.lat, o.lon)) return null;
      let real = null;
      if (o.real !== null) {
        const r = o.real && typeof o.real === 'object' ? { temp: safeText(o.real.temp, 20), hum: safeText(o.real.hum, 20), wind: safeText(o.real.wind, 20) } : null;
        if (!r || !r.temp || !r.hum || !r.wind) return null;
        real = r;
      }
      const why = o.why === '' ? '' : safeText(o.why, 80);
      if (why === null) return null;
      if (!Array.isArray(o.avgs) || o.avgs.length !== 4 || !o.avgs.every(v => v === null || inRange(v, -90, 60))) return null;
      return { v: RESULT_VER, key: o.key, zip: o.zip, lat: o.lat, lon: o.lon, bed: o.bed, wake: o.wake, at: o.at, day: o.day, t0: o.t0, addr, tonight, last, real, why, avgs: o.avgs };
    } catch (e) { return null; }
  }
  function saveResult(d) {
    try {
      localStorage.setItem(RESULT_KEY, JSON.stringify({ v: RESULT_VER, key: d.key, zip: d.zip, lat: d.lat, lon: d.lon, bed: d.bed, wake: d.wake, at: d.at, day: d.day, t0: d.t0, addr: d.addr,
        tonight: d.tonight.map(dumpHour), last: d.last.map(dumpHour), real: d.real, why: d.why, avgs: d.avgs }));
    } catch (e) { /* 保存できなくても動く */ }
  }
  // 設定の「起きる時刻」より前に見たら『今夜』は昨日の夜から始まった夜(まだ寝ている夜)、起きる時刻を過ぎたら次に来る夜。その基準の日(0時)
  // 切り替えの判定・保存結果の使い回し・画面の説明文は、すべてこの関数と起きる時刻から作る
  const beforeWake = (now, wake) => now.getHours() < wake;
  const tonightBase = (now, wake) => { const b = new Date(beforeWake(now, wake) ? addDays(now, -1) : now); b.setHours(0, 0, 0, 0); return b; };
  const WD = '日月火水木金土';
  const mdw = d => `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
  // 同じ日で、同じ郵便番号・時刻で、「今夜」の基準日も同じなら、保存した結果をそのまま使える
  const isFresh = (d, key, bed, wake, now) => d.key === key && d.bed === bed && d.wake === wake
    && d.day === ymdKey(now) && d.at <= now.getTime() + 60000 && d.t0 === tonightBase(now, wake).getTime();
  // 全データ削除から呼ぶ。寝具の郵便番号・時刻・保存した結果を消す
  window.beddingClear = () => { try { localStorage.removeItem(BEDDING_KEY); localStorage.removeItem(RESULT_KEY); localStorage.removeItem(REVIEW_KEY); localStorage.removeItem('sleep-type-tool-bedding-rvopen'); } catch (e) { /* 何もしない */ } };

  // ---- 昨夜のふりかえり:気象庁アメダスの気温(1時間ごと)を、昨夜と前の晩の2晩ぶん端末に保存して比べる
  //  - 送り先は気象庁だけ。最寄りの観測地点は端末の中で選ぶ(位置は送らない)。送るのは地点の番号と日付だけ
  //  - 保存は端末の localStorage(REVIEW_KEY)だけ。バックアップのJSONには入れない。全削除で消える
  //  - 取れた値は保存して使い回す。値がそろった晩は二度と取りに行かない
  const REVIEW_KEY = 'sleep-type-tool-bedding-review';
  const REVIEW_SAME_C = 0.5;                 // 睡眠中の平均気温の差がこれ未満なら「ほぼ同じ」
  const RV = { from: 19, n: 16, keep: 3 };   // 晩ごとに 19時〜翌10時の1時間ごと16点。保存は新しい3晩まで
  const HOUR = 3600000;
  const RV_RETRY_MS = 30 * 60000;            // 観測がまだそろわない晩を取り直す間隔
  const RV_FINAL_MS = 60 * 60000;            // 晩の終わり(10時)からこれだけたてば、欠けは確定として取り直さない
  const KEY_RE = /^(zip:\d{7}|place:-?\d{1,3}\.\d{2},-?\d{1,3}\.\d{2})$/;
  const dateOf = k => new Date(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8));
  const validDay = k => typeof k === 'string' && /^\d{8}$/.test(k) && ymdKey(dateOf(k)) === k;
  const nightStart = k => { const d = dateOf(k); d.setHours(RV.from, 0, 0, 0); return d.getTime(); };
  const nightEnd = k => nightStart(k) + (RV.n - 1) * HOUR;
  const prefsKey = () => { const p = load(); return p.zip ? `zip:${p.zip}` : p.place ? placeKey(p.place) : ''; };

  function loadReview() {
    try {
      const o = JSON.parse(localStorage.getItem(REVIEW_KEY) || 'null');
      if (!o || typeof o !== 'object' || o.v !== 1 || typeof o.key !== 'string' || !KEY_RE.test(o.key)) return null;
      if (!Array.isArray(o.cands) || o.cands.length < 1 || o.cands.length > AMEDAS_MAX_TRY || !Number.isInteger(o.si) || o.si < 0 || o.si >= o.cands.length) return null;
      const cands = o.cands.map(c => c && /^\d{5}$/.test(c.id) && safeText(c.name, 20) ? { id: c.id, name: c.name } : null);
      if (!cands.every(Boolean)) return null;
      if (!o.nights || typeof o.nights !== 'object') return null;
      const nights = {};
      const ents = Object.entries(o.nights);
      if (ents.length > RV.keep + 1) return null;
      for (const [k, e] of ents) {
        if (!validDay(k) || !e || !Array.isArray(e.pts) || e.pts.length !== RV.n || !e.pts.every(v => v === null || inRange(v, -60, 60))
          || !inRange(e.at, 0, 4e12) || typeof e.ok !== 'boolean') return null;
        nights[k] = { pts: e.pts.slice(), at: e.at, ok: e.ok };
      }
      return { v: 1, key: o.key, cands, si: o.si, nights };
    } catch (e) { return null; }
  }
  function saveReview(r) { try { localStorage.setItem(REVIEW_KEY, JSON.stringify(r)); } catch (e) { /* 保存できなくても動く */ } }

  // その晩の「寝ていた時間帯」。睡眠の記録(その夜の日付の記録)があれば寝た・起きた時刻、なければ今夜の寝具で設定した時刻。19時〜翌10時の中に収める
  function windowOf(k) {
    const base = dateOf(k), s0 = nightStart(k), e0 = nightEnd(k);
    const at = (h, m, plus) => { const d = new Date(base); d.setDate(d.getDate() + plus); d.setHours(h, m, 0, 0); return d.getTime(); };
    let bed = null, wake = null, src = 'setting';
    try {
      if (typeof Store !== 'undefined') {
        const iso = `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6, 8)}`;
        for (const r of Store.records()) {
          if (r.date !== iso || !isHm(r.bedTime) || !isHm(r.wakeTime)) continue;
          const [bh, bm] = r.bedTime.split(':').map(Number), [wh, wm] = r.wakeTime.split(':').map(Number);
          const b = at(bh, bm, bh < 12 ? 1 : 0);
          let w = at(wh, wm, 0); while (w <= b) w += 24 * HOUR;
          bed = bed === null ? b : Math.min(bed, b); wake = wake === null ? w : Math.max(wake, w);
        }
      }
    } catch (e) { bed = null; }
    if (bed !== null) {
      bed = Math.max(bed, s0); wake = Math.min(wake, e0);
      if (wake - bed >= HOUR / 2) src = 'record'; else bed = null;
    }
    if (bed === null) {
      const p = load();
      bed = Math.max(at(p.bed, 0, p.bed < 12 ? 1 : 0), s0); wake = Math.min(at(p.wake, 0, 1), e0);
    }
    return { bed, wake, src };
  }

  // 「昨夜」=起きる時刻を過ぎた、いちばん新しい晩。[昨夜, 前の晩, その前の晩] の日付(YYYYMMDD)
  function latestNights(now) {
    const base = new Date(now); base.setHours(0, 0, 0, 0);
    for (let i = 0; i <= 3; i++) {
      const k = ymdKey(addDays(base, -i));
      if (windowOf(k).wake <= now.getTime()) return [0, 1, 2].map(j => ymdKey(addDays(dateOf(k), -j)));
    }
    return [];
  }

  // 1晩ぶんの気温(19時〜翌10時、1時間ごと)を気象庁から読む。欠測・品質が正常でない値は null
  async function loadTempNight(id, k, signal) {
    const s0 = nightStart(k);
    const hoursOf = i => new Date(s0 + i * HOUR);
    const files = new Set();
    for (let i = 0; i < RV.n; i++) { const t = hoursOf(i); files.add(`${ymdKey(t)}_${pad2(Math.floor(t.getHours() / 3) * 3)}`); }
    const data = {};
    let ok = true, got = false;
    await Promise.all([...files].map(async f => {
      try {
        const j = await getJSON(`${JMA_BASE}data/point/${id}/${f}.json`, signal);
        if (j && typeof j === 'object') { Object.assign(data, j); got = true; }
      } catch (e) {
        if (signal && signal.aborted) throw e;
        if (!(e instanceof NetError) || !/\((403|404)\)/.test(e.message)) ok = false;   // まだ無い・無いファイルは欠測。それ以外の失敗は取り直す
      }
    }));
    const pts = [];
    for (let i = 0; i < RV.n; i++) {
      const t = hoursOf(i), o = data[`${ymdKey(t)}${pad2(t.getHours())}0000`];
      const a = o && typeof o === 'object' ? o.temp : null;
      pts.push(Array.isArray(a) && a[1] === 0 && inRange(a[0], -60, 60) ? a[0] : null);
    }
    return { pts, at: Date.now(), ok, got };
  }

  // 最寄りの観測地点(気温あり、40km以内、近い順に最大3つ)を端末の中で選んで保存する。場所が変わったときだけ
  let rvNoStation = '';
  async function reviewSeed(key, lat, lon, signal) {
    const cur = loadReview();
    if ((cur && cur.key === key) || rvNoStation === key) return;
    const table = await getJSON(`${JMA_BASE}const/amedastable.json`, signal);
    const cands = parseStations(table).filter(s => s.el[ELEM.temp] === '1')
      .map(s => ({ s, d: distKm({ lat, lon }, s) })).filter(c => c.d <= AMEDAS_MAX_KM)
      .sort((a, b) => a.d - b.d).slice(0, AMEDAS_MAX_TRY).map(c => ({ id: c.s.id, name: c.s.name }));
    if (!cands.length) { rvNoStation = key; return; }
    saveReview({ v: 1, key, cands, si: 0, nights: {} });
  }

  // 保存した値を足りないぶんだけ取り足す。何か保存したら true
  let rvBusy = null;
  function reviewRefresh(signal) {
    if (!rvBusy) rvBusy = reviewRefreshRun(signal).finally(() => { rvBusy = null; });
    return rvBusy;
  }
  async function reviewRefreshRun(signal) {
    const key = prefsKey(), r = loadReview();
    if (!key || !r || r.key !== key) return false;
    const now = new Date(), nowMs = now.getTime();
    const ks = latestNights(now);
    if (ks.length < 3) return false;
    const needFetch = k => {
      const e = r.nights[k];
      if (!e) return true;
      if (e.ok && e.at >= nightEnd(k) + RV_FINAL_MS) return false;               // 欠けも含めて確定
      return (e.pts.includes(null) || !e.ok) && nowMs - e.at >= RV_RETRY_MS;     // まだ観測が増えるかもしれない晩は、間をあけて取り直す
    };
    let changed = false;
    const fetchList = async list => {
      for (const k of list) {
        if (!needFetch(k)) continue;
        const e = await loadTempNight(r.cands[r.si].id, k, signal);
        // その地点にこの晩の観測がまったく無ければ、次に近い地点へ替えて最初からやり直す
        if (e.ok && !e.pts.some(v => v !== null) && r.si + 1 < r.cands.length) { r.si++; r.nights = {}; changed = true; return true; }
        if (e.got) { r.nights[k] = { pts: e.pts, at: e.at, ok: e.ok }; changed = true; }
      }
      return false;
    };
    for (let round = 0; round < AMEDAS_MAX_TRY; round++) {
      if (await fetchList([ks[0], ks[1]])) continue;
      if (!(nightModel(r, ks[0]) && nightModel(r, ks[1])) && await fetchList([ks[2]])) continue;
      break;
    }
    if (changed) {
      for (const k of Object.keys(r.nights).sort().reverse().slice(RV.keep)) delete r.nights[k];
      saveReview(r);
    }
    return changed;
  }

  // 時刻 t(ミリ秒)の気温。1時間ごとの点を直線でつなぐ。点が欠けていれば null
  const interp = (pts, s0, t) => {
    const x = (t - s0) / HOUR;
    if (x < -1e-9 || x > RV.n - 1 + 1e-9) return null;
    const i = Math.min(RV.n - 1, Math.floor(x + 1e-9)), f = x - i;
    const a = pts[i];
    if (a === null) return null;
    if (f < 1e-6) return a;
    const b = pts[i + 1];
    return b === null ? null : a + (b - a) * f;
  };
  // その晩の寝ていた時間帯の平均・最低など。時間帯の気温がそろっていなければ null
  function nightModel(r, k) {
    const e = r.nights[k];
    if (!e) return null;
    const s0 = nightStart(k), w = windowOf(k);
    const i0 = Math.floor((w.bed - s0) / HOUR), i1 = Math.min(RV.n - 1, Math.ceil((w.wake - s0) / HOUR));
    for (let i = i0; i <= i1; i++) if (e.pts[i] === null) return null;
    let sum = 0, cnt = 0, min = Infinity, minAt = w.bed;
    for (let t = w.bed; ; t += 600000) {
      const tt = Math.min(t, w.wake), v = interp(e.pts, s0, tt);
      if (v === null) return null;
      sum += v; cnt++;
      if (v < min) { min = v; minAt = tt; }
      if (tt >= w.wake) break;
    }
    return { k, s0, pts: e.pts, win: w, avg: sum / cnt, min, minAt,
      atBed: interp(e.pts, s0, w.bed), atWake: interp(e.pts, s0, w.wake), at2: interp(e.pts, s0, s0 + 7 * HOUR), at5: interp(e.pts, s0, s0 + 10 * HOUR) };
  }
  // 画面に出す形。条件がそろわなければ null(エラーは出さない)
  function reviewModel(now) {
    const key = prefsKey(), r = loadReview();
    if (!key || !r || r.key !== key) return null;
    const ks = latestNights(now);
    for (let i = 0; i + 1 < ks.length; i++) {
      const a = nightModel(r, ks[i]), b = nightModel(r, ks[i + 1]);
      if (a && b) {
        const dd = a.avg - b.avg, rd = Math.round(Math.abs(dd) * 10) / 10;
        return { a, b, dd, absd: rd, same: rd < REVIEW_SAME_C, station: r.cands[r.si].name };
      }
    }
    return null;
  }

  // 凡例用:「11/7(金)→11/8(土)」。今夜の見出しと同じ日付+曜日の書式
  const nightLabelWd = k => { const s = dateOf(k); return `${mdw(s)}→${mdw(addDays(s, 1))}`; };
  const nightLabel = k => {
    const s = dateOf(k), e = addDays(s, 1);
    return `${s.getMonth() + 1}/${s.getDate()}→${e.getMonth() === s.getMonth() ? '' : (e.getMonth() + 1) + '/'}${e.getDate()}`;
  };
  const hmText = ms => { const d = new Date(ms); return `${d.getHours()}:${pad2(d.getMinutes())}`; };
  const feelWord = m => m.same ? 'same' : m.dd < 0 ? 'cold' : 'warm';

  // ホームの一言カード(押すと今夜の寝具のふりかえりへ)。文字はすべてここで作る固定の言い回しと数字だけ
  function reviewCardEl(m) {
    const w = feelWord(m);
    const emo = w === 'cold' ? '🥶' : w === 'warm' ? '😊' : '😌';
    const big = w === 'same' ? `前の晩とほぼ同じ(差 ${fmt(m.absd)}℃)`
      : `前の晩より <b class="rv-${w}">${fmt(m.absd)}℃</b> ${w === 'cold' ? '寒かった' : '暖かかった'}`;
    const el = document.createElement('a');
    el.className = 'card rv-card'; el.href = '#bedding?review=1';
    el.innerHTML = `<span class="rv-emo" aria-hidden="true">${emo}</span>
      <span class="rv-text"><span class="rv-top">昨夜のふりかえり(${nightLabel(m.a.k)}の夜) <span class="rv-tag">実測</span></span>
        <span class="rv-big">${big}</span>
        <span class="rv-sub">最低 ${fmt(m.a.min)}℃(前の晩 ${fmt(m.b.min)}℃)</span></span>
      <span class="rv-go" aria-hidden="true">›</span>`;
    return el;
  }
  // ホームから呼ぶ。保存済みの値で先に描き、足りなければ気象庁から取り足して描き直す。条件がそろわなければ何も出さない
  window.beddingReviewCard = function (box) {
    if (!box) return;
    const draw = () => { box.replaceChildren(); const m = reviewModel(new Date()); if (m) box.append(reviewCardEl(m)); };
    draw();
    reviewRefresh().then(ch => { if (ch && box.isConnected) draw(); }).catch(() => { /* 取れなくても何も出さない */ });
  };

  // グラフ(19時〜翌10時、3時間おきの目盛り)。昨夜=青の実線、前の晩=オレンジの点線。下に寝ていた時間の帯
  function reviewChart(m, W) {
    const { a, b } = m;
    const H = 150, pl = 40, pr = 12, pt = 12, pb = 20, BH = 9;
    const vals = [...a.pts, ...b.pts].filter(v => v !== null);
    let lo = Math.floor(Math.min(...vals)) - 1, hi = Math.ceil(Math.max(...vals)) + 1;
    const step = hi - lo > 10 ? 4 : 2;
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    const x = i => pl + (W - pl - pr) * i / (RV.n - 1);
    const y = v => pt + (H - pt - pb) * (hi - v) / (hi - lo);
    const xo = (n, t) => x((t - n.s0) / HOUR);
    const path = pts => { let d = '', pen = false; pts.forEach((v, i) => { if (v === null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; }); return d; };
    let g = '';
    for (let v = lo; v <= hi; v += step) {
      g += `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/>`
         + `<text x="${pl - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${v}℃</text>`;
    }
    for (let i = 0; i < RV.n; i += 3) {
      g += `<line x1="${x(i)}" x2="${x(i)}" y1="${pt}" y2="${H - pb}" stroke="var(--line)" stroke-width="1" stroke-dasharray="2 4"/>`
         + `<text x="${x(i)}" y="${H - 5}" text-anchor="middle" font-size="11" fill="var(--muted)">${(RV.from + i) % 24}時</text>`;
    }
    const mx = xo(a, a.minAt), my = y(a.min);
    const lx = Math.max(pl + 28, Math.min(W - pr - 28, mx)), ly = my + 17 > H - pb ? my - 9 : my + 17;
    const by1 = H + 2, by2 = by1 + BH + 5, svgH = by2 + BH + 4;
    const band = (n, by, col, name) => `<text x="${pl - 6}" y="${by + BH - 1}" text-anchor="end" font-size="10" fill="var(--muted)">${name}</text>`
      + `<rect x="${xo(n, n.win.bed).toFixed(1)}" y="${by}" width="${Math.max(2, xo(n, n.win.wake) - xo(n, n.win.bed)).toFixed(1)}" height="${BH}" rx="3" fill="${col}"/>`;
    return `<svg class="rv-plot" viewBox="0 0 ${W} ${svgH}" role="img" aria-label="昨夜と前の晩の気温の推移と、寝ていた時間">
      ${g}
      <path d="${path(b.pts)}" fill="none" stroke="var(--rv-prev)" stroke-width="2.2" stroke-dasharray="1.5 4.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="${path(a.pts)}" fill="none" stroke="var(--rv-last)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="4.5" fill="var(--rv-last)" stroke="var(--surface)" stroke-width="2"/>
      <text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="var(--rv-last)">最低 ${fmt(a.min)}℃</text>
      ${band(a, by1, 'var(--rv-last)', '昨夜')}${band(b, by2, 'var(--rv-prev)', '前の晩')}
    </svg>`;
  }
  const rvT = v => v === null ? '—' : `${fmt(v)}℃`;
  // 今夜の寝具の「昨夜のふりかえり」の中身(文字は固定の言い回しと数字。観測地点名だけは呼び出し側が textContent で入れる)
  function reviewHtml(m) {
    const { a, b } = m, w = feelWord(m);
    const head = w === 'same' ? `昨夜は前の晩と平均ほぼ同じ(差 ${fmt(m.absd)}℃)`
      : `昨夜は前の晩より <b class="rv-${w}">平均 ${fmt(m.absd)}℃ ${w === 'cold' ? '寒かった' : '暖かかった'}</b>`;
    const src = n => n.win.src === 'record' ? '睡眠の記録' : '今夜の寝具で設定した時刻';
    const cell = (v, ms) => `<td>${rvT(v)}<br><small>${hmText(ms)}</small></td>`;
    const dif = (x, y) => {
      if (x === null || y === null) return '<td class="flat">—</td>';
      const d = Math.round((x - y) * 10) / 10, c = d <= -REVIEW_SAME_C ? 'cold' : d >= REVIEW_SAME_C ? 'warm' : 'flat';
      return `<td class="rv-${c}">${d > 0 ? '+' : ''}${fmt(d)}℃</td>`;
    };
    return `<p class="rv-head">${head}</p>
      <p class="bd-note">寝ていた時間帯の平均気温どうしで比べています。</p>
      <div class="bd-legend">
        <span><svg width="22" height="6" aria-hidden="true"><line x1="1" x2="21" y1="3" y2="3" stroke="var(--rv-last)" stroke-width="2.4" stroke-linecap="round"/></svg>昨夜 ${nightLabelWd(a.k)}</span>
        <span><svg width="22" height="6" aria-hidden="true"><line x1="1.5" x2="20.5" y1="3" y2="3" stroke="var(--rv-prev)" stroke-width="2.2" stroke-dasharray="1.5 4.5" stroke-linecap="round"/></svg>前の晩 ${nightLabelWd(b.k)}</span>
      </div>
      <div class="rv-chart"></div>
      <div class="rv-bandtxt"><span><i class="sw last"></i>昨夜 ${hmText(a.win.bed)}〜${hmText(a.win.wake)}<small>(${src(a)})</small></span>
        <span><i class="sw prev"></i>前の晩 ${hmText(b.win.bed)}〜${hmText(b.win.wake)}<small>(${src(b)})</small></span></div>
      <table class="bd-cmp rv-tbl"><thead><tr><th></th><th>寝たとき</th><th>深夜2時</th><th>明け方5時</th><th>起きたとき</th></tr></thead><tbody>
        <tr><td><i class="sw last"></i>昨夜</td>${cell(a.atBed, a.win.bed)}<td>${rvT(a.at2)}</td><td>${rvT(a.at5)}</td>${cell(a.atWake, a.win.wake)}</tr>
        <tr><td><i class="sw prev"></i>前の晩</td>${cell(b.atBed, b.win.bed)}<td>${rvT(b.at2)}</td><td>${rvT(b.at5)}</td>${cell(b.atWake, b.win.wake)}</tr>
        <tr><td>差</td>${dif(a.atBed, b.atBed)}${dif(a.at2, b.at2)}${dif(a.at5, b.at5)}${dif(a.atWake, b.atWake)}</tr>
      </tbody></table>
      <p class="bd-note">出典:気象庁アメダス <span class="rv-station"></span>(気温の実測。1時間ごと。加工して作成)</p>`;
  }

  window.viewBedding = function viewBedding(root, _id, query) {
    const saved = load();
    const hopt = (from, to, wrap) => { let s = ''; for (let h = from; h <= to; h++) s += `<option value="${wrap ? h % 24 : h}">${wrap ? h % 24 : h}:00</option>`; return s; };
    root.innerHTML = `<div class="bd">
      <p class="bd-lead">昨夜と比べて、毛布をどうするか。郵便番号か地名の天気予報から目安を出します。</p>
      <section class="card bd-loc">
        <div class="bd-sumrow" hidden><span class="bd-sumtxt"></span><button type="button" class="btn ghost small bd-chg" aria-expanded="false" aria-controls="bdLocBody">変更</button></div>
        <div class="bd-fold" id="bdLocBody">
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
        </div>
      </section>
      <section class="card bd-th">
        <h2>気温のしきい値</h2>
        <div class="bd-sumrow" hidden><span class="bd-sumtxt"></span><button type="button" class="btn ghost small bd-chg" aria-expanded="false" aria-controls="bdThBody">変更</button></div>
        <div class="bd-fold" id="bdThBody">
        <form class="bd-thform" novalidate>
          <label class="f">寒くて起きる気温(℃)<input class="bd-th-cold" type="text" inputmode="decimal" autocomplete="off" maxlength="5"></label>
          <label class="f">暑くて起きる気温(℃)<input class="bd-th-hot" type="text" inputmode="decimal" autocomplete="off" maxlength="5"></label>
          <label class="f">エアコンを入れるのは<select class="bd-th-lead">${[0, 1, 2, 3, 4, 5, 6].map(n => `<option value="${n}">${n ? `下回る${n}時間前` : '下回る時刻に'}</option>`).join('')}</select></label>
          <button class="btn bd-thgo" type="submit">保存</button>
        </form>
        <div class="bd-note">寝る〜起きる時刻の予報気温が、この気温を下回る(寒い側)・上回る(暑い側)かで、エアコンや暑さの目安を出します。この端末にだけ保存します。</div>
        <div class="bd-thmsg" role="alert"></div>
        </div>
      </section>
      <div class="bd-result" hidden>
        <div class="bd-status"><span class="bd-stext" role="status"></span><button type="button" class="btn ghost small bd-refresh" title="天気を取り直す">更新</button></div>
        <section class="card bd-review" id="bdReview">
          <button type="button" class="rv-toggle" aria-expanded="false" aria-controls="rvBody">
            <span class="rv-tt">🔍 昨夜のふりかえり <span class="rv-tag">実測</span></span>
            <span class="rv-sum"></span><span class="rv-chev" aria-hidden="true">▸</span></button>
          <div class="rv-wrap" id="rvBody" hidden></div>
        </section>
        <div class="bd-verdict">
          <div class="bd-when"><div class="bd-wl"></div><div class="bd-wn"></div></div>
          <div class="bd-head" hidden></div>
          <div class="bd-icon"></div>
          <div class="bd-main"></div>
          <div class="bd-why"></div>
          <div class="bd-plan"></div>
          <ul class="bd-tips"></ul>
        </div>
        <section class="card"><h2>今夜と昨夜の比べ</h2>
          <div class="bd-note bd-srcline"></div>
          <div class="bd-chart"></div>
          <table class="bd-cmp"><thead><tr><th></th><th class="bd-lastth">昨夜</th><th>今夜</th><th>差</th></tr></thead><tbody></tbody></table>
          <div class="bd-note pre bd-nightlabel"></div>
        </section>
        <section class="card"><h2>夜のあいだの天気</h2>
          <div class="bd-hours"></div>
          <div class="bd-note">青枠が最低気温の時間。☔ は雨の確率。</div>
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

    // 気温のしきい値(寒い・暑い・エアコンを何時間前に入れるか)。保存は同じ設定のキー。入力の誤りは保存しない
    let th = saved.th, thSaved = saved.thSaved, lastShown = null;   // lastShown: 最後に描いた結果(しきい値を変えたとき描き直す)
    const thCold = q('.bd-th-cold'), thHot = q('.bd-th-hot'), thLead = q('.bd-th-lead'), thMsg = q('.bd-thmsg');
    // 入力済みなら1行の要約にたたむ(「変更」で開く)。値が保存されていない初回は開いたまま。aria-expanded でキーボードからも操作できる
    const fold = (card, body) => {
      const row = q(`${card} .bd-sumrow`), txt = q(`${card} .bd-sumtxt`), btn = q(`${card} .bd-chg`), box = q(body);
      const st = { has: false, open: true };
      const apply = () => { row.hidden = !st.has; box.hidden = st.has && !st.open; btn.setAttribute('aria-expanded', String(!box.hidden)); btn.textContent = box.hidden ? '変更' : '閉じる'; };
      btn.addEventListener('click', () => { st.open = !st.open; apply(); });
      return {
        set(text) { st.has = true; txt.textContent = text; apply(); },   // 要約を出してたたむ
        open() { st.open = true; apply(); },                              // 誤り・候補の選択などで開く
        collapse() { if (st.has) { st.open = false; apply(); } }
      };
    };
    const locFold = fold('.bd-loc', '#bdLocBody'), thFold = fold('.bd-th', '#bdThBody');
    const thText = () => `寒い ${fmt(th.cold)}℃ / 暑い ${fmt(th.hot)}℃ / ${th.lead ? `下回る${th.lead}時間前` : '下回る時刻に'}`.replace(/\.0℃/g, '℃');
    const locText = (name, bed, wake) => `📍 ${name} ・ ${bed}:00〜${wake}:00`;
    const fillTh = () => { thCold.value = String(th.cold); thHot.value = String(th.hot); thLead.value = String(th.lead); };
    fillTh();
    if (thSaved) { thFold.set(thText()); thFold.collapse(); }
    // 保存済みの場所があれば、1行の要約にたたんでおく(取得できたら住所に替わる。誤りが出れば開く)
    if (saved.zip || saved.place) { locFold.set(locText(saved.place ? saved.place.name : `〒${saved.zip.slice(0, 3)}-${saved.zip.slice(3)}`, saved.bed, saved.wake)); locFold.collapse(); }
    q('.bd-thform').addEventListener('submit', e => {
      e.preventDefault();
      [thCold, thHot, thLead].forEach(el => el.classList.remove('bad'));
      const r = checkTh(thCold.value, thHot.value, thLead.value);
      if (r.error) {
        thMsg.className = 'bd-thmsg err'; thMsg.textContent = r.error + '(保存していません)';
        r.bad.forEach(k => ({ cold: thCold, hot: thHot, lead: thLead })[k].classList.add('bad'));
        thFold.open();
        return;
      }
      th = r.th; fillTh();
      const p = load(); p.th = th; save(p); thSaved = true;
      thMsg.className = 'bd-thmsg'; thMsg.textContent = '';
      thFold.set(thText()); thFold.collapse();
      if (lastShown) render(lastShown[0], lastShown[1], true);   // 通信せず、保存済みの予報で判定だけやり直す
    });

    let ctl = null, lastChart = null, rt = null, left = false;
    const rvCtl = new AbortController();   // 画面を離れたら、ふりかえりの通信もやめる
    let rvPending = false, rvScrolled = false;
    const wantReview = !!(query && query.review === '1');   // ホームのカードから来た

    // 昨夜のふりかえり(保存してある気象庁の実測から描く。足りなければ短い案内)
    const RV_OPEN_KEY = 'sleep-type-tool-bedding-rvopen';
    const rvStored = () => { try { return localStorage.getItem(RV_OPEN_KEY) === '1'; } catch (e) { return false; } };
    let rvOpen = wantReview || rvStored();   // 初めは閉じる。ホームのカードから来たときは開く(その開きは覚えない)
    function applyOpen() {
      const t = q('.rv-toggle'), wrap = q('.rv-wrap');
      t.setAttribute('aria-expanded', String(rvOpen)); q('.rv-chev').textContent = rvOpen ? '▾' : '▸';
      wrap.hidden = !rvOpen;
    }
    function drawReview() {
      const wrap = q('.rv-wrap');
      if (!wrap) return;
      const m = reviewModel(new Date());
      const sum = q('.rv-sum');
      sum.textContent = m ? (m.same ? `前の晩とほぼ同じ(差 ${fmt(m.absd)}℃)` : `前の晩より ${fmt(m.absd)}℃ ${m.dd < 0 ? '寒かった' : '暖かかった'}`) : (rvPending ? '取得中…' : 'まだ比べられません');
      sum.className = 'rv-sum' + (m && !m.same ? (m.dd < 0 ? ' rv-cold' : ' rv-warm') : '');
      if (!rvOpen) { wrap.textContent = ''; return; }
      if (!m) {
        wrap.innerHTML = '';
        const p = document.createElement('p'); p.className = 'bd-note';
        p.textContent = rvPending ? '気象庁の実測を取っています…'
          : '昨夜と前の晩の実測がそろっていないため、比べを出せません(観測地点が近くにない・観測の欠け・取得前など)。そろえばここに出ます。';
        wrap.append(p);
        return;
      }
      wrap.innerHTML = reviewHtml(m);
      wrap.querySelector('.rv-station').textContent = m.station;
      const box = wrap.querySelector('.rv-chart');
      box.innerHTML = reviewChart(m, Math.max(280, box.clientWidth || 340));
    }
    q('.rv-toggle').addEventListener('click', () => {
      rvOpen = !rvOpen;
      try { localStorage.setItem(RV_OPEN_KEY, rvOpen ? '1' : '0'); } catch (e) { /* 覚えられなくても開閉できる */ }
      applyOpen(); drawReview();
    });
    applyOpen();
    async function reviewFlow(d) {
      rvPending = true; drawReview();
      try {
        if (d.lat !== undefined) await reviewSeed(d.key, d.lat, d.lon, rvCtl.signal);
        if (!left) { drawReview(); await reviewRefresh(rvCtl.signal); }
      } catch (e) { /* 取れなければ案内のまま */ }
      rvPending = false;
      if (!left) drawReview();
    }

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

    const onResize = () => { clearTimeout(rt); rt = setTimeout(() => { if (lastChart) { drawChart(...lastChart); drawReview(); } }, 150); };
    window.addEventListener('resize', onResize);

    function showError(text) {
      locFold.open();
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
      const t0 = tonightBase(now, wake);
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
      return { v: RESULT_VER, key: target.key, zip: target.zip || '', lat: round2(loc.lat), lon: round2(loc.lon), bed, wake, at: now.getTime(), day: ymdKey(now), t0: t0.getTime(), addr: loc.addr, tonight: nTonight, last: nLast, real, why, avgs };
    }

    const hm = d => `${d.getHours()}:${pad2(d.getMinutes())}`;

    // 取得結果を画面に出す。stale があれば、更新できなかった理由つきの「古い情報」表示にする
    function render(d, stale, again) {
      lastShown = [d, stale];
      const { bed, wake, tonight: nTonight, last: nLast, real, why } = d;
      q('.bd-msg').textContent = '';
      q('.bd-place').textContent = `📍 ${d.addr}${d.zip ? `(〒${d.zip.slice(0, 3)}-${d.zip.slice(3)})` : ''}`;
      locFold.set(locText(d.addr, bed, wake));
      if (!again) locFold.collapse();   // 取得できたら要約にたたむ(しきい値の保存からの描き直しでは、開いている欄はそのまま)
      const at = new Date(d.at), isToday = d.day === ymdKey(new Date());
      const when = isToday ? `今日 ${hm(at)}` : `${at.getMonth() + 1}/${at.getDate()}`;
      q('.bd-stext').textContent = stale ? `${when} の情報です。更新できませんでした(${stale})` : `${when} 更新`;
      q('.bd-status').classList.toggle('stale', !!stale);

      const a = summarize(nTonight), b = summarize(nLast);
      const v = decide(a, b, bed, nTonight, th);
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
      // 対象の夜(日付+曜日+設定の時刻)と、切り替わりの説明
      const nowD = new Date(), t0d = new Date(d.t0);
      const sd = new Date(t0d); sd.setHours(bed, 0, 0, 0); if (bed < 12) sd.setDate(sd.getDate() + 1);
      const ed = addDays(t0d, 1); ed.setHours(wake, 0, 0, 0);
      q('.bd-wl').textContent = `${mdw(sd)} ${bed}時 〜 ${mdw(ed)} ${wake}時 の夜`;
      q('.bd-wn').textContent = beforeWake(nowD, wake)
        ? `今表示しているのは、明けたばかりの夜です。起きる時刻(${wake}時)を過ぎると、次の夜の予報に切り替わります。`
        : `起きる時刻(${wake}時)を過ぎたので、今夜(これから寝る夜)の予報です。翌日の${wake}時を過ぎると、次の夜に切り替わります。`;
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
      if (!again) reviewFlow(d);
      if (wantReview && !rvScrolled) { rvScrolled = true; setTimeout(() => { const el = q('#bdReview'); if (el && !left) el.scrollIntoView({ block: 'start' }); }, 60); }
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
      if (!text) { locFold.open(); q('.bd-msg').textContent = '郵便番号か地名を入れてください'; zipEl.focus(); return; }
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
            locFold.open();
            q('.bd-result').hidden = true; lastChart = null;
            return;
          }
          target = r.target;
        }
        const data = await fetchData(target, bed, wake, ctl.signal);
        if (left) return;
        save({ zip: target.zip, place: target.place, query: target.place ? placeQuery : '', bed, wake, th: thSaved ? th : undefined });   // 取得できた内容だけ保存する
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

    return () => { left = true; window.removeEventListener('resize', onResize); clearTimeout(rt); if (ctl) ctl.abort(); rvCtl.abort(); };
  };
})();
