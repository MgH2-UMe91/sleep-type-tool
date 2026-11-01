// 満月・新月の計算と、その前後の日の印(満月の前後=GSD、新月の前後=NMD)
// 端末の中だけで計算する(外部のサービスは使わない)。
// 計算方法:Jean Meeus『Astronomical Algorithms』第49章「月の位相」。誤差は数分程度で、
// 2026〜2027年の国立天文台「暦要項」の朔・望の時刻と照合済み。日付は日本時間の暦の日付。
// GSD・NMD がゲームの中でどんな意味を持つかは、このアプリでは扱わない(利用者が決めた印)。
'use strict';

const MOON_SPAN_DAYS = 1; // 満月・新月の日の前後何日を印にするか(前後1日=計3日)

const Moon = (() => {
  const rad = d => d * Math.PI / 180;
  const sin = d => Math.sin(rad(d));

  // 位相の瞬間(力学時のユリウス日 JDE)。k は 2000年1月6日の新月を0とする通し番号(整数=新月、+0.5=満月)
  function phaseJde(k) {
    const T = k / 1236.85, T2 = T * T, T3 = T2 * T, T4 = T3 * T;
    let jde = 2451550.09766 + 29.530588861 * k + 0.00015437 * T2 - 0.000000150 * T3 + 0.00000000073 * T4;
    const E = 1 - 0.002516 * T - 0.0000074 * T2;
    const M = 2.5534 + 29.10535670 * k - 0.0000014 * T2 - 0.00000011 * T3;           // 太陽の平均近点角
    const Mp = 201.5643 + 385.81693528 * k + 0.0107582 * T2 + 0.00001238 * T3 - 0.000000058 * T4; // 月の平均近点角
    const F = 160.7108 + 390.67050284 * k - 0.0016118 * T2 - 0.00000227 * T3 + 0.000000011 * T4;  // 月の緯度引数
    const O = 124.7746 - 1.56375588 * k + 0.0020672 * T2 + 0.00000215 * T3;          // 昇交点黄経
    const full = Math.abs(k % 1) > 0.25;
    // 新月と満月で係数が少し違う主な補正項
    const c = full
      ? [-0.40614, 0.17302, 0.01614, 0.01043, 0.00734, -0.00515, 0.00209]
      : [-0.40720, 0.17241, 0.01608, 0.01039, 0.00739, -0.00514, 0.00208];
    jde += c[0] * sin(Mp) + c[1] * E * sin(M) + c[2] * sin(2 * Mp) + c[3] * sin(2 * F)
      + c[4] * E * sin(Mp - M) + c[5] * E * sin(Mp + M) + c[6] * E * E * sin(2 * M)
      - 0.00111 * sin(Mp - 2 * F) - 0.00057 * sin(Mp + 2 * F) + 0.00056 * E * sin(2 * Mp + M)
      - 0.00042 * sin(3 * Mp) + 0.00042 * E * sin(M + 2 * F) + 0.00038 * E * sin(M - 2 * F)
      - 0.00024 * E * sin(2 * Mp - M) - 0.00017 * sin(O) - 0.00007 * sin(Mp + 2 * M)
      + 0.00004 * sin(2 * Mp - 2 * F) + 0.00004 * sin(3 * M) + 0.00003 * sin(Mp + M - 2 * F)
      + 0.00003 * sin(2 * Mp + 2 * F) - 0.00003 * sin(Mp + M + 2 * F) + 0.00003 * sin(Mp - M + 2 * F)
      - 0.00002 * sin(Mp - M - 2 * F) - 0.00002 * sin(3 * Mp + M) + 0.00002 * sin(4 * Mp);
    // すべての位相に共通の追加補正(惑星の影響など)
    const A = [299.77 + 0.107408 * k - 0.009173 * T2, 251.88 + 0.016321 * k, 251.83 + 26.651886 * k, 349.42 + 36.412478 * k,
      84.66 + 18.206239 * k, 141.74 + 53.303771 * k, 207.14 + 2.453732 * k, 154.84 + 7.306860 * k, 34.52 + 27.261239 * k,
      207.19 + 0.121824 * k, 291.34 + 1.844379 * k, 161.72 + 24.198154 * k, 239.56 + 25.513099 * k, 331.55 + 3.592518 * k];
    const W = [0.000325, 0.000165, 0.000164, 0.000126, 0.000110, 0.000062, 0.000060, 0.000056, 0.000047, 0.000042, 0.000040, 0.000037, 0.000035, 0.000023];
    A.forEach((a, i) => { jde += W[i] * sin(a); });
    return jde;
  }

  // 力学時と世界時の差(ΔT)。2020年代は約69秒。日付を決めるには十分な精度
  const DELTA_T_SEC = 69;
  const jdeToMs = jde => (jde - 2440587.5) * 86400000 - DELTA_T_SEC * 1000;
  const JST_MS = 9 * 3600 * 1000;
  const jstYmd = ms => new Date(ms + JST_MS).toISOString().slice(0, 10);
  const jstHm = ms => new Date(ms + JST_MS).toISOString().slice(11, 16);

  // 年ごとの満月・新月の一覧(日本時間)。計算結果は覚えておく
  const cache = {};
  function phasesOfYear(y) {
    if (cache[y]) return cache[y];
    const out = [];
    let k = Math.floor((y - 2000) * 12.3685) - 2;
    for (let i = 0; i < 60; i++, k += 0.5) {
      const ms = jdeToMs(phaseJde(k));
      const date = jstYmd(ms);
      if (date.slice(0, 4) > String(y)) break;
      if (date.slice(0, 4) === String(y)) out.push({ kind: k % 1 === 0 ? 'new' : 'full', date, time: jstHm(ms), ms });
    }
    return (cache[y] = out);
  }

  // 日付 → その日の印。{ mark: 'GSD'|'NMD', phase: 'full'|'new', center: 満月・新月の日, exact: その日そのものか, time }
  function markOf(date) {
    const y = Number(date.slice(0, 4));
    for (const p of [...phasesOfYear(y - 1), ...phasesOfYear(y), ...phasesOfYear(y + 1)]) {
      const diff = daysBetween(p.date, date);
      if (Math.abs(diff) <= MOON_SPAN_DAYS) return { mark: p.kind === 'full' ? 'GSD' : 'NMD', phase: p.kind, center: p.date, exact: diff === 0, time: p.time };
    }
    return null;
  }

  // 期間(両端を含む)に入る GSD・NMD のまとまり。[{ mark, phase, center, time, from, to }]
  function spansBetween(from, to) {
    const out = [];
    for (let y = Number(from.slice(0, 4)) - 1; y <= Number(to.slice(0, 4)) + 1; y++) {
      for (const p of phasesOfYear(y)) {
        const a = addDays(p.date, -MOON_SPAN_DAYS), b = addDays(p.date, MOON_SPAN_DAYS);
        if (b >= from && a <= to) out.push({ mark: p.kind === 'full' ? 'GSD' : 'NMD', phase: p.kind, center: p.date, time: p.time, from: a, to: b });
      }
    }
    return out;
  }

  return { markOf, spansBetween, phasesOfYear };
})();
