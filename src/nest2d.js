// ===== Раскладка деталей на листе (растровый метод «вниз-влево» по форме) =====
// Работает и в странице, и в Web Worker (тот же текст).
(function (root) {
  'use strict';
  const hyp = Math.hypot;

  // ---------------------------------------------------------------- геометрия
  function polyArea(P) { let s = 0; for (let i = 0, n = P.length; i < n; i++) { const a = P[i], b = P[(i + 1) % n]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; }
  function simplify(P, tol) { // Дуглас-Пекер для замкнутого контура
    if (P.length < 8) return P;
    // разрезаем по двум дальним точкам
    let i0 = 0, i1 = 0, dm = -1;
    for (let i = 0; i < P.length; i++) { const d = hyp(P[i][0] - P[0][0], P[i][1] - P[0][1]); if (d > dm) { dm = d; i1 = i; } }
    const keep = new Uint8Array(P.length); keep[i0] = keep[i1] = 1;
    const dp = (a, b) => { // индексы по кругу a->b
      const n = P.length; const stack = [[a, b]];
      while (stack.length) {
        const [s, e] = stack.pop(); const A = P[s], B = P[e % n];
        let best = -1, bd = tol;
        for (let k = s + 1; k < e; k++) { const p = P[k % n]; const d = segDist(p, A, B); if (d > bd) { bd = d; best = k; } }
        if (best >= 0) { keep[best % n] = 1; stack.push([s, best], [best, e]); }
      }
    };
    dp(i0, i1); dp(i1, i0 + P.length);
    const out = []; for (let i = 0; i < P.length; i++) if (keep[i]) out.push(P[i]);
    return out;
  }
  function segDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1]; const L2 = dx * dx + dy * dy;
    let t = L2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
    return hyp(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  }
  function hull(P) {
    const p = P.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]); if (p.length < 3) return p;
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    up.pop(); lo.pop(); return lo.concat(up);
  }

  // поворот (+зеркало по X до поворота) и сдвиг в 0
  function orient(polys, ang, mir) {
    const a = ang * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    const m = mir ? -1 : 1;
    // матрица p' = R * diag(m,1) * p
    const M = [ca * m, sa * m, -sa, ca];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const out = polys.map(P => P.map(p => { const x = M[0] * p[0] + M[2] * p[1], y = M[1] * p[0] + M[3] * p[1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; return [x, y]; }));
    for (const P of out) for (const p of P) { p[0] -= x0; p[1] -= y0; }
    return { polys: out, w: x1 - x0, h: y1 - y0, M: [M[0], M[1], M[2], M[3], -x0, -y0] };
  }

  // ---------------------------------------------------------------- маска
  // ячейка занята, если её центр ближе R к детали (заливка с отверстиями или без)
  function buildMask(polys, w, h, c, R, pad, filled, rectOnly) {
    const nx = Math.ceil((w + 2 * pad) / c), ny = Math.ceil((h + 2 * pad) / c);
    const g = new Uint8Array(nx * ny);
    const cx = i => -pad + (i + 0.5) * c, cy = j => -pad + (j + 0.5) * c;
    if (rectOnly) {
      for (let j = 0; j < ny; j++) { const y = cy(j); if (y < -R || y > h + R) continue; for (let i = 0; i < nx; i++) { const x = cx(i); if (x >= -R && x <= w + R) g[j * nx + i] = 1; } }
      return toRows(g, nx, ny);
    }
    const fillPolys = filled ? [polys[0]] : polys;
    // заливка по центрам ячеек (чёт-нечет)
    for (let j = 0; j < ny; j++) {
      const y = cy(j); const xs = [];
      for (const P of fillPolys) for (let k = 0, n = P.length; k < n; k++) {
        const a = P[k], b = P[(k + 1) % n];
        if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k] + pad) / c - 0.5)), i1 = Math.min(nx - 1, Math.floor((xs[k + 1] + pad) / c - 0.5));
        for (let i = i0; i <= i1; i++) g[j * nx + i] = 1;
      }
    }
    // полоса шириной R вдоль кромок
    if (R > 0) for (const P of fillPolys) for (let k = 0, n = P.length; k < n; k++) capsule(g, nx, ny, P[k], P[(k + 1) % n], R, c, pad);
    return toRows(g, nx, ny);
  }
  function capsule(g, nx, ny, A, B, R, c, pad) {
    const ylo = Math.min(A[1], B[1]) - R, yhi = Math.max(A[1], B[1]) + R;
    const j0 = Math.max(0, Math.ceil((ylo + pad) / c - 0.5)), j1 = Math.min(ny - 1, Math.floor((yhi + pad) / c - 0.5));
    const dx = B[0] - A[0], dy = B[1] - A[1], L = hyp(dx, dy);
    for (let j = j0; j <= j1; j++) {
      const y = -pad + (j + 0.5) * c;
      let lo = Infinity, hi = -Infinity;
      for (const P of [A, B]) { const t = R * R - (y - P[1]) * (y - P[1]); if (t >= 0) { const s = Math.sqrt(t); lo = Math.min(lo, P[0] - s); hi = Math.max(hi, P[0] + s); } }
      if (L > 1e-12) {
        // |cross(d, X-A)|/L <= R:  cross = dx*(y-Ay) - dy*(x-Ax)
        // 0 <= dot(d, X-A) <= L^2: dot = dx*(x-Ax) + dy*(y-Ay)
        let a0 = -Infinity, a1 = Infinity;
        const lin = (k, b, lo2, hi2) => { // k*x + b в [lo2,hi2]
          if (Math.abs(k) < 1e-12) { if (b < lo2 || b > hi2) { a0 = Infinity; a1 = -Infinity; } return; }
          let u = (lo2 - b) / k, v = (hi2 - b) / k; if (u > v) { const t = u; u = v; v = t; } a0 = Math.max(a0, u); a1 = Math.min(a1, v);
        };
        lin(-dy, dx * (y - A[1]) + dy * A[0], -R * L, R * L);
        lin(dx, -dx * A[0] + dy * (y - A[1]), 0, L * L);
        if (a0 <= a1) { lo = Math.min(lo, a0); hi = Math.max(hi, a1); }
      }
      if (lo > hi) continue;
      const i0 = Math.max(0, Math.ceil((lo + pad) / c - 0.5)), i1 = Math.min(nx - 1, Math.floor((hi + pad) / c - 0.5));
      for (let i = i0; i <= i1; i++) g[j * nx + i] = 1;
    }
  }
  function toRows(g, nx, ny) {
    const rows = []; let cells = 0;
    for (let j = 0; j < ny; j++) {
      const iv = []; let i = 0;
      while (i < nx) { while (i < nx && !g[j * nx + i]) i++; if (i >= nx) break; const s = i; while (i < nx && g[j * nx + i]) i++; iv.push(s, i - 1); cells += i - s; }
      rows.push(iv);
    }
    // порядок проверки строк: вперемешку (быстрее находим помеху)
    const order = []; const seen = new Uint8Array(ny);
    for (let step = 1 << Math.ceil(Math.log2(Math.max(1, ny))); step >= 1; step >>= 1) for (let j = 0; j < ny; j += step) if (!seen[j]) { seen[j] = 1; if (rows[j].length) order.push(j); }
    return { nx, ny, rows, order, cells };
  }

  // ---------------------------------------------------------------- лист
  function Sheet(W, H, c, pad) {
    this.c = c; this.pad = pad;
    this.cols = Math.ceil((W + 2 * pad) / c); this.rowsN = Math.ceil((H + 2 * pad) / c);
    this.occ = new Uint8Array(this.cols * this.rowsN);
    this.run = new Int32Array(this.cols * this.rowsN);
    for (let r = 0; r < this.rowsN; r++) this.fixRow(r, this.cols - 1, 0, true);
  }
  // пересчёт длины свободного/занятого участка справа налево
  Sheet.prototype.fixRow = function (r, xFrom, xChangedLo, full) {
    const C = this.cols, base = r * C, occ = this.occ, run = this.run;
    for (let x = Math.min(C - 1, xFrom); x >= 0; x--) {
      const nxt = x + 1 < C ? run[base + x + 1] : 0;
      const v = occ[base + x] ? (x + 1 < C && nxt < 0 ? nxt - 1 : -1) : (x + 1 < C && nxt > 0 ? nxt + 1 : 1);
      if (!full && x < xChangedLo && run[base + x] === v) break;
      run[base + x] = v;
    }
  };
  Sheet.prototype.fits = function (m, gx, gy) {
    const run = this.run, C = this.cols;
    for (const j of m.order) {
      const iv = m.rows[j]; const base = (gy + j) * C + gx;
      for (let k = 0; k < iv.length; k += 2) { const v = run[base + iv[k]]; if (v < iv[k + 1] - iv[k] + 1) return { j, k, v }; }
    }
    return null;
  };
  Sheet.prototype.put = function (m, gx, gy) {
    const C = this.cols;
    for (let j = 0; j < m.ny; j++) {
      const iv = m.rows[j]; if (!iv.length) continue; const r = gy + j; const base = r * C + gx;
      for (let k = 0; k < iv.length; k += 2) for (let i = iv[k]; i <= iv[k + 1]; i++) this.occ[base + i] = 1;
      this.fixRow(r, gx + iv[iv.length - 1] + 1, gx + iv[0], false);
    }
  };
  // наилучшее место: минимум правого края, затем нижнего
  Sheet.prototype.find = function (m, xr, yr, bound, start) {
    let best = null;
    const [gx0, gx1] = xr, [gy0, gy1] = yr;
    if (gx1 < gx0 || gy1 < gy0) return null;
    let bR = bound ? bound.right : Infinity, bY = bound ? bound.gy : Infinity;
    for (let gy = gy0; gy <= gy1; gy++) {
      let gx = gx0;
      if (start) { const minR = gy < start.gy ? start.right + 1 : start.right; gx = Math.max(gx, minR - m.nx); }
      while (gx <= gx1) {
        const right = gx + m.nx;
        if (right > bR || (right === bR && gy >= bY)) break;
        const f = this.fits(m, gx, gy);
        if (!f) { bR = right; bY = gy; best = { gx, gy, right }; break; }
        const v = f.v; gx += v >= 0 ? v + 1 : -v;
      }
    }
    return best;
  };

  // ---------------------------------------------------------------- раскладка
  /*
   opt: { W, H, margin, gap, mode:'shape'|'rect', holes:bool, rotStep: 0|180|90|45|15..., mirror:bool, common:bool, cell }
   parts: [{ id, qty, polys:[outer, hole...], area, cut, pierces, rect:bool }]
   progress(frac, text)
  */
  function nest(parts, opt, progress) {
    const W = +opt.W, H = +opt.H, margin = Math.max(0, +opt.margin || 0), gap = Math.max(0, +opt.gap || 0);
    const c = opt.cell || Math.max(0.25, Math.min(2, Math.max(W, H) / 4000));
    const R = gap / 2 + c * Math.SQRT1_2;
    const pad = Math.ceil(R / c + 1) * c;
    const angles = [];
    const step = +opt.rotStep;
    if (!step) angles.push(0); else for (let a = 0; a < 360 - 1e-9; a += step) angles.push(a);
    const mirrors = opt.mirror ? [false, true] : [false];
    const rectMode = opt.mode === 'rect';

    // подготовка ориентаций
    const types = [];
    let ti = 0;
    for (const p of parts) {
      ti++;
      if (progress) progress(0.05 * ti / parts.length, 'Подготовка деталей');
      if (!(p.qty > 0) || !p.polys || !p.polys[0] || p.polys[0].length < 3) continue;
      const tol = Math.min(c / 4, 0.2);
      const polys = p.polys.map((P, i) => simplify(P, tol)).filter(P => P.length >= 3);
      const outs = []; const seen = new Set();
      for (const mi of mirrors) for (const a of angles) {
        const o = orient(polys, a, mi);
        const holed = buildMask(o.polys, o.w, o.h, c, R, pad, rectMode || !opt.holes, rectMode);
        const key = holed.nx + 'x' + holed.ny + ':' + holed.rows.map(r => r.join(',')).join(';');
        if (seen.has(key)) continue; seen.add(key);
        outs.push({ ang: a, mir: mi, o, mask: holed });
      }
      types.push({ p, outs, left: p.qty, area: Math.abs(p.area || polyArea(p.polys[0])), dim: 0, hullArea: Math.abs(polyArea(hull(p.polys[0]))) });
    }
    for (const t of types) { const o = t.outs[0].o; t.dim = Math.max(o.w, o.h); }
    types.sort((a, b) => b.hullArea - a.hullArea || b.dim - a.dim);

    const sheets = []; const unplaced = [];
    const totalQty = types.reduce((s, t) => s + t.left, 0);
    let doneQty = 0;

    // общий рез: прямоугольные детали блоками без зазора
    const commonTypes = opt.common ? types.filter(t => t.p.rect) : [];

    let guard = 0;
    while (types.some(t => t.left > 0) && guard++ < 10000) {
      const S = new Sheet(W, H, c, pad);
      const placed = []; const cnt = new Map(); const bounds = new Map();
      const before = new Map(types.map(t => [t, t.left]));
      let shared = 0;

      // блоки общего реза
      for (const t of commonTypes) {
        if (t.left <= 0) continue;
        const blk = commonBlock(t, W, H, margin);
        if (!blk) continue;
        // маска блока: объединение прямоугольников
        const res = placeBlock(S, blk, t, c, R, pad, W, H, margin);
        if (!res) continue;
        for (const pl of res.items) { placed.push(pl); cnt.set(t, (cnt.get(t) || 0) + 1); }
        t.left -= res.items.length; shared += res.shared;
      }

      for (const t of types) {
        if (t.left <= 0) continue;
        let fitAny = false;
        while (t.left > 0) {
          let best = null;
          for (const or of t.outs) {
            const m = or.mask, o = or.o;
            // допустимые позиции по отступу от края
            const gxMin = Math.ceil((margin + pad - pad) / c - 1e-9), gyMin = gxMin;
            const gxMax = Math.floor((W - margin - o.w) / c + 1e-9), gyMax = Math.floor((H - margin - o.h) / c + 1e-9);
            // перевод: левый нижний угол детали = gx*c - pad + pad = gx*c  (маска начинается на pad левее детали)
            const bound = best ? { right: best.right, gy: best.gy } : null;
            const key = or; const start = bounds.get(key);
            const f = S.find(m, [gxMin, gxMax], [gyMin, gyMax], bound, start);
            if (f && (!best || f.right < best.right || (f.right === best.right && f.gy < best.gy))) best = Object.assign(f, { or });
          }
          if (!best) break;
          fitAny = true;
          S.put(best.or.mask, best.gx, best.gy);
          bounds.set(best.or, { right: best.right, gy: best.gy });
          placed.push(placement(t, best.or, best.gx * c, best.gy * c));
          cnt.set(t, (cnt.get(t) || 0) + 1);
          t.left--; doneQty++;
          if (progress && (doneQty % 3 === 0)) progress(0.05 + 0.95 * doneQty / totalQty, 'Лист ' + (sheets.reduce((s, x) => s + x.count, 0) + 1) + ': ' + placed.length + ' дет.');
        }
        if (!fitAny && !placed.length && t.left > 0 && !sheets.length) { /* проверим ниже, влезает ли вообще */ }
      }

      if (!placed.length) {
        // ничего не влезло на пустой лист — эти детали больше листа
        for (const t of types) if (t.left > 0) { unplaced.push({ id: t.p.id, n: t.left, reason: 'не помещается на лист' }); t.left = 0; }
        break;
      }
      // детали, не влезшие на пустой лист (если лист был пуст на момент проверки — их уже нет смысла пробовать)
      for (const t of types) if (t.left > 0 && !cnt.has(t) && fitsEmpty(t, W, H, margin) === false) { unplaced.push({ id: t.p.id, n: t.left, reason: 'не помещается на лист' }); t.left = 0; }

      // повтор того же листа
      let rep = 1;
      if (cnt.size) {
        rep = Infinity;
        for (const [t, n] of cnt) rep = Math.min(rep, Math.floor(before.get(t) / n));
        rep = Math.max(1, rep);
        for (const [t, n] of cnt) t.left = before.get(t) - n * rep;
        doneQty = totalQty - types.reduce((s, t) => s + t.left, 0) - unplaced.reduce((s, u) => s + u.n, 0);
      }
      const usedX = placed.reduce((m, pl) => Math.max(m, pl.x + pl.w), 0);
      const netArea = placed.reduce((s, pl) => s + pl.area, 0);
      sheets.push({ count: rep, items: placed, usedX, util: netArea / (W * H), shared, cut: placed.reduce((s, pl) => s + pl.cut, 0) - shared, pierces: placed.reduce((s, pl) => s + pl.pierces, 0) });
      if (progress) progress(0.05 + 0.95 * doneQty / Math.max(1, totalQty), 'Листов: ' + sheets.reduce((s, x) => s + x.count, 0));
    }
    return { sheets, unplaced, cell: c };
  }

  function fitsEmpty(t, W, H, margin) { return t.outs.some(or => or.o.w <= W - 2 * margin + 1e-6 && or.o.h <= H - 2 * margin + 1e-6); }

  function placement(t, or, x, y) {
    const M = or.o.M; // p' = M p (+ сдвиг в 0), затем + (x,y)
    return { id: t.p.id, ang: or.ang, mir: or.mir, x, y, w: or.o.w, h: or.o.h, m: [M[0], M[1], M[2], M[3], M[4] + x, M[5] + y], area: t.area, cut: t.p.cut || 0, pierces: t.p.pierces || 0 };
  }

  // ---------------------------------------------------------------- общий рез
  function commonBlock(t, W, H, margin) {
    // варианты ориентации 0/90 (если повороты разрешены)
    const o = t.outs.filter(x => !x.mir && (x.ang === 0 || x.ang === 90));
    let best = null;
    for (const or of o) {
      const w = or.o.w, h = or.o.h;
      const rowsMax = Math.floor((H - 2 * margin + 1e-6) / h), colsMax = Math.floor((W - 2 * margin + 1e-6) / w);
      if (rowsMax < 1 || colsMax < 1) continue;
      const n = Math.min(t.left, rowsMax * colsMax);
      const rows = Math.min(rowsMax, n), cols = Math.ceil(n / rows);
      const score = cols * w; // занятая длина листа
      if (!best || score < best.score) best = { or, w, h, n, rows, cols, score };
    }
    return best;
  }
  function placeBlock(S, b, t, c, R, pad, W, H, margin) {
    // прямоугольники блока
    const rects = []; let k = 0;
    for (let ci = 0; ci < b.cols && k < b.n; ci++) for (let ri = 0; ri < b.rows && k < b.n; ri++, k++) rects.push([ci * b.w, ri * b.h]);
    const BW = b.cols * b.w, BH = b.rows * b.h;
    // маска блока
    const nx = Math.ceil((BW + 2 * pad) / c), ny = Math.ceil((BH + 2 * pad) / c);
    const g = new Uint8Array(nx * ny);
    for (const [x, y] of rects) for (let j = 0; j < ny; j++) { const cy = -pad + (j + 0.5) * c; if (cy < y - R || cy > y + b.h + R) continue; for (let i = 0; i < nx; i++) { const cx = -pad + (i + 0.5) * c; if (cx >= x - R && cx <= x + b.w + R) g[j * nx + i] = 1; } }
    const m = toRows(g, nx, ny);
    const gxMin = Math.ceil(margin / c - 1e-9), gyMin = gxMin;
    const gxMax = Math.floor((W - margin - BW) / c + 1e-9), gyMax = Math.floor((H - margin - BH) / c + 1e-9);
    const f = S.find(m, [gxMin, gxMax], [gyMin, gyMax], null, null);
    if (!f) return null;
    S.put(m, f.gx, f.gy);
    const X = f.gx * c, Y = f.gy * c;
    const items = rects.map(([x, y]) => placement(t, b.or, X + x, Y + y));
    // общие кромки
    let shared = 0; const has = new Set(rects.map(([x, y]) => Math.round(x / b.w) + ':' + Math.round(y / b.h)));
    for (const [x, y] of rects) { const ci = Math.round(x / b.w), ri = Math.round(y / b.h); if (has.has((ci + 1) + ':' + ri)) shared += b.h; if (has.has(ci + ':' + (ri + 1))) shared += b.w; }
    return { items, shared };
  }

  root.Nest2D = { nest, orient, buildMask, simplify, hull, polyArea };
  if (typeof module !== 'undefined') module.exports = root.Nest2D;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
