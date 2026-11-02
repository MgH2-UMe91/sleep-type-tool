// 画面の表示と操作
'use strict';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const fmtDate = s => { const d = parseYmd(s); return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`; };
const fmtDateLong = s => { const d = parseYmd(s); return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${WD[d.getDay()]})`; };
const fmtPct = v => v === null || v === undefined ? '—' : v.toFixed(1);
const SHORT = { none: 'なし', uto: 'うと', suya: 'すや', gus: 'ぐっ', '': '?' };
const tchip = (t, suffix = '') => `<span class="tchip ${t ? 't-' + t : 't-empty'}">${TYPE_LABEL[t || '']}${suffix}</span>`;
const pctDot = k => `<i class="t-${k}"></i>`;

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
}

// 確認ダイアログ(ブラウザ標準の confirm は使わない)
function ask(msg, { ok = 'OK', danger = false, extra = '', cancel = 'やめる' } = {}) {
  const dlg = $('#modal');
  $('#modalMsg').textContent = msg;
  $('#modalExtra').innerHTML = extra;
  $('#modalOk').textContent = ok;
  $('#modalOk').className = 'btn' + (danger ? ' danger' : '');
  $('#modalCancel').textContent = cancel;
  $('#modalCancel').classList.toggle('hidden', cancel === null);
  // 確認の入力欄で Enter を押しても閉じない(既定ボタンが「やめる」なので、何も起きずに閉じて迷うのを防ぐ)。
  // 安全のため Enter で削除は実行しない。押すべきボタンを案内する
  const inp = $('#modalExtra input');
  if (inp) inp.onkeydown = e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    let hint = $('#modalExtra .hint');
    if (!hint) { hint = document.createElement('p'); hint.className = 'hint small muted'; $('#modalExtra').append(hint); }
    hint.textContent = `入力したら「${ok}」ボタンを押してください`;
  };
  // ボタンの押下で直接答えを返す(閉じたイベントは遅れて届くことがあり、続けて開いた別の確認と混ざるため)。
  // Esc キーなどボタン以外で閉じたときだけ、閉じたイベントで「やめる」として返す
  return new Promise(res => {
    let done = false;
    const finish = v => {
      if (done) return;
      done = true;
      dlg.onclose = null; $('#modalOk').onclick = null; $('#modalCancel').onclick = null;
      if (dlg.open) dlg.close();
      res(v);
    };
    $('#modalOk').onclick = e => { e.preventDefault(); finish(inp ? inp.value : true); };
    $('#modalCancel').onclick = e => { e.preventDefault(); finish(false); };
    dlg.onclose = () => finish(false);
    dlg.returnValue = '';
    dlg.showModal();
  });
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function applyTheme() {
  const t = Store.get().settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
}

// ---------- ルーティング(#画面名/ID?キー=値) ----------
const APP_NAME = '睡眠タイプ管理ツール';
const FOR_GAME = 'ポケモンスリープ';
const FULL_NAME = `${APP_NAME} for ${FOR_GAME}`;
// 公式イベントの typeFree(どのタイプのポケモンも出る)の呼び名。内部のデータ名は typeFree のまま
const YAMI = '【闇鍋】';
const YAMI_NOTE = 'どのタイプのポケモンも出る';
const TITLES = { home: APP_NAME, input: '入力', bulk: '一括取り込み', calendar: 'カレンダー', targets: '狙い設定', stats: '統計', data: 'データ管理', about: 'このアプリについて', menu: 'メニュー', events: 'イベント' };
const TAB_OF = { bulk: 'menu', targets: 'menu', data: 'menu', about: 'menu', events: 'menu' };
let cleanup = null;

function route() {
  const [path, qs] = (location.hash.slice(1) || 'home').split('?');
  const [name, id] = path.split('/');
  const q = Object.fromEntries(new URLSearchParams(qs || ''));
  const view = VIEWS[name] ? name : 'home';
  if (cleanup) { cleanup(); cleanup = null; }
  $('#pageTitle').textContent = TITLES[view];
  $('.topbar .byline').hidden = view !== 'home'; // 「for ポケモンスリープ」はアプリ名の横にだけ
  document.title = view === 'home' ? FULL_NAME : `${TITLES[view]} | ${FULL_NAME}`;
  $$('.tabbar a').forEach(a => a.toggleAttribute('aria-current', false));
  const tab = $(`.tabbar a[data-tab="${TAB_OF[view] || view}"]`);
  if (tab) tab.setAttribute('aria-current', 'page');
  const root = $('#view');
  root.innerHTML = '';
  cleanup = VIEWS[view](root, id, q) || null;
  window.scrollTo(0, 0);
}

// ---------- 平均の表示部品 ----------
function avgBlock(st, label) {
  if (!st.n) return `<div class="small muted">${label}:記録なし</div>`;
  const bar = KINDS.map(k => `<span class="t-${k}" style="width:${st[k].mean}%"></span>`).join('');
  return `<div class="stack">
    <div class="row"><b>${label}</b><span class="small muted">${st.n}件</span>${st.isReference ? '<span class="ref">参考値(30件未満)</span>' : ''}</div>
    <div class="avgbar" aria-hidden="true">${bar}</div>
    <div class="avgtbl">
      <span></span>${KINDS.map(k => `<span class="h pct-label">${pctDot(k)}${TYPE_LABEL[k]}</span>`).join('')}
      <span class="h">平均</span>${KINDS.map(k => `<span class="num">${fmtPct(st[k].mean)}%</span>`).join('')}
    </div></div>`;
}

// ================= ホーム =================
function viewHome(root) {
  // 「今夜」の日付。早朝(NIGHT_START_HOUR 時より前)は前日の夜として扱う。入力の初期日付と同じ規則
  const today = tonightYmd();
  const s = Store.get().settings;
  const plan = Calc.planFor(today);
  const weekEvents = Events.forWeek(mondayOf(today));
  // 次の(または今の)狙い週が闇鍋(typeFree)のイベントと重なっていたら注意
  const aimWeek = Store.get().weekTargets.filter(t => KINDS.includes(t.target) && addDays(t.weekStart, 6) >= today).sort((a, b) => a.weekStart < b.weekStart ? -1 : 1)[0];
  const aimFree = aimWeek ? Events.forWeek(aimWeek.weekStart).filter(Events.isYami) : [];
  const a30n = Calc.averageAt(today, 'count');
  const missing = Calc.missingDays(today);
  const recs = Store.records();
  const lastExp = Store.get().lastExportAt;
  const expDays = lastExp ? daysBetween(ymd(new Date(lastExp)), today) : null;
  const needBackup = recs.length > 0 && (lastExp === null || expDays >= s.backupRemindDays);
  const last = recs[recs.length - 1];

  root.innerHTML = `
  <section class="card hero ${plan.type ? 'k-' + plan.type : ''}">
    <div class="row"><span class="small muted">${fmtDateLong(today)}の夜</span><span class="guess">推定にもとづく提案</span></div>
    <p class="next-aim"><span class="muted small">次の狙い</span><b>${esc(plan.next)}</b></p>
    <div>
      <p class="small muted">${plan.kind === 'aim' ? '狙い期間中' : '今週のおすすめ'}</p>
      <p class="big">${esc(plan.title)}</p>
    </div>
    <p class="small">${esc(plan.reason)}</p>
    ${plan.more ? `<p class="small muted">${esc(plan.more)}</p>` : ''}
    ${aimFree.length ? `<p class="msg warn">${fmtDate(aimWeek.weekStart)}の狙い週は「${esc(Events.displayTitle(aimFree[0].title))}」(${YAMI}:${YAMI_NOTE}イベント)と重なっています。狙い週をずらすことも考えてみてください。</p>` : ''}
    ${plan.kind === 'unset' ? '<a class="btn" href="#targets">狙う週を決める</a>' : '<p class="small"><a href="#targets">狙う週を決める・変える</a></p>'}
  </section>
  ${(() => {
    const ws = mondayOf(today), sp = Moon.spansBetween(ws, addDays(ws, 13));
    return sp.length ? `<section class="card"><h2 class="small-h">今週・来週の GSD / NMD</h2>
      <div class="stack">${sp.map(x => `<p class="small"><span class="moon-tag ${x.phase}">${moonSpanLabel(x)}</span> ${MOON_NAME[x.phase]} ${fmtDate(x.center)} ${x.time}</p>`).join('')}</div></section>` : '';
  })()}
  ${weekEvents.length ? `<section class="card"><h2 class="small-h">今週のイベント</h2>${eventListHtml(weekEvents, true)}</section>` : ''}
  ${needBackup ? `<section class="msg warn">${lastExp ? `最後のバックアップから${expDays}日たちました。` : 'まだバックアップを書き出していません。'}ブラウザのデータを消すと記録も消えます。<a href="#data">データ管理で書き出す</a></section>` : ''}
  ${missing.length ? `<section class="card"><h2>未入力の日</h2><p class="small muted">直近14日で記録がない日</p>
    <div class="row">${missing.map(d => `<a class="btn ghost small" href="#input?date=${d}">${fmtDate(d)}</a>`).join('')}</div></section>` : ''}
  <section class="card">
    <h2>直近30回の平均</h2>
    ${avgBlock(a30n, '直近30回')}
    <p class="small muted"><a href="#stats">くわしい統計・自分の傾向</a></p>
  </section>
  ${last ? `<section class="card"><h2>最新の記録</h2>
    <div class="row">${tchip(last.type)}<span>${fmtDate(last.date)}</span>
    <span class="num small">${last.utoPct}/${last.suyaPct}/${last.gusPct}</span>
    <span class="small muted">${last.sleepMin != null ? minToHm(last.sleepMin) : ''}</span></div></section>` : ''}
  <div class="grid2">
    <a class="btn" href="#input">記録を入力</a>
    <a class="btn ghost" href="#bulk">スクショをまとめて</a>
  </div>`;
}

// 読み取りの詳細(折りたたみ)。実機で読めなかったとき、この部分のスクショを送ってもらえば原因を調べられる
function debugDetails(res) {
  const el = document.createElement('details');
  el.className = 'ocr-debug';
  const dbg = res.debug;
  if (!dbg) return el;
  const L = dbg.loc;
  const band = (b, extra = '') => b ? `y ${b.a}〜${b.b}${extra}` : '見つからず';
  const rows = [
    ['画像サイズ', dbg.size],
    ['割合バー', L && band(L.bar)],
    ['見出し帯', L && band(L.header)],
    ['タイプ帯', L && band(L.pill, L.pill ? `(${TYPE_LABEL[L.pill.cls]})` : '')],
    ['日付帯', L && band(L.dateBand, L.dateBand ? ` / 文字 ${L.dateBand.ta ?? '—'}〜${L.dateBand.tb ?? '—'} / 右端 x ${L.dateBand.xr}` : '')],
    ['色帯の比率', res.bar ? res.bar.join(' / ') : '—'],
    ['読み取り結果', res.error ? res.error : `${res.date ?? '日付?'} ${res.bedTime ?? '?'}〜${res.wakeTime ?? '?'} ${res.sleepMin != null ? minToHm(res.sleepMin) : '?'} ${res.rate ? res.rate.map(v => v ?? '?').join('/') : ''} ${res.type ? TYPE_LABEL[res.type] : 'タイプ?'}`],
    ['処理時間', res.ms != null ? `${res.ms}ms` : '—'],
    ['端末', navigator.userAgent],
  ];
  el.innerHTML = `<summary>読み取りの詳細</summary>
    <p class="small muted">うまく読めなかったときは、ここを開いた画面のスクショを作者に送ってください(この内容は自動では送信されません)。</p>
    <div class="dbg-grid small">${rows.map(r => `<span class="muted">${r[0]}</span><span class="num">${esc(r[1] ?? '—')}</span>`).join('')}</div>`;
  for (const c of dbg.crops) {
    const box = document.createElement('div');
    box.className = 'dbg-crop';
    box.innerHTML = `<div class="small"><b>${esc(c.label)}</b> <span class="muted">認識:</span><span class="num">「${esc(c.raw)}」</span></div>`;
    box.append(c.canvas);
    el.append(box);
  }
  return el;
}

// ================= 入力 =================
// 3つの割合欄:2つ入れると残りを 100−合計 で自動入力
function attachPct(root, onChange) {
  const inputs = $$('[data-pct]', root);
  const msg = $('.pct-msg', root);
  function recompute() {
    const manual = inputs.filter(el => el.dataset.manual === '1');
    const val = el => el.value === '' ? null : Number(el.value);
    inputs.forEach(el => el.classList.remove('bad'));
    $$('.autotag', root).forEach(t => t.classList.add('hidden'));
    let err = '', hint = '';
    const outOfRange = manual.filter(el => !Number.isInteger(val(el)) || val(el) < 0 || val(el) > 100);
    if (outOfRange.length) {
      err = '割合は0〜100の整数で入れてください'; outOfRange.forEach(el => el.classList.add('bad'));
      // 自動で入れた値は、元の値が不正になったので消す
      inputs.filter(el => el.dataset.manual !== '1').forEach(el => { el.value = ''; el.classList.remove('auto'); });
    }
    else if (manual.length === 2) {
      const other = inputs.find(el => el.dataset.manual !== '1');
      const sum = manual.reduce((a, el) => a + val(el), 0);
      if (sum > 100) { err = `2つの合計が${sum}%で、100を超えています`; other.value = ''; other.classList.remove('auto'); manual.forEach(el => el.classList.add('bad')); }
      else { other.value = 100 - sum; other.classList.add('auto'); $(`.autotag[data-for="${other.dataset.pct}"]`, root).classList.remove('hidden'); }
    } else if (manual.length === 3) {
      const sum = manual.reduce((a, el) => a + val(el), 0);
      inputs.forEach(el => el.classList.remove('auto'));
      if (sum !== 100) { err = `合計が${sum}%です。100%になるよう直してください`; inputs.forEach(el => el.classList.add('bad')); }
    } else {
      inputs.filter(el => el.dataset.manual !== '1').forEach(el => { el.value = ''; el.classList.remove('auto'); });
      hint = '2つ入れると、残り1つを自動で入れます';
    }
    msg.className = 'pct-msg msg ' + (err ? 'err' : hint ? 'muted' : '');
    msg.textContent = err || hint;
    if (onChange) onChange();
    return !err;
  }
  inputs.forEach(el => el.addEventListener('input', () => { el.dataset.manual = el.value !== '' ? '1' : ''; el.classList.remove('auto'); recompute(); }));
  return {
    recompute,
    // 値を外から入れる(読み取り結果など)。auto に指定した欄は自動扱い
    set(vals, autoField = '') {
      inputs.forEach(el => { const v = vals[el.dataset.pct]; el.value = v ?? ''; el.dataset.manual = v != null && el.dataset.pct !== autoField ? '1' : ''; el.classList.remove('auto'); });
      recompute();
    },
    read() {
      const ok = recompute();
      const v = Object.fromEntries(inputs.map(el => [el.dataset.pct, el.value === '' ? null : Number(el.value)]));
      const auto = inputs.find(el => el.classList.contains('auto'));
      const filled = KINDS.every(k => v[k] !== null);
      return { ok: ok && filled, vals: v, autoField: auto ? auto.dataset.pct : '' };
    },
  };
}

const pctFields = () => `<div class="grid3">${KINDS.map(k => `
  <label class="f"><span class="pct-label">${pctDot(k)}${TYPE_LABEL[k]} <span class="autotag hidden" data-for="${k}">自動</span></span>
  <input type="number" inputmode="numeric" min="0" max="100" step="1" data-pct="${k}" aria-label="${TYPE_LABEL[k]}(%)"></label>`).join('')}</div>
  <p class="pct-msg msg"></p>`;

const typeOptions = sel => ['', 'none', 'uto', 'suya', 'gus'].map(t => `<option value="${t}" ${t === sel ? 'selected' : ''}>${TYPE_LABEL[t]}</option>`).join('');

// 記録の初期日付:いちばん最近に終わった夜(=ホームの「今夜」の前日)。早朝は前日扱いの規則をホームとそろえる
const defaultDate = () => addDays(tonightYmd(), -1);

function viewInput(root, id, q) {
  const editing = id ? Store.get().records.find(r => r.id === id) : null;
  const r = editing || { date: q.date || defaultDate(), bedTime: '', wakeTime: '', sleepMin: null, type: '', memo: '', source: 'manual' };
  let source = r.source, ocrSnapshot = null;

  root.innerHTML = `
  ${editing ? '' : `<section class="card">
    <h2>スクショから読み取る</h2>
    <p class="small muted">睡眠結果の画面のスクショを選ぶと、下の欄に入ります。確認してから保存してください。画像は端末の外に送りません。</p>
    <input type="file" id="shot" accept="image/*">
    <img id="shotPrev" class="preview-img hidden" alt="選んだスクショ">
    <p id="shotMsg" class="msg"></p>
    <div id="shotDbg"></div>
    <p class="small muted">何枚もまとめて入れるときは <a href="#bulk">一括取り込み</a></p>
  </section>`}
  <form class="card" id="f" novalidate>
    <h2>${editing ? '記録を直す' : '手入力'}</h2>
    <label class="f">日付(ゲームの表示)<input type="date" name="date" value="${esc(r.date)}" required></label>
    <p class="small muted">分割睡眠で同じ日付にもう1回寝たときは、同じ日付でもう1件入れてください(就寝時刻で区別します)。</p>
    <div class="grid2">
      <label class="f">就寝<input type="time" name="bedTime" value="${esc(r.bedTime)}"></label>
      <label class="f">起床<input type="time" name="wakeTime" value="${esc(r.wakeTime)}"></label>
    </div>
    <div class="stack">
      <div class="grid2">
        <label class="f">睡眠時間(時間)<input type="number" inputmode="numeric" min="0" max="23" name="sleepH"></label>
        <label class="f">(分)<input type="number" inputmode="numeric" min="0" max="59" name="sleepM"></label>
      </div>
      <div class="row small"><span id="sleepHint" class="muted"></span><button type="button" class="btn ghost small hidden" id="recalc">時刻から計算し直す</button></div>
    </div>
    <h3>割合(%)</h3>
    ${pctFields()}
    <label class="f">表示タイプ(ゲームの表示)<select name="type">${typeOptions(r.type)}</select></label>
    <label class="f">メモ(任意)<input type="text" name="memo" value="${esc(r.memo)}" maxlength="200"></label>
    <p id="formMsg" class="msg"></p>
    <button class="btn block" type="submit">${editing ? '更新する' : '保存する'}</button>
    ${editing ? '<button class="btn ghost block" type="button" id="del">この記録を削除</button>' : ''}
  </form>`;

  const f = $('#f', root);
  const pct = attachPct(f);
  // 睡眠時間:ゲームの表示値を正とする。手で変えるまでは就寝・起床からの計算値を入れる
  let sleepEdited = r.sleepMin != null;
  const setSleep = m => { f.sleepH.value = m == null ? '' : Math.floor(m / 60); f.sleepM.value = m == null ? '' : m % 60; };
  const readSleep = () => (f.sleepH.value === '' && f.sleepM.value === '') ? null : Number(f.sleepH.value || 0) * 60 + Number(f.sleepM.value || 0);
  function syncSleep() {
    const span0 = Calc.spanMin(f.bedTime.value, f.wakeTime.value);
    // 就寝と起床が同じ時刻なら 0:00 を自動で入れない
    const span = span0 === 0 ? null : span0;
    if (!sleepEdited) setSleep(span);
    const cur = readSleep();
    $('#sleepHint', root).textContent = span0 === 0 ? '就寝と起床が同じ時刻です。時刻を確認してください'
      : !sleepEdited ? (span != null ? '就寝〜起床から計算した値(ゲームの表示と違えば直してください)' : '')
      : span != null && cur != null && cur !== span ? `就寝〜起床は${minToHm(span)}(ゲームの表示を優先)` : '';
    $('#recalc', root).classList.toggle('hidden', !sleepEdited || span == null || cur === span);
  }
  setSleep(r.sleepMin);
  f.bedTime.addEventListener('input', syncSleep);
  f.wakeTime.addEventListener('input', syncSleep);
  [f.sleepH, f.sleepM].forEach(el => el.addEventListener('input', () => { sleepEdited = true; syncSleep(); }));
  $('#recalc', root).onclick = () => { sleepEdited = false; syncSleep(); };
  syncSleep();
  if (editing) pct.set({ uto: r.utoPct, suya: r.suyaPct, gus: r.gusPct }, r.autoField); else pct.recompute();

  const current = () => ({ date: f.date.value, bedTime: f.bedTime.value, wakeTime: f.wakeTime.value, sleepMin: readSleep(), ...pct.read().vals, type: f.type.value });

  // スクショ読み取り
  const shot = $('#shot', root);
  if (shot) shot.onchange = async () => {
    const file = shot.files[0]; if (!file) return;
    const prev = $('#shotPrev', root), m = $('#shotMsg', root);
    prev.src = URL.createObjectURL(file); prev.classList.remove('hidden');
    m.className = 'msg muted'; m.textContent = '読み取り中…(初回は文字認識の準備に数秒かかります)';
    $('#shotDbg', root).replaceChildren();
    try {
      const res = await Ocr.analyzeFile(file);
      $('#shotDbg', root).replaceChildren(debugDetails(res));
      if (res.error) { m.className = 'msg err'; m.textContent = res.error; return; }
      // 読めなかった項目は空欄にして強調する(既定値のまま保存されないように)
      f.date.value = res.date || '';
      f.bedTime.value = res.bedTime || ''; f.wakeTime.value = res.wakeTime || '';
      sleepEdited = res.sleepMin != null; setSleep(res.sleepMin); syncSleep();
      if (res.sleepMin == null) setSleep(null);
      [[f.date, !res.date], [f.bedTime, !res.bedTime], [f.wakeTime, !res.wakeTime], [f.sleepH, res.sleepMin == null], [f.sleepM, res.sleepMin == null], [f.type, !res.type]]
        .forEach(([el, bad]) => el.classList.toggle('bad', bad));
      pct.set({ uto: res.rate[0], suya: res.rate[1], gus: res.rate[2] });
      f.type.value = res.type || '';
      source = 'ocr';
      ocrSnapshot = JSON.stringify(current());
      m.className = 'msg ' + (res.warnings.length ? 'warn' : 'ok');
      m.innerHTML = res.warnings.length ? '要確認:' + res.warnings.map(esc).join(' / ') : `読み取りました(${res.ms}ms)。内容を確認して保存してください。`;
    } catch (e) {
      m.className = 'msg err'; m.textContent = '読み取りに失敗しました:' + e.message;
    }
  };

  // 強調した欄は、手で直したら元に戻す
  f.addEventListener('input', e => { if (!e.target.dataset.pct) e.target.classList.remove('bad'); });
  f.addEventListener('change', e => { if (!e.target.dataset.pct) e.target.classList.remove('bad'); });

  f.onsubmit = async e => {
    e.preventDefault();
    const fm = $('#formMsg', root);
    const p = pct.read();
    const errs = [];
    if (!isYmd(f.date.value)) errs.push('日付を入れてください');
    if (!p.ok) errs.push('割合を確認してください(3つそろって合計100)');
    const sm = readSleep();
    const okPart = (v, max) => v === '' || (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= max);
    if (sm != null && (!okPart(f.sleepH.value, 23) || !okPart(f.sleepM.value, 59) || sm <= 0 || sm >= 1440)) errs.push('睡眠時間を確認してください(時間は0〜23、分は0〜59の整数)');
    if (errs.length) { fm.className = 'msg err'; fm.textContent = errs.join(' / '); return; }
    const cur = current();
    if (source !== 'manual' && ocrSnapshot && JSON.stringify(cur) !== ocrSnapshot) source = 'ocr_edited';
    const rec = { ...(editing || {}), id: editing ? editing.id : Store.newId(), ...cur, utoPct: p.vals.uto, suyaPct: p.vals.suya, gusPct: p.vals.gus,
      autoField: p.autoField, memo: f.memo.value.trim(), source };
    const dup = Store.findDuplicate(rec);
    if (dup && !(await ask(`${fmtDate(rec.date)} ${rec.bedTime || ''} の記録がすでにあります。それでも保存しますか?`, { ok: '保存する' }))) return;
    if (!dup && Store.findSameDateUnsure(rec) && !(await ask(`${fmtDate(rec.date)} の記録がすでにあります(就寝時刻がないため同じ夜か判断できません)。分割睡眠なら、そのまま保存してください。`, { ok: '保存する' }))) return;
    Store.upsertRecord(rec);
    toast(editing ? '更新しました' : '保存しました');
    location.hash = `#calendar?d=${rec.date}`;
  };

  const del = $('#del', root);
  if (del) del.onclick = async () => {
    if (!(await ask('この記録を削除しますか?元に戻せません。', { ok: '削除する', danger: true }))) return;
    Store.deleteRecord(editing.id); toast('削除しました'); location.hash = `#calendar?d=${editing.date}`;
  };
  return () => { const p = $('#shotPrev', root); if (p && p.src) URL.revokeObjectURL(p.src); };
}

// ================= 一括取り込み =================
function viewBulk(root) {
  let items = [];
  root.innerHTML = `
  <section class="card">
    <h2>スクショをまとめて読み取る</h2>
    <p class="small muted">過去分などを複数枚まとめて選べます。読み取り結果を確認して、まとめて保存します。画像は端末の外に送りません。</p>
    <input type="file" id="files" accept="image/*" multiple>
    <div id="prog" class="stack hidden"><div class="progress"><span></span></div><p class="small muted" id="progTxt"></p></div>
  </section>
  <section id="results" class="stack"></section>
  <div id="saveBar" class="card hidden"><p class="small" id="saveSum"></p><button class="btn block" id="saveAll">チェックした記録をまとめて保存</button></div>`;

  // 1件の状態を確認して、要確認の理由を返す
  function check(it, i) {
    const v = it.v;
    // 読めなかった項目は、手で埋めたら警告を消す
    const filled = { '日付が読めません': isYmd(v.date), '就寝・起床時刻が読めません': !!(v.bedTime && v.wakeTime), '睡眠時間が読めません': v.sleepMin != null, 'タイプの帯が見つかりません': !!v.type };
    const w = it.ocr.error ? [it.ocr.error] : it.ocr.warnings.filter(x => !filled[x]);
    if (!isYmd(v.date) && !w.includes('日付が読めません')) w.push('日付がありません');
    if (it.saveError) w.push(it.saveError);
    if (v.sleepBad) w.push('睡眠時間は 7:41 のように H:MM で入れてください');
    const pv = [v.utoPct, v.suyaPct, v.gusPct];
    if (pv.some(x => x === null || x === '' || isNaN(x))) w.push('割合が足りません');
    else if (pv.some(x => !Number.isInteger(x) || x < 0 || x > 100)) w.push('割合は0〜100の整数にしてください');
    else if (pv.reduce((a, x) => a + Number(x), 0) !== 100) w.push('割合の合計が100ではありません');
    if (isYmd(v.date) && Store.findDuplicate({ ...v, id: null })) w.push('同じ日付・就寝時刻の記録がすでにあります');
    else if (isYmd(v.date) && Store.findSameDateUnsure({ ...v, id: null })) w.push('同じ日付の記録があります(分割睡眠なら そのまま保存)');
    const others = items.filter((o, j) => j < i && !o.saved && o.v.date === v.date);
    if (others.some(o => o.v.bedTime === v.bedTime)) w.push('この一覧の中に同じ日付・就寝時刻があります');
    else if (others.some(o => !o.v.bedTime || !v.bedTime)) w.push('この一覧の中に同じ日付があります(分割睡眠なら そのまま保存)');
    return [...new Set(w)];
  }

  function itemHtml(it, i) {
    const v = it.v;
    return `<div class="bulk-item" data-i="${i}">
      <div class="row"><label class="check grow"><input type="checkbox" data-k="include" ${it.include ? 'checked' : ''}><b class="small">${esc(it.name)}</b></label>${tchip(v.type)}</div>
      <p class="msg warn w"></p>
      <div class="grid2">
        <label class="f">日付<input type="date" data-k="date" value="${esc(v.date || '')}"></label>
        <label class="f">睡眠時間(H:MM)<input type="text" inputmode="numeric" data-k="sleep" value="${v.sleepMin != null ? minToHm(v.sleepMin) : ''}" placeholder="7:41"></label>
        <label class="f">就寝<input type="time" data-k="bedTime" value="${esc(v.bedTime || '')}"></label>
        <label class="f">起床<input type="time" data-k="wakeTime" value="${esc(v.wakeTime || '')}"></label>
      </div>
      <div class="grid3">${KINDS.map(k => `<label class="f"><span class="pct-label">${pctDot(k)}${TYPE_LABEL[k]}</span><input type="number" inputmode="numeric" data-k="${PCT_KEY[k]}" value="${v[PCT_KEY[k]] ?? ''}"></label>`).join('')}</div>
      <label class="f">表示タイプ<select data-k="type">${typeOptions(v.type)}</select></label>
      ${it.ocr.bar ? `<p class="small muted">色帯の比率:${it.ocr.bar.join(' / ')}</p>` : ''}
      <div class="dbg-slot"></div>
    </div>`;
  }

  function refresh() {
    items.forEach((it, i) => {
      const el = $(`.bulk-item[data-i="${i}"]`, root);
      el.classList.toggle('hidden', !!it.saved);
      if (it.saved) return;
      it.warnings = check(it, i);
      el.classList.toggle('need', it.warnings.length > 0);
      $('.w', el).textContent = it.warnings.length ? '要確認:' + it.warnings.join(' / ') : '';
      // 読めなかった(空の)欄・不正な欄を強調
      $$('[data-k]', el).forEach(inp => {
        if (inp.type === 'checkbox') return;
        const k = inp.dataset.k, v = it.v[k];
        const bad = inp.value === '' || (k === 'sleep' && it.v.sleepBad) || (/Pct$/.test(k) && (!Number.isInteger(v) || v < 0 || v > 100));
        inp.classList.toggle('bad', bad);
      });
    });
    const rest = items.filter(it => !it.saved);
    const n = rest.filter(it => it.include).length, need = rest.filter(it => it.include && it.warnings.length).length;
    $('#saveSum', root).textContent = `${rest.length}件中 ${n}件を保存します${need ? `(うち要確認 ${need}件)` : ''}`;
    $('#saveAll', root).disabled = n === 0;
  }

  $('#files', root).onchange = async e => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    items = [];
    $('#results', root).innerHTML = '';
    $('#saveBar', root).classList.add('hidden');
    const prog = $('#prog', root), bar = $('.progress span', root), txt = $('#progTxt', root);
    prog.classList.remove('hidden');
    for (let i = 0; i < files.length; i++) {
      txt.textContent = `${i + 1} / ${files.length} 枚目を読み取り中…${i === 0 ? '(初回は文字認識の準備に数秒かかります)' : ''}`;
      bar.style.width = `${i / files.length * 100}%`;
      let res;
      try { res = await Ocr.analyzeFile(files[i]); } catch (err) { res = { error: '読み取りに失敗しました:' + err.message }; }
      const v = res.error ? { date: '', bedTime: '', wakeTime: '', sleepMin: null, utoPct: null, suyaPct: null, gusPct: null, type: '' }
        : { date: res.date || '', bedTime: res.bedTime || '', wakeTime: res.wakeTime || '', sleepMin: res.sleepMin, utoPct: res.rate[0], suyaPct: res.rate[1], gusPct: res.rate[2], type: res.type || '' };
      const it = { name: files[i].name, ocr: res, v, include: true };
      items.push(it);
      it.warnings = check(it, items.length - 1);
      // 重複・読み取り失敗はチェックを外しておく
      it.include = !res.error && !it.warnings.some(w => /同じ日付・就寝時刻|日付がありません|日付が読めません|割合が足りません|0〜100/.test(w));
      $('#results', root).insertAdjacentHTML('beforeend', itemHtml(it, items.length - 1));
      $(`.bulk-item[data-i="${items.length - 1}"] .dbg-slot`, root).append(debugDetails(res));
    }
    bar.style.width = '100%';
    txt.textContent = `${files.length}枚の読み取りが終わりました。黄色い枠は要確認です。`;
    $('#saveBar', root).classList.remove('hidden');
    refresh();
  };

  $('#results', root).addEventListener('input', e => {
    const el = e.target, box = el.closest('.bulk-item'); if (!box) return;
    const it = items[Number(box.dataset.i)], k = el.dataset.k;
    if (k !== 'include') it.saveError = ''; // 直したら前回の保存失敗の表示を消す
    if (k === 'include') it.include = el.checked;
    else if (k === 'sleep') {
      // H:MM 以外の形は空扱いにせず「要確認」にする
      const t = el.value.trim(), m = t.match(/^(\d{1,2}):(\d{2})$/);
      const min = m && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : null;
      it.v.sleepMin = min && min < 1440 ? min : null;
      it.v.sleepBad = t !== '' && it.v.sleepMin === null;
    }
    else if (k in PCT_KEY || /Pct$/.test(k)) it.v[k] = el.value === '' ? null : Number(el.value);
    else it.v[k] = el.value;
    if (k === 'type') box.querySelector('.tchip').outerHTML = tchip(it.v.type);
    refresh();
  });

  // まとめて保存。1件ずつ保存し、失敗した件は要確認として一覧に残す。保存できた件は一覧から外す(二重保存しない)
  $('#saveAll', root).onclick = async () => {
    const targets = items.filter(it => it.include && !it.saved);
    const need = targets.filter(it => it.warnings.length);
    if (need.length && !(await ask(`要確認の記録が${need.length}件あります。そのまま保存しますか?(日付・割合などが不正なものは保存されず、一覧に残ります)`, { ok: '保存する' }))) return;
    let saved = 0, failed = 0, dup = 0;
    for (const it of targets) {
      it.saveError = '';
      try {
        const v = it.v;
        // 保存の直前にもう一度重複を確認する(この一覧で先に保存したもの・前に保存したものを含む)
        if (Store.findDuplicate({ ...v, id: null })) { it.saveError = '同じ日付・就寝時刻の記録がすでにあるため保存しませんでした'; it.include = false; dup++; continue; }
        if (v.sleepBad) throw new Error('睡眠時間の形が正しくありません');
        const rec = { id: Store.newId(), date: v.date, bedTime: v.bedTime, wakeTime: v.wakeTime, sleepMin: v.sleepMin,
          utoPct: v.utoPct, suyaPct: v.suyaPct, gusPct: v.gusPct, type: v.type, autoField: '', memo: '', source: 'ocr' };
        const o = it.ocr;
        if (!o.error && (v.date !== o.date || v.utoPct !== o.rate[0] || v.suyaPct !== o.rate[1] || v.gusPct !== o.rate[2] || v.sleepMin !== o.sleepMin || v.type !== (o.type || '') || v.bedTime !== (o.bedTime || '') || v.wakeTime !== (o.wakeTime || ''))) rec.source = 'ocr_edited';
        Store.upsertRecord(rec); // 日付・時刻・割合が不正ならここで例外になる
        it.saved = true; it.include = false; saved++;
      } catch (err) {
        it.saveError = '保存できませんでした(日付・時刻・割合の合計100・睡眠時間を確認してください)';
        failed++;
      }
    }
    // 結果は必ず知らせる
    const left = failed + dup;
    toast(`${saved}件保存しました` + (left ? `。${left}件は保存せず一覧に残しました` : ''));
    if (!left) { location.hash = '#calendar'; return; }
    $$('.bulk-item', root).forEach(el => { const it = items[Number(el.dataset.i)]; $('[data-k="include"]', el).checked = it.include; });
    refresh();
    $('#saveSum', root).textContent = `${saved}件を保存しました。残りの${items.filter(it => !it.saved).length}件は要確認です。直してからもう一度保存できます。`;
    const first = items.find(it => !it.saved);
    if (first) $(`.bulk-item[data-i="${items.indexOf(first)}"]`, root).scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
}

// ================= カレンダー(縦スクロール) =================
// 月を縦に並べ、指でスクロールして過去・未来へ移動する。月の見出しはスクロール中も上に固定。
// 日をタップすると下からシートで詳細を出す(ページは動かないのでスクロール位置はそのまま)。
// 詳細から入力画面へ行って戻ったときは、離れたときのスクロール位置に戻す。
const calState = { y: null, from: null }; // 離れたときのスクロール位置と、その時点で一番古く描いていた月
const ymOf = s => s.slice(0, 7);
const addMonths = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; };

function viewCalendar(root, id, q) {
  const today = todayYmd(), thisMonth = ymOf(today);
  const recs = Store.records(), d = Store.get();
  const byDate = {};
  recs.forEach(r => (byDate[r.date] = byDate[r.date] || []).push(r));
  const evByDate = Events.byDate(); // 公式イベント(日付の切り替わりは午前4時)
  // 週をまたぐイベントは、期間の日がいちばん多く入る「週×月」の行にだけ帯を出す(同じ数なら早いほう)。
  // 例:日曜に始まって月〜火に続くイベントは、日曜1日だけの週ではなく次の週に出す
  const slotOf = {};
  for (const e of Events.list()) {
    if (!e.from) continue;
    const cnt = {};
    for (let x = e.from, n = 0; x <= e.to && n < 62; x = addDays(x, 1), n++) { const k = mondayOf(x) + '|' + ymOf(x); cnt[k] = (cnt[k] || 0) + 1; }
    // 同じ日数なら、その週の中で早い曜日から始まる(帯を右へ伸ばせる)ほう。日曜1日だけの側は選ばれにくい
    const startCol = k => { const [ws, ym] = k.split('|'); let x = e.from > ws ? e.from : ws; if (ymOf(x) < ym) x = ym + '-01'; return daysBetween(ws, x); };
    slotOf[e.id] = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a] || startCol(a) - startCol(b) || (a < b ? -1 : 1))[0];
  }
  // 公式の NMD・GSD イベントと重なる月相の期間は、●NMD/○GSD の札を出さない(回数つきの公式の表記だけにする)
  const moonKindOf = e => /ニュームーンデー/.test(e.title) ? 'new' : /グッドスリープデー/.test(e.title) ? 'full' : null;
  const officialMoon = Events.list().filter(e => e.from && e.to && moonKindOf(e));
  const hasOfficial = sp => officialMoon.some(e => moonKindOf(e) === sp.phase && e.from <= sp.to && e.to >= sp.from);
  // 表示する範囲:過去は記録のある最初の月まで、未来は狙いの設定とイベントに合わせて(最低3か月先)
  const targetDates = d.weekTargets.filter(t => KINDS.includes(t.target)).map(t => addDays(t.weekStart, 6))
    .concat(d.dayTargets.filter(t => KINDS.includes(t.target)).map(t => t.date))
    .concat(Events.list().filter(e => e.to && e.to >= today).map(e => e.to));
  const firstMonth = [thisMonth, recs.length ? ymOf(recs[0].date) : thisMonth, ...targetDates.map(ymOf)].sort()[0];
  const lastMonth = [addMonths(thisMonth, 3), ...targetDates.map(t => addMonths(ymOf(t), 1))].sort().pop();
  const want = q.d && isYmd(q.d) ? q.d : null;
  const restoring = want && calState.y !== null;
  // 最初に描く範囲(古い月はスクロールで近づいたら追加する)
  // 見たい月の3か月前から。戻ってきたときは、離れたときに描いていた一番古い月から。記録のある最初の月より前には行かない
  let from = addMonths(ymOf(want || today), -3);
  if (restoring && calState.from && calState.from < from) from = calState.from;
  if (from < firstMonth) from = firstMonth;

  function monthHtml(ym) {
    const [y, m] = ym.split('-').map(Number);
    const first = ym + '-01';
    let html = `<section class="cal-month" data-ym="${ym}">
      <div class="cal-head"><h2>${y}年${m}月</h2>
        <div class="cal-wd">${['月', '火', '水', '木', '金', '土', '日'].map((w, i) => `<span class="${i === 5 ? 'sat' : i === 6 ? 'sun' : ''}">${w}</span>`).join('')}</div></div>`;
    for (let ws = mondayOf(first); ymOf(ws) <= ym; ws = addDays(ws, 7)) {
      // 週の行。狙う週なら色と文字の印を付ける
      const wt = d.weekTargets.find(t => t.weekStart === ws && KINDS.includes(t.target));
      let cells = '';
      for (let i = 0; i < 7; i++) {
        const day = addDays(ws, i);
        if (ymOf(day) !== ym) { cells += '<span class="day blank"></span>'; continue; }
        const rs = byDate[day] || [];
        const dt = d.dayTargets.find(t => t.date === day);
        const evs = evByDate[day] || [];
        const mn = Moon.markOf(day);
        cells += `<button type="button" class="day ${day === today ? 'today' : ''} ${evs.length ? 'ev' : ''}" data-d="${day}"
          aria-label="${fmtDateLong(day)}${rs.length ? ' ' + rs.map(r => TYPE_LABEL[r.type]).join('・') : ' 記録なし'}${dt ? ' 狙い' + TARGET_LABEL[dt.target] : ''}${evs.length ? ' イベント ' + esc(evs.map(e => Events.displayTitle(e.title)).join('、')) : ''}${mn ? ` ${mn.mark}(${MOON_NAME[mn.phase]}${mn.exact ? 'の日' : 'の前後'})` : ''}">
          ${mn ? `<span class="moon ${mn.phase} ${mn.exact ? 'exact' : ''}" aria-hidden="true">${MOON_ICON[mn.phase]}</span>` : ''}
          ${rs.length ? `<span class="mark" aria-hidden="true">${rs.map(() => '<i></i>').join('')}</span>` : ''}
          <span class="d">${Number(day.slice(8))}</span>
          ${rs.map(r => `<span class="tl ${r.type ? 't-' + r.type : 't-empty'}">${SHORT[r.type]}</span>`).join('')}
          ${dt ? `<span class="tg">狙${dt.target === 'none' ? 'なし' : SHORT[dt.target]}</span>` : ''}
        </button>`;
      }
      // この週(この月の分)に開催中のイベント名を短くして並べる
      const wfrom = ymOf(ws) === ym ? ws : first, wto = ymOf(addDays(ws, 6)) === ym ? addDays(ws, 6) : addDays(addMonths(ym, 1) + '-01', -1);
      // イベントの帯は、期間の日がいちばん多く入る週の行にだけ出す(ほかの週では繰り返さない。開催中の日はマスの下の線で分かる)。
      // NMD・GSD のイベントだけは、期間の日が1日でも入る週すべてに出す
      const wevs = [];
      for (let i = 0; i < 7; i++) {
        const day = addDays(ws, i);
        if (ymOf(day) !== ym) continue;
        for (const e of evByDate[day] || []) if (!wevs.includes(e) && (Events.isMoonDay(e) || slotOf[e.id] === ws + '|' + ym)) wevs.push(e);
      }
      // 帯はその週の開始日の列から(終了日の列まで)。段への詰め方と、文字が収まらないときの伸ばし方は layoutBars() が決める
      const col = day => daysBetween(ws, day) + 1;
      const clip = (a, b) => [a < wfrom ? wfrom : a, b > wto ? wto : b];
      const bars = [];
      if (wt) bars.push(`<span class="bar wk-tag t-${wt.target}" data-s="1" data-e="1">${TYPE_LABEL[wt.target]}を狙う週</span>`);
      for (const e of wevs) {
        const [a, b] = clip(e.from, e.to);
        const yami = Events.isYami(e), md = Events.isMoonDay(e);
        const name = Events.displayTitle(e.title).replace(/^【[^】]*】\s*/, '').replace(/[「」]/g, '');
        bars.push(`<button type="button" class="bar ev-bar ${yami ? 'free' : ''} ${md ? 'moon-ev' : ''}" data-s="${col(a)}" data-e="${col(b)}"${md ? ` data-fixed="1" data-short="${/グッドスリープデー/.test(e.title) ? 'GSD' : 'NMD'}"` : ''}
          data-full="${esc(Events.displayTitle(e.title))}${yami ? `(${YAMI}:${YAMI_NOTE}イベント)` : ''}" data-period="${esc(Events.periodLabel(e))}">${yami ? `<b>${YAMI}</b>` : ''}${esc(name)}</button>`);
      }
      // GSD/NMD:その日の列の真上だけに短い札(日付の範囲は書かない)。列の位置は動かさない。
      // 期間の日が1日でも入る週すべてに出す。公式のイベントがあれば出さない(回数つきの公式の帯が代わりに出る)
      for (const sp of Moon.spansBetween(wfrom, wto)) {
        if (hasOfficial(sp)) continue;
        const [a, b] = clip(sp.from, sp.to);
        bars.push(`<button type="button" class="bar moon-bar ${sp.phase}" data-s="${col(a)}" data-e="${col(b)}" data-fixed="1" data-short="${sp.mark}"
          data-full="${sp.mark}(${MOON_NAME[sp.phase]}の前後)" data-period="${esc(`${Calc.fmtMd(sp.from)}〜${Calc.fmtMd(sp.to)}(${MOON_NAME[sp.phase]} ${fmtDate(sp.center)} ${sp.time})`)}">${MOON_ICON[sp.phase]}${sp.mark}</button>`);
      }
      html += `<div class="cal-week ${wt ? 'aim k-' + wt.target : ''}">
        ${bars.length ? `<div class="wk-bars">${bars.join('')}</div>` : ''}
        <div class="cal-days">${cells}</div></div>`;
    }
    return html + '</section>';
  }
  const range = (a, b) => { const out = []; for (let ym = a; ym <= b; ym = addMonths(ym, 1)) out.push(ym); return out; };

  root.innerHTML = `
    <p class="small muted">緑の点=入力済み(分割睡眠は件数分) · 色と文字=表示タイプ(なし/うと/すや/ぐっ) · 色の帯=狙う週 · 狙○=日ごとの狙い · 紫の線=イベント · ○/●=満月・新月の前後</p>
    <p class="small muted">GSD=満月の前後(満月の日と前後1日の計3日)、NMD=新月の前後(新月の日と前後1日の計3日)。${YAMI}=${YAMI_NOTE}イベント</p>
    <div id="calTop" class="small muted cal-more">${from > firstMonth ? '前の月を読み込み中…' : ''}</div>
    <div id="calList">${range(from, lastMonth).map(monthHtml).join('')}</div>
    <p class="small muted" style="text-align:center">${Number(lastMonth.slice(0, 4))}年${Number(lastMonth.slice(5))}月まで表示しています</p>
    <button type="button" class="btn today-btn" id="toToday">今日</button>
    <dialog id="daySheet" class="sheet"><div id="daySheetBody"></div><button type="button" class="btn ghost block" id="sheetClose">閉じる</button></dialog>`;

  const list = $('#calList', root), topEl = $('#calTop', root);
  // 古い月を追加する。追加した高さぶんスクロール位置をずらして、見ている場所を動かさない
  // 週の行の帯を上の段から詰めて並べる(狙う週の札も同じ段に入れる)。
  // 帯は開始日の列から始めるのが基本。上の段に空きがあれば、イベントの期間内で右にずらして入れる。
  // 文字が収まる幅まで伸ばし(最大で日曜の列まで)、それでも収まらない分は「…」で省略
  const GAP = 3;
  function layoutBars(scope) {
    for (const box of $$('.wk-bars:not(.laid)', scope)) {
      box.classList.add('laid');
      const colW = (box.clientWidth - GAP * 6) / 7;
      const colsFor = px => { let n = 1; while (n < 7 && n * colW + (n - 1) * GAP < px) n++; return n; };
      const rows = []; // rows[r][c] = 使用中
      const free = (r, a, b) => { for (let c = a; c <= b; c++) if (rows[r] && rows[r][c]) return false; return true; };
      const take = (r, a, b) => { rows[r] = rows[r] || []; for (let c = a; c <= b; c++) rows[r][c] = true; };
      const items = [...box.children];
      for (const el of items.filter(x => !x.dataset.fixed)) {
        el.style.gridColumn = '1 / 2';
        const need = colsFor(el.scrollWidth + 1); // 文字に必要な列数
        const s = Number(el.dataset.s), e = Number(el.dataset.e);
        let spot = null;
        // 上の段から順に、イベントの期間内(開始列〜終了列)の空きを探す
        for (let r = 0; r < rows.length && !spot; r++) {
          for (let c = s; c <= e && !spot; c++) {
            const end = Math.min(7, Math.max(e, c + need - 1));
            if (c + need - 1 <= 7 && free(r, c, end)) spot = [r, c, end];
          }
        }
        if (!spot) spot = [rows.length, s, Math.min(7, Math.max(e, s + need - 1))]; // 新しい段
        // 1列ぶんの幅にしかならないイベントの帯(日曜だけに切れた断片など)は描かない。日の詳細・ホーム・狙い設定には出る
        if (spot[1] === spot[2] && el.classList.contains('ev-bar') && !el.classList.contains('moon-ev')) { el.remove(); continue; }
        take(...spot);
        el.style.gridRow = String(spot[0] + 1);
        el.style.gridColumn = `${spot[1]} / ${spot[2] + 1}`;
      }
      // NMD・GSD(公式の回数つきの帯と ●NMD/○GSD の札)は、狙う週の札・イベントの帯より下の段に、その日の列だけに置く。
      // 幅に収まらなければ「NMD」「GSD」とだけ書く
      const base = rows.length;
      for (const el of items.filter(x => x.dataset.fixed)) {
        const s = Number(el.dataset.s), e = Number(el.dataset.e);
        let r = base; while (!free(r, s, e)) r++;
        take(r, s, e); el.style.gridRow = String(r + 1); el.style.gridColumn = `${s} / ${e + 1}`;
        if (el.scrollWidth > el.clientWidth + 1 && el.dataset.short) { el.textContent = el.dataset.short; el.classList.add('short'); }
      }
      if (!box.children.length) box.remove(); // 帯が全部なくなった週は、空の段を残さない
    }
  }
  layoutBars(list);

  function prepend(n = 6) {
    if (from <= firstMonth) return false;
    const newFrom = [addMonths(from, -n), firstMonth].sort().pop();
    const h0 = document.documentElement.scrollHeight, y0 = window.scrollY;
    list.insertAdjacentHTML('afterbegin', range(newFrom, addMonths(from, -1)).map(monthHtml).join(''));
    layoutBars(list);
    from = newFrom;
    window.scrollTo(0, y0 + document.documentElement.scrollHeight - h0);
    if (from <= firstMonth) topEl.textContent = '';
    return true;
  }
  // 上端から600px以内に来たら古い月を追加(スクロールのたびに軽く確認するだけ。passive なのでスクロールを止めない)
  let watching = false;
  const onScroll = () => { if (watching && window.scrollY < 600) prepend(); };
  window.addEventListener('scroll', onScroll, { passive: true });

  const scrollToDay = (day, behavior = 'auto') => {
    const el = $(`.day[data-d="${day}"]`, root) || $(`.cal-month[data-ym="${ymOf(day)}"]`, root);
    if (!el) return;
    const head = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h')) || 50;
    const y = el.getBoundingClientRect().top + window.scrollY - head - 120; // 月の見出しの下に見えるよう少し上に余白
    window.scrollTo({ top: Math.max(0, y), behavior });
  };

  // 日の詳細(シート)
  const sheet = $('#daySheet', root);
  function openDay(day) {
    $('#daySheetBody', root).innerHTML = calDetailHtml(day, byDate[day] || []);
    history.replaceState(null, '', `#calendar?d=${day}`); // 入力画面から戻ったとき、この日とスクロール位置に戻れるように
    if (!sheet.open) sheet.showModal();
    sheet.scrollTop = 0;
  }
  // 閉じたら URL から日付を外す(ほかの画面へ移るときに閉じた場合は、移った先の URL を変えない)
  const clearDay = () => { if (location.hash.startsWith('#calendar')) history.replaceState(null, '', '#calendar'); };
  const closeSheet = () => { sheet.close(); clearDay(); };
  sheet.addEventListener('close', clearDay); // Esc キーで閉じたとき
  sheet.addEventListener('click', e => { if (e.target === sheet) closeSheet(); }); // 外側(背景)をタップで閉じる
  $('#sheetClose', root).onclick = closeSheet;
  list.addEventListener('click', e => {
    const bar = e.target.closest('button.bar');
    if (bar) { ask(`${bar.dataset.full}\n${bar.dataset.period}`, { ok: '閉じる', cancel: null }); return; }
    const b = e.target.closest('button.day'); if (b) openDay(b.dataset.d);
  });
  $('#toToday', root).onclick = () => scrollToDay(today, 'smooth');

  // 位置合わせは route() のスクロールリセットの後に行う
  setTimeout(() => {
    if (restoring) window.scrollTo(0, calState.y);
    else scrollToDay(want || today);
    if (want) openDay(want);
    watching = true; onScroll(); // 位置を合わせてから、上端に近づいたら古い月を追加する監視を始める
  }, 0);

  return () => {
    calState.y = window.scrollY; calState.from = from;
    window.removeEventListener('scroll', onScroll);
    if (sheet.open) sheet.close();
  };
}

function calDetailHtml(d, rs) {
  const tg = Store.targetOf(d);
  const a30n = Calc.averageAt(d, 'count');
  const items = rs.map(r => {
    const est = Calc.estimateType(r, 'count');
    return `<div class="stack">
      <div class="row">${rs.length > 1 ? `<span class="ref">${rs.indexOf(r) + 1}件目</span>` : ''}${tchip(r.type)}<span class="small muted">${r.bedTime || '--:--'}〜${r.wakeTime || '--:--'}</span>
        <span class="small">${r.sleepMin != null ? minToHm(r.sleepMin) : ''}</span><a class="btn ghost small" href="#input/${r.id}" style="margin-left:auto">直す</a></div>
      <div class="avgtbl">
        <span></span>${KINDS.map(k => `<span class="h pct-label">${pctDot(k)}${TYPE_LABEL[k]}</span>`).join('')}
        <span class="h">この夜</span>${KINDS.map(k => `<span class="num">${r[PCT_KEY[k]]}%</span>`).join('')}
        ${est ? `<span class="h">それまでの平均</span>${KINDS.map(k => `<span class="num">${fmtPct(est.prior[k].mean)}%</span>`).join('')}
        <span class="h">平均との差</span>${KINDS.map(k => `<span class="num">${est.diffs[k] >= 0 ? '+' : ''}${est.diffs[k].toFixed(1)}</span>`).join('')}` : ''}
      </div>
      ${est ? `<p class="small">推定タイプ:${tchip(est.type)} <span class="guess">推定</span> <span class="muted">平均より一番多く出たもの。差が${NEAR_AVG_PT}ポイント未満なら「とくちょうなし」(しきい値は仮)</span></p>` : '<p class="small muted">これより前の記録がないため、推定タイプは出せません。</p>'}
      ${r.memo ? `<p class="small">メモ:${esc(r.memo)}</p>` : ''}
      <p class="small muted">入力元:${{ manual: '手入力', ocr: 'スクショ', ocr_edited: 'スクショ(修正あり)' }[r.source]}</p>
    </div>`;
  }).join('');
  return `<div class="stack">
    <h2>${fmtDateLong(d)}</h2>
    <p class="small">狙い:${tg ? `${TARGET_LABEL[tg.target]}(${tg.from === 'day' ? '日の設定' : '週の設定'})` : '未設定'}</p>
    ${(() => { const mn = Moon.markOf(d); return mn ? `<p class="small"><span class="moon-tag ${mn.phase}">${MOON_ICON[mn.phase]}${mn.mark}</span> ${MOON_NAME[mn.phase]}:${fmtDate(mn.center)} ${mn.time}(日本時間)${mn.exact ? '' : `。この日は${MOON_NAME[mn.phase]}の${d < mn.center ? '前日' : '翌日'}`}</p>` : ''; })()}
    ${eventListHtml(Events.byDate()[d] || [])}
    <div class="list">${items || '<p class="small muted">記録はありません。</p>'}</div>
    <a class="btn ghost" href="#input?date=${d}">この日の記録を追加</a>
    <h3>この日時点の平均</h3>
    ${avgBlock(a30n, '直近30回')}
  </div>`;
}

// ================= 狙い設定 =================
function viewTargets(root) {
  const thisWeek = mondayOf(tonightYmd());
  const openDays = new Set(); // 日ごとの上書きを開いている週(再描画しても開いたままにする)
  const opt = (list, sel, first) => `<option value="">${first}</option>` + list.map(t => `<option value="${t}" ${t === sel ? 'selected' : ''}>${TARGET_LABEL[t]}</option>`).join('');

  function render() {
    const d = Store.get();
    let weeks = '';
    for (let w = -1; w <= 12; w++) {
      const ws = addDays(thisWeek, w * 7);
      const wt = d.weekTargets.find(t => t.weekStart === ws);
      const aim = wt && KINDS.includes(wt.target) ? wt.target : '';
      const overrides = d.dayTargets.filter(t => t.date >= ws && t.date <= addDays(ws, 6));
      // 狙わない週には、狙う週に向けたおすすめを自動で出す(今週は今夜の時点、ほかの週は月曜の時点で計算)
      // 公式イベント。闇鍋(typeFree)の週は狙い週にするともったいない。タイプが有利になる週は狙い週の候補
      const wevs = Events.forWeek(ws);
      const free = wevs.some(Events.isYami);
      const boost = [...new Set(wevs.flatMap(e => e.boostTypes))];
      const evHtml = wevs.length ? `<div class="stack">${wevs.map(e => `<span class="small"><span class="ev-tag ${Events.isYami(e) ? 'free' : ''}">${Events.isYami(e) ? YAMI : 'イベント'}</span> ${esc(Events.displayTitle(e.title))} <span class="muted">${Events.periodLabel(e)}</span></span>`).join('')}
        ${free ? `<p class="msg warn">${YAMI}の週(${YAMI_NOTE})${aim ? 'です。狙い週にするのはもったいないかもしれません' : ':狙い週にするのはもったいない'}</p>` : ''}
        ${boost.length ? `<p class="msg ok">${boost.map(k => TYPE_LABEL[k]).join('・')}の狙い週の候補(イベントで${boost.map(k => TYPE_LABEL[k]).join('・')}が有利)</p>` : ''}</div>` : '';
      let note;
      if (aim) note = `<span class="tchip t-${aim}">${TYPE_LABEL[aim]}を狙う週</span>`;
      else {
        const p = Calc.planFor(w === 0 ? tonightYmd() : ws);
        note = p.kind === 'unset' ? '<span class="small muted">この先の狙う週が未設定です(決めるとおすすめが出ます)</span>'
          : `<span class="small">おすすめ:<b>${esc(p.title)}</b>${p.kind === 'aim' ? '' : `<span class="muted">(次の狙い ${esc(p.next)})</span>`}</span>`;
      }
      let days = '';
      for (let i = 0; i < 7; i++) {
        const day = addDays(ws, i);
        const dt = d.dayTargets.find(t => t.date === day);
        days += `<label class="dayrow"><span>${fmtDate(day)}</span><select data-day="${day}" aria-label="${fmtDate(day)}の狙い">${opt(['uto', 'suya', 'gus', 'none'], dt && dt.target, '週の設定に従う')}</select></label>`;
      }
      weeks += `<section class="week ${w === 0 ? 'cur' : ''} ${aim ? 'aim k-' + aim : ''} ${boost.length && !aim ? 'boost' : ''}">
        <div class="week-head">
          <span><b>${fmtDate(ws)}〜${fmtDate(addDays(ws, 6))}</b>${w === 0 ? '(今週)' : w === 1 ? '(来週)' : ''}</span>
          <select data-week="${ws}" aria-label="${fmtDate(ws)}の週の狙い">${opt(KINDS, aim, '狙わない')}</select>
        </div>
        <div>${note}</div>
        ${evHtml}
        ${(() => { const t = moonTags(ws, addDays(ws, 6)); return t ? `<div class="wk-tags">${t}</div>` : ''; })()}
        <details class="dayover" data-ws="${ws}" ${openDays.has(ws) || overrides.length ? 'open' : ''}><summary>日ごとに変える${overrides.length ? `(${overrides.length}日)` : ''}</summary><div class="stack">${days}</div></details>
      </section>`;
    }
    root.innerHTML = `
    <section class="card">
      <h2>狙う週を決める</h2>
      <p class="small">タイプを出したい週にだけ、狙うタイプを付けてください。狙わない週は「狙わない」のままで大丈夫です。その週には、次の狙いに向けて意識するタイプを自動で表示します。</p>
      <p class="small muted">考え方(推定):タイプは、その夜の割合が直近30回の平均より目立って多いものになる。狙う週の前は狙うタイプを少なめにして平均を下げておくと、狙う週に出やすい。週は月曜始まり。</p>
    </section>
    <div class="stack" id="tg">${weeks}</div>`;
    $$('.dayover', root).forEach(el => el.addEventListener('toggle', () => { if (el.open) openDays.add(el.dataset.ws); else openDays.delete(el.dataset.ws); }));
  }

  const onChange = e => {
    const el = e.target;
    if (!el.dataset.week && !el.dataset.day) return;
    if (el.dataset.week) { Store.setWeekTarget(el.dataset.week, el.value); toast(el.value ? `${fmtDate(el.dataset.week)}の週を${TARGET_LABEL[el.value]}狙いにしました` : '狙わない週にしました'); }
    if (el.dataset.day) { Store.setDayTarget(el.dataset.day, el.value); toast('日の狙いを保存しました'); }
    const y = window.scrollY; render(); window.scrollTo(0, y); // おすすめは狙いによって変わるので描き直す
  };
  root.addEventListener('change', onChange);
  render();
  // root(#view)は画面をまたいで使い回すので、離れるときにリスナーを外す
  return () => root.removeEventListener('change', onChange);
}

// ================= 統計 =================
const TREND_LABEL = { r30: '直近30回(ゲームの平均)', r100: '直近100回', all: '全期間(本来の姿)' };
const TREND_SEG = { r30: '直近30回<small>ゲームの平均</small>', r100: '直近100回', all: '全期間<small>本来の姿</small>' };

function viewStats(root) {
  // 平均の基準は直近30回。直近30日は将来の検証用の参考表示(切り替えは保存しない)
  let range = 'count', period = 'all';
  function render() {
    const today = tonightYmd();
    const st = Calc.averageAt(today, range);
    const label = range === 'days' ? '参考:直近30日' : '直近30回';
    const tr = Calc.tendencyAt(today, period);
    root.innerHTML = `
    <section class="card">
      <h2>自分の傾向</h2>
      <div class="seg trend-seg" role="group" aria-label="傾向の期間">
        ${Object.keys(TREND_SEG).map(p => `<button data-p="${p}" aria-pressed="${period === p}">${TREND_SEG[p]}</button>`).join('')}
      </div>
      <div class="row"><b>${TREND_LABEL[period]}</b><span class="small muted">${tr.n}件</span>${tr.n ? `<span class="ref">${tr.level}</span>` : ''}</div>
      ${tr.n ? `
      <h3 class="small-h">タイプの出やすさ(何%の夜に出たか)</h3>
      <div class="tbl-wrap"><table>
        <tr><th></th><th>夜の割合</th><th>回数</th></tr>
        ${['uto', 'suya', 'gus', 'none'].map(k => `<tr><td>${tchip(k)}</td><td class="num">${tr.typed ? tr.rate[k].toFixed(1) + '%' : '—'}</td><td class="num">${tr.counts[k]}/${tr.typed}</td></tr>`).join('')}
      </table></div>
      ${tr.untyped ? `<p class="small muted">タイプが未記録の${tr.untyped}件は、出やすさの数から除いています。</p>` : ''}
      <h3 class="small-h">割合の平均とばらつき</h3>
      <div class="tbl-wrap"><table>
        <tr><th></th><th>平均</th><th>標準偏差</th></tr>
        ${KINDS.map(k => `<tr><td><span class="pct-label">${pctDot(k)}${TYPE_LABEL[k]}</span></td><td class="num">${fmtPct(tr.stats[k].mean)}%</td><td class="num">${fmtPct(tr.stats[k].sd)}</td></tr>`).join('')}
      </table></div>` : '<p class="small muted">記録がありません。</p>'}
      <p class="small">出やすさは、あなたの記録から数えた実績に基づく目安です(ゲームの内部の判定は公開されていないため、推測を含みます)。</p>
      <ul class="small muted" style="margin:0;padding-left:1.2em">
        <li>直近30回:ゲームの平均に近い基準(推定)。全期間:記録全体から見た、普段のあなたの姿。</li>
        <li>件数の目安:30回未満=参考値、30〜99回=目安、100回以上=安定。</li>
        <li>狙うタイプが全期間で${USUAL_RATE_PCT}%以上の夜に出ていれば、ホームで「普段どおりで十分です」と案内します(記録${TREND_MIN_N}件以上のとき)。</li>
      </ul>
    </section>
    <h2 class="small-h">平均(判定の基準)</h2>
    <div class="seg" role="group" aria-label="集計範囲">
      <button data-r="count" aria-pressed="${range === 'count'}">直近30回</button>
      <button data-r="days" aria-pressed="${range === 'days'}">参考:直近30日</button>
    </div>
    <section class="card">
      <div class="row"><h2>${label}</h2><span class="small muted">${st.n}件 · 基準日 ${fmtDate(today)}</span>${st.isReference ? '<span class="ref">参考値(30件未満)</span>' : ''}</div>
      ${st.n ? `<div class="tbl-wrap"><table>
        <tr><th></th><th>単純平均</th><th>重み付き平均</th><th>標準偏差</th></tr>
        ${KINDS.map(k => `<tr><td><span class="pct-label">${pctDot(k)}${TYPE_LABEL[k]}</span></td>
          <td class="num">${fmtPct(st[k].mean)}%</td><td class="num">${fmtPct(st[k].wMean)}%</td><td class="num">${fmtPct(st[k].sd)}</td></tr>`).join('')}
      </table></div>` : '<p class="small muted">記録がありません。</p>'}
      <ul class="small muted" style="margin:0;padding-left:1.2em">
        <li>重み付き平均:睡眠時間で重み付け(Σ割合×睡眠分 ÷ Σ睡眠分)。分割睡眠の短い方の影響が小さくなります。睡眠時間のない記録は除外。</li>
        <li>標準偏差:母標準偏差(件数で割る)。</li>
        <li>直近30回:新しい順に30件。ホーム・カレンダー・推定タイプ・今夜の狙いはすべてこの平均を使います。</li>
        <li>参考:直近30日:基準日を含む過去30日の全記録(検証用。分割睡眠の日は2件とも入ります)。</li>
      </ul>
    </section>`;
    $$('.seg button[data-r]', root).forEach(b => b.onclick = () => { range = b.dataset.r; render(); });
    $$('.seg button[data-p]', root).forEach(b => b.onclick = () => { period = b.dataset.p; render(); });
  }
  render();
}

// ================= データ管理 =================
function viewData(root) {
  const d = Store.get(), s = d.settings;
  const stamp = () => todayYmd().replace(/-/g, '');
  root.innerHTML = `
  <section class="card">
    <h2>書き出し(バックアップ)</h2>
    <p class="small muted">記録はこの端末のブラウザの中にだけあります。ブラウザのデータを消すと記録も消えるので、ときどき書き出して保管してください。</p>
    <p class="small">記録 <span id="recCount">${d.records.length}</span>件 · 最後の書き出し:${d.lastExportAt ? new Date(d.lastExportAt).toLocaleString('ja-JP') : 'なし'}</p>
    <div class="grid2"><button class="btn" id="expJson">JSONで書き出す</button><button class="btn ghost" id="expCsv">CSVで書き出す</button></div>
    <p class="small muted">JSON:狙い・設定も含む完全なバックアップ。CSV:記録だけ(表計算ソフト用)。</p>
  </section>
  <section class="card">
    <h2>読み込み(復元)</h2>
    <input type="file" id="imp" accept=".json,.csv,application/json,text/csv">
    <div class="stack">
      <label class="check"><input type="radio" name="mode" value="append" checked>追加(同じ記録は除外)</label>
      <label class="check"><input type="radio" name="mode" value="replace">上書き(今の記録を消して置き換え)</label>
    </div>
    <button class="btn" id="doImp" disabled>読み込む</button>
    <p id="impMsg" class="msg"></p>
  </section>
  <section class="card">
    <h2>設定</h2>
    <label class="f">バックアップのお知らせ(最後の書き出しから何日後)<input type="number" id="remind" min="1" max="365" value="${s.backupRemindDays}"></label>
    <label class="f">表示テーマ<select id="theme">
      <option value="auto" ${s.theme === 'auto' ? 'selected' : ''}>端末に合わせる</option>
      <option value="light" ${s.theme === 'light' ? 'selected' : ''}>ライト</option>
      <option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>ダーク</option></select></label>
  </section>
  <section class="card">
    <h2>全削除</h2>
    <p class="small muted">記録・狙い・手で入れたイベントをすべて消します(設定は残ります)。先に書き出しておくのがおすすめです。</p>
    <button class="btn danger" id="wipe">すべて削除する</button>
  </section>`;

  $('#expJson', root).onclick = () => { download(`sleep-type-tool-${stamp()}.json`, Store.exportJson(), 'application/json'); toast('JSONを書き出しました'); viewData(root); };
  $('#expCsv', root).onclick = () => { download(`sleep-type-tool-${stamp()}.csv`, Store.exportCsv(), 'text/csv'); toast('CSVを書き出しました'); viewData(root); };
  const imp = $('#imp', root);
  imp.onchange = () => { $('#doImp', root).disabled = !imp.files.length; };
  $('#doImp', root).onclick = async () => {
    const file = imp.files[0]; if (!file) return;
    const mode = $('input[name="mode"]:checked', root).value;
    if (mode === 'replace' && !(await ask(`今の記録(${Store.get().records.length}件)を消して、ファイルの内容で置き換えます。よろしいですか?`, { ok: '上書きする', danger: true }))) return;
    const m = $('#impMsg', root);
    try {
      const r = Store.importText(await file.text(), file.name, mode);
      m.className = 'msg ok';
      m.textContent = `${r.added}件を読み込みました` + (r.skipped ? `(重複${r.skipped}件は除外)` : '') + (r.invalid ? `。形式が不正な${r.invalid}件は読み込めませんでした(日付・時刻・割合の合計100・睡眠時間を確認してください)` : '');
      $('#recCount', root).textContent = Store.get().records.length;
      applyTheme();
    } catch (e) { m.className = 'msg err'; m.textContent = '読み込めませんでした:' + e.message; }
  };
  $('#remind', root).onchange = e => { const v = Math.max(1, Math.min(365, Math.round(Number(e.target.value) || 30))); e.target.value = v; Store.setSetting('backupRemindDays', v); toast('保存しました'); };
  $('#theme', root).onchange = e => { Store.setSetting('theme', e.target.value); applyTheme(); };
  $('#wipe', root).onclick = async () => {
    const n = Store.get().records.length;
    const v = await ask(`記録${n}件・狙い・手で入れたイベントをすべて削除します。元に戻せません。続けるには「削除」と入力してください。`,
      { ok: '削除する', danger: true, extra: '<input type="text" aria-label="確認の入力" placeholder="削除" autocomplete="off">' });
    if (v !== '削除') { if (v !== false) toast('入力が「削除」と一致しないため、やめました'); return; }
    Store.clearAll(); toast('すべて削除しました'); viewData(root);
  };
}

// ================= このアプリについて / メニュー =================
function viewAbout(root) {
  root.innerHTML = `
  <section class="card">
    <h2>${APP_NAME}</h2>
    <p class="small muted">対象:${FOR_GAME}(非公式ファンツール)</p>
    <p>睡眠計測ゲームの睡眠結果(うとうと・すやすや・ぐっすりの割合)を自分で記録し、平均を見ながら今夜狙うタイプを決めるための<b>非公式ファンツール</b>です。ゲームの開発・運営会社とは関係ありません。ゲームの画像・ロゴは使っていません。</p>
    <p class="small muted">制作者: ゆめくい(X: <a href="https://x.com/youmay91" target="_blank" rel="noopener noreferrer">@youmay91</a>)</p>
  </section>
  <section class="card">
    <h2>データの扱い</h2>
    <ul class="small" style="margin:0;padding-left:1.2em">
      <li>記録はこの端末のブラウザの中(localStorage)にだけ保存されます。サーバーには送りません。</li>
      <li>スクショの読み取りも端末の中で行います(文字認識:Tesseract.js、同梱)。画像は外に送りません。</li>
      <li>ログイン・アクセス解析・広告はありません。</li>
      <li>ブラウザのデータを消すと記録も消えます。<a href="#data">データ管理</a>で定期的に書き出してください。</li>
    </ul>
  </section>
  <section class="card">
    <h2>使い方</h2>
    <ol class="small" style="margin:0;padding-left:1.2em">
      <li>はじめに、過去分のスクショを<a href="#bulk">一括取り込み</a>で入れると、初日から平均が出ます。</li>
      <li>毎朝、スクショを<a href="#input">入力</a>で読み取って保存します。手入力もできます。</li>
      <li><a href="#targets">狙い設定</a>で週ごとの狙いを決めると、ホームに今夜の過ごし方が出ます。</li>
    </ol>
  </section>
  <section class="card">
    <h2>推定について</h2>
    <p class="small">タイプの決まり方は公式に公開されていません。このアプリでは「その夜の割合が、過去の平均より多く出たタイプになる。平均に近ければとくちょうなし」と<b>推定</b>して提案しています。外れることがあります。</p>
  </section>
  <p class="small muted">記録の日付はゲームに表示される日付(就寝日)です。睡眠時間はゲームの表示値を優先します。週は月曜始まり。</p>`;
}

function viewMenu(root) {
  root.innerHTML = `<section class="card list menu">
    <a href="#bulk"><span>一括取り込み<small>スクショを複数枚まとめて読み取る</small></span>›</a>
    <a href="#targets"><span>狙い設定<small>週ごと・日ごとの狙い</small></span>›</a>
    <a href="#stats"><span>統計<small>平均・重み付き平均・標準偏差</small></span>›</a>
    <a href="#events"><span>イベント<small>公式イベントの確認・手で追加・修正</small></span>›</a>
    <a href="#data"><span>データ管理<small>書き出し・読み込み・設定・全削除</small></span>›</a>
    <a href="#about"><span>このアプリについて<small>非公式の明記・データの扱い</small></span>›</a>
  </section>`;
}

// ================= 満月(GSD)・新月(NMD)の印 =================
// 満月・新月の日とその前後1日に付ける利用者の印。色だけに頼らず、○(満月)/●(新月)と文字で示す
const MOON_ICON = { full: '○', new: '●' };
const MOON_NAME = { full: '満月', new: '新月' };
const moonSpanLabel = sp => `${MOON_ICON[sp.phase]}${sp.mark} ${Calc.fmtMd(sp.from)}〜${Calc.fmtMd(sp.to)}`;
const moonTags = (from, to) => Moon.spansBetween(from, to).map(sp => `<span class="moon-tag ${sp.phase}">${moonSpanLabel(sp)}</span>`).join('');

// ================= 公式イベント =================
// イベントの一覧(タイトル・期間・公式記事へのリンクだけ。公式の本文・画像は出さない)
function eventListHtml(evs, compact = false) {
  if (!evs.length) return '';
  return `<div class="stack ev-list">${evs.map(e => `<div class="ev-item">
    <div><b>${esc(Events.displayTitle(e.title))}</b> <span class="small muted">${Events.periodLabel(e)}</span></div>
    <div class="row small">
      ${Events.isYami(e) ? `<span class="ev-tag free" title="${YAMI_NOTE}イベント">${YAMI}</span>` : ''}
      ${e.boostTypes.map(k => `<span class="tchip t-${k}">${TYPE_LABEL[k]}が有利</span>`).join('')}
      ${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">公式のお知らせ</a>` : ''}
      ${!compact && e.source !== 'official' ? `<span class="muted">${e.source === 'manual' ? '手入力' : '手で修正'}</span>` : ''}
    </div></div>`).join('')}</div>`;
}

function viewEvents(root) {
  let editing = null; // 修正中のイベントの id(新規なら null)

  function formHtml(e) {
    const v = e || { title: '', from: '', to: '', url: '', typeFree: false, boostTypes: [] };
    return `<form class="card" id="evForm" novalidate>
      <h2>${e ? 'イベントを修正' : 'イベントを手で追加'}</h2>
      <label class="f">タイトル<input type="text" name="title" maxlength="80" value="${esc(v.title)}" required></label>
      <div class="grid2">
        <label class="f">始まる日<input type="date" name="from" value="${esc(v.from || '')}"></label>
        <label class="f">終わる日<input type="date" name="to" value="${esc(v.to || '')}"></label>
      </div>
      <p class="small muted">日付はゲームの日付(午前4時に切り替わる)で入れてください。</p>
      <label class="f">公式のお知らせのURL(任意)<input type="url" name="url" value="${esc(v.url || '')}" placeholder="https://"></label>
      <label class="check"><input type="checkbox" name="typeFree" ${v.typeFree ? 'checked' : ''}>${YAMI}(${YAMI_NOTE}イベント)</label>
      <div class="row small"><span class="muted">有利なタイプ:</span>${KINDS.map(k => `<label class="check"><input type="checkbox" name="boost" value="${k}" ${v.boostTypes.includes(k) ? 'checked' : ''}>${TYPE_LABEL[k]}</label>`).join('')}</div>
      <p id="evMsg" class="msg"></p>
      <div class="grid2"><button class="btn" type="submit">${e ? '修正を保存' : '追加する'}</button>${e ? '<button class="btn ghost" type="button" id="evCancel">やめる</button>' : ''}</div>
    </form>`;
  }

  function render() {
    const all = Events.list(true);
    const cur = editing ? all.find(e => e.id === editing) : null;
    const today = todayYmd();
    const items = all.map(e => `<div class="ev-item ${e.hidden ? 'hidden-ev' : ''}" data-id="${esc(e.id)}">
      <div><b>${esc(Events.displayTitle(e.title))}</b> <span class="small muted">${Events.periodLabel(e)}${e.to && e.to < today ? '(終了)' : ''}</span></div>
      <div class="row small">
        <span class="muted">${{ official: '公式', edited: '公式を手で修正', manual: '手入力' }[e.source]}${e.hidden ? '・非表示' : ''}</span>
        ${Events.isYami(e) ? `<span class="ev-tag free" title="${YAMI_NOTE}イベント">${YAMI}</span>` : ''}
        ${e.boostTypes.map(k => `<span class="tchip t-${k}">${TYPE_LABEL[k]}が有利</span>`).join('')}
        ${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">公式のお知らせ</a>` : ''}
      </div>
      <div class="row">
        <button class="btn ghost small" data-act="edit">修正</button>
        <button class="btn ghost small" data-act="${e.hidden ? 'show' : 'hide'}">${e.hidden ? '表示に戻す' : '非表示'}</button>
        ${e.source === 'edited' ? '<button class="btn ghost small" data-act="reset">公式の内容に戻す</button>' : ''}
        ${e.source === 'manual' ? '<button class="btn ghost small" data-act="delete">削除</button>' : ''}
      </div></div>`).join('');
    root.innerHTML = `
    <section class="card">
      <p class="small">公式のお知らせから集めたイベントを、カレンダー・狙い設定・ホームに出します。表示するのはタイトル・期間・公式のお知らせへのリンクだけです。</p>
      <p class="small muted">足りないイベントは手で追加でき、公式のイベントも手で修正・非表示にできます(この端末だけ。手で入れた内容が優先)。日付の切り替わりは午前4時です。</p>
    </section>
    ${formHtml(cur)}
    <section class="card"><h2>イベントの一覧</h2>
      <div class="list">${items || '<p class="small muted">まだイベントはありません。</p>'}</div>
    </section>`;

    const f = $('#evForm', root);
    f.onsubmit = e => {
      e.preventDefault();
      const title = f.title.value.trim(), from = f.from.value, to = f.to.value || f.from.value;
      const err = !title ? 'タイトルを入れてください' : !isYmd(from) ? '始まる日を入れてください' : to < from ? '終わる日が始まる日より前です'
        : f.url.value && !/^https?:\/\//.test(f.url.value) ? 'URLは https:// から始めてください' : '';
      if (err) { $('#evMsg', root).className = 'msg err'; $('#evMsg', root).textContent = err; return; }
      const prev = (Store.get().events || []).find(x => x.id === editing) || {};
      Store.upsertEvent({ ...prev, id: editing || 'm-' + Store.newId(), title, start: Events.dayStartIso(from), end: Events.dayEndIso(to),
        url: f.url.value.trim(), typeFree: f.typeFree.checked, boostTypes: $$('input[name="boost"]:checked', f).map(x => x.value), hidden: !!prev.hidden });
      toast(editing ? 'イベントを修正しました' : 'イベントを追加しました');
      editing = null; render();
    };
    const cancel = $('#evCancel', root);
    if (cancel) cancel.onclick = () => { editing = null; render(); };
  }

  const onClick = async e => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const id = b.closest('.ev-item').dataset.id;
    const ev = Events.list(true).find(x => x.id === id);
    const mine = (Store.get().events || []).find(x => x.id === id);
    const act = b.dataset.act;
    if (act === 'edit') { editing = id; render(); $('#evForm', root).scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (act === 'hide' || act === 'show') {
      // 公式のものは「非表示」の印だけを手入力側に持つ(公式の内容はそのまま)
      Store.upsertEvent(mine ? { ...mine, hidden: act === 'hide' } : { id, hidden: true });
      if (act === 'show' && mine && ev.source !== 'manual' && Object.keys(mine).every(k => k === 'id' || k === 'hidden')) Store.removeEvent(id);
      toast(act === 'hide' ? '非表示にしました' : '表示に戻しました');
    }
    if (act === 'reset' && await ask('手で修正した内容を消して、公式の内容に戻しますか?', { ok: '戻す' })) { Store.removeEvent(id); toast('公式の内容に戻しました'); }
    if (act === 'delete' && await ask(`「${ev.title}」を削除しますか?`, { ok: '削除する', danger: true })) { Store.removeEvent(id); toast('削除しました'); }
    render();
  };
  root.addEventListener('click', onClick);
  render();
  return () => root.removeEventListener('click', onClick);
}

const VIEWS = { home: viewHome, input: viewInput, bulk: viewBulk, calendar: viewCalendar, targets: viewTargets, stats: viewStats, data: viewData, about: viewAbout, menu: viewMenu, events: viewEvents };

Store.load();
applyTheme();
const setTopbarH = () => document.documentElement.style.setProperty('--topbar-h', $('.topbar').offsetHeight + 'px');
setTopbarH();
window.addEventListener('resize', setTopbarH);
window.addEventListener('hashchange', route);
window.addEventListener('storage', e => { if (e.key === STORAGE_KEY) { Store.load(); route(); } });
route();
// 公式イベントの最新を読み込む(配信前・読めないときは何もしない)。変わっていたら、イベントを出している画面を描き直す
// カレンダーはスクロール位置が戻ってしまうので描き直さない(次に開いたときに反映)
// いま動いている版(index.html の ?v=)と、サーバーの最新の index.html を比べ、違えば再読み込みを案内する
(async () => {
  try {
    const mine = (document.querySelector('script[src*="app.js"]').getAttribute('src').match(/v=([\w-]+)/) || [])[1];
    const html = await (await fetch('index.html', { cache: 'no-store' })).text();
    const latest = (html.match(/app\.js\?v=([\w-]+)/) || [])[1];
    if (mine && latest && mine !== latest) {
      const bar = document.createElement('div');
      bar.className = 'update-bar';
      bar.innerHTML = '新しい版があります。<button type="button" class="btn small">再読み込み</button>';
      bar.querySelector('button').onclick = () => location.reload();
      document.body.append(bar);
    }
  } catch (e) { /* オフラインなどは何もしない */ }
})();
Events.load().then(changed => { if (changed && /^#(home|targets|events)?($|\?)/.test(location.hash || '#home')) route(); });