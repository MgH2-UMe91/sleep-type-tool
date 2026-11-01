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
  return new Promise(res => {
    dlg.onclose = () => res(dlg.returnValue === 'ok' ? (inp ? inp.value : true) : false);
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
const AUTHOR = 'ゆめくい';
const FULL_NAME = `${APP_NAME} by ${AUTHOR}`;
const TITLES = { home: APP_NAME, input: '入力', bulk: '一括取り込み', calendar: 'カレンダー', targets: '狙い設定', stats: '統計', data: 'データ管理', about: 'このアプリについて', menu: 'メニュー' };
const TAB_OF = { bulk: 'menu', targets: 'menu', data: 'menu', about: 'menu' };
let cleanup = null;

function route() {
  const [path, qs] = (location.hash.slice(1) || 'home').split('?');
  const [name, id] = path.split('/');
  const q = Object.fromEntries(new URLSearchParams(qs || ''));
  const view = VIEWS[name] ? name : 'home';
  if (cleanup) { cleanup(); cleanup = null; }
  $('#pageTitle').textContent = TITLES[view];
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
  const adv = Calc.todayAdvice(today);
  const t = Store.targetOf(today);
  const a30d = Calc.averageAt(today, 'days'), a30n = Calc.averageAt(today, 'count');
  const missing = Calc.missingDays(today);
  const recs = Store.records();
  const lastExp = Store.get().lastExportAt;
  const expDays = lastExp ? daysBetween(ymd(new Date(lastExp)), today) : null;
  const needBackup = recs.length > 0 && (lastExp === null || expDays >= s.backupRemindDays);
  const last = recs[recs.length - 1];

  root.innerHTML = `
  <section class="card hero ${adv.type ? 'k-' + adv.type : ''}">
    <div class="row"><span class="small muted">${fmtDateLong(today)}の夜</span><span class="guess">推定にもとづく提案</span></div>
    <p class="big">${esc(adv.title)}</p>
    <p class="small">${esc(adv.reason)}</p>
    <p class="small muted">狙い:${t ? `${TARGET_LABEL[t.target]}(${t.from === 'day' ? '日の設定' : '週の設定'})` : '未設定'} · <a href="#targets">狙いを設定する</a></p>
  </section>
  ${needBackup ? `<section class="msg warn">${lastExp ? `最後のバックアップから${expDays}日たちました。` : 'まだバックアップを書き出していません。'}ブラウザのデータを消すと記録も消えます。<a href="#data">データ管理で書き出す</a></section>` : ''}
  ${missing.length ? `<section class="card"><h2>未入力の日</h2><p class="small muted">直近14日で記録がない日</p>
    <div class="row">${missing.map(d => `<a class="btn ghost small" href="#input?date=${d}">${fmtDate(d)}</a>`).join('')}</div></section>` : ''}
  <section class="card">
    <h2>直近の平均</h2>
    ${avgBlock(a30d, '直近30日')}
    ${avgBlock(a30n, '直近30回')}
    <p class="small muted">分割睡眠で1日に2件あると、30日と30回で差が出ます · <a href="#stats">くわしい統計</a></p>
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

// ================= カレンダー =================
function viewCalendar(root, id, q) {
  let sel = q.d && isYmd(q.d) ? q.d : null;
  let month = (sel || todayYmd()).slice(0, 7);
  const range = () => Store.get().settings.defaultRange;

  function render() {
    const recs = Store.records();
    const byDate = {};
    recs.forEach(r => (byDate[r.date] = byDate[r.date] || []).push(r));
    const first = month + '-01';
    const start = mondayOf(first);
    const [y, m] = month.split('-').map(Number);
    const today = todayYmd();
    let cells = '';
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i);
      if (i >= 35 && d.slice(0, 7) !== month) break;
      const rs = byDate[d] || [];
      const tg = Store.targetOf(d);
      // 分割睡眠で1日に2件以上あれば、件数分の印とタイプを就寝時刻順に並べる
      cells += `<button type="button" class="day ${d === today ? 'today' : ''} ${d === sel ? 'sel' : ''} ${d.slice(0, 7) !== month ? 'out' : ''}" data-d="${d}"
        aria-label="${fmtDateLong(d)}${rs.length ? ' ' + rs.map(r => TYPE_LABEL[r.type]).join('・') : ' 記録なし'}">
        ${rs.length ? `<span class="mark" aria-hidden="true">${rs.map(() => '<i></i>').join('')}</span>` : ''}
        <span class="d">${parseYmd(d).getDate()}</span>
        ${rs.map(r => `<span class="tl ${r.type ? 't-' + r.type : 't-empty'}">${SHORT[r.type]}</span>`).join('')}
        ${tg && tg.target !== 'none' ? `<span class="tg">狙${SHORT[tg.target]}</span>` : ''}
      </button>`;
    }
    root.innerHTML = `
    <section class="card">
      <div class="row"><button class="btn ghost small" id="prev" aria-label="前の月">◀</button>
        <h2 class="grow" style="text-align:center">${y}年${m}月</h2>
        <button class="btn ghost small" id="next" aria-label="次の月">▶</button></div>
      <div class="cal">${['月', '火', '水', '木', '金', '土', '日'].map((w, i) => `<span class="wd ${i === 5 ? 'sat' : i === 6 ? 'sun' : ''}">${w}</span>`).join('')}${cells}</div>
      <p class="small muted">●=入力済み(分割睡眠は件数分) · 色と文字=表示タイプ(なし/うと/すや/ぐっ) · 狙○=その日の狙い</p>
    </section>
    <section id="detail">${sel ? detailHtml(sel, byDate[sel] || []) : '<p class="small muted">日をタップすると詳細が出ます。</p>'}</section>`;
    $('#prev', root).onclick = () => { month = addDays(first, -1).slice(0, 7); render(); };
    $('#next', root).onclick = () => { month = addDays(first, 32).slice(0, 7); render(); };
    $$('.day', root).forEach(b => b.onclick = () => { sel = b.dataset.d; if (sel.slice(0, 7) !== month) month = sel.slice(0, 7); history.replaceState(null, '', `#calendar?d=${sel}`); render(); $('#detail', root).scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  }

  function detailHtml(d, rs) {
    const tg = Store.targetOf(d);
    const a30d = Calc.averageAt(d, 'days'), a30n = Calc.averageAt(d, 'count');
    const items = rs.map(r => {
      const est = Calc.estimateType(r, range());
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
    return `<div class="card">
      <h2>${fmtDateLong(d)}</h2>
      <p class="small">狙い:${tg ? `${TARGET_LABEL[tg.target]}(${tg.from === 'day' ? '日の設定' : '週の設定'})` : '未設定'}</p>
      <div class="list">${items || '<p class="small muted">記録はありません。</p>'}</div>
      <a class="btn ghost" href="#input?date=${d}">この日の記録を追加</a>
      <h3>この日時点の平均</h3>
      ${avgBlock(a30d, '直近30日')}
      ${avgBlock(a30n, '直近30回')}
    </div>`;
  }
  render();
}

// ================= 狙い設定 =================
function viewTargets(root) {
  const thisWeek = mondayOf(todayYmd());
  const d = Store.get();
  const opt = (sel, first) => `<option value="">${first}</option>` + ['uto', 'suya', 'gus', 'none'].map(t => `<option value="${t}" ${t === sel ? 'selected' : ''}>${TARGET_LABEL[t]}</option>`).join('');
  let html = `<section class="card"><p class="small">週ごとに狙うタイプを決めます。必要な日だけ、日ごとに上書きできます(日の設定が優先)。週は月曜始まり。</p>
    <p class="small muted">狙いの数日前からは、狙うタイプを少なめにして平均を下げておくと、狙う夜に「平均より多い」になりやすい(推定)。ホームの提案はこの考え方で出します。</p></section>`;
  for (let w = -2; w <= 8; w++) {
    const ws = addDays(thisWeek, w * 7);
    const wt = d.weekTargets.find(t => t.weekStart === ws);
    const overrides = d.dayTargets.filter(t => t.date >= ws && t.date <= addDays(ws, 6)).length;
    let days = '';
    for (let i = 0; i < 7; i++) {
      const day = addDays(ws, i);
      const dt = d.dayTargets.find(t => t.date === day);
      days += `<label class="dayrow"><span>${fmtDate(day)}</span><select data-day="${day}" aria-label="${fmtDate(day)}の狙い">${opt(dt && dt.target, '週の設定に従う')}</select></label>`;
    }
    html += `<section class="week ${w === 0 ? 'cur' : ''}">
      <label class="f"><span><b>${fmtDate(ws)}〜${fmtDate(addDays(ws, 6))}</b>${w === 0 ? '(今週)' : w === 1 ? '(来週)' : ''}</span>
        <select data-week="${ws}">${opt(wt && wt.target, '未設定')}</select></label>
      <details ${overrides ? 'open' : ''}><summary>日ごとに上書き${overrides ? `(${overrides}日)` : ''}</summary><div class="stack">${days}</div></details>
    </section>`;
  }
  root.innerHTML = `<div class="stack" id="tg">${html}</div>`;
  $('#tg', root).addEventListener('change', e => {
    const el = e.target;
    if (el.dataset.week) { Store.setWeekTarget(el.dataset.week, el.value); toast('週の狙いを保存しました'); }
    if (el.dataset.day) { Store.setDayTarget(el.dataset.day, el.value); toast('日の狙いを保存しました'); }
  });
}

// ================= 統計 =================
function viewStats(root) {
  function render() {
    const s = Store.get().settings, range = s.defaultRange, today = todayYmd();
    const st = Calc.averageAt(today, range);
    const label = range === 'days' ? '直近30日' : '直近30回';
    root.innerHTML = `
    <div class="seg" role="group" aria-label="集計範囲">
      <button data-r="days" aria-pressed="${range === 'days'}">直近30日</button>
      <button data-r="count" aria-pressed="${range === 'count'}">直近30回</button>
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
        <li>直近30日:今日を含む過去30日の全記録。直近30回:新しい順に30件。ゲームがどちらで判定しているかは不明(推定)。</li>
        <li>分割睡眠で同じ日付に2件ある日は、30日では両方が入り、30回では1件ずつ数えます。</li>
      </ul>
    </section>
    <p class="small muted">ここでの切り替えは、ホームの提案に使う平均にも反映されます。</p>`;
    $$('.seg button', root).forEach(b => b.onclick = () => { Store.setSetting('defaultRange', b.dataset.r); render(); });
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
    <p class="small muted">記録と狙いをすべて消します(設定は残ります)。先に書き出しておくのがおすすめです。</p>
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
    const v = await ask(`記録${n}件と狙いをすべて削除します。元に戻せません。続けるには「削除」と入力してください。`,
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
    <p class="small muted">作者:${AUTHOR}</p>
    <p>睡眠計測ゲームの睡眠結果(うとうと・すやすや・ぐっすりの割合)を自分で記録し、平均を見ながら今夜狙うタイプを決めるための<b>非公式ファンツール</b>です。ゲームの開発・運営会社とは関係ありません。ゲームの画像・ロゴは使っていません。</p>
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
    <a href="#data"><span>データ管理<small>書き出し・読み込み・設定・全削除</small></span>›</a>
    <a href="#about"><span>このアプリについて<small>非公式の明記・データの扱い</small></span>›</a>
  </section>`;
}

const VIEWS = { home: viewHome, input: viewInput, bulk: viewBulk, calendar: viewCalendar, targets: viewTargets, stats: viewStats, data: viewData, about: viewAbout, menu: viewMenu };

Store.load();
applyTheme();
window.addEventListener('hashchange', route);
window.addEventListener('storage', e => { if (e.key === STORAGE_KEY) { Store.load(); route(); } });
route();
