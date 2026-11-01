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
  // range: 'days' = 基準日を含む過去30日 / 'count' = 新しい順に30件
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
  function estimateType(rec, range) {
    const prior = stats(pick(Store.records(), rec.date, range, { before: rec }));
    if (!prior.n) return null;
    let best = null, bestDiff = -Infinity;
    const diffs = {};
    for (const k of KINDS) { diffs[k] = rec[PCT_KEY[k]] - prior[k].mean; if (diffs[k] > bestDiff) { bestDiff = diffs[k]; best = k; } }
    return { type: bestDiff < NEAR_AVG_PT ? 'none' : best, diffs, prior };
  }

  // ホームの「今夜の狙い」。date の夜(就寝日=date)について
  function todayAdvice(date) {
    const range = Store.get().settings.defaultRange;
    const avg = averageAt(date, range);
    const rangeLabel = range === 'days' ? '直近30日' : '直近30回';
    const pct = k => avg[k] ? avg[k].mean.toFixed(1) + '%' : '—';
    const t = Store.targetOf(date);

    if (t && t.target !== 'none') {
      const k = t.target;
      return {
        kind: 'target', type: k,
        title: `今夜は「${TYPE_LABEL[k]}」狙い`,
        reason: avg.n
          ? `${TYPE_LABEL[k]}の${rangeLabel}平均は${pct(k)}。その夜の割合が平均より多く出ると${TYPE_LABEL[k]}になりやすい(推定)ので、今夜は${TYPE_LABEL[k]}多めを目指しましょう。`
          : `まだ記録がないため平均は出せません。今夜は${TYPE_LABEL[k]}多めを目指しましょう。`,
        from: t.from,
      };
    }

    // 7日以内の狙いをすべて見る。一番近い狙いに向けて、そのタイプを少なめにして平均を下げておく(要件F5)
    const upcoming = [];
    for (let i = 1; i <= 7; i++) {
      const d = addDays(date, i);
      const u = Store.targetOf(d);
      if (u && u.target !== 'none') upcoming.push({ d, i, k: u.target });
    }
    if (upcoming.length) {
      const when = x => mondayOf(x.d) !== mondayOf(date) ? `来週の${fmtMd(x.d)}` : `${x.i}日後(${fmtMd(x.d)})`;
      const near = upcoming[0], k = near.k;
      const other = upcoming.find(x => x.k !== k);
      return {
        kind: 'prep', type: k,
        title: `今夜は「${TYPE_LABEL[k]}」を少なめに`,
        reason: `${when(near)}から${TYPE_LABEL[k]}狙い。それまでは${TYPE_LABEL[k]}を少なめにして、${TYPE_LABEL[k]}の平均(今は${pct(k)})を下げておきましょう。平均が低いほど、狙う夜に「平均より多い」になりやすい(推定)。`
          + (other ? `(${when(other)}は${TYPE_LABEL[other.k]}狙いもあります)` : ''),
      };
    }

    // 狙い未設定:平均が一番低いタイプをおすすめ(簡易ルール)
    if (!avg.n) return { kind: 'empty', type: null, title: '記録を入れると今夜の狙いが出ます', reason: 'まずは最近の睡眠を入力するか、スクショをまとめて取り込んでください。' };
    let low = KINDS[0];
    for (const k of KINDS) if (avg[k].mean < avg[low].mean) low = k;
    return {
      kind: 'suggest', type: low,
      title: `おすすめは「${TYPE_LABEL[low]}」`,
      reason: `狙いが未設定のため簡易ルールでおすすめ:${rangeLabel}平均が一番低いのは${TYPE_LABEL[low]}(${pct(low)})。平均が低いタイプほど、その夜に少し多く出るだけで「平均より多い」になりやすい(推定)。`,
    };
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

  return { pick, stats, averageAt, estimateType, todayAdvice, missingDays, spanMin, fmtMd };
})();
