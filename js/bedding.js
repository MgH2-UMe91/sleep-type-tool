// 今夜の寝具:郵便番号と寝る・起きる時刻から、昨夜と比べた毛布・エアコン・パジャマの目安を出す
// - 通信はこの画面を開いたとき(保存済みの郵便番号があるとき)と「表示」を押したときだけ。アプリの起動時には通信しない
//   郵便番号 → zipcloud / 住所 → 国土地理院 / 緯度経度 → Open-Meteo。睡眠の記録は送らない
// - 郵便番号と時刻は別のキー(BEDDING_KEY)に保存する。記録(sleep-type-tool)とバックアップJSONには入れない
// - 本体の $ や esc とぶつからないよう、全体を即時関数に閉じて window.viewBedding だけを出す
(() => {
  'use strict';
  const BEDDING_KEY = 'sleep-type-tool-bedding';
  const NET_TIMEOUT_MS = 10000;

  const load = () => {
    try {
      const o = JSON.parse(localStorage.getItem(BEDDING_KEY) || '{}') || {};
      const zip = typeof o.zip === 'string' && /^\d{7}$/.test(o.zip) ? o.zip : '';
      const bed = Number.isInteger(o.bed) && o.bed >= 0 && o.bed <= 23 ? o.bed : 23;
      const wake = Number.isInteger(o.wake) && o.wake >= 0 && o.wake <= 23 ? o.wake : 6;
      return { zip, bed, wake };
    } catch (e) { return { zip: '', bed: 23, wake: 6 }; }
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
      const r = await fetch(url, { signal: ctl.signal });
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

  async function lookupZip(zip, signal) {
    const z = await getJSON(`https://zipcloud.ibsnet.co.jp/api/search?zipcode=${zip}`, signal);
    if (!z || !Array.isArray(z.results) || !z.results.length) throw new InputError('その郵便番号は見つかりませんでした。番号を確かめてください');
    const a = z.results[0];
    const addr = String(a.address1 || '') + String(a.address2 || '') + String(a.address3 || '');
    // 住所 → 緯度経度(国土地理院)。町名で見つからなければ市区町村で
    for (const q of [addr, String(a.address1 || '') + String(a.address2 || '')]) {
      const g = await getJSON(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q)}`, signal);
      if (Array.isArray(g) && g.length && g[0].geometry && Array.isArray(g[0].geometry.coordinates)) {
        const [lon, lat] = g[0].geometry.coordinates;
        if (Number.isFinite(lat) && Number.isFinite(lon)) return { addr, lat, lon };
      }
    }
    throw new InputError('場所の位置がわかりませんでした');
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

  window.viewBedding = function viewBedding(root) {
    const saved = load();
    const hopt = (from, to, wrap) => { let s = ''; for (let h = from; h <= to; h++) s += `<option value="${wrap ? h % 24 : h}">${wrap ? h % 24 : h}:00</option>`; return s; };
    root.innerHTML = `<div class="bd">
      <p class="bd-lead">昨夜と比べて、毛布をどうするか。郵便番号の天気予報から目安を出します。</p>
      <section class="card">
        <form class="bd-form" novalidate>
          <label class="f">郵便番号
            <input class="bd-zip" inputmode="numeric" autocomplete="postal-code" placeholder="例 100-0001" maxlength="8">
          </label>
          <label class="f">寝る時刻<select class="bd-bed">${hopt(19, 26, true)}</select></label>
          <label class="f">起きる時刻<select class="bd-wake">${hopt(4, 10, false)}</select></label>
          <button class="btn bd-go" type="submit">表示</button>
        </form>
        <div class="bd-place" role="status"></div>
        <div class="bd-msg" role="alert"></div>
      </section>
      <div class="bd-result" hidden>
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
          <div class="bd-chart"></div>
          <table class="bd-cmp"><thead><tr><th></th><th>昨夜</th><th>今夜</th><th>差</th></tr></thead><tbody></tbody></table>
          <div class="bd-note pre bd-nightlabel"></div>
        </section>
        <section class="card bd-pj"></section>
        <p class="bd-night">🌙 良い夢を　おやすみなさい</p>
      </div>
      <p class="bd-foot">天気:<a href="https://open-meteo.com/" target="_blank" rel="noopener">Weather data by Open-Meteo.com</a>(<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>) ／ 郵便番号→住所:<a href="https://zipcloud.ibsnet.co.jp/" target="_blank" rel="noopener">zipcloud</a> ／ 住所→位置:国土地理院<br>この画面を使うと、郵便番号・住所・緯度経度が上の外部サービスに送られます(睡眠の記録は送りません)。</p>
    </div>`;

    const q = s => root.querySelector(s);
    const zipEl = q('.bd-zip'), bedEl = q('.bd-bed'), wakeEl = q('.bd-wake'), goEl = q('.bd-go');
    zipEl.value = saved.zip ? `${saved.zip.slice(0, 3)}-${saved.zip.slice(3)}` : '';
    bedEl.value = String(saved.bed);
    wakeEl.value = String(saved.wake);
    if (bedEl.value === '') bedEl.value = '23';
    if (wakeEl.value === '') wakeEl.value = '6';

    let ctl = null, lastChart = null, rt = null, runId = 0, left = false;

    function drawChart(nT, nL) {
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
          <span><svg width="22" height="6" aria-hidden="true"><line x1="1" x2="21" y1="3" y2="3" stroke="var(--muted)" stroke-width="2" stroke-dasharray="5 4"/></svg>昨夜</span>
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

    async function run(e) {
      if (e) e.preventDefault();
      const zip = toHalf(zipEl.value).replace(/[^0-9]/g, '');
      if (zip.length !== 7) { q('.bd-msg').textContent = '郵便番号は7桁の数字で入れてください'; zipEl.focus(); return; }
      const bed = +bedEl.value, wake = +wakeEl.value;
      if (ctl) ctl.abort();
      ctl = new AbortController();
      const my = ++runId;
      q('.bd-msg').textContent = ''; goEl.disabled = true; q('.bd-place').textContent = '調べています…';
      try {
        const loc = await lookupZip(zip, ctl.signal);
        save({ zip, bed, wake });   // 住所が見つかった番号だけ保存する
        q('.bd-place').textContent = `📍 ${loc.addr}(〒${zip.slice(0, 3)}-${zip.slice(3)})`;
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}`
          + `&hourly=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation_probability,weather_code,wind_speed_10m`
          + `&past_days=5&forecast_days=3&timezone=Asia%2FTokyo`;
        const w = await getJSON(url, ctl.signal);
        const hr = w && w.hourly;
        if (!hr || !Array.isArray(hr.time) || !Array.isArray(hr.temperature_2m)) throw new NetError('天気のデータを受け取れませんでした。しばらくしてからもう一度');
        const H = hr.time.map((t, i) => ({
          t: new Date(t), temp: hr.temperature_2m[i], feel: hr.apparent_temperature[i],
          hum: hr.relative_humidity_2m[i], pop: hr.precipitation_probability[i],
          code: hr.weather_code[i], wind: hr.wind_speed_10m[i]
        })).filter(h => Number.isFinite(h.temp) && Number.isFinite(h.feel) && Number.isFinite(h.hum) && Number.isFinite(h.wind) && Number.isFinite(h.code));

        // 昼12時より前に見たら「今夜」は昨日の夜から始まった夜
        const now = new Date();
        const tonightStart = now.getHours() < 12 ? addDays(now, -1) : now;
        const t0 = new Date(tonightStart); t0.setHours(0, 0, 0, 0);
        const nTonight = nightSlice(H, t0, bed, wake);
        const nLast = nightSlice(H, addDays(t0, -1), bed, wake);
        if (nTonight.length < 2 || nLast.length < 2) throw new InputError('天気のデータが足りませんでした');

        const a = summarize(nTonight), b = summarize(nLast);
        const v = decide(a, b, bed, nTonight);

        // パジャマ:最近3晩(今夜を含む)の夜の平均気温で決める。1晩前にずらした3晩と違えば「切り替え時」
        const nightAvg = k => { const n = nightSlice(H, addDays(t0, -k), bed, wake); return n.length ? avg(n.map(h => h.temp)) : null; };
        const avgs = [0, 1, 2, 3].map(nightAvg);
        const pj = t => t >= 22 ? ['夏用', '半袖・薄手', '🩳'] : t >= 15 ? ['春秋用', '長袖・薄手', '👕'] : ['冬用', '長袖・厚手', '🧥'];
        const cur3 = avg(avgs.slice(0, 3).filter(x => x != null));
        const old3 = avg(avgs.slice(1, 4).filter(x => x != null));
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
          const d = x - y, cls = d >= 0.5 ? 'up' : d <= -0.5 ? 'down' : 'flat';
          const arrow = d >= 0.5 ? '↑' : d <= -0.5 ? '↓' : '→';
          return `<td class="${cls}">${arrow} ${d > 0 ? '+' : ''}${fmt(d)}℃</td>`;
        };
        const row = (name, x, y) => `<tr><td>${name}</td><td>${fmt(y)}℃</td><td>${fmt(x)}℃</td>${diff(x, y)}</tr>`;
        // 最低は時刻も添える(昨夜と今夜で時刻が違うことがあるため)
        const at = d => `<br><small class="flat">${d.getHours()}時ごろ</small>`;
        const rowT = (name, x, y, xt, yt) => `<tr><td>${name}</td><td>${fmt(y)}℃${at(yt)}</td><td>${fmt(x)}℃${at(xt)}</td>${diff(x, y)}</tr>`;
        const dh = Math.round(a.hum - b.hum);
        q('.bd-cmp tbody').innerHTML =
            row(`寝るとき(${bed}時)`, a.bed, b.bed)
          + row('入眠2時間平均(体感)', a.earlyFeel, b.earlyFeel)
          + rowT('最低気温', a.min, b.min, a.minAt, b.minAt)
          + row(`起きるとき(${wake}時)`, a.wake, b.wake)
          + `<tr><td>湿度(平均)</td><td>${Math.round(b.hum)}%</td><td>${Math.round(a.hum)}%</td><td class="flat">${dh > 0 ? '+' : ''}${dh}%</td></tr>`;
        const md = d => `${d.getMonth() + 1}/${d.getDate()}`;
        q('.bd-nightlabel').textContent = `今夜=${md(nTonight[0].t)} ${bed}時〜${md(nTonight[nTonight.length - 1].t)} ${wake}時 ／ 昨夜=${md(nLast[0].t)}〜${md(nLast[nLast.length - 1].t)}。昨夜は観測に近い値、今夜は予報です。\n※体感温度は、気温に風や湿度の影響を加えた「人が感じる温度」です。風が強いときや乾燥しているときは、気温より低く出ます。`;

        q('.bd-hours').innerHTML = nTonight.map(h => {
          const [ic, nm] = WMO(h.code);
          const isMin = h.t.getTime() === a.minAt.getTime();
          return `<div class="bd-hr${isMin ? ' min' : ''}" title="${nm}">
            <div class="t">${h.t.getHours()}時</div>
            <div class="w">${ic}</div>
            <div class="c">${Math.round(h.temp)}℃</div>
            <div class="r">☔${h.pop ?? '-'}%</div></div>`;
        }).join('');

        q('.bd-result').hidden = false;
        lastChart = [nTonight, nLast];
        drawChart(nTonight, nLast);
      } catch (err) {
        if (left || my !== runId) return;  // 画面を離れた、または新しい取得に入れ替わった
        showError(err instanceof NetError || err instanceof InputError ? err.message : '表示できませんでした。もう一度お試しください');
        q('.bd-result').hidden = true;
        lastChart = null;
      } finally {
        if (my === runId) goEl.disabled = false;
      }
    }

    q('.bd-form').addEventListener('submit', run);
    if (saved.zip) run();   // 保存済みの郵便番号があれば、この画面を開いたときに取得する

    return () => { left = true; window.removeEventListener('resize', onResize); clearTimeout(rt); if (ctl) ctl.abort(); };
  };
})();
