// データの保存・読み込み(localStorage)
// 項目名はそのままデータベースの列名にできるよう、すべて英数字のキャメルケースにしている
'use strict';

const SCHEMA_VERSION = 1;
const STORAGE_KEY = 'sleep-type-tool';

// 睡眠記録の列(CSVの列順もこれ)
// 分割睡眠で同じ日付に複数件ありうる。同じ記録かどうかは 日付+就寝時刻 で判定する
const RECORD_COLUMNS = ['id', 'date', 'bedTime', 'wakeTime', 'sleepMin', 'utoPct', 'suyaPct', 'gusPct',
  'autoField', 'type', 'source', 'memo', 'createdAt', 'updatedAt', 'excluded'];
// excluded:「自分の傾向」の集計に含めない(計測ミス・放置など。画面の表記は「集計外」)。任意の項目で、無い記録(古いデータ・古いCSV)は false

const DEFAULT_SETTINGS = {
  backupRemindDays: 30,     // 最後の書き出しから何日でお知らせするか
  theme: 'auto',            // 'auto' / 'light' / 'dark'
};

// 週の計画のフィールド(この順でプルダウンに出す)。保存するのは id だけなので、id は変えないこと。増えたらここに足す
const FIELDS = [
  { id: 'greengrass', emoji: '🏕️', name: 'ワカクサ本島' },
  { id: 'cyan', emoji: '🏝️', name: 'シアンの砂浜' },
  { id: 'taupe', emoji: '🏔️', name: 'トープ洞窟' },
  { id: 'snowdrop', emoji: '⛄', name: 'ウノハナ雪原' },
  { id: 'lapis', emoji: '🏞️', name: 'ラピスラズリ湖畔' },
  { id: 'oldgold', emoji: '🏭', name: 'ゴールド旧発電所' },
  { id: 'amber', emoji: '🏜️', name: 'アンバー渓谷' },
  { id: 'greengrass-ex', emoji: '🏕️', name: 'ワカクサ本島 EX' },
  { id: 'cyan-ex', emoji: '🏝️', name: 'シアンの砂浜 EX' },
];
const fieldOf = id => FIELDS.find(f => f.id === id) || null;
const WEEK_NOTE_MAX = 100; // 週の計画の、夜ごとのメモの文字数

// ---------- 日付のヘルパー(すべて端末のローカル日付) ----------
const pad2 = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const todayYmd = () => ymd(new Date());
// 週は月曜始まり
const mondayOf = s => { const d = parseYmd(s); const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd); return ymd(d); };
const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
// 実在する日付か(2026-02-30 のような繰り上がりは不可)
const isYmd = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && ymd(parseYmd(s)) === s;
// 時刻の形と範囲(0:00〜23:59)
const isHm = s => typeof s === 'string' && /^\d{1,2}:\d{2}$/.test(s) && Number(s.split(':')[0]) < 24 && Number(s.split(':')[1]) < 60;
// 日付の表記ゆれをそろえる(Excelで保存したCSVの 2026/10/6 なども受け付ける)。不正なら null
const toYmd = s => {
  const m = String(s ?? '').trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (!m) return null;
  const v = `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  return isYmd(v) ? v : null;
};
// 「夜」の日付の区切り。ゲームの日付は午前4時に切り替わるので、この時刻より前(0:00〜3:59)は前日の夜として扱う。
// ホームの「今夜」・入力の初期日付・記録の並び順で共通
const NIGHT_START_HOUR = 4;
const tonightYmd = (now = new Date()) => now.getHours() < NIGHT_START_HOUR ? addDays(ymd(now), -1) : ymd(now);
// 記録を実際の時間順に並べるための鍵。0:00〜3:59 の就寝は同じ日付の夜の後半なので 24:00〜27:59 として扱う
const sleepOrderKey = r => {
  const t = r.bedTime;
  if (!t) return r.date + ' 99:99';
  const [h, m] = t.split(':').map(Number);
  return `${r.date} ${pad2(h < NIGHT_START_HOUR ? h + 24 : h)}:${pad2(m)}`;
};
// 記録・イベントの id に使える形(画面の属性やリンクに入れるので、記号の入ったものは受け付けない)
const isSafeId = s => (typeof s === 'string' || typeof s === 'number') && /^[A-Za-z0-9_.:-]{1,100}$/.test(String(s));
// 日時として読める文字列か(イベントの開始・終了)
const isIsoTime = s => typeof s === 'string' && s.length <= 40 && /^\d{4}-\d{2}-\d{2}/.test(s) && !isNaN(Date.parse(s));
// リンクにしてよいURLか(http/https だけ。javascript: などは不可)
const isHttpUrl = s => typeof s === 'string' && s.length <= 500 && /^https?:\/\/[^\s"'<>]+$/i.test(s);
// 入力された時刻を「HH:MM」(0:00〜23:59)にそろえる。読めなければ null。
// ゲームは深夜を 24〜27時台で表すことがあるので、24:00〜27:59 は 0:00〜3:59 にする(日付はその夜のまま)。
// 「2510」「1:10」「２５：１０」のような書き方も受け付ける。28時以降・60分以上は null
const normHm = s => {
  const t = String(s == null ? '' : s).trim().replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[：]/g, ':');
  const m = t.match(/^(\d{1,2}):?(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h >= 28 || mi >= 60) return null;
  return `${pad2(h % 24)}:${pad2(mi)}`;
};
// 24〜27時台の書き方か(確認の表示用)
const isLateHm = s => { const m = String(s || '').trim().match(/^(\d{1,2})/); return !!m && Number(m[1]) >= 24 && normHm(s) !== null; };
const hmToMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const minToHm = n => `${Math.floor(n / 60)}:${pad2(n % 60)}`;
const nowIso = () => new Date().toISOString();
// 読み込むファイルの上限(文字数)。1件およそ300文字なので、数万件ぶんの余裕がある
const IMPORT_MAX_CHARS = 10 * 1024 * 1024;

const Store = (() => {
  let db = null;

  function empty() {
    // events:利用者が手で追加・修正・非表示にした公式イベント(events.json と id で合わせ、こちらが優先)
    // weekPlans:週の計画 { weekStart, field, notes: { 日付: メモ } }。任意の項目で、無いデータ(古いバックアップ)は空として読む
    return { schemaVersion: SCHEMA_VERSION, records: [], weekTargets: [], dayTargets: [], weekPlans: [], events: [], settings: { ...DEFAULT_SETTINGS }, lastExportAt: null };
  }

  // 古い版のデータを今の版にそろえる(版が上がったらここに変換を足す)
  function migrate(d) {
    const out = empty();
    if (!d || typeof d !== 'object') return out;
    out.records = Array.isArray(d.records) ? d.records.map(normalizeRecord).filter(Boolean) : [];
    out.weekTargets = Array.isArray(d.weekTargets) ? d.weekTargets.filter(t => t && typeof t === 'object' && isYmd(t.weekStart) && TARGETS.includes(t.target)).map(t => ({ weekStart: t.weekStart, target: t.target })) : [];
    out.dayTargets = Array.isArray(d.dayTargets) ? d.dayTargets.filter(t => t && typeof t === 'object' && isYmd(t.date) && TARGETS.includes(t.target)).map(t => ({ date: t.date, target: t.target })) : [];
    out.weekPlans = Array.isArray(d.weekPlans) ? d.weekPlans.map(cleanWeekPlan).filter(Boolean) : [];
    out.events = Array.isArray(d.events) ? d.events.map(cleanEvent).filter(Boolean) : [];
    // 設定は知っている項目だけを、決まった形の値で受け取る(読み込んだファイルの値をそのまま画面に出さないため)。
    // 試作時の includeNaps、30日/30回の defaultRange など古い項目はここで落ちる
    const s = d.settings && typeof d.settings === 'object' ? d.settings : {};
    const days = Number(s.backupRemindDays);
    if (Number.isInteger(days) && days >= 1 && days <= 365) out.settings.backupRemindDays = days;
    if (['auto', 'light', 'dark'].includes(s.theme)) out.settings.theme = s.theme;
    out.lastExportAt = d.lastExportAt || null;
    return out;
  }

  const TARGETS = ['uto', 'suya', 'gus', 'none'];
  const TYPES = ['none', 'uto', 'suya', 'gus', ''];

  // 週の計画1件をそろえる。週の7日以外のメモと空のメモは落とす。フィールドもメモもない週は null(保存しない)。
  // field は一覧にない id でも形が正しければ残す(新しい版のバックアップを読んでも消さないため)
  function cleanWeekPlan(p) {
    if (!p || typeof p !== 'object' || !isYmd(p.weekStart) || mondayOf(p.weekStart) !== p.weekStart) return null;
    const src = p.notes && typeof p.notes === 'object' ? p.notes : {}, notes = {};
    for (let i = 0; i < 7; i++) {
      const day = addDays(p.weekStart, i), v = src[day];
      const s = typeof v === 'string' ? v.trim().slice(0, WEEK_NOTE_MAX) : '';
      if (s) notes[day] = s;
    }
    const field = isSafeId(p.field) ? String(p.field) : '';
    return field || Object.keys(notes).length ? { weekStart: p.weekStart, field, notes } : null;
  }

  // 手で追加・修正・非表示にしたイベント1件をそろえる。入っていた項目だけを残す
  // (「非表示」の印だけの {id, hidden} を、公式の内容を上書きしない形のまま保つため)。不正なら null
  function cleanEvent(e) {
    if (!e || typeof e !== 'object' || !isSafeId(e.id)) return null;
    const out = { id: String(e.id) };
    const has = k => Object.prototype.hasOwnProperty.call(e, k);
    if (has('hidden')) out.hidden = !!e.hidden;
    if (has('title') && e.title != null && e.title !== '') out.title = String(e.title).slice(0, 200);
    if (has('category')) out.category = String(e.category ?? '').slice(0, 40);
    for (const k of ['start', 'end']) if (has(k)) out[k] = isIsoTime(e[k]) ? e[k] : null;
    if (has('url')) out.url = isHttpUrl(e.url) ? e.url : '';
    if (has('typeFree')) out.typeFree = !!e.typeFree;
    if (has('boostTypes')) out.boostTypes = Array.isArray(e.boostTypes) ? e.boostTypes.filter(k => ['uto', 'suya', 'gus'].includes(k)) : [];
    return out.hidden || out.title ? out : null;
  }

  // 記録1件を正しい形にそろえる。値がおかしいもの(実在しない日付、範囲外の時刻、
  // 整数でない割合、合計が100でない割合、0以下の睡眠時間)は null を返して取り込まない
  function normalizeRecord(r) {
    if (!r) return null;
    const date = toYmd(r.date);
    if (!date) return null;
    const blank = v => v === '' || v === null || v === undefined;
    // 空なら null、整数でなければ NaN(=不正)
    const int = v => blank(v) ? null : (Number.isInteger(Number(v)) ? Number(v) : NaN);
    const time = v => blank(v) ? '' : normHm(v); // 24〜27時台は 0〜3時台にそろえる
    const bedTime = time(r.bedTime), wakeTime = time(r.wakeTime), sleepMin = int(r.sleepMin);
    if (bedTime === null || wakeTime === null) return null;
    if (Number.isNaN(sleepMin) || (sleepMin !== null && (sleepMin <= 0 || sleepMin >= 1440))) return null;
    const rec = {
      id: isSafeId(r.id) ? String(r.id) : newId(),
      date,
      bedTime,
      wakeTime,
      sleepMin,
      utoPct: int(r.utoPct),
      suyaPct: int(r.suyaPct),
      gusPct: int(r.gusPct),
      autoField: ['uto', 'suya', 'gus'].includes(r.autoField) ? r.autoField : '',
      type: TYPES.includes(r.type) ? r.type : '',
      source: ['manual', 'ocr', 'ocr_edited'].includes(r.source) ? r.source : 'manual',
      memo: r.memo ? String(r.memo).slice(0, 500) : '',
      excluded: r.excluded === true || /^(true|1)$/i.test(String(r.excluded == null ? '' : r.excluded).trim()),
      createdAt: r.createdAt || nowIso(),
      updatedAt: r.updatedAt || r.createdAt || nowIso(),
    };
    const pct = [rec.utoPct, rec.suyaPct, rec.gusPct];
    if (pct.some(v => v === null || Number.isNaN(v) || v < 0 || v > 100)) return null;
    if (pct[0] + pct[1] + pct[2] !== 100) return null;
    return rec;
  }

  function newId() {
    return (crypto.randomUUID ? crypto.randomUUID() : 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
  }

  // ---------- 読めなかった保存データの退避 ----------
  // 保存データが壊れている・読み飛ばした項目があるときは、元の文字列を別のキー(BROKEN_PREFIX + 日時)へ写してから、読めた分だけで動く。
  // 次の保存で元データが上書きされても、退避したものは残る(データ管理で書き出せる)。退避できない(容量不足)ときは、上書きを避けるため保存を止める
  const BROKEN_PREFIX = STORAGE_KEY + '-broken-';
  const BROKEN_KEEP = 3;
  let saveBlocked = false;
  const brokenKeys = () => { const out = []; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(BROKEN_PREFIX)) out.push(k); } } catch (e) { /* 読めなければ空 */ } return out.sort(); };
  function backupRaw(raw) {
    try {
      if (brokenKeys().some(k => localStorage.getItem(k) === raw)) return true; // すでに退避済み(何度も読み直しても増やさない)
      const t = new Date();
      const base = BROKEN_PREFIX + `${t.getFullYear()}${pad2(t.getMonth() + 1)}${pad2(t.getDate())}${pad2(t.getHours())}${pad2(t.getMinutes())}${pad2(t.getSeconds())}`;
      let key = base, n = 2;
      while (localStorage.getItem(key) !== null) key = `${base}-${n++}`; // 同じ秒に別の内容を退避しても上書きしない
      localStorage.setItem(key, raw);
      for (const k of brokenKeys().slice(0, -BROKEN_KEEP)) localStorage.removeItem(k);
      return true;
    } catch (e) { return false; }
  }
  // 退避したデータの一覧 { key, at(キーの日時), chars }
  const brokenList = () => brokenKeys().map(k => { let raw = ''; try { raw = localStorage.getItem(k) || ''; } catch (e) { /* 空 */ } return { key: k, at: k.slice(BROKEN_PREFIX.length, BROKEN_PREFIX.length + 14), chars: raw.length }; });
  const brokenText = key => { try { return brokenKeys().includes(key) ? localStorage.getItem(key) : null; } catch (e) { return null; } };
  function removeBroken(key) { if (brokenKeys().includes(key)) { try { localStorage.removeItem(key); } catch (e) { /* 何もしない */ } } }

  function load() {
    saveBlocked = false;
    let raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { raw = null; }
    if (raw === null) { db = empty(); return db; }
    try {
      const parsed = JSON.parse(raw);
      db = migrate(parsed);
      // 形が合わず読み飛ばした記録があるときも、元の文字列を残す
      if (parsed && Array.isArray(parsed.records) && parsed.records.length > db.records.length && !backupRaw(raw)) saveBlocked = true;
    } catch (e) {
      db = empty();
      // 退避できたら元のキーは空ける(退避を消したあとに、同じ壊れたデータをまた退避しないため)。できなければ元のまま残し、保存を止める
      if (backupRaw(raw)) { try { localStorage.removeItem(STORAGE_KEY); } catch (e2) { /* 何もしない */ } } else saveBlocked = true;
    }
    return db;
  }
  function save() {
    if (saveBlocked) throw new Error('保存データを読み込めず、元のデータを退避できなかったため、保存を止めています。ブラウザの保存領域を空けてから、ページを開き直してください');
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  }
  // ホームの案内用:退避データがあるか、保存を止めているか
  const recovery = () => ({ blocked: saveBlocked, list: brokenList() });
  const get = () => db || load();

  // 日付→就寝時刻の順に並べる(0:00〜3:59 の就寝はその日付の夜の後半)
  const sortKey = sleepOrderKey;
  function records() { return get().records.slice().sort((a, b) => sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0); }

  function upsertRecord(r) {
    const d = get();
    const rec = normalizeRecord({ ...r, updatedAt: nowIso() });
    if (!rec) throw new Error('記録の形が正しくありません');
    const i = d.records.findIndex(x => x.id === rec.id);
    if (i >= 0) { rec.createdAt = d.records[i].createdAt; d.records[i] = rec; } else d.records.push(rec);
    save();
    return rec;
  }
  // 同じ睡眠の記録か(日付+就寝時刻)
  const sameSleep = (a, b) => a.date === b.date && (a.bedTime || '') === (b.bedTime || '');
  // 読み込みで「同じ記録」とみなす条件。画面では、同じ日付・就寝時刻の記録を確認のうえ2件保存できる(分割睡眠など)ので、
  // 日付+就寝時刻が同じだけでは重複にしない。id が同じか、id・作成/更新時刻以外が全部同じ(コピーの二重取り込み)のときだけ。
  // id の無い行(外部のCSV。_noId の印が付く)だけは、日付+就寝時刻でも重複とみなす(同じ行を二度読んだ場合の代わり)
  const CONTENT_COLS = RECORD_COLUMNS.filter(c => !['id', 'createdAt', 'updatedAt'].includes(c));
  const sameContent = (a, b) => CONTENT_COLS.every(c => (a[c] ?? '') === (b[c] ?? ''));
  const isSameRecord = (a, b) => a.id === b.id || sameContent(a, b) || ((a._noId || b._noId) && sameSleep(a, b));
  // 「自分の傾向」から外す/戻す
  function setExcluded(id, v) {
    const r = get().records.find(x => x.id === id);
    if (!r) return;
    r.excluded = !!v; r.updatedAt = nowIso(); save();
  }
  function deleteRecord(id) { const d = get(); d.records = d.records.filter(r => r.id !== id); save(); }
  function findDuplicate(r) {
    return get().records.find(x => x.id !== r.id && sameSleep(x, r));
  }
  // 就寝時刻がどちらか空で、同じ日付の記録(同じ夜の二重登録かもしれない。分割睡眠ならそのままでよい)
  function findSameDateUnsure(r) {
    return get().records.find(x => x.id !== r.id && x.date === r.date && !sameSleep(x, r) && (!x.bedTime || !r.bedTime));
  }

  // ---------- 狙い ----------
  function setWeekTarget(weekStart, target) {
    const d = get();
    d.weekTargets = d.weekTargets.filter(t => t.weekStart !== weekStart);
    if (target) d.weekTargets.push({ weekStart, target });
    save();
  }
  function setDayTarget(date, target) {
    const d = get();
    d.dayTargets = d.dayTargets.filter(t => t.date !== date);
    if (target) d.dayTargets.push({ date, target });
    save();
  }
  // その日の狙い。日の設定が週の設定より優先。どちらもなければ null
  function targetOf(date) {
    const d = get();
    const day = d.dayTargets.find(t => t.date === date);
    if (day) return { target: day.target, from: 'day' };
    const wk = d.weekTargets.find(t => t.weekStart === mondayOf(date));
    if (wk) return { target: wk.target, from: 'week' };
    return null;
  }

  // ---------- 週の計画 ----------
  const weekPlan = weekStart => get().weekPlans.find(p => p.weekStart === weekStart) || null;
  function setWeekPlan(weekStart, plan) {
    const d = get(), p = cleanWeekPlan({ ...plan, weekStart });
    d.weekPlans = d.weekPlans.filter(x => x.weekStart !== weekStart);
    if (p) d.weekPlans.push(p);
    save();
  }
  // その日に見せる計画(一覧にあるフィールドと、その夜のメモ)。どちらもなければ null
  function dayPlan(date) {
    const p = weekPlan(mondayOf(date));
    if (!p) return null;
    const field = fieldOf(p.field), note = p.notes[date] || '';
    return field || note ? { field, note } : null;
  }

  function setSetting(k, v) { get().settings[k] = v; save(); }

  // ---------- 手入力のイベント ----------
  function upsertEvent(e) { const d = get(); d.events = d.events.filter(x => x.id !== e.id); d.events.push(e); save(); }
  function removeEvent(id) { const d = get(); d.events = d.events.filter(x => x.id !== id); save(); }

  // ---------- 書き出し・読み込み ----------
  // 書き出しの文字列を作るだけ(「最後の書き出し」は変えない)。ファイルを渡せたあとに markExported(at) を呼ぶ
  function exportJson(at = nowIso()) {
    const d = get();
    return JSON.stringify({ app: 'sleep-type-tool', exportedAt: at, ...d, lastExportAt: at }, null, 2);
  }
  function markExported(at = nowIso()) { const d = get(); d.lastExportAt = at; save(); }
  function exportCsv() {
    const esc = v => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [RECORD_COLUMNS.join(',')].concat(records().map(r => RECORD_COLUMNS.map(c => esc(r[c])).join(',')));
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  function parseCsv(text) {
    text = text.replace(/^﻿/, '');
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    const head = rows.shift() || [];
    return rows.filter(r => r.some(c => c !== '')).map(r => Object.fromEntries(head.map((h, i) => [h.trim(), r[i]])));
  }

  // 読み込み。mode: 'replace' 上書き / 'append' 追加(重複は除外)
  // 戻り値: { added, skipped, invalid }
  function importText(text, fileName, mode) {
    // 端末の保存領域(localStorage は5MB前後)に入らない大きさは、読む前に断る
    if (text.length > IMPORT_MAX_CHARS) throw new Error('ファイルが大きすぎます(このアプリで書き出したファイルか確認してください)');
    let incoming;
    const isJson = /\.json$/i.test(fileName) || /^\s*\{/.test(text);
    if (isJson) {
      let raw;
      try { raw = JSON.parse(text); } catch (e) { throw new Error('JSONの形式が正しくありません(ファイルが壊れているか、このアプリで書き出したファイルではないようです)'); }
      if (!raw || !Array.isArray(raw.records)) throw new Error('このアプリのJSONではないようです');
      incoming = { rawCount: raw.records.length, ...migrate(raw), hasSettings: !!raw.settings };
    } else {
      const rows = parseCsv(text);
      if (!rows.length || !('date' in rows[0])) throw new Error('CSVの1行目に列名(date など)がありません');
      incoming = { rawCount: rows.length, records: rows.map(row => { const rec = normalizeRecord(row); if (rec && !isSafeId(row.id)) rec._noId = true; return rec; }).filter(Boolean), weekTargets: [], dayTargets: [], hasSettings: false };
    }
    const invalid = incoming.rawCount - incoming.records.length;
    const d = get();
    // 保存できなかったとき(容量不足)は、読み込む前の状態に戻す
    const before = JSON.stringify(d);
    const commit = () => {
      try { save(); } catch (e) { db = migrate(JSON.parse(before)); throw new Error('端末の保存領域が足りず、読み込めませんでした'); }
    };
    if (mode === 'replace') {
      // ファイルの中に同じ記録(idが同じ、または中身が全部同じ)が2つ以上あるときは、最初の1件だけ読み込む(追加読み込みと同じ判定。日付+就寝時刻だけが同じ別の記録は、分割睡眠として残す)
      const kept = [];
      for (const r of incoming.records) if (!kept.some(x => isSameRecord(x, r))) kept.push(r);
      for (const r of kept) delete r._noId;
      const dups = incoming.records.length - kept.length;
      d.records = kept;
      if (isJson) { d.weekTargets = incoming.weekTargets; d.dayTargets = incoming.dayTargets; d.weekPlans = incoming.weekPlans; d.events = incoming.events; if (incoming.hasSettings) d.settings = incoming.settings; }
      commit();
      return { added: kept.length, skipped: dups, invalid };
    }
    let added = 0, skipped = 0;
    for (const r of incoming.records) {
      const dup = d.records.some(x => isSameRecord(x, r));
      delete r._noId;
      if (dup) skipped++; else { d.records.push(r); added++; }
    }
    for (const t of incoming.weekTargets) if (!d.weekTargets.some(x => x.weekStart === t.weekStart)) d.weekTargets.push(t);
    for (const t of incoming.dayTargets) if (!d.dayTargets.some(x => x.date === t.date)) d.dayTargets.push(t);
    for (const p of incoming.weekPlans || []) if (!d.weekPlans.some(x => x.weekStart === p.weekStart)) d.weekPlans.push(p);
    for (const e of incoming.events || []) if (!d.events.some(x => x.id === e.id)) d.events.push(e);
    commit();
    return { added, skipped, invalid };
  }

  function clearAll() { const s = get().settings; db = empty(); db.settings = s; saveBlocked = false; save(); brokenKeys().forEach(k => { try { localStorage.removeItem(k); } catch (e) { /* 何もしない */ } }); }

  return { load, get, records, upsertRecord, setExcluded, deleteRecord, findDuplicate, findSameDateUnsure, newId, setWeekTarget, setDayTarget, targetOf, weekPlan, setWeekPlan, dayPlan,
    setSetting, upsertEvent, removeEvent, exportJson, exportCsv, markExported, importText, clearAll, normalizeRecord, recovery, brokenText, removeBroken };
})();
