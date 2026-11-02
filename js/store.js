// データの保存・読み込み(localStorage)
// 項目名はそのままデータベースの列名にできるよう、すべて英数字のキャメルケースにしている
'use strict';

const SCHEMA_VERSION = 1;
const STORAGE_KEY = 'sleep-type-tool';

// 睡眠記録の列(CSVの列順もこれ)
// 分割睡眠で同じ日付に複数件ありうる。同じ記録かどうかは 日付+就寝時刻 で判定する
const RECORD_COLUMNS = ['id', 'date', 'bedTime', 'wakeTime', 'sleepMin', 'utoPct', 'suyaPct', 'gusPct',
  'autoField', 'type', 'source', 'memo', 'createdAt', 'updatedAt', 'excluded'];
// excluded:「自分の傾向」の集計から外す(嘘寝など)。任意の項目で、無い記録(古いデータ・古いCSV)は false

const DEFAULT_SETTINGS = {
  backupRemindDays: 30,     // 最後の書き出しから何日でお知らせするか
  theme: 'auto',            // 'auto' / 'light' / 'dark'
};

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
// 「夜」の日付の区切り。この時刻より前(早朝)は前日の夜として扱う。ホームの「今夜」と入力の初期日付で共通
const NIGHT_START_HOUR = 5;
const tonightYmd = (now = new Date()) => now.getHours() < NIGHT_START_HOUR ? addDays(ymd(now), -1) : ymd(now);
const hmToMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const minToHm = n => `${Math.floor(n / 60)}:${pad2(n % 60)}`;
const nowIso = () => new Date().toISOString();

const Store = (() => {
  let db = null;

  function empty() {
    // events:利用者が手で追加・修正・非表示にした公式イベント(events.json と id で合わせ、こちらが優先)
    return { schemaVersion: SCHEMA_VERSION, records: [], weekTargets: [], dayTargets: [], events: [], settings: { ...DEFAULT_SETTINGS }, lastExportAt: null };
  }

  // 古い版のデータを今の版にそろえる(版が上がったらここに変換を足す)
  function migrate(d) {
    const out = empty();
    if (!d || typeof d !== 'object') return out;
    out.records = Array.isArray(d.records) ? d.records.map(normalizeRecord).filter(Boolean) : [];
    out.weekTargets = Array.isArray(d.weekTargets) ? d.weekTargets.filter(t => isYmd(t.weekStart) && TARGETS.includes(t.target)) : [];
    out.dayTargets = Array.isArray(d.dayTargets) ? d.dayTargets.filter(t => isYmd(t.date) && TARGETS.includes(t.target)) : [];
    out.events = Array.isArray(d.events) ? d.events.filter(e => e && e.id && (e.hidden || e.title)) : [];
    out.settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
    delete out.settings.includeNaps; // 試作時の設定(分割睡眠を昼寝と誤解していた)。今は使わない
    delete out.settings.defaultRange; // 平均は直近30回に統一したので、30日/30回の既定表示の設定は使わない
    out.lastExportAt = d.lastExportAt || null;
    return out;
  }

  const TARGETS = ['uto', 'suya', 'gus', 'none'];
  const TYPES = ['none', 'uto', 'suya', 'gus', ''];

  // 記録1件を正しい形にそろえる。値がおかしいもの(実在しない日付、範囲外の時刻、
  // 整数でない割合、合計が100でない割合、0以下の睡眠時間)は null を返して取り込まない
  function normalizeRecord(r) {
    if (!r) return null;
    const date = toYmd(r.date);
    if (!date) return null;
    const blank = v => v === '' || v === null || v === undefined;
    // 空なら null、整数でなければ NaN(=不正)
    const int = v => blank(v) ? null : (Number.isInteger(Number(v)) ? Number(v) : NaN);
    const time = v => blank(v) ? '' : (isHm(String(v).trim()) ? String(v).trim().padStart(5, '0') : null);
    const bedTime = time(r.bedTime), wakeTime = time(r.wakeTime), sleepMin = int(r.sleepMin);
    if (bedTime === null || wakeTime === null) return null;
    if (Number.isNaN(sleepMin) || (sleepMin !== null && (sleepMin <= 0 || sleepMin >= 1440))) return null;
    const rec = {
      id: r.id ? String(r.id) : newId(),
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
      memo: r.memo ? String(r.memo) : '',
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

  function load() {
    try { db = migrate(JSON.parse(localStorage.getItem(STORAGE_KEY))); }
    catch (e) { db = empty(); }
    return db;
  }
  function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(db)); }
  const get = () => db || load();

  // 日付→就寝時刻の順に並べる
  const sortKey = r => r.date + ' ' + (r.bedTime || '99:99');
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

  function setSetting(k, v) { get().settings[k] = v; save(); }

  // ---------- 手入力のイベント ----------
  function upsertEvent(e) { const d = get(); d.events = d.events.filter(x => x.id !== e.id); d.events.push(e); save(); }
  function removeEvent(id) { const d = get(); d.events = d.events.filter(x => x.id !== id); save(); }

  // ---------- 書き出し・読み込み ----------
  function exportJson() {
    const d = get();
    d.lastExportAt = nowIso(); save();
    return JSON.stringify({ app: 'sleep-type-tool', exportedAt: d.lastExportAt, ...d }, null, 2);
  }
  function exportCsv() {
    const d = get();
    d.lastExportAt = nowIso(); save();
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
      incoming = { rawCount: rows.length, records: rows.map(normalizeRecord).filter(Boolean), weekTargets: [], dayTargets: [], hasSettings: false };
    }
    const invalid = incoming.rawCount - incoming.records.length;
    const d = get();
    if (mode === 'replace') {
      d.records = incoming.records;
      if (isJson) { d.weekTargets = incoming.weekTargets; d.dayTargets = incoming.dayTargets; d.events = incoming.events; if (incoming.hasSettings) d.settings = incoming.settings; }
      save();
      return { added: incoming.records.length, skipped: 0, invalid };
    }
    let added = 0, skipped = 0;
    for (const r of incoming.records) {
      const dup = d.records.some(x => x.id === r.id || sameSleep(x, r));
      if (dup) skipped++; else { d.records.push(r); added++; }
    }
    for (const t of incoming.weekTargets) if (!d.weekTargets.some(x => x.weekStart === t.weekStart)) d.weekTargets.push(t);
    for (const t of incoming.dayTargets) if (!d.dayTargets.some(x => x.date === t.date)) d.dayTargets.push(t);
    for (const e of incoming.events || []) if (!d.events.some(x => x.id === e.id)) d.events.push(e);
    save();
    return { added, skipped, invalid };
  }

  function clearAll() { const s = get().settings; db = empty(); db.settings = s; save(); }

  return { load, get, records, upsertRecord, setExcluded, deleteRecord, findDuplicate, findSameDateUnsure, newId, setWeekTarget, setDayTarget, targetOf,
    setSetting, upsertEvent, removeEvent, exportJson, exportCsv, importText, clearAll, normalizeRecord };
})();
