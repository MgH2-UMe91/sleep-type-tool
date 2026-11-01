// 公式イベントの表示用データ
// events.json(リポジトリ直下。別の仕組みが公式のお知らせから作る)と、利用者が手で追加・修正したもの(端末内)を id で合わせる。
// 手で入れたものが優先。events.json がない・読めないときは何もせず、手で入れたものだけを使う。
// 公式の本文・画像は扱わない(タイトル・期間・リンクだけ)。
'use strict';

const EVENTS_CACHE_KEY = 'sleep-type-tool-events-cache'; // 最後に読めた events.json(オフラインでも出せるように)
// ゲームの日付は午前4時に切り替わる(公式の記載)。イベントの時刻は日本時間なので、
// 日本時間から4時間引いた日付を「その日」とする(UTC+9-4 = +5時間)
const GAME_DAY_OFFSET_MS = 5 * 3600 * 1000;

const Events = (() => {
  let remote = [];
  try { const c = JSON.parse(localStorage.getItem(EVENTS_CACHE_KEY)); if (c && Array.isArray(c.events)) remote = c.events.map(clean).filter(Boolean); } catch (e) { /* 読めなければ空 */ }

  // ISO日時 → ゲーム上の日付(YYYY-MM-DD)。null や不正は null
  function gameDate(iso) {
    if (!iso) return null;
    const t = Date.parse(iso);
    return isNaN(t) ? null : new Date(t + GAME_DAY_OFFSET_MS).toISOString().slice(0, 10);
  }
  // ゲーム上の日付 → その日の始まり・終わりの日時(手入力のイベント用)
  const dayStartIso = d => `${d}T04:00:00+09:00`;
  const dayEndIso = d => `${addDays(d, 1)}T03:59:00+09:00`;

  // 1件をそろえる。id とタイトルがなければ捨てる
  function clean(e) {
    if (!e || !e.id || !e.title) return null;
    return {
      id: String(e.id), title: String(e.title), category: e.category ? String(e.category) : '',
      start: e.start || null, end: e.end || null,
      url: /^https?:\/\//.test(e.url || '') ? e.url : '',
      typeFree: !!e.typeFree,
      boostTypes: Array.isArray(e.boostTypes) ? e.boostTypes.filter(k => KINDS.includes(k)) : [],
    };
  }

  // events.json を読む。変わっていれば true
  async function load() {
    try {
      const res = await fetch('events.json', { cache: 'no-cache' });
      if (!res.ok) return false;
      const data = await res.json();
      if (!data || !Array.isArray(data.events)) return false;
      const list = data.events.map(clean).filter(Boolean);
      const changed = JSON.stringify(list) !== JSON.stringify(remote);
      remote = list;
      try { localStorage.setItem(EVENTS_CACHE_KEY, JSON.stringify({ updatedAt: data.updatedAt || null, events: list })); } catch (e) { /* 容量不足などは無視 */ }
      return changed;
    } catch (e) { return false; } // 配信前・オフライン・形式違いは静かに無視
  }

  // 手入力(Store の events)と合わせた一覧。hidden のものは除く(all=true なら含める)
  function list(all = false) {
    const manual = Store.get().events || [];
    const byId = new Map(remote.map(e => [e.id, { ...e, source: 'official' }]));
    for (const m of manual) {
      const base = byId.get(m.id);
      // 公式のものに「非表示」の印だけを付けた場合は、内容は公式のまま
      const onlyHidden = Object.keys(m).every(k => k === 'id' || k === 'hidden');
      byId.set(m.id, { ...(base || {}), ...m, source: base ? (onlyHidden ? 'official' : 'edited') : 'manual' });
    }
    return [...byId.values()].filter(e => all || !e.hidden).map(e => ({ ...e, from: gameDate(e.start), to: gameDate(e.end) || gameDate(e.start) }))
      .sort((a, b) => (a.from || '9999') < (b.from || '9999') ? -1 : 1);
  }
  const official = id => remote.find(e => e.id === id) || null;

  // 日付 → その日に開催中のイベント
  function byDate() {
    const map = {};
    for (const e of list()) {
      if (!e.from) continue;
      for (let d = e.from, n = 0; d <= e.to && n < 62; d = addDays(d, 1), n++) (map[d] = map[d] || []).push(e);
    }
    return map;
  }
  // 週(月曜始まり)に重なるイベント
  const forWeek = ws => list().filter(e => e.from && e.from <= addDays(ws, 6) && e.to >= ws);

  const periodLabel = e => !e.from ? '期間未定' : e.from === e.to ? `${Calc.fmtMd(e.from)}` : `${Calc.fmtMd(e.from)}〜${Calc.fmtMd(e.to)}`;
  // 長いタイトルを短くする。「タイプ不問」などの大事な語が後ろにあるときは、それを残す
  const shortTitle = (t, n = 12) => {
    if (t.length <= n) return t;
    const m = t.match(/[((][^()()]*不問[^()()]*[))]$/);
    return m && m[0].length < n - 2 ? t.slice(0, n - m[0].length - 1) + '…' + m[0] : t.slice(0, n - 1) + '…';
  };

  return { load, list, official, byDate, forWeek, gameDate, dayStartIso, dayEndIso, periodLabel, shortTitle, clean, setRemoteForTest: l => { remote = l.map(clean).filter(Boolean); } };
})();
