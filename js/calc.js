// 平均・ばらつき・狙いの提案の計算
'use strict';

const KINDS = ['uto', 'suya', 'gus'];
const PCT_KEY = { uto: 'utoPct', suya: 'suyaPct', gus: 'gusPct' };
const TYPE_LABEL = { none: 'とくちょうなし', uto: 'うとうと', suya: 'すやすや', gus: 'ぐっすり', '': '未記録' };
const TARGET_LABEL = { uto: 'うとうと', suya: 'すやすや', gus: 'ぐっすり', none: '指定なし' };
const RANGE_N = 30;
// 推定タイプで「平均に近い」とみなす差(ポイント)。根拠のない仮の値
const NEAR_AVG_PT = 5;

const Calc = (() => {
  // 基準日(含む)までの記録から、集計対象を選ぶ
  // range: 'count' = 新しい順に30件(アプリの平均の基準) / 'days' = 基準日を含む過去30日(統計画面の参考表示だけ)
  // before: 指定した記録より前だけ(その夜の推定タイプ用)
  // 分割睡眠で1日に複数件あると、30日と30回で対象が変わる
  function pick(all, refDate, range, opts = {}) {
    let rs = all.filter(r => r.date <= refDate);
    if (opts.before) {
      const k = opts.before.date + ' ' + (opts.before.bedTime || '99:99');
      rs = rs.filter(r => r.id !== opts.before.id && (r.date + ' ' + (r.bedTime || '99:99')) < k);
    }
    if (range === 'days') { const from = addDays(refDate, -(RANGE_N - 1)); return rs.filter(r => r.date >= from); }
    return rs.slice(-RANGE_N); // all は古い順に並んでいる前提
  }

  // 3つの割合それぞれの 単純平均・睡眠時間重み付き平均・母標準偏差
  function stats(rs) {
    const out = { n: rs.length, isReference: rs.length < RANGE_N };
    const wRs = rs.filter(r => r.sleepMin > 0);
    const wSum = wRs.reduce((a, r) => a + r.sleepMin, 0);
    for (const k of KINDS) {
      const vals = rs.map(r => r[PCT_KEY[k]]);
      if (!vals.length) { out[k] = null; continue; }
      const mean = vals.reduce((a, v) => a + v, 0) / vals.length;
      const sd = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length); // 母標準偏差(n で割る)
      const wMean = wSum > 0 ? wRs.reduce((a, r) => a + r[PCT_KEY[k]] * r.sleepMin, 0) / wSum : null;
      out[k] = { mean, wMean, sd };
    }
    return out;
  }

  const averageAt = (refDate, range, opts) => stats(pick(Store.records(), refDate, range, opts));

  // その夜の推定タイプ:その夜より前の平均と比べ、平均より一番多く出たもの。差が小さければ「とくちょうなし」
  function estimateType(rec, range = 'count') {
    const prior = stats(pick(Store.records(), rec.date, range, { before: rec }));
    if (!prior.n) return null;
    let best = null, bestDiff = -Infinity;
    const diffs = {};
    for (const k of KINDS) { diffs[k] = rec[PCT_KEY[k]] - prior[k].mean; if (diffs[k] > bestDiff) { bestDiff = diffs[k]; best = k; } }
    return { type: bestDiff < NEAR_AVG_PT ? 'none' : best, diffs, prior };
  }

  // ---------- 狙う週に向けたおすすめ ----------
  // 考え方(推定):タイプはその夜の割合が直近30回の平均より目立って多いもの。
  // 狙う週にタイプXを出すには、狙っていない週にXを少なめにして平均を下げておく。効くのは狙い週の直前30回ぶんの夜だけ。

  // 狙うタイプの平均を下げるために、狙っていない週に意識するタイプ
  function counterOf(k, avg) {
    if (k === 'uto') return { k: 'gus', why: '' };
    if (k === 'gus') return { k: 'uto', why: '' };
    // すやすや狙い:うとうと・ぐっすりのうち今の平均が高いほう(普段から出やすく、すやすやの少ない夜を作りやすい)。簡易ルール
    if (!avg.n) return { k: 'gus', why: '記録がないため、ひとまずぐっすり' };
    const c = avg.uto.mean >= avg.gus.mean ? 'uto' : 'gus';
    return { k: c, why: `${TYPE_LABEL[c]}のほうが普段の平均が高く(${avg[c].mean.toFixed(1)}%)、すやすやの少ない夜を作りやすいため(簡易ルール)` };
  }

  // 直近30回が何日ぶんにあたるか。分割睡眠の頻度(直近60日の、記録のある日1日あたりの件数)から見積もる
  function windowDays(date) {
    const from = addDays(date, -59);
    const rs = Store.records().filter(r => r.date >= from && r.date <= date);
    const days = new Set(rs.map(r => r.date)).size;
    const perDay = rs.length >= 10 && days ? rs.length / days : 1;
    return Math.max(1, Math.ceil(RANGE_N / perDay));
  }

  // date より後に始まる狙い(週の狙いと日の上書き)を近い順に
  function upcomingTargets(date) {
    const d = Store.get(), out = [];
    for (const t of d.weekTargets) if (KINDS.includes(t.target) && t.weekStart > date) out.push({ start: t.weekStart, k: t.target, week: true });
    for (const t of d.dayTargets) if (KINDS.includes(t.target) && t.date > date && !out.some(o => o.week && o.start <= t.date && t.date <= addDays(o.start, 6) && o.k === t.target)) out.push({ start: t.date, k: t.target, week: false });
    return out.sort((x, y) => x.start < y.start ? -1 : x.start > y.start ? 1 : 0);
  }

  const startLabel = x => x.week ? `${fmtMd(x.start)}週` : `${fmtMd(x.start)}`;

  // date(就寝日)の週・夜についての計画。ホームと狙い設定で使う
  // kind: 'aim'(狙い期間中) / 'prep'(狙い前:平均を下げる) / 'far'(まだ影響しない) / 'unset'(狙い週が未設定)
  function planFor(date) {
    const avg = averageAt(date, 'count');
    const pct = k => avg.n ? avg[k].mean.toFixed(1) + '%' : '—';
    const ups = upcomingTargets(date);
    const now = Store.targetOf(date);
    let plan;
    if (now && KINDS.includes(now.target)) {
      const k = now.target;
      plan = {
        kind: 'aim', type: k, aim: k,
        next: `${now.from === 'day' ? '今夜' : '今週'} ${TYPE_LABEL[k]}(狙い期間中)`,
        title: `${now.from === 'day' ? '今夜' : '今週'}は${TYPE_LABEL[k]}を狙って寝る`,
        reason: `平均より${TYPE_LABEL[k]}を多めに出すのがねらい(${TYPE_LABEL[k]}の直近30回の平均 ${pct(k)})。`,
      };
    } else if (!ups.length) {
      return { kind: 'unset', type: null, next: '未設定', title: 'まず狙う週を決めてください',
        reason: '狙う週を決めると、それまでの週に意識するタイプをおすすめします。', avg };
    } else {
      const x = ups[0], k = x.k, left = daysBetween(date, x.start), win = windowDays(date);
      const next = `${startLabel(x)} ${TYPE_LABEL[k]}(あと${left}日)`;
      if (left > win) {
        plan = { kind: 'far', type: null, aim: k, next,
          title: '普段どおりでOK',
          reason: `狙いまで${left}日あり、平均に使う直近30回(いまの記録の頻度で約${win}日ぶん)より先なので、まだ影響しない期間です。あと${left - win}日ほどしたら意識を始めましょう。` };
      } else {
        const c = counterOf(k, avg);
        plan = { kind: 'prep', type: c.k, aim: k, next,
          title: `${TYPE_LABEL[c.k]}を意識して寝る`,
          reason: `${TYPE_LABEL[k]}の直近30回の平均 ${pct(k)} → 下げたい。狙う週の前に${TYPE_LABEL[k]}を少なめにしておくと、狙う週に「平均より多い」になりやすい(推定)。` + (c.why ? `${TYPE_LABEL[c.k]}を選んだ理由:${c.why}。` : '') };
      }
    }
    // 次の(別の)狙いを補足で一言
    const after = plan.kind === 'aim' ? ups.find(u => !(u.k === plan.aim && mondayOf(u.start) === mondayOf(date))) : ups[1];
    if (after) plan.more = `その次の狙い:${startLabel(after)} ${TYPE_LABEL[after.k]}`;
    plan.avg = avg;
    return plan;
  }

  const fmtMd = s => { const d = parseYmd(s); return `${d.getMonth() + 1}/${d.getDate()}`; };

  // 未入力の日(記録が1件もない日)。最初の記録の日以降、直近14日まで
  function missingDays(today) {
    const rs = Store.records();
    if (!rs.length) return [];
    const has = new Set(rs.map(r => r.date));
    const first = rs[0].date;
    const out = [];
    for (let i = 14; i >= 1; i--) { const d = addDays(today, -i); if (d >= first && !has.has(d)) out.push(d); }
    return out;
  }

  // 睡眠時間(分)を就寝・起床から計算。日付をまたぐので24時間で折り返す
  function spanMin(bed, wake) {
    if (!isHm(bed) || !isHm(wake)) return null;
    return ((hmToMin(wake) - hmToMin(bed)) % 1440 + 1440) % 1440;
  }

  return { pick, stats, averageAt, estimateType, planFor, windowDays, missingDays, spanMin, fmtMd };
})();
