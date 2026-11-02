// 平均・ばらつき・狙いの提案の計算
'use strict';

const KINDS = ['uto', 'suya', 'gus'];
const PCT_KEY = { uto: 'utoPct', suya: 'suyaPct', gus: 'gusPct' };
const TYPE_LABEL = { none: 'とくちょうなし', uto: 'うとうと', suya: 'すやすや', gus: 'ぐっすり', '': '未記録' };
const TARGET_LABEL = { uto: 'うとうと', suya: 'すやすや', gus: 'ぐっすり', none: '指定なし' };
const RANGE_N = 30;
// 推定タイプで「平均に近い」とみなす差(ポイント)。根拠のない仮の値
const NEAR_AVG_PT = 5;
// 傾向:狙うタイプが出た夜の割合(全期間)がこれ以上なら「普段どおりで十分」と案内する(%)。仮の値
const USUAL_RATE_PCT = 40;
// 傾向を案内に使う最低の件数(タイプのわかる記録)。これ未満では従来の案内にする。仮の値
const TREND_MIN_N = 10;
// 傾向の期間。件数(null = 全期間)
const TREND_PERIODS = { r30: 30, r100: 100, all: null };
// 狙い週の窓の見込み:B「反対側を意識」で、これからの夜の反対側の割合を普段の平均から何ポイント寄せるとみなすか。仮の値
const PREP_SHIFT_PT = 10;
// 狙い週時点の見込み平均で、狙うタイプが全期間の平均よりこれだけ(ポイント)低ければ、普段どおりでも狙い週に目立ちやすいとみなす。仮の値
const PROJ_USUAL_GAP_PT = 5;
// 期間の比較で「差が大きい」と印を付ける差(ポイント)。直近30回と比べる。仮の値
const COMPARE_DIFF_PT = 5;
// 怪しい記録の目安:睡眠時間がこれ(分)未満なのにぐっすり。仮の値
const SUSPECT_SLEEP_MIN = 120;

const Calc = (() => {
  // 基準日(含む)までの記録から、集計対象を選ぶ
  // range: 'count' = 新しい順に30件(アプリの平均の基準) / 'days' = 基準日を含む過去30日(統計画面の参考表示だけ)
  // before: 指定した記録より前だけ(その夜の推定タイプ用)
  // 分割睡眠で1日に複数件あると、30日と30回で対象が変わる
  function pick(all, refDate, range, opts = {}) {
    let rs = all.filter(r => r.date <= refDate);
    if (opts.before) {
      const k = sleepOrderKey(opts.before);
      rs = rs.filter(r => r.id !== opts.before.id && sleepOrderKey(r) < k);
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

  // ---------- 自分の傾向 ----------
  // 記録の件数から、数字の確からしさの目安:30回未満=参考値、30〜99回=目安、100回以上=安定
  const reliability = n => n < 30 ? '参考値' : n < 100 ? '目安' : '安定';

  // 記録の並び(古い順)から:タイプ別に何%の夜に出たか(回数も)と、3つの割合の平均・ばらつき
  // タイプが未記録の記録は、出やすさの数からだけ除く(割合の平均には入れる)
  function tendency(rs) {
    const counts = { none: 0, uto: 0, suya: 0, gus: 0 };
    for (const r of rs) if (r.type in counts) counts[r.type]++;
    const typed = counts.none + counts.uto + counts.suya + counts.gus;
    const rate = {};
    for (const k in counts) rate[k] = typed ? counts[k] / typed * 100 : null;
    return { n: rs.length, typed, untyped: rs.length - typed, counts, rate, stats: stats(rs), level: reliability(typed) };
  }

  // 基準日(含む)までの記録の傾向。period: 'r30' | 'r100' | 'all'
  // 「傾向の集計に含めない」記録(集計外)は、直近100回・全期間では数えない(直近100回は集計外を除いたあとの100件)。
  // 直近30回はゲームの平均に近づけるため、集計外も含める(ゲーム側ではこうした記録も平均に入る)
  function tendencyAt(refDate, period = 'all') {
    const all = Store.records().filter(r => r.date <= refDate);
    const applies = period !== 'r30';
    const rs = applies ? all.filter(r => !r.excluded) : all;
    const n = TREND_PERIODS[period];
    return { ...tendency(n ? rs.slice(-n) : rs), excludedCount: all.filter(r => r.excluded).length, excludeApplied: applies };
  }

  // 怪しい記録:睡眠時間が SUSPECT_SLEEP_MIN 分未満なのに、ぐっすり(表示タイプ、または割合の半分以上)。集計外にしたものは除く。新しい順
  const suspicious = () => Store.records()
    .filter(r => !r.excluded && r.sleepMin != null && r.sleepMin < SUSPECT_SLEEP_MIN && (r.type === 'gus' || r.gusPct >= 50))
    .reverse();

  // 割合 rec を平均 prior と比べたときのタイプ:平均より一番多く出たもの。差が NEAR_AVG_PT 未満なら「とくちょうなし」
  function classify(rec, prior) {
    let best = null, bestDiff = -Infinity;
    const diffs = {};
    for (const k of KINDS) { diffs[k] = rec[PCT_KEY[k]] - prior[k].mean; if (diffs[k] > bestDiff) { bestDiff = diffs[k]; best = k; } }
    return { type: bestDiff < NEAR_AVG_PT ? 'none' : best, diffs };
  }

  // その夜の推定タイプ:その夜より前の平均と比べる
  function estimateType(rec, range = 'count') {
    const prior = stats(pick(Store.records(), rec.date, range, { before: rec }));
    if (!prior.n) return null;
    return { ...classify(rec, prior), prior };
  }

  // 今夜の睡眠タイプ予報(推定)。ゲームの基準(直近30回の平均)と、普段の寝方(直近100回の平均。集計外を除き、100件に満たなければ全期間)を比べ、
  // 普段の平均が基準を一番上回るタイプを「普通に寝ると出やすい」とする。差が NEAR_AVG_PT 未満なら「とくちょうなし」(classify と同じ規則)
  function likelyTonight(date) {
    const base = tendencyAt(date, 'r30').stats, us = tendencyAt(date, 'r100'), usual = us.stats;
    if (!base.n || !usual.n) return { n: usual.n, enough: false };
    const c = classify({ utoPct: usual.uto.mean, suyaPct: usual.suya.mean, gusPct: usual.gus.mean }, base);
    const top = KINDS.reduce((a, k) => c.diffs[k] > c.diffs[a] ? k : a, KINDS[0]);
    return { n: usual.n, level: reliability(us.typed), enough: usual.n >= TREND_MIN_N, partial: usual.n < 100,
      type: c.type, top, diffs: c.diffs, base, usual };
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

  // 1日(1夜)あたりの記録の件数。分割睡眠の頻度(直近60日の、記録のある日1日あたりの件数)から見積もる
  function perDayAt(date) {
    const from = addDays(date, -59);
    const rs = Store.records().filter(r => r.date >= from && r.date <= date);
    const days = new Set(rs.map(r => r.date)).size;
    return rs.length >= 10 && days ? rs.length / days : 1;
  }
  // 直近30回が何日ぶんにあたるか
  const windowDays = date => Math.max(1, Math.ceil(RANGE_N / perDayAt(date)));

  // ---------- 狙い週の窓(推定) ----------
  // ゲームが狙い週(開始日 S)に見る平均は、S の前日までの直近30回(推定)。
  // 今日(today)から S までの夜はまだ記録がないので「これから入る夜」とし、その分だけ今の記録の古いほうが窓から抜ける。
  // 集計外の記録も窓に含める(直近30回はゲームの平均に近づけるため)
  function windowAt(S, today) {
    const all = Store.records().filter(r => r.date < S && r.date <= today);
    const cur = pick(all, today, 'count');
    const perDay = perDayAt(today);
    // これからの夜:今日の夜がまだ記録されていなければ今日から、記録済みなら明日から、S の前日まで
    const futureFrom = all.some(r => r.date === today) ? addDays(today, 1) : today;
    const nights = Math.max(0, daysBetween(futureFrom, S));
    const future = Math.min(RANGE_N, Math.round(nights * perDay));
    const keep = RANGE_N - future;
    const stay = keep > 0 ? all.slice(-keep) : [];
    const staySet = new Set(stay);
    const drop = cur.filter(r => !staySet.has(r));
    // 窓の期間:残る記録の最初の日(すべて入れ替わるなら、これからの夜の30件ぶんの始まり)〜S の前日
    const from = stay.length ? stay[0].date : addDays(S, -Math.max(1, Math.ceil(future / perDay)));
    return { S, today, cur, stay, drop, nights, future, perDay, from, to: addDays(S, -1) };
  }

  // これからの夜を埋める割合。A=普段どおり(全期間の平均)/ B=反対側を意識(反対側に PREP_SHIFT_PT 寄せる)
  function fillPct(today, mode, aim) {
    const base = tendencyAt(today, 'all').stats;
    const v = {};
    for (const k of KINDS) v[k] = base.n ? base[k].mean : 100 / 3;
    if (mode === 'B' && aim) {
      const c = counterOf(aim, averageAt(today, 'count')).k;
      const move = Math.min(PREP_SHIFT_PT, v[aim], 100 - v[c]);
      v[aim] -= move; v[c] += move;
    }
    return v;
  }

  // 狙い週時点の30回平均の見込み。stats と同じ形({ n, uto: { mean }, ... })に、real(残る実記録)・future(これからの夜)を付ける
  function projectAverage(S, mode = 'A', aim = null, today = tonightYmd()) {
    const w = windowAt(S, today), fill = fillPct(today, mode, aim);
    const n = w.stay.length + w.future;
    const out = { n, real: w.stay.length, future: w.future, mode, isReference: n < RANGE_N };
    for (const k of KINDS) {
      out[k] = n ? { mean: (w.stay.reduce((a, r) => a + r[PCT_KEY[k]], 0) + w.future * fill[k]) / n } : null;
    }
    if (mode === 'B' && aim) out.counter = counterOf(aim, averageAt(today, 'count')).k;
    return out;
  }

  // 抜ける記録だけで平均がどれだけ動くか(タイプ別、ポイント)。残る記録の平均 − 今の直近30回の平均。
  // 全部入れ替わる・何も抜けないときは null
  function abandonImpact(S, today = tonightYmd()) {
    const w = windowAt(S, today);
    if (!w.drop.length || !w.stay.length) return null;
    const a = stats(w.cur), b = stats(w.stay), out = {};
    for (const k of KINDS) out[k] = b[k].mean - a[k].mean;
    return out;
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
        // 平均は「狙い週の直前30回」の見込み(これからの夜は普段どおりとみなす)で考える(推定)
        const proj = projectAverage(x.start, 'A', k, date);
        const ppct = proj.n ? proj[k].mean.toFixed(1) + '%' : '—';
        const ref = tendencyAt(date, 'all');
        const gap = proj.n && ref.stats.n ? ref.stats[k].mean - proj[k].mean : null;
        // 全期間の記録で、狙うタイプが普段から出やすいなら、反対側を狙わず普段どおりで十分(推定)
        const tr = ref;
        if (gap != null && proj.real > 0 && ref.stats.n >= TREND_MIN_N && gap >= PROJ_USUAL_GAP_PT) {
          plan = { kind: 'usual', type: null, aim: k, next, proj,
            title: '普段どおりで十分です',
            reason: `狙い週(${fmtMd(x.start)}〜)の直前30回の見込みでは、${TYPE_LABEL[k]}の平均は${ppct}で、あなたの普段(全期間 ${ref.stats[k].mean.toFixed(1)}%)より${gap.toFixed(1)}ポイント低くなりそうです。普段どおりに寝れば、狙う週に「平均より多い」になりやすい見込みです(推定)。` };
        } else if (tr.typed >= TREND_MIN_N && tr.rate[k] >= USUAL_RATE_PCT) {
          plan = { kind: 'usual', type: null, aim: k, next, proj,
            title: '普段どおりで十分です',
            reason: `あなたの記録では、${TYPE_LABEL[k]}が出た夜は全期間で${tr.rate[k].toFixed(0)}%(${tr.counts[k]}/${tr.typed}回・${tr.level})。普段から出やすいので、前の週に反対側を狙わなくても、狙う週に出る見込みがあります(記録から数えた目安・推定)。` };
        } else {
        const c = counterOf(k, avg);
        plan = { kind: 'prep', type: c.k, aim: k, next, proj,
          title: `${TYPE_LABEL[c.k]}を意識して寝る`,
          reason: `狙い週(${fmtMd(x.start)}〜)の直前30回の見込みで、${TYPE_LABEL[k]}の平均 ${ppct}(今日の直近30回は ${pct(k)})→ 下げたい。狙う週の前に${TYPE_LABEL[k]}を少なめにしておくと、狙う週に「平均より多い」になりやすい(推定)。` + (c.why ? `${TYPE_LABEL[c.k]}を選んだ理由:${c.why}。` : '') };
        }
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

  return { pick, stats, averageAt, reliability, tendency, tendencyAt, suspicious, estimateType, planFor, windowDays, perDayAt, upcomingTargets,
    windowAt, projectAverage, abandonImpact, likelyTonight, missingDays, spanMin, fmtMd };
})();
