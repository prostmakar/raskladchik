// ===== STEP (.stp/.step, AP203/AP214/AP242) -> модель граней и рёбер для расчёта реза трубы =====
// Тело B-rep: ADVANCED_FACE / FACE_BOUND / EDGE_LOOP / ORIENTED_EDGE / EDGE_CURVE / VERTEX_POINT.
// Кривые: LINE, CIRCLE, ELLIPSE, B_SPLINE (в т.ч. рациональные), SURFACE_CURVE/SEAM_CURVE, TRIMMED_CURVE.
// Поверхности: PLANE, CYLINDRICAL_SURFACE, CONICAL_SURFACE, B_SPLINE_SURFACE (по сетке точек), прочие — по границе.
(function (root) {
  'use strict';
  const I = root.IGES || (typeof require !== 'undefined' ? require('./iges.js') : null);
  const H = I._int;
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = a => Math.hypot(a[0], a[1], a[2]);
  const norm = a => { const l = len(a) || 1; return mul(a, 1 / l); };
  const dist = (a, b) => len(sub(a, b));

  // ---------------------------------------------------------------- разбор файла
  function decode(src) {
    if (typeof src === 'string') return src;
    try { return new TextDecoder('utf-8', { fatal: false }).decode(src); } catch (e) { let s = ''; for (let i = 0; i < src.length; i++) s += String.fromCharCode(src[i]); return s; }
  }
  // значение: число | строка {s} | ссылка {r} | перечисление {e} | список [] | {t: TYPE, a: [...]} | null
  function parse(src) {
    const text = decode(src);
    if (!/ISO-10303-21/.test(text.slice(0, 2000))) throw new Error('Это не STEP-файл');
    const di = text.search(/\bDATA\s*;/); if (di < 0) throw new Error('В STEP-файле нет раздела DATA');
    const head = text.slice(0, di);
    const T = text; let i = di + text.slice(di).indexOf(';') + 1; const n = T.length;
    const ents = new Map();
    const ws = () => { for (;;) { while (i < n && /\s/.test(T[i])) i++; if (T[i] === '/' && T[i + 1] === '*') { const e = T.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; } break; } };
    const val = () => {
      ws(); const c = T[i];
      if (c === '(') { i++; const L = []; ws(); if (T[i] === ')') { i++; return L; } for (;;) { L.push(val()); ws(); if (T[i] === ',') { i++; continue; } if (T[i] === ')') { i++; break; } throw new Error('STEP: ошибка разбора около ' + i); } return L; }
      if (c === "'") { let s = ''; i++; for (;;) { const j = T.indexOf("'", i); if (j < 0) { i = n; break; } s += T.slice(i, j); if (T[j + 1] === "'") { s += "'"; i = j + 2; continue; } i = j + 1; break; } return { s }; }
      if (c === '#') { let j = i + 1; while (j < n && /[0-9]/.test(T[j])) j++; const r = +T.slice(i + 1, j); i = j; return { r }; }
      if (c === '.') { const j = T.indexOf('.', i + 1); const e = T.slice(i + 1, j); i = j + 1; return { e }; }
      if (c === '$' || c === '*') { i++; return null; }
      if (c === '"') { const j = T.indexOf('"', i + 1); i = j + 1; return null; }
      if (/[A-Za-z_]/.test(c)) { let j = i; while (j < n && /[A-Za-z0-9_]/.test(T[j])) j++; const t = T.slice(i, j).toUpperCase(); i = j; ws(); if (T[i] === '(') { const a = val(); return { t, a }; } return { e: t }; }
      let j = i; while (j < n && /[-+0-9.eEdD]/.test(T[j])) j++; const x = parseFloat(T.slice(i, j).replace(/[dD]/, 'e')); i = j; return isFinite(x) ? x : 0;
    };
    while (i < n) {
      ws(); if (T.startsWith('ENDSEC', i)) break;
      if (T[i] !== '#') { const j = T.indexOf(';', i); if (j < 0) break; i = j + 1; continue; }
      let j = i + 1; while (/[0-9]/.test(T[j])) j++; const id = +T.slice(i + 1, j); i = j; ws();
      if (T[i] !== '=') { const k = T.indexOf(';', i); i = k + 1; continue; } i++; ws();
      try {
        if (T[i] === '(') { // сложная запись: ( A(...) B(...) ... )
          i++; const parts = {}; ws();
          while (T[i] !== ')' && i < n) { const v = val(); if (v && v.t) parts[v.t] = v.a; ws(); }
          i++; ents.set(id, { t: '_COMPLEX', parts });
        } else { const v = val(); if (v && v.t) ents.set(id, { t: v.t, a: v.a }); }
      } catch (e) { /* пропускаем запись */ }
      const k = T.indexOf(';', i); i = k < 0 ? n : k + 1;
    }
    return { ents, head };
  }

  // ---------------------------------------------------------------- геометрия
  function makeCtx(doc) {
    const E = doc.ents;
    const get = r => r && r.r !== undefined ? E.get(r.r) : null;
    // единицы длины
    let scale = 1;
    for (const e of E.values()) {
      if (e.t !== '_COMPLEX') continue;
      const P = e.parts;
      if (P.LENGTH_UNIT !== undefined && P.SI_UNIT) { const pre = P.SI_UNIT[0], nm = P.SI_UNIT[1]; if (nm && nm.e === 'METRE') scale = pre && pre.e === 'MILLI' ? 1 : pre && pre.e === 'CENTI' ? 10 : pre && pre.e === 'MICRO' ? 0.001 : !pre ? 1000 : 1; }
      if (P.LENGTH_UNIT !== undefined && P.CONVERSION_BASED_UNIT) { const nm = P.CONVERSION_BASED_UNIT[0]; const s = nm && nm.s ? nm.s.toUpperCase() : ''; if (/INCH/.test(s)) scale = 25.4; else if (/FOOT|FEET/.test(s)) scale = 304.8; }
    }
    const pt = r => { const e = get(r); if (!e) return null; if (e.t === 'CARTESIAN_POINT') { const c = e.a[1]; return [(c[0] || 0) * scale, (c[1] || 0) * scale, (c[2] || 0) * scale]; } if (e.t === 'VERTEX_POINT') return pt(e.a[1]); return null; };
    const dir = r => { const e = get(r); if (!e) return null; if (e.t === 'DIRECTION') { const c = e.a[1]; return norm([c[0] || 0, c[1] || 0, c[2] || 0]); } if (e.t === 'VECTOR') return dir(e.a[1]); return null; };
    const place = r => { // AXIS2_PLACEMENT_3D -> {o, z, x, y}
      const e = get(r); if (!e) return { o: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0], y: [0, 1, 0] };
      const o = pt(e.a[1]) || [0, 0, 0]; const z = (e.a[2] && dir(e.a[2])) || [0, 0, 1];
      let x = (e.a[3] && dir(e.a[3])) || H.perp(z); x = norm(sub(x, mul(z, dot(x, z)))); return { o, z, x, y: cross(z, x) };
    };
    return { E, get, pt, dir, place, scale };
  }

  // B-сплайн: из записи с кратностями узлов
  function bspline(deg, ctrl, mults, knots, weights) {
    const U = []; mults.forEach((m, k) => { for (let j = 0; j < m; j++) U.push(knots[k]); });
    const n = ctrl.length - 1; const W = weights || ctrl.map(() => 1);
    const lo = U[deg], hi = U[n + 1];
    const ev = t => {
      const s = H.findSpan(U, deg, n, t), N = H.basis(U, deg, s, t);
      let x = 0, y = 0, z = 0, w = 0;
      for (let j = 0; j <= deg; j++) { const q = ctrl[s - deg + j], ww = W[s - deg + j] * N[j]; x += q[0] * ww; y += q[1] * ww; z += q[2] * ww; w += ww; }
      return [x / w, y / w, z / w];
    };
    const spans = []; for (let k = deg; k <= n; k++) if (U[k + 1] > U[k]) spans.push([U[k], U[k + 1]]);
    return { ev, lo, hi, spans };
  }
  function curveSampler(C, e) { // -> функция точек между вершинами {pts(A, B, sense)}
    if (!e) return null;
    let t = e.t, a = e.a, parts = e.parts;
    if (t === 'SURFACE_CURVE' || t === 'SEAM_CURVE' || t === 'INTERSECTION_CURVE') return curveSampler(C, C.get(a[1]));
    if (t === 'TRIMMED_CURVE') return curveSampler(C, C.get(a[1]));
    if (t === 'LINE') return { kind: 'line' };
    if (t === 'CIRCLE' || t === 'ELLIPSE') {
      const P = C.place(a[1]); const r1 = a[2] * C.scale, r2 = (t === 'ELLIPSE' ? a[3] : a[2]) * C.scale;
      return { kind: 'conic', P, r1, r2 };
    }
    let deg, ctrl, mults, knots, weights = null;
    if (t === 'B_SPLINE_CURVE_WITH_KNOTS') { deg = a[1]; ctrl = a[2].map(r => C.pt(r)); mults = a[6]; knots = a[7]; }
    else if (t === '_COMPLEX' && parts.B_SPLINE_CURVE && parts.B_SPLINE_CURVE_WITH_KNOTS) {
      const b = parts.B_SPLINE_CURVE; deg = b[0]; ctrl = b[1].map(r => C.pt(r)); mults = parts.B_SPLINE_CURVE_WITH_KNOTS[0]; knots = parts.B_SPLINE_CURVE_WITH_KNOTS[1];
      if (parts.RATIONAL_B_SPLINE_CURVE) weights = parts.RATIONAL_B_SPLINE_CURVE[0];
    } else if (t === 'POLYLINE') { return { kind: 'poly', pts: a[1].map(r => C.pt(r)) }; }
    else return null;
    if (!ctrl || ctrl.some(q => !q)) return null;
    return { kind: 'bs', bs: bspline(deg, ctrl, mults, knots, weights), deg };
  }
  function edgePoints(C, smp, A, B, sense) {
    if (!smp) return A && B ? [A, B] : null;
    if (smp.kind === 'line') return [A, B];
    if (smp.kind === 'poly') return H.trimTo(smp.pts, A, B);
    if (smp.kind === 'conic') {
      const { P, r1, r2 } = smp;
      const ang = q => { const d = sub(q, P.o); return Math.atan2(dot(d, P.y) / r2, dot(d, P.x) / r1); };
      let a0 = ang(A), a1 = ang(B);
      const closed = dist(A, B) < 1e-7 * Math.max(1, r1);
      // направление параметризации — против часовой вокруг оси; EDGE_CURVE.same_sense=.F. — обратно
      if (sense) { if (closed) a1 = a0 + 2 * Math.PI; else while (a1 <= a0 + 1e-12) a1 += 2 * Math.PI; }
      else { if (closed) a1 = a0 - 2 * Math.PI; else while (a1 >= a0 - 1e-12) a1 -= 2 * Math.PI; }
      const N = Math.max(8, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 180)));
      const out = []; for (let k = 0; k <= N; k++) { const t = a0 + (a1 - a0) * k / N; out.push(add(P.o, add(mul(P.x, r1 * Math.cos(t)), mul(P.y, r2 * Math.sin(t))))); }
      out[0] = A.slice(); out[out.length - 1] = B.slice();
      return out;
    }
    const bs = smp.bs; const per = smp.deg <= 1 ? 1 : Math.max(6, Math.min(48, Math.ceil(3000 / Math.max(1, bs.spans.length))));
    const P = [bs.ev(bs.lo)];
    for (const [u0, u1] of bs.spans) for (let k = 1; k <= per; k++) P.push(bs.ev(u0 + (u1 - u0) * k / per));
    let Q = P;
    if (!sense) Q = P.slice().reverse();
    return H.trimTo(Q, A, B);
  }

  function surfaceOf(C, e, bpts, lineDirs) {
    if (!e) return I.classifySurface(bpts, null, lineDirs);
    const t = e.t, a = e.a;
    if (t === 'PLANE') { const P = C.place(a[1]); return { kind: 'plane', n: P.z, p: P.o, x: P.x }; }
    if (t === 'CYLINDRICAL_SURFACE') { const P = C.place(a[1]); return { kind: 'cylinder', a: P.z, p: P.o, x: P.x, r: a[2] * C.scale }; }
    if (t === 'CONICAL_SURFACE') { const P = C.place(a[1]); return { kind: 'cone', a: P.z, p: P.o, x: P.x, r: a[2] * C.scale }; }
    let deg1, deg2, grid, m1, m2, k1, k2, W = null;
    if (t === 'B_SPLINE_SURFACE_WITH_KNOTS') { deg1 = a[1]; deg2 = a[2]; grid = a[3]; m1 = a[8]; m2 = a[9]; k1 = a[10]; k2 = a[11]; }
    else if (t === '_COMPLEX' && e.parts.B_SPLINE_SURFACE && e.parts.B_SPLINE_SURFACE_WITH_KNOTS) {
      const b = e.parts.B_SPLINE_SURFACE, k = e.parts.B_SPLINE_SURFACE_WITH_KNOTS; deg1 = b[0]; deg2 = b[1]; grid = b[2]; m1 = k[0]; m2 = k[1]; k1 = k[2]; k2 = k[3];
      if (e.parts.RATIONAL_B_SPLINE_SURFACE) W = e.parts.RATIONAL_B_SPLINE_SURFACE[0];
    } else return I.classifySurface(bpts, null, lineDirs);
    const P = grid.map(row => row.map(r => C.pt(r)));
    const U = [], V = []; m1.forEach((m, i) => { for (let j = 0; j < m; j++) U.push(k1[i]); }); m2.forEach((m, i) => { for (let j = 0; j < m; j++) V.push(k2[i]); });
    const n1 = P.length - 1, n2 = P[0].length - 1;
    const ev = (u, v) => {
      const su = H.findSpan(U, deg1, n1, u), sv = H.findSpan(V, deg2, n2, v);
      const Nu = H.basis(U, deg1, su, u), Nv = H.basis(V, deg2, sv, v);
      let x = 0, y = 0, z = 0, w = 0;
      for (let i = 0; i <= deg1; i++) for (let j = 0; j <= deg2; j++) { const q = P[su - deg1 + i][sv - deg2 + j]; const ww = (W ? W[su - deg1 + i][sv - deg2 + j] : 1) * Nu[i] * Nv[j]; x += q[0] * ww; y += q[1] * ww; z += q[2] * ww; w += ww; }
      return [x / w, y / w, z / w];
    };
    const u0 = U[deg1], u1 = U[n1 + 1], v0 = V[deg2], v1 = V[n2 + 1];
    const g = 9, pts = [], G = [];
    for (let i = 0; i <= g; i++) { G[i] = []; for (let j = 0; j <= g; j++) { const q = ev(u0 + (u1 - u0) * (0.02 + 0.96 * i / g), v0 + (v1 - v0) * (0.02 + 0.96 * j / g)); G[i][j] = q; pts.push(q); } }
    const N = []; for (let i = 1; i < g; i++) for (let j = 1; j < g; j++) { const c = cross(sub(G[i + 1][j], G[i - 1][j]), sub(G[i][j + 1], G[i][j - 1])); if (len(c) > 1e-12) N.push(norm(c)); }
    return I.classifySurface(pts, N, lineDirs);
  }

  // ---------------------------------------------------------------- модель
  function toModel(src) {
    const doc = parse(src); const C = makeCtx(doc);
    let faceIds = [];
    for (const [id, e] of C.E) if (e.t === 'ADVANCED_FACE' || e.t === 'FACE_SURFACE') faceIds.push(id);
    if (!faceIds.length) throw new Error('В STEP не найдено твёрдое тело (только каркас или сборка без геометрии)');
    // несколько тел (сборка) — берём самое большое
    const shells = [...C.E.entries()].filter(([, e]) => e.t === 'CLOSED_SHELL' || e.t === 'OPEN_SHELL');
    if (shells.length > 1) {
      const big = shells.map(([id, e]) => ({ id, faces: (e.a[1] || []).map(r => r.r) })).sort((x, y) => y.faces.length - x.faces.length)[0];
      faceIds = big.faces.filter(id => C.E.has(id));
    }
    const ecMap = new Map(); // id EDGE_CURVE -> {faces, ...}
    const faces = new Map();
    for (const fid of faceIds) {
      const f = C.E.get(fid); const bounds = (f.a[1] || []).map(r => C.get(r)).filter(Boolean);
      const loops = [];
      for (const b of bounds) {
        const loop = C.get(b.a[1]); if (!loop) continue;
        if (loop.t === 'VERTEX_LOOP') continue;
        if (loop.t !== 'EDGE_LOOP') continue;
        const items = [];
        for (const r of loop.a[1] || []) {
          const oe = C.get(r); if (!oe || oe.t !== 'ORIENTED_EDGE') continue;
          const ecId = oe.a[3] && oe.a[3].r; const ec = C.E.get(ecId); if (!ec || ec.t !== 'EDGE_CURVE') continue;
          if (!ecMap.has(ecId)) ecMap.set(ecId, { id: ecId, ec, faces: [] });
          ecMap.get(ecId).faces.push(fid);
          items.push(ecId);
        }
        loops.push(items);
      }
      faces.set(fid, { fid, surf: C.get(f.a[2]), loopItems: loops });
    }
    const edges = [];
    for (const em of ecMap.values()) {
      const a = em.ec.a; const A = C.pt(a[1]), B = C.pt(a[2]); const sense = !(a[4] && a[4].e === 'F');
      const smp = curveSampler(C, C.get(a[3]));
      let P = null; try { P = edgePoints(C, smp, A, B, sense); } catch (e) { P = null; }
      if (!P || P.length < 2) { if (A && B) P = [A, B]; else continue; }
      const va = A ? H.vkey(A) : null, vb = B ? H.vkey(B) : null;
      const fl = em.faces.length >= 2 ? em.faces.slice(0, 2) : em.faces.slice();
      const e = H.makeEdge('s' + em.id, P, fl, va, vb);
      if (va && vb && va === vb && e.kind === 'circle') e.ring = true;
      em.e = e; edges.push(e);
    }
    const out = new Map();
    for (const f of faces.values()) {
      const loops = f.loopItems.map(items => H.chainLoop(items.map(id => ecMap.get(id) && ecMap.get(id).e).filter(Boolean)));
      const bpts = []; for (const L of loops) bpts.push(...L);
      const dirs = []; for (const items of f.loopItems) for (const id of items) { const em = ecMap.get(id); if (em && em.e && em.e.kind === 'line') dirs.push(em.e.dir); }
      out.set(f.fid, { idx: f.fid, surf: surfaceOf(C, f.surf, bpts, dirs), loops, edges: [] });
    }
    for (const e of edges) for (const fi of e.faces) if (out.has(fi)) out.get(fi).edges.push(e);
    if (!edges.length) throw new Error('В STEP не найдено рёбер');
    return { edges, faces: out, info: { scale: C.scale } };
  }

  root.STEP = { toModel, parse, makeCtx };
  if (typeof module !== 'undefined') module.exports = root.STEP;
})(typeof window !== 'undefined' ? window : globalThis);
