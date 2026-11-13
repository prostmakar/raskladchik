// ===== STEP → IGES (тело B-rep) — чтобы хлыст из STEP-деталей открывался в TubesT, которая читает только IGES =====
// Точный перевод, без разбиения на отрезки: рёбра → NURBS-кривые (126), поверхности → NURBS-поверхности (128),
// топология → 502/504/508/510/514/186. Так же пишет IGES SolidWorks, такие файлы TubesT открывает.
(function (root) {
  'use strict';
  const STEP = root.STEP || (typeof require !== 'undefined' ? require('./step.js') : null);
  const TC = root.TubeCut || (typeof require !== 'undefined' ? require('./tubecut.js') : null);
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = a => Math.hypot(a[0], a[1], a[2]);
  const norm = a => { const l = len(a) || 1; return mul(a, 1 / l); };
  const dist = (a, b) => len(sub(a, b));
  const TAU = Math.PI * 2;

  // ---------------------------------------------------------------- NURBS-кривая: {deg, P:[[x,y,z]], W:[], U:[]}
  const lineN = (A, B) => ({ deg: 1, P: [A, B], W: [1, 1], U: [0, 0, 1, 1] });
  // дуга коники: точка(θ) = o + r1 cosθ x + r2 sinθ y, от a0 на sweep (со знаком)
  function arcN(F, r1, r2, a0, sweep) {
    const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9)), d = sweep / n, wm = Math.cos(d / 2);
    const at = (t, f) => add(F.o, add(mul(F.x, f * r1 * Math.cos(t)), mul(F.y, f * r2 * Math.sin(t))));
    const P = [at(a0, 1)], W = [1], U = [0, 0, 0];
    for (let i = 0; i < n; i++) { P.push(at(a0 + d * (i + 0.5), 1 / wm), at(a0 + d * (i + 1), 1)); W.push(wm, 1); U.push(i + 1, i + 1); }
    U.push(n);
    return { deg: 2, P, W, U };
  }
  function evalN(c, t) {
    const n = c.P.length - 1, H = root.IGES ? root.IGES._int : require('./iges.js')._int;
    const s = H.findSpan(c.U, c.deg, n, t), N = H.basis(c.U, c.deg, s, t);
    let x = 0, y = 0, z = 0, w = 0;
    for (let j = 0; j <= c.deg; j++) { const q = c.P[s - c.deg + j], ww = c.W[s - c.deg + j] * N[j]; x += q[0] * ww; y += q[1] * ww; z += q[2] * ww; w += ww; }
    return [x / w, y / w, z / w];
  }
  function reverseN(c) { const a = c.U[0], b = c.U[c.U.length - 1]; return { deg: c.deg, P: c.P.slice().reverse(), W: c.W.slice().reverse(), U: c.U.map(u => a + b - u).reverse() }; }
  // вставка узла t (алгоритм Бёма), в однородных координатах
  function insertKnot(c, t) {
    const p = c.deg, U = c.U, n = c.P.length - 1;
    let k = p; while (k < n && U[k + 1] <= t) k++;
    const Q = [], W = [];
    const h = i => { const w = c.W[i]; return [c.P[i][0] * w, c.P[i][1] * w, c.P[i][2] * w, w]; };
    for (let i = 0; i <= n + 1; i++) {
      let v;
      if (i <= k - p) v = h(i);
      else if (i > k) v = h(i - 1);
      else { const a = (t - U[i]) / (U[i + p] - U[i]); const A = h(i), B = h(i - 1); v = [a * A[0] + (1 - a) * B[0], a * A[1] + (1 - a) * B[1], a * A[2] + (1 - a) * B[2], a * A[3] + (1 - a) * B[3]]; }
      Q.push([v[0] / v[3], v[1] / v[3], v[2] / v[3]]); W.push(v[3]);
    }
    const U2 = U.slice(0, k + 1).concat([t], U.slice(k + 1));
    return { deg: p, P: Q, W, U: U2 };
  }
  // кусок кривой между параметрами t0 < t1: узлы t0 и t1 доводятся до кратности p, дальше берётся отрезок контрольных точек
  function subN(c, t0, t1) {
    const p = c.deg, eps = 1e-10 * Math.max(1, Math.abs(c.U[c.U.length - 1] - c.U[0]));
    const mult = (cc, t) => { let m = 0; for (const u of cc.U) if (Math.abs(u - t) < eps) m++; return m; };
    for (const t of [t0, t1]) { let g = 0; while (mult(c, t) < p && g++ < p + 1) c = insertKnot(c, t); }
    const U = c.U; let k0 = -1, k1 = -1;
    for (let i = 0; i < U.length; i++) { if (Math.abs(U[i] - t0) < eps) k0 = i; if (k1 < 0 && Math.abs(U[i] - t1) < eps) k1 = i; }
    if (k0 < 0 || k1 < 0) return null;
    const st = k0 - p, en = k1 - 1; if (st < 0 || en >= c.P.length || en - st < p) return null;
    const inner = U.filter(u => u > t0 + eps && u < t1 - eps);
    return { deg: p, P: c.P.slice(st, en + 1), W: c.W.slice(st, en + 1), U: [...Array(p + 1).fill(t0), ...inner, ...Array(p + 1).fill(t1)] };
  }
  // параметр ближайшей к точке q точки кривой
  function paramOf(c, q) {
    const lo = c.U[c.deg], hi = c.U[c.P.length]; const N = Math.max(64, c.P.length * 12);
    let bt = lo, bd = Infinity;
    for (let i = 0; i <= N; i++) { const t = lo + (hi - lo) * i / N, d = dist(evalN(c, t), q); if (d < bd) { bd = d; bt = t; } }
    let h = (hi - lo) / N;
    for (let it = 0; it < 40; it++) { h /= 2; for (const t of [bt - h, bt + h]) { if (t < lo || t > hi) continue; const d = dist(evalN(c, t), q); if (d < bd) { bd = d; bt = t; } } }
    return { t: bt, d: bd };
  }

  // ---------------------------------------------------------------- кривые STEP
  function splineOf(C, e) {
    let deg, ctrl, mults, knots, weights = null; const t = e.t, a = e.a, parts = e.parts;
    if (t === 'B_SPLINE_CURVE_WITH_KNOTS') { deg = a[1]; ctrl = a[2].map(r => C.pt(r)); mults = a[6]; knots = a[7]; }
    else if (t === '_COMPLEX' && parts.B_SPLINE_CURVE && parts.B_SPLINE_CURVE_WITH_KNOTS) {
      const b = parts.B_SPLINE_CURVE; deg = b[0]; ctrl = b[1].map(r => C.pt(r)); mults = parts.B_SPLINE_CURVE_WITH_KNOTS[0]; knots = parts.B_SPLINE_CURVE_WITH_KNOTS[1];
      if (parts.RATIONAL_B_SPLINE_CURVE) weights = parts.RATIONAL_B_SPLINE_CURVE[0];
    } else if (t === 'BEZIER_CURVE' || (t === '_COMPLEX' && parts.BEZIER_CURVE && parts.B_SPLINE_CURVE)) {
      const b = t === 'BEZIER_CURVE' ? a.slice(1) : parts.B_SPLINE_CURVE; deg = b[0]; ctrl = b[1].map(r => C.pt(r)); mults = [deg + 1, deg + 1]; knots = [0, 1];
      if (parts && parts.RATIONAL_B_SPLINE_CURVE) weights = parts.RATIONAL_B_SPLINE_CURVE[0];
    } else if (t === 'POLYLINE') { ctrl = a[1].map(r => C.pt(r)); deg = 1; mults = ctrl.map((_, i) => i === 0 || i === ctrl.length - 1 ? 2 : 1); knots = ctrl.map((_, i) => i); }
    else return null;
    if (!ctrl || ctrl.some(q => !q)) return null;
    const U = []; mults.forEach((m, k) => { for (let j = 0; j < m; j++) U.push(knots[k]); });
    if (U.length !== ctrl.length + deg + 1) return null;
    return { deg, P: ctrl, W: weights ? weights.slice() : ctrl.map(() => 1), U };
  }
  const unwrap = (C, e) => { let g = 0; while (e && g++ < 8 && (e.t === 'SURFACE_CURVE' || e.t === 'SEAM_CURVE' || e.t === 'INTERSECTION_CURVE' || e.t === 'TRIMMED_CURVE')) e = C.get(e.a[1]); return e; };
  // ребро от вершины A к вершине B (sense — по направлению кривой или против). Замкнутое — вся кривая.
  function edgeCurve(C, e, A, B, sense) {
    e = unwrap(C, e);
    const closed = dist(A, B) < 1e-6;
    if (!e) { if (closed) throw new Error('замкнутое ребро без кривой'); return lineN(A, B); }
    if (e.t === 'LINE') { if (closed) throw new Error('вырожденный отрезок'); return lineN(A, B); }
    if (e.t === 'CIRCLE' || e.t === 'ELLIPSE') {
      const F = C.place(e.a[1]); const r1 = e.a[2] * C.scale, r2 = (e.t === 'ELLIPSE' ? e.a[3] : e.a[2]) * C.scale;
      const ang = q => { const d = sub(q, F.o); return Math.atan2(dot(d, F.y) / r2, dot(d, F.x) / r1); };
      const a0 = ang(A); let a1 = ang(B);
      if (sense) { if (closed) a1 = a0 + TAU; else while (a1 <= a0 + 1e-12) a1 += TAU; }
      else { if (closed) a1 = a0 - TAU; else while (a1 >= a0 - 1e-12) a1 -= TAU; }
      const c = arcN(F, r1, r2, a0, a1 - a0); c.P[0] = A.slice(); c.P[c.P.length - 1] = B.slice();
      return c;
    }
    let c = splineOf(C, e); if (!c) throw new Error('кривая ' + e.t + ' пока не поддерживается');
    if (!sense) c = reverseN(c);
    const lo = c.U[c.deg], hi = c.U[c.P.length]; const tol = 1e-5 * Math.max(1, dist(c.P[0], c.P[c.P.length - 1]));
    const s0 = evalN(c, lo), s1 = evalN(c, hi);
    if (closed) return c;
    if (dist(s0, A) < Math.max(tol, 1e-4) && dist(s1, B) < Math.max(tol, 1e-4)) return c;
    const pa = paramOf(c, A), pb = paramOf(c, B);
    if (pb.t - pa.t < 1e-9 * (hi - lo)) throw new Error('не получилось обрезать сплайн по вершинам');
    const piece = subN(c, Math.max(lo, pa.t), Math.min(hi, pb.t));
    if (!piece) throw new Error('не получилось обрезать сплайн по вершинам');
    return piece;
  }
  // кривая целиком (для поверхностей выдавливания и вращения)
  function fullCurve(C, e) {
    e = unwrap(C, e); if (!e) return null;
    if (e.t === 'LINE') { const p = C.pt(e.a[1]), v = C.get(e.a[2]); const d = C.dir(e.a[2]); const m = v && v.t === 'VECTOR' ? (v.a[2] || 1) * C.scale : 1; return { line: true, p, d, m }; }
    if (e.t === 'CIRCLE' || e.t === 'ELLIPSE') { const F = C.place(e.a[1]); const r1 = e.a[2] * C.scale, r2 = (e.t === 'ELLIPSE' ? e.a[3] : e.a[2]) * C.scale; return arcN(F, r1, r2, 0, TAU); }
    return splineOf(C, e);
  }

  // ---------------------------------------------------------------- NURBS-поверхности: {d1, d2, G[i][j], W[i][j], U, V} (i — первый параметр)
  // вращение кривой вокруг оси (o, z): первый параметр — угол от a0 на sweep (отсчёт от самой кривой), по умолчанию полный оборот
  function revolve(c, o, z, a0, sweep) {
    if (sweep === undefined) { a0 = 0; sweep = TAU; }
    const n = Math.max(1, Math.ceil(sweep / (Math.PI / 2) - 1e-9)), d = sweep / n, wm = Math.cos(d / 2); const G = [], W = [], U = [a0, a0, a0];
    for (let i = 0; i <= 2 * n; i++) {
      const th = a0 + i * d / 2, f = i % 2 ? 1 / wm : 1, w = i % 2 ? wm : 1; G[i] = []; W[i] = [];
      for (let j = 0; j < c.P.length; j++) {
        const p = c.P[j], foot = add(o, mul(z, dot(sub(p, o), z))), r = sub(p, foot), t = cross(z, r);
        G[i][j] = add(foot, mul(add(mul(r, Math.cos(th)), mul(t, Math.sin(th))), f)); W[i][j] = c.W[j] * w;
      }
    }
    for (let i = 1; i < n; i++) U.push(a0 + i * d, a0 + i * d);
    U.push(a0 + sweep, a0 + sweep, a0 + sweep);
    return { d1: 2, d2: c.deg, G, W, U, V: c.U.slice(), closedU: Math.abs(sweep - TAU) < 1e-9 };
  }
  // какой сектор вокруг оси занимает грань: [a0, sweep] или null — полный оборот
  function sector(pts, o, x, y) {
    const A = pts.map(p => { const d = sub(p, o); return Math.atan2(dot(d, y), dot(d, x)); }).map(a => a < 0 ? a + TAU : a).sort((p, q) => p - q);
    if (A.length < 2) return null;
    let gap = A[0] + TAU - A[A.length - 1], at = A.length - 1;
    for (let i = 0; i + 1 < A.length; i++) if (A[i + 1] - A[i] > gap) { gap = A[i + 1] - A[i]; at = i; }
    if (gap < Math.PI / 6) return null;
    const m = Math.min(gap / 4, Math.PI / 36); const start = A[(at + 1) % A.length] - m;
    return [start, TAU - gap + 2 * m];
  }
  const transposeN = s => ({ d1: s.d2, d2: s.d1, G: s.G[0].map((_, j) => s.G.map(r => r[j])), W: s.W[0].map((_, j) => s.W.map(r => r[j])), U: s.V, V: s.U, closedV: s.closedU });
  const flipV = s => { const a = s.V[0], b = s.V[s.V.length - 1]; return Object.assign({}, s, { G: s.G.map(r => r.slice().reverse()), W: s.W.map(r => r.slice().reverse()), V: s.V.map(v => a + b - v).reverse() }); };
  // та же поверхность с нормалью в другую сторону (первый параметр — задом наперёд)
  function flipN(s) { const a = s.U[0], b = s.U[s.U.length - 1]; return Object.assign({}, s, { G: s.G.slice().reverse(), W: s.W.slice().reverse(), U: s.U.map(u => a + b - u).reverse() }); }
  function surfaceN(C, e, pts) { // pts — точки на рёбрах грани (для размеров бесконечных поверхностей)
    if (!e) throw new Error('грань без поверхности');
    const t = e.t, a = e.a, M = 1; // запас, мм
    const range = (o, d) => { let lo = Infinity, hi = -Infinity; for (const p of pts) { const v = dot(sub(p, o), d); if (v < lo) lo = v; if (v > hi) hi = v; } return [lo - M, hi + M]; };
    if (t === 'PLANE') {
      const F = C.place(a[1]); const [x0, x1] = range(F.o, F.x), [y0, y1] = range(F.o, F.y);
      const at = (x, y) => add(F.o, add(mul(F.x, x), mul(F.y, y)));
      return { d1: 1, d2: 1, G: [[at(x0, y0), at(x0, y1)], [at(x1, y0), at(x1, y1)]], W: [[1, 1], [1, 1]], U: [0, 0, 1, 1], V: [0, 0, 1, 1] };
    }
    if (t === 'CYLINDRICAL_SURFACE' || t === 'CONICAL_SURFACE') {
      const F = C.place(a[1]); const R = a[2] * C.scale; const k = t === 'CONICAL_SURFACE' ? Math.tan(a[3]) : 0; // углы в STEP — радианы (plane_angle_unit не пересчитываем: градусы встречаются редко)
      let [z0, z1] = range(F.o, F.z);
      if (k) { const zz = -R / k; if (k > 0) z0 = Math.max(z0, zz + 1e-6); else z1 = Math.min(z1, zz - 1e-6); }
      const at = z => add(F.o, add(mul(F.x, R + z * k), mul(F.z, z)));
      const sc = sector(pts, F.o, F.x, F.y);
      return sc ? revolve(lineN(at(z0), at(z1)), F.o, F.z, sc[0], sc[1]) : revolve(lineN(at(z0), at(z1)), F.o, F.z);
    }
    if (t === 'SPHERICAL_SURFACE') { const F = C.place(a[1]); const R = a[2] * C.scale; return revolve(arcN({ o: F.o, x: F.x, y: F.z }, R, R, -Math.PI / 2, Math.PI), F.o, F.z); }
    if (t === 'TOROIDAL_SURFACE') { const F = C.place(a[1]); const R = a[2] * C.scale, r = a[3] * C.scale; return revolve(arcN({ o: add(F.o, mul(F.x, R)), x: F.x, y: F.z }, r, r, 0, TAU), F.o, F.z); }
    if (t === 'SURFACE_OF_REVOLUTION') {
      const c = fullCurve(C, C.get(a[1])); const ax = C.get(a[2]); if (!c || !ax) throw new Error('поверхность вращения: нет образующей');
      const o = C.pt(ax.a[1]), z = C.dir(ax.a[2]);
      if (c.line) { const [t0, t1] = range(c.p, c.d); return revolve(lineN(add(c.p, mul(c.d, t0)), add(c.p, mul(c.d, t1))), o, z); }
      return revolve(c, o, z);
    }
    if (t === 'SURFACE_OF_LINEAR_EXTRUSION') {
      let c = fullCurve(C, C.get(a[1])); const d = C.dir(a[2]); if (!c || !d) throw new Error('поверхность выдавливания: нет образующей');
      if (c.line) { const [t0, t1] = range(c.p, c.d); c = lineN(add(c.p, mul(c.d, t0)), add(c.p, mul(c.d, t1))); }
      let c0 = Infinity, c1 = -Infinity; for (const p of c.P) { const v = dot(p, d); if (v < c0) c0 = v; if (v > c1) c1 = v; }
      let f0 = Infinity, f1 = -Infinity; for (const p of pts) { const v = dot(p, d); if (v < f0) f0 = v; if (v > f1) f1 = v; }
      const t0 = f0 - c1 - M, t1 = f1 - c0 + M;
      return { d1: c.deg, d2: 1, G: c.P.map(p => [add(p, mul(d, t0)), add(p, mul(d, t1))]), W: c.W.map(w => [w, w]), U: c.U.slice(), V: [0, 0, 1, 1] };
    }
    let d1, d2, grid, m1, m2, k1, k2, W = null;
    if (t === 'B_SPLINE_SURFACE_WITH_KNOTS') { d1 = a[1]; d2 = a[2]; grid = a[3]; m1 = a[8]; m2 = a[9]; k1 = a[10]; k2 = a[11]; }
    else if (t === '_COMPLEX' && e.parts.B_SPLINE_SURFACE && e.parts.B_SPLINE_SURFACE_WITH_KNOTS) {
      const b = e.parts.B_SPLINE_SURFACE, k = e.parts.B_SPLINE_SURFACE_WITH_KNOTS; d1 = b[0]; d2 = b[1]; grid = b[2]; m1 = k[0]; m2 = k[1]; k1 = k[2]; k2 = k[3];
      if (e.parts.RATIONAL_B_SPLINE_SURFACE) W = e.parts.RATIONAL_B_SPLINE_SURFACE[0];
    } else throw new Error('поверхность ' + t + ' пока не поддерживается');
    const G = grid.map(row => row.map(r => C.pt(r)));
    const U = [], V = []; m1.forEach((m, i) => { for (let j = 0; j < m; j++) U.push(k1[i]); }); m2.forEach((m, i) => { for (let j = 0; j < m; j++) V.push(k2[i]); });
    return { d1, d2, G, W: W ? W.map(r => r.slice()) : G.map(r => r.map(() => 1)), U, V };
  }

  // ---------------------------------------------------------------- сборка IGES
  const num = v => { if (!isFinite(v)) v = 0; if (Math.abs(v) < 1e-12) v = 0; let s = (+v.toPrecision(15)).toString().toUpperCase(); if (!/[.E]/.test(s)) s += '.'; else if (/E/.test(s) && !/\./.test(s.split('E')[0])) s = s.replace('E', '.E'); return s; };
  function convert(src, info) {
    const doc = STEP.parse(src); const C = STEP.makeCtx(doc);
    // грани самого большого тела — как в расчёте
    let faceIds = []; for (const [id, e] of C.E) if (e.t === 'ADVANCED_FACE' || e.t === 'FACE_SURFACE') faceIds.push(id);
    const shells = [...C.E.entries()].filter(([, e]) => e.t === 'CLOSED_SHELL' || e.t === 'OPEN_SHELL');
    if (shells.length > 1) { const big = shells.map(([id, e]) => (e.a[1] || []).map(r => r.r)).sort((x, y) => y.length - x.length)[0]; faceIds = big.filter(id => C.E.has(id)); }
    else if (shells.length === 1) faceIds = (shells[0][1].a[1] || []).map(r => r.r).filter(id => C.E.has(id));
    if (!faceIds.length) throw new Error('в STEP нет тела');

    const W = TC.igesWriter(), p8 = TC.pad8;
    const ent = (type, form, toks, st) => { W.emit([type, 0, 0, 0, 0, 0, 0, 0, st || '00010000'].map(p8), [type, 0, 0, 0, form, '', '', '', 0].map(p8), [String(type), ...toks]); return 2 * (W.count() - 1) + 1; };
    const curve126 = c => { const K = c.P.length - 1; const planar = 0; return ent(126, 0, [K, c.deg, planar, 0, c.W.some(w => Math.abs(w - c.W[0]) > 1e-12) ? 0 : 1, 0, ...c.U.map(num), ...c.W.map(num), ...c.P.flatMap(p => p.map(num)), num(c.U[c.deg]), num(c.U[K + 1]), '0.', '0.', '0.'].map(String)); };
    const surf128 = s => {
      const K1 = s.G.length - 1, K2 = s.G[0].length - 1; const w = [], p = []; let poly = 1;
      for (let j = 0; j <= K2; j++) for (let i = 0; i <= K1; i++) { w.push(num(s.W[i][j])); p.push(...s.G[i][j].map(num)); if (Math.abs(s.W[i][j] - s.W[0][0]) > 1e-12) poly = 0; }
      return ent(128, 0, [K1, K2, s.d1, s.d2, s.closedU ? 1 : 0, s.closedV ? 1 : 0, poly, 0, 0, ...s.U.map(num), ...s.V.map(num), ...w, ...p, num(s.U[s.d1]), num(s.U[K1 + 1]), num(s.V[s.d2]), num(s.V[K2 + 1])].map(String));
    };

    // вершины и рёбра: сначала всё собираем, кривые пишем сразу, списки 502/504 — после
    const verts = [], vIdx = new Map();
    const vOf = (key, p) => { if (!vIdx.has(key)) { verts.push(p); vIdx.set(key, verts.length); } return vIdx.get(key); };
    const sampN = c => { const lo = c.U[c.deg], hi = c.U[c.P.length], n = c.deg === 1 && c.P.length === 2 ? 1 : 12 * (c.P.length - c.deg), o = []; for (let i = 0; i <= n; i++) o.push(evalN(c, lo + (hi - lo) * i / n)); return o; };
    const edges = [], eMap = new Map(); // id EDGE_CURVE -> [{idx в списке рёбер}] (замкнутое ребро — две половины)
    const edgeOf = ecId => {
      if (eMap.has(ecId)) return eMap.get(ecId);
      const ec = C.E.get(ecId); const a = ec.a; const A = C.pt(a[1]), B = C.pt(a[2]); const sense = !(a[4] && a[4].e === 'F');
      if (!A || !B) throw new Error('ребро без вершин');
      const c = edgeCurve(C, C.get(a[3]), A, B, sense);
      const va = vOf('v' + a[1].r, A), vb = vOf('v' + a[2].r, B);
      let list;
      if (va === vb) { // замкнутое ребро: делим пополам — так пишет SolidWorks, так надёжнее читается
        const lo = c.U[c.deg], hi = c.U[c.P.length], tm = (lo + hi) / 2;
        const h1 = subN(c, lo, tm), h2 = subN(c, tm, hi); if (!h1 || !h2) throw new Error('не получилось разделить замкнутое ребро');
        const vm = vOf('m' + ecId, evalN(c, tm));
        edges.push({ c: h1, s: va, t: vm }); edges.push({ c: h2, s: vm, t: va });
        list = [{ i: edges.length - 1, pts: sampN(h1) }, { i: edges.length, pts: sampN(h2) }];
      } else { edges.push({ c, s: va, t: vb }); list = [{ i: edges.length, pts: sampN(c) }]; }
      eMap.set(ecId, list); return list;
    };
    const faces = [];
    for (const fid of faceIds) {
      const f = C.E.get(fid); const same = !(f.a[3] && f.a[3].e === 'F');
      const loops = [], pts = [];
      for (const br of f.a[1] || []) {
        const b = C.get(br); if (!b) continue; const loop = C.get(b.a[1]); if (!loop || loop.t !== 'EDGE_LOOP') continue;
        let items = [];
        for (const r of loop.a[1] || []) {
          const oe = C.get(r); if (!oe || oe.t !== 'ORIENTED_EDGE') continue; const ecId = oe.a[3] && oe.a[3].r; const ec = C.E.get(ecId); if (!ec || ec.t !== 'EDGE_CURVE') continue;
          const fwd = !(oe.a[4] && oe.a[4].e === 'F'); const parts = edgeOf(ecId);
          for (const h of parts) pts.push(...h.pts);
          const seq = parts.map(h => ({ i: h.i, of: fwd ? 1 : 0 })); if (!fwd) seq.reverse();
          items.push(...seq);
        }
        const bo = !(b.a[2] && b.a[2].e === 'F');
        if (!bo) items = items.reverse().map(x => ({ i: x.i, of: x.of ? 0 : 1 }));
        if (items.length) loops.push({ items, outer: b.t === 'FACE_OUTER_BOUND' });
      }
      if (!loops.length) continue;
      loops.sort((x, y) => (y.outer ? 1 : 0) - (x.outer ? 1 : 0));
      // нормаль поверхности — наружу тела (как пишет SolidWorks): при same_sense=.F. переворачиваем саму поверхность
      let sf = surfaceN(C, C.get(f.a[2]), pts); if (!same) sf = flipN(sf);
      // TubesT зависает, если у поверхности первым идёт «кривой» параметр: линейное направление — первым (так пишет SolidWorks)
      if (sf.d1 > sf.d2) sf = flipV(transposeN(sf));
      faces.push({ surf: surf128(sf), loops, outer: loops[0].outer });
    }
    if (!faces.length) throw new Error('в STEP нет граней');
    const cde = edges.map(e => curve126(e.c));
    const vde = ent(502, 1, [verts.length, ...verts.flatMap(p => p.map(num))].map(String));
    const ede = ent(504, 1, [edges.length, ...edges.flatMap((e, i) => [cde[i], vde, e.s, vde, e.t])].map(String), '00010001');
    const fde = [];
    for (const f of faces) {
      const lde = f.loops.map(L => ent(508, 1, [L.items.length, ...L.items.flatMap(x => [0, ede, x.i, x.of, 0])].map(String)));
      fde.push(ent(510, 1, [f.surf, lde.length, f.outer ? 1 : 0, ...lde].map(String)));
    }
    const sde = ent(514, 1, [faces.length, ...faces.flatMap((f, i) => [fde[i], 1])].map(String));
    ent(186, 0, [sde, 1, 0].map(String), '00000000');
    return W.finish(info || { comment: ['Raskladchik: STEP to IGES'] });
  }

  root.STEP2IGES = { convert, _int: { arcN, subN, insertKnot, evalN, revolve } };
  if (typeof module !== 'undefined') module.exports = root.STEP2IGES;
})(typeof window !== 'undefined' ? window : globalThis);
