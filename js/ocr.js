// スクショ読み取り(ocr-test.html の方式を移植)
// 色の目印で位置を割り出し、割合は数字だけを認識して色帯の比率でチェック、タイプは帯の色で判定する。
// 画像は端末の外へ出さない。Tesseract.js と学習データは vendor/ に同梱
'use strict';

const Ocr = (() => {
  const sat = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b);
  const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

  // 割合バー・タイプ帯の色を分類する
  function colorClass(r, g, b) {
    if (r > 200 && g > 190 && b < 170) return 'uto';                  // 黄
    if (r < 190 && g > 200 && b > 200) return 'suya';                 // 水色
    if (r < 110 && g > 110 && g < 180 && b > 200) return 'gus';       // 青
    if (Math.abs(r - g) < 12 && Math.abs(g - b) < 12 && r > 150 && r < 215) return 'none'; // 灰
    return null;
  }

  function getPixels(img) {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    const W = c.width, H = c.height;
    const px = (x, y) => { const i = (y * W + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
    return { c, W, H, px };
  }

  // 横幅の大半が色付きの行をまとめて返す(バーや見出し帯の候補)
  function wideColoredBands(P, y0, y1) {
    const bands = [];
    for (let y = y0; y < y1; y++) {
      let n = 0;
      // 背景の淡い水色は彩度が40前後あるので、色の濃いバー・見出し(彩度120以上)だけを数える
      for (let x = 0; x < P.W; x += 2) { const p = P.px(x, y); if (sat(...p) > 60) n++; }
      if (n > P.W / 2 * 0.7) {
        const last = bands[bands.length - 1];
        if (last && y === last.b + 1) last.b = y; else bands.push({ a: y, b: y });
      }
    }
    return bands;
  }

  // ---------- 画面の目印を探す ----------
  function locate(P) {
    const { W, H } = P;
    const bands = wideColoredBands(P, Math.round(H * 0.3), Math.round(H * 0.85));
    const thinH = H * 0.012, tallH = H * 0.02;
    // 割合バー: 細い帯。直前に太い見出し帯(詳細データ)がある
    let bar = null, header = null;
    for (let i = 1; i < bands.length; i++) {
      const h = bands[i].b - bands[i].a + 1, hp = bands[i - 1].b - bands[i - 1].a + 1;
      if (h <= thinH && hp >= tallH) { bar = bands[i]; header = bands[i - 1]; break; }
    }
    if (!bar) return null;

    // タイプ帯: 見出し帯より上で、左右(30%,70%)が同じ色、左端(8%)が白
    let pill = null;
    for (let y = header.a - 3; y > H * 0.25; y--) {
      const L = P.px(Math.round(W * 0.3), y), R = P.px(Math.round(W * 0.7), y), E = P.px(Math.round(W * 0.08), y);
      const cl = colorClass(...L), cr = colorClass(...R);
      // 左端は白(色味の変換で少しずれても通るよう、ほぼ白なら可)
      if (cl && cl === cr && luma(...E) > 225 && sat(...E) < 30) {
        if (!pill) pill = { a: y, b: y, cls: cl }; else pill.a = y;
      } else if (pill) break;
    }

    // 日付帯: 上部の青い帯(左寄り)
    let dateBand = null;
    const isBlue = (c) => c[2] > 200 && c[0] < 110 && c[1] > 100 && c[1] < 190;
    for (let y = 0; y < H * 0.25; y++) {
      let n = 0;
      for (let x = Math.round(W * 0.1); x < W * 0.65; x += 2) if (isBlue(P.px(x, y))) n++;
      if (n > (W * 0.55 / 2) * 0.4) { if (!dateBand) dateBand = { a: y, b: y }; else dateBand.b = y; }
      // 文字の行は青が減るので、帯の高さの半分程度(画面高さの2%)までの途切れは帯の続きとみなす
      // (以前は固定の3pxで、大きい元画像では帯が文字の途中で切れていた)
      else if (dateBand && y - dateBand.b > H * 0.02) break;
    }
    if (dateBand) {
      // 帯の右端(帯の外の白を文字と間違えないため)
      const yr = dateBand.a + Math.max(1, Math.round((dateBand.b - dateBand.a) * 0.1));
      dateBand.xr = 0;
      for (let x = 0; x < W; x++) if (isBlue(P.px(x, yr))) dateBand.xr = x;
      // 白文字のある行だけに絞る(文字を十分な大きさに拡大するため)。
      // 帯のふちの白い線(横いっぱいに白)は除き、白のある行が一番長く続く範囲を文字とする
      const isWhite = (c) => luma(...c) > 200 && sat(...c) < 60;
      const x0 = Math.round(W * 0.15), x1 = Math.round(dateBand.xr - W * 0.01);
      let run = null;
      for (let y = dateBand.a; y <= dateBand.b + 1; y++) {
        let n = 0;
        if (y <= dateBand.b) for (let x = x0; x < x1; x++) if (isWhite(P.px(x, y))) n++;
        if (n > 1 && n < (x1 - x0) * 0.5) { if (run) run.b = y; else run = { a: y, b: y }; }
        else if (run) {
          if (dateBand.ta === undefined || run.b - run.a > dateBand.tb - dateBand.ta) { dateBand.ta = run.a; dateBand.tb = run.b; }
          run = null;
        }
      }
    }
    return { bar, header, pill, dateBand };
  }

  // 割合バーの色の長さから比率を測る
  function measureBar(P, bar) {
    const y = Math.round((bar.a + bar.b) / 2);
    const cnt = { uto: 0, suya: 0, gus: 0 };
    for (let x = 0; x < P.W; x++) { const k = colorClass(...P.px(x, y)); if (k in cnt) cnt[k]++; }
    const total = cnt.uto + cnt.suya + cnt.gus;
    if (!total) return null;
    return ['uto', 'suya', 'gus'].map(k => Math.round(cnt[k] / total * 100));
  }

  // ---------- 切り出しと二値化 ----------
  // mode: 'dark' 濃い文字だけ残す / 'nonwhite' 白以外を残す / 'white' 白い文字を残す
  // exact: true なら縮小もして高さを targetH にそろえる(縮尺に依存させない)
  function crop(P, x0, y0, x1, y1, mode, targetH = 60, exact = false) {
    x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0));
    x1 = Math.min(P.W, Math.round(x1)); y1 = Math.min(P.H, Math.round(y1));
    const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
    const scale = exact ? targetH / h : Math.max(1, targetH / h);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(P.c, x0, y0, w, h, 0, 0, c.width, c.height);
    const im = ctx.getImageData(0, 0, c.width, c.height), d = im.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      let ink;
      if (mode === 'dark') ink = luma(r, g, b) < 120 && sat(r, g, b) < 70;
      else if (mode === 'white') ink = luma(r, g, b) > 200 && sat(r, g, b) < 60;
      else ink = luma(r, g, b) < 215;
      const v = ink ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(im, 0, 0);
    // 余白を足す(端の文字の認識が安定する)
    const pad = document.createElement('canvas');
    pad.width = c.width + 40; pad.height = c.height + 40;
    const pc = pad.getContext('2d', { willReadFrequently: true });
    pc.fillStyle = '#fff'; pc.fillRect(0, 0, pad.width, pad.height);
    pc.drawImage(c, 20, 20);
    return pad;
  }

  // 斜体を起こす(上の行ほど左へずらす)
  function deslant(cv, k) {
    const c = document.createElement('canvas');
    c.width = cv.width + Math.round(cv.height * k); c.height = cv.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.setTransform(1, 0, k, 1, 0, 0);
    ctx.drawImage(cv, 0, 0);
    return c;
  }

  // 二値化済み画像を、黒画素のない列で文字ごとに分ける。文字の高さも返す
  function glyphs(cv) {
    const d = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data;
    const ink = (x, y) => d[(y * cv.width + x) * 4] < 128;
    let top = cv.height, bottom = -1;
    const col = [];
    for (let x = 0; x < cv.width; x++) {
      let n = 0;
      for (let y = 0; y < cv.height; y++) if (ink(x, y)) { n++; top = Math.min(top, y); bottom = Math.max(bottom, y); }
      col.push(n);
    }
    const th = bottom - top + 1;
    const runs = [];
    let s = null;
    for (let x = 0; x <= cv.width; x++) {
      if (x < cv.width && col[x] > 0) { if (s === null) s = x; }
      else if (s !== null) { if (x - s >= th * 0.1) runs.push({ a: s, b: x - 1, w: x - s }); s = null; }
    }
    return { runs, th };
  }

  // 横方向の一部を切り出して余白を付ける
  function sliceX(cv, x0, x1, padPx = 20) {
    const w = x1 - x0 + 1;
    const c = document.createElement('canvas');
    c.width = w + padPx * 2; c.height = cv.height;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(cv, x0, 0, w, cv.height, padPx, 0, w, cv.height);
    return c;
  }

  // ---------- 文字認識 ----------
  let workersPromise = null;
  function loadScript(src) {
    return new Promise((ok, ng) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => ng(new Error('読み込み失敗: ' + src)); document.head.append(s); });
  }
  function getWorkers() {
    if (workersPromise) return workersPromise;
    workersPromise = (async () => {
      if (!window.Tesseract) await loadScript('vendor/tesseract.min.js');
      const abs = p => new URL(p, location.href).href;
      // workerBlobURL: false … 文字認識の部品をページと同じ場所から直接読み、オフライン用のキャッシュ(sw.js)から出せるようにする
      const opt = { workerPath: abs('vendor/worker.min.js'), corePath: abs('vendor/core'), langPath: abs('vendor/lang'), workerBlobURL: false };
      const digits = await Tesseract.createWorker('eng', 1, opt);
      await digits.setParameters({ tessedit_char_whitelist: '0123456789%:', tessedit_pageseg_mode: '7' });
      const jpn = await Tesseract.createWorker('jpn', 1, opt);
      await jpn.setParameters({ tessedit_pageseg_mode: '7' });
      return { digits, jpn };
    })();
    workersPromise.catch(() => { workersPromise = null; });
    return workersPromise;
  }
  const ocr = async (worker, canvas) => (await worker.recognize(canvas)).data.text.trim();

  // 読み取り本体。戻り値の値はすべて読めなければ null
  // { date, sleepMin, bedTime, wakeTime, type, rate:[u,s,g], bar:[u,s,g], check, warnings:[], ms }
  async function analyze(img) {
    const t0 = performance.now();
    const P = getPixels(img);
    const loc = locate(P);
    // 実機で原因を調べるための記録(画像サイズ・見つけた帯の位置・切り出し画像・認識した生の文字)
    const debug = { size: `${P.W}×${P.H}`, loc, crops: [] };
    const keep = (label, canvas, raw) => { debug.crops.push({ label, canvas, raw }); return canvas; };
    if (!loc) return { error: '割合バーが見つかりません(睡眠結果の画面のスクショか確認してください)', debug };
    const { digits, jpn } = await getWorkers();
    const { W, H } = P;
    const res = { warnings: [], debug };

    // 割合: 見出し帯とバーの間。3等分して数字だけ読む
    const ry0 = loc.header.b + 2, ry1 = loc.bar.a - 2;
    const thirds = [[0.18, 0.40], [0.50, 0.71], [0.81, 1.0]];
    res.rate = [];
    for (let i = 0; i < 3; i++) {
      const cv = crop(P, W * thirds[i][0], ry0, W * thirds[i][1], ry1, 'dark');
      const t = await ocr(digits, cv);
      keep(['うとうと%', 'すやすや%', 'ぐっすり%'][i], cv, t);
      const m = t.match(/(\d{1,3})/);
      res.rate.push(m && Number(m[1]) <= 100 ? Number(m[1]) : null);
    }
    res.bar = measureBar(P, loc.bar);
    // 1つだけ読めなかった場合は残り2つから補う
    if (res.rate.filter(v => v === null).length === 1) {
      const s = res.rate.reduce((a, v) => a + (v || 0), 0);
      res.rate = res.rate.map(v => v === null ? 100 - s : v);
      res.warnings.push('割合の1つが読めず、残り2つから計算しました');
    }
    // 文字認識の値と色帯の比率が±2%以上ずれたら要確認(しきい値は仮)
    const unread = res.rate.filter(v => v === null).length;
    if (unread >= 2) res.warnings.push(unread === 3 ? '割合が読めません' : '割合が2つ以上読めません');
    else {
      if (res.bar) res.rate.forEach((v, i) => { if (Math.abs(v - res.bar[i]) >= 2) res.rateMismatch = true; });
      if (res.rateMismatch) res.warnings.push(`割合が色帯の比率(${res.bar ? res.bar.join('/') : '—'})と合いません`);
    }
    if (res.rate.every(v => v !== null) && res.rate.reduce((a, v) => a + v, 0) !== 100) res.warnings.push('割合の合計が100になりません');

    // タイプ(帯の色)
    res.type = loc.pill ? loc.pill.cls : null;
    if (!res.type) res.warnings.push('タイプの帯が見つかりません');

    // 睡眠時間・就寝/起床: タイプ帯の上
    if (loc.pill) {
      const top = loc.pill.a - H * 0.11;
      const mid = loc.pill.a - H * 0.045;
      const cvT = crop(P, W * 0.36, top, W * 0.92, mid, 'dark');
      // 就寝と起床: 行全体を切り出し、中ほどの一番広いすき間で左右に分け、
      // それぞれ全角コロン(最初の細い文字)より右だけを数字専用で読む
      const yb1 = loc.pill.a - H * 0.012;
      const cvLine = crop(P, W * 0.36, mid, W * 0.92, yb1, 'nonwhite');
      const { runs, th: lh } = glyphs(cvLine);
      let split = -1, best = 0;
      for (let i = 1; i < runs.length; i++) {
        const gap = runs[i].a - runs[i - 1].b, c = (runs[i].a + runs[i - 1].b) / 2;
        if (c > cvLine.width * 0.3 && c < cvLine.width * 0.75 && gap > best) { best = gap; split = i; }
      }
      const timePart = (rs) => {
        if (!rs.length) return null;
        const k = rs.findIndex(r => r.w < lh * 0.35);
        const t = rs.slice(k + 1);
        return t.length ? sliceX(cvLine, t[0].a, t[t.length - 1].b) : null;
      };
      const cvBed = split > 0 ? timePart(runs.slice(0, split)) : null;
      const cvWake = split > 0 ? timePart(runs.slice(split)) : null;
      const rawSleep = (await ocr(jpn, cvT)).replace(/\s/g, '');
      const rawBed = cvBed ? await ocr(digits, cvBed) : '';
      const rawWake = cvWake ? await ocr(digits, cvWake) : '';
      keep('睡眠時間', cvT, rawSleep);
      keep('就寝・起床の行', cvLine, '');
      if (cvBed) keep('就寝', cvBed, rawBed);
      if (cvWake) keep('起床', cvWake, rawWake);
      const s = rawSleep.match(/(\d{1,2})時間(\d{1,2})分/) || rawSleep.match(/(\d{1,2})\D+(\d{1,2})/);
      res.sleepMin = s && Number(s[2]) < 60 ? Number(s[1]) * 60 + Number(s[2]) : null;
      // 24〜27時台(ゲームの深夜の表し方)も normHm で 0〜3時台にそろえる
      const hhmm = (t) => { const d = t.replace(/\D/g, ''); if (d.length < 3) return null; return normHm(d.slice(-4)); };
      res.bedTime = hhmm(rawBed);
      res.wakeTime = hhmm(rawWake);
      // 整合チェック: 睡眠時間と(起床−就寝)の差が10分以内か
      if (res.sleepMin !== null && res.bedTime && res.wakeTime) {
        const span = ((hmToMin(res.wakeTime) - hmToMin(res.bedTime)) % 1440 + 1440) % 1440;
        res.check = { span, diff: Math.abs(span - res.sleepMin) };
        if (res.check.diff > 10) res.warnings.push(`睡眠時間と就寝〜起床(${minToHm(span)})の差が${res.check.diff}分あります`);
      }
    }
    if (res.sleepMin == null) { res.sleepMin = null; res.warnings.push('睡眠時間が読めません'); }
    if (!res.bedTime || !res.wakeTime) { res.bedTime = res.bedTime || null; res.wakeTime = res.wakeTime || null; res.warnings.push('就寝・起床時刻が読めません'); }

    // 日付: 文字の高さをそろえて斜体を起こし、文字幅で数字(細い)と年・月・日(太い)を分けて数字だけ読む
    const db = loc.dateBand;
    res.date = null;
    if (db && db.ta !== undefined) {
      const th = db.tb - db.ta + 1;
      const cv = deslant(crop(P, W * 0.15, db.ta - th * 0.2, db.xr - W * 0.01, db.tb + th * 0.2, 'white', 56, true), 0.25);
      const { runs, th: gh } = glyphs(cv);
      const groups = [];
      let cur = null;
      for (const r of runs) {
        if (r.w < gh * 0.75) { if (cur) cur.b = r.b; else cur = { a: r.a, b: r.b }; }
        else if (cur) { groups.push(cur); cur = null; }
      }
      if (cur) groups.push(cur);
      keep('日付の行', cv, `数字のかたまり ${groups.length}個`);
      const nums = [];
      for (const [i, g] of groups.slice(0, 3).entries()) {
        const gcv = sliceX(cv, g.a, g.b);
        const t = await ocr(digits, gcv);
        keep(`日付の数字${i + 1}`, gcv, t);
        nums.push(t.replace(/\D/g, ''));
      }
      let m = nums.length === 3 && /^\d{4}$/.test(nums[0]) && nums[1] && nums[2] ? nums : null;
      if (!m) {
        // 分割に失敗したときは日本語でそのまま読む
        const t = (await ocr(jpn, cv)).replace(/\s/g, '');
        keep('日付(日本語で読み直し)', cv, t);
        // 「年」「月」が別の文字に誤認識されても拾えるよう、年(20xx)のあとの数字2つを月・日とみなす
        const mm = t.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/) || t.match(/(20\d{2})\D{1,3}(\d{1,2})\D{1,3}(\d{1,2})/);
        m = mm ? mm.slice(1) : null;
      }
      if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12 && Number(m[2]) >= 1 && Number(m[2]) <= 31) res.date = `${m[0]}-${pad2(m[1])}-${pad2(m[2])}`;
    }
    if (!res.date) res.warnings.push('日付が読めません');
    res.ms = Math.round(performance.now() - t0);
    return res;
  }

  async function analyzeFile(file) {
    const url = URL.createObjectURL(file);
    try {
      // img.decode() はタブが裏にあると止まることがあるので onload で待つ
      const img = await new Promise((ok, ng) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => ng(new Error('画像を開けませんでした')); im.src = url; });
      return await analyze(img);
    } finally { URL.revokeObjectURL(url); }
  }

  return { analyze, analyzeFile, getWorkers };
})();
