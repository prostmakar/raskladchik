// ===== IGES (.igs/.iges) -> модель граней и рёбер для расчёта реза трубы =====
// Поддерживается: тело MSBO (186/514/510/508/504/502) и набор обрезанных поверхностей (144/142).
// Кривые: 126 NURBS, 110 отрезок, 100 дуга, 102 составная. Поверхности: 128 NURBS, 190 плоскость,
// 192 цилиндр; остальные — по точкам границы. Преобразования 124.
(function (root) {
  'use strict';
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = a => Math.hypot(a[0], a[1], a[2]);
  const norm = a => { const l = len(a) || 1; return mul(a, 1 / l); };
  const dist = (a, b) => len(sub(a, b));

  // ---------------------------------------------------------------- чтение файла
  function bytesToText(src) {
    if (typeof src === 'string') return src;
    let s = ''; const CH = 0x8000;
    for (let i = 0; i < src.length; i += CH) s += String.fromCharCode.apply(null, src.subarray(i, i + CH));
    return s; // байты 1:1 — длины Hollerith-строк считаются в байтах
  }

  function parseParams(str, pd, rd) {
    const out = []; let i = 0; const n = str.length;
    while (i < n) {
      while (i < n && (str[i] === ' ' || str[i] === '\n' || str[i] === '\r')) i++;
      if (i >= n) break;
      // Hollerith: nH...
      const m = /^(\d+)H/.exec(str.slice(i, i + 12));
      if (m) {
        const k = +m[1]; const st = i + m[0].length;
        out.push(str.substr(st, k)); i = st + k;
        while (i < n && str[i] === ' ') i++;
        if (str[i] === rd) break; i++; continue;
      }
      let j = i; while (j < n && str[j] !== pd && str[j] !== rd) j++;
      const tok = str.slice(i, j).trim();
      out.push(tok === '' ? null : tok);
      if (str[j] === rd || j >= n) break;
      i = j + 1;
    }
    return out;
  }
  const real = v => { if (v === null || v === undefined) return 0; const x = parseFloat(String(v).replace(/[dD]/, 'e')); return isFinite(x) ? x : 0; };
  const int = v => { if (v === null || v === undefined) return 0; return Math.round(real(v)); };

  function readIGES(src) {
    const text = bytesToText(src);
    const lines = text.split(/\r\n|\n|\r/);
    let S = [], G = '', D = [], P = new Map();
    for (const raw of lines) {
      if (raw.length < 73) continue;
      const sec = raw[72];
      if (sec === 'G') G += raw.slice(0, 72);
      else if (sec === 'D') D.push(raw);
      else if (sec === 'P') { const de = parseInt(raw.slice(64, 72), 10); if (!P.has(de)) P.set(de, []); P.get(de).push(raw.slice(0, 64)); }
      else if (sec === 'S') S.push(raw.slice(0, 72));
    }
    if (!D.length) throw new Error('Это не IGES-файл (нет раздела D). Если это STEP — сохраните модель как IGES или x_t.');
    // разделители из раздела G
    let pd = ',', rd = ';';
    const g0 = G.trimStart();
    if (/^1H./.test(g0)) pd = g0[2];
    const gp = parseParams(G, pd, rd);
    if (gp[1] && gp[1].length === 1) rd = gp[1];
    const unitFlag = int(gp[13]) || 2;
    const UNIT = { 1: 25.4, 2: 1, 3: 1, 4: 304.8, 5: 1609344, 6: 1000, 7: 1e6, 8: 0.0254, 9: 0.001, 10: 10, 11: 0.0000254 };
    let scale = UNIT[unitFlag] || 1;
    if (unitFlag === 3 && gp[14]) { const u = String(gp[14]).toUpperCase(); scale = { IN: 25.4, INCH: 25.4, FT: 304.8, MM: 1, M: 1000, CM: 10 }[u] || 1; }
    const ents = new Map();
    for (let k = 0; k + 1 < D.length; k += 2) {
      const a = D[k], b = D[k + 1];
      const f = (s, i) => s.slice(i * 8, i * 8 + 8).trim();
      const de = k + 1;
      const e = { de, type: int(f(a, 0)), pptr: int(f(a, 1)), xf: int(f(a, 6)), status: f(a, 8), form: int(f(b, 4)), pcount: int(f(b, 3)) };
      ents.set(de, e);
    }
    for (const e of ents.values()) {
      const L = P.get(e.de); if (!L) { e.p = []; continue; }
      e.p = parseParams(L.join(''), pd, rd); // e.p[0] — номер типа
    }
    return { ents, scale, system: gp[4] || '', pre: gp[5] || '' };
  }

  // ---------------------------------------------------------------- преобразования 124
  function xformOf(doc, de, depth = 0) {
    const e = doc.ents.get(de); if (!e || !e.xf || depth > 10) return null;
    const t = doc.ents.get(e.xf); if (!t || t.type !== 124) return null;
    const p = t.p.slice(1).map(real);
    let M = [p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8], p[9], p[10], p[11]];
    const parent = xformOf(doc, t.de, depth + 1);
    if (parent) M = compose(parent, M);
    return M;
  }
  function compose(A, B) { // A∘B
    const r = [];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) r[i * 4 + j] = A[i * 4] * B[j] + A[i * 4 + 1] * B[4 + j] + A[i * 4 + 2] * B[8 + j];
      r[i * 4 + 3] = A[i * 4] * B[3] + A[i * 4 + 1] * B[7] + A[i * 4 + 2] * B[11] + A[i * 4 + 3];
    }
    return r;
  }
  const apX = (M, p) => M ? [M[0] * p[0] + M[1] * p[1] + M[2] * p[2] + M[3], M[4] * p[0] + M[5] * p[1] + M[6] * p[2] + M[7], M[8] * p[0] + M[9] * p[1] + M[10] * p[2] + M[11]] : p;
  const apV = (M, v) => M ? [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[4] * v[0] + M[5] * v[1] + M[6] * v[2], M[8] * v[0] + M[9] * v[1] + M[10] * v[2]] : v;

  // ---------------------------------------------------------------- NURBS
  function findSpan(U, deg, n, t) { // n — индекс последней контрольной точки
    if (t >= U[n + 1]) return n;
    if (t <= U[deg]) return deg;
    let lo = deg, hi = n + 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t < U[m]) hi = m; else lo = m; }
    return lo;
  }
  function basis(U, deg, span, t) {
    const N = [1], left = [], right = [];
    for (let j = 1; j <= deg; j++) {
      left[j] = t - U[span + 1 - j]; right[j] = U[span + j] - t;
      let saved = 0;
      for (let r = 0; r < j; r++) { const den = right[r + 1] + left[j - r]; const tmp = den ? N[r] / den : 0; N[r] = saved + right[r + 1] * tmp; saved = left[j - r] * tmp; }
      N[j] = saved;
    }
    return N;
  }
  function curve126(e, scale, M) {
    const p = e.p; const K = int(p[1]), deg = int(p[2]);
    const n = K, A = n + deg + 2;
    let i = 7; const U = []; for (let k = 0; k < A; k++) U.push(real(p[i++]));
    const W = []; for (let k = 0; k <= n; k++) W.push(real(p[i++]) || 1);
    const C = []; for (let k = 0; k <= n; k++) { C.push([real(p[i]), real(p[i + 1]), real(p[i + 2])]); i += 3; }
    const v0 = real(p[i++]), v1 = real(p[i++]);
    const ev = t => {
      const s = findSpan(U, deg, n, t), N = basis(U, deg, s, t);
      let x = 0, y = 0, z = 0, w = 0;
      for (let j = 0; j <= deg; j++) { const q = C[s - deg + j], ww = W[s - deg + j] * N[j]; x += q[0] * ww; y += q[1] * ww; z += q[2] * ww; w += ww; }
      return apX(M, [x / w * scale, y / w * scale, z / w * scale]);
    };
    // точки: по каждому промежутку узлов
    const breaks = [v0]; for (const u of U) if (u > v0 + 1e-12 && u < v1 - 1e-12 && u !== breaks[breaks.length - 1]) breaks.push(u); breaks.push(v1);
    const nsp = Math.max(1, breaks.length - 1);
    const per = deg <= 1 ? 1 : Math.max(6, Math.min(48, Math.ceil(3000 / nsp)));
    const pts = [ev(v0)];
    for (let b = 0; b + 1 < breaks.length; b++) for (let k = 1; k <= per; k++) pts.push(ev(breaks[b] + (breaks[b + 1] - breaks[b]) * k / per));
    return { pts, ctrlLine: deg === 1 && n === 1 };
  }
  function surf128(e, scale, M) {
    const p = e.p; const K1 = int(p[1]), K2 = int(p[2]), M1 = int(p[3]), M2 = int(p[4]);
    let i = 10; const S = [], T = [];
    for (let k = 0; k < K1 + M1 + 2; k++) S.push(real(p[i++]));
    for (let k = 0; k < K2 + M2 + 2; k++) T.push(real(p[i++]));
    const W = []; for (let k = 0; k < (K1 + 1) * (K2 + 1); k++) W.push(real(p[i++]) || 1);
    const C = []; for (let k = 0; k < (K1 + 1) * (K2 + 1); k++) { C.push([real(p[i]), real(p[i + 1]), real(p[i + 2])]); i += 3; }
    const u0 = real(p[i++]), u1 = real(p[i++]), v0 = real(p[i++]), v1 = real(p[i++]);
    const ev = (u, v) => {
      const su = findSpan(S, M1, K1, u), sv = findSpan(T, M2, K2, v);
      const Nu = basis(S, M1, su, u), Nv = basis(T, M2, sv, v);
      let x = 0, y = 0, z = 0, w = 0;
      for (let b = 0; b <= M2; b++) for (let a = 0; a <= M1; a++) {
        const idx = (sv - M2 + b) * (K1 + 1) + (su - M1 + a);
        const ww = W[idx] * Nu[a] * Nv[b]; const q = C[idx];
        x += q[0] * ww; y += q[1] * ww; z += q[2] * ww; w += ww;
      }
      return apX(M, [x / w * scale, y / w * scale, z / w * scale]);
    };
    return { ev, u0, u1, v0, v1 };
  }

  // ---------------------------------------------------------------- кривые
  // точки кривой в мм (с учётом преобразований)
  function curvePts(doc, de, depth = 0) {
    const e = doc.ents.get(de); if (!e || depth > 20) return null;
    const M = xformOf(doc, de), s = doc.scale, p = e.p;
    if (e.type === 126) return curve126(e, s, M).pts;
    if (e.type === 110) return [apX(M, [real(p[1]) * s, real(p[2]) * s, real(p[3]) * s]), apX(M, [real(p[4]) * s, real(p[5]) * s, real(p[6]) * s])];
    if (e.type === 100) {
      const zt = real(p[1]), cx = real(p[2]), cy = real(p[3]), sx = real(p[4]), sy = real(p[5]), ex = real(p[6]), ey = real(p[7]);
      const r = Math.hypot(sx - cx, sy - cy);
      let a0 = Math.atan2(sy - cy, sx - cx), a1 = Math.atan2(ey - cy, ex - cx);
      if (Math.hypot(ex - sx, ey - sy) < 1e-9 * Math.max(1, r)) a1 = a0 + 2 * Math.PI; else while (a1 <= a0) a1 += 2 * Math.PI;
      const n = Math.max(8, Math.ceil((a1 - a0) / (Math.PI / 96)));
      const out = []; for (let k = 0; k <= n; k++) { const t = a0 + (a1 - a0) * k / n; out.push(apX(M, [(cx + r * Math.cos(t)) * s, (cy + r * Math.sin(t)) * s, zt * s])); }
      return out;
    }
    if (e.type === 102) {
      const n = int(p[1]); const out = [];
      for (let k = 0; k < n; k++) { let q = curvePts(doc, int(p[2 + k]), depth + 1); if (!q) continue; if (M) q = q.map(v => apX(M, v)); let seg = q; if (out.length) { const last = out[out.length - 1]; if (dist(seg[seg.length - 1], last) < dist(seg[0], last)) seg = seg.slice().reverse(); seg = seg.slice(1); } out.push(...seg); }
      return out.length ? out : null;
    }
    return null;
  }
  // составная кривая -> отдельные сегменты (каждый — будущее ребро)
  function curveSegments(doc, de, depth = 0) {
    const e = doc.ents.get(de); if (!e || depth > 20) return [];
    if (e.type === 102) { const M = xformOf(doc, de); const out = []; for (let k = 0; k < int(e.p[1]); k++) out.push(...curveSegments(doc, int(e.p[2 + k]), depth + 1).map(P => M ? P.map(v => apX(M, v)) : P)); return out; }
    const q = curvePts(doc, de); return q ? [q] : [];
  }

  // длина и вид кривой по точкам
  function polyLen(P) { let s = 0; for (let i = 1; i < P.length; i++) s += dist(P[i - 1], P[i]); return s; }
  function circleThrough(a, b, c) {
    const ab = sub(b, a), ac = sub(c, a), n = cross(ab, ac); const nn = dot(n, n); if (nn < 1e-18) return null;
    const ctr = add(a, mul(add(mul(cross(n, ab), dot(ac, ac)), mul(cross(ac, n), dot(ab, ab))), 1 / (2 * nn)));
    return { c: ctr, r: dist(ctr, a), n: norm(n) };
  }
  function classifyCurve(P) {
    const L = polyLen(P); const closed = P.length > 2 && dist(P[0], P[P.length - 1]) < 1e-6 * Math.max(1, L);
    if (!closed) {
      const a = P[0], b = P[P.length - 1], ab = sub(b, a), lab = len(ab);
      let dev = 0; if (lab > 1e-9) for (const q of P) { const d = len(cross(sub(q, a), ab)) / lab; if (d > dev) dev = d; }
      if (lab > 1e-9 && dev < 1e-4 * Math.max(1, lab)) return { kind: 'line', len: lab, dir: norm(ab), pts: [a, b] };
    }
    if (P.length >= 5) {
      const i1 = Math.floor(P.length / 3), i2 = Math.floor(2 * P.length / 3);
      const c = circleThrough(P[0], P[i1], P[i2]);
      if (c && c.r < 1e6) {
        let ok = true; for (const q of P) { if (Math.abs(dist(q, c.c) - c.r) > 1e-3 + 1e-5 * c.r || Math.abs(dot(sub(q, c.c), c.n)) > 1e-3) { ok = false; break; } }
        if (ok) { let ang = 0; for (let i = 1; i < P.length; i++) { const ch = Math.min(1, dist(P[i - 1], P[i]) / (2 * c.r)); ang += 2 * Math.asin(ch); } return { kind: 'circle', len: c.r * ang, r: c.r, closed, pts: P }; }
      }
    }
    // Ричардсон по половине точек для общей кривой
    let Lh = 0; for (let i = 2; i < P.length; i += 2) Lh += dist(P[i - 2], P[i]);
    const Lr = P.length % 2 === 1 && P.length > 4 ? L + (L - Lh) / 3 : L;
    return { kind: 'other', len: Lr, closed, pts: P };
  }

  // ---------------------------------------------------------------- поверхности
  function eig3(A) { // симметричная 3×3, Якоби: [значения], [векторы-столбцы]
    const a = [[A[0][0], A[0][1], A[0][2]], [A[1][0], A[1][1], A[1][2]], [A[2][0], A[2][1], A[2][2]]];
    const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let it = 0; it < 50; it++) {
      let p = 0, q = 1; if (Math.abs(a[0][2]) > Math.abs(a[p][q])) { p = 0; q = 2; } if (Math.abs(a[1][2]) > Math.abs(a[p][q])) { p = 1; q = 2; }
      if (Math.abs(a[p][q]) < 1e-15) break;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]); const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)); const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
      for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < 3; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
    }
    const vals = [a[0][0], a[1][1], a[2][2]];
    const idx = [0, 1, 2].sort((i, j) => vals[j] - vals[i]); // по убыванию
    return { vals: idx.map(i => vals[i]), vecs: idx.map(i => [V[0][i], V[1][i], V[2][i]]) };
  }
  function cov(P, c) { const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; for (const q of P) { const d = c ? sub(q, c) : q; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) A[i][j] += d[i] * d[j]; } return A; }
  function centroid(P) { let s = [0, 0, 0]; for (const q of P) s = add(s, q); return mul(s, 1 / P.length); }
  const perp = a => norm(cross(a, Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
  function fitCircle2(Q) { // алгебраическая окружность по 2D-точкам
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0; const n = Q.length;
    for (const [x, y] of Q) { const z = x * x + y * y; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z; sz += z; }
    const A = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]], b = [-sxz, -syz, -sz];
    const det = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D0 = det(A); if (Math.abs(D0) < 1e-20) return null;
    const rep = (k) => A.map((r, i) => r.map((v, j) => j === k ? b[i] : v));
    const D = det(rep(0)) / D0, E = det(rep(1)) / D0, F = det(rep(2)) / D0;
    const cx = -D / 2, cy = -E / 2, r2 = cx * cx + cy * cy - F; if (r2 <= 0) return null;
    return { cx, cy, r: Math.sqrt(r2) };
  }
  // P — точки на поверхности; Nn — нормали (по желанию); axes — направления-кандидаты оси
  function classifySurface(P, Nn, axes) {
    if (P.length < 4) return { kind: 'other' };
    const c = centroid(P); const E = eig3(cov(P, c));
    const size = Math.sqrt(Math.max(E.vals[0], 1e-12) / P.length);
    if (Math.sqrt(Math.max(0, E.vals[2]) / P.length) < 1e-4 * Math.max(1, size) + 1e-5) {
      let n = norm(E.vecs[2]); let mx = 0; for (const q of P) mx = Math.max(mx, Math.abs(dot(sub(q, c), n)));
      if (mx < 2e-3) return { kind: 'plane', n, p: c, x: norm(E.vecs[0]) };
    }
    const cands = [];
    if (Nn && Nn.length >= 3) { const En = eig3(cov(Nn, null)); const a = norm(En.vecs[2]); let mx = 0; for (const n of Nn) mx = Math.max(mx, Math.abs(dot(n, a))); if (mx < 2e-3) cands.push(a); }
    for (const a of axes || []) cands.push(norm(a));
    let best = null;
    for (const a of cands) {
      const X = perp(a), Y = cross(a, X);
      const Q = P.map(q => [dot(q, X), dot(q, Y)]);
      const f = fitCircle2(Q); if (!f || f.r > 1e5) continue;
      let mx = 0; for (const [x, y] of Q) mx = Math.max(mx, Math.abs(Math.hypot(x - f.cx, y - f.cy) - f.r));
      if (mx < 2e-3 + 1e-5 * f.r && (!best || mx < best.mx)) {
        const p0 = add(mul(X, f.cx), mul(Y, f.cy)); // точка на оси (с точностью до сдвига вдоль оси)
        best = { mx, s: { kind: 'cylinder', a, p: add(p0, mul(a, dot(c, a))), x: X, r: f.r } };
      }
    }
    return best ? best.s : { kind: 'other' };
  }
  function surfaceInfo(doc, de, boundaryPts, lineDirs) {
    const e = doc.ents.get(de); if (!e) return classifySurface(boundaryPts || [], null, lineDirs);
    const M = xformOf(doc, de), s = doc.scale, p = e.p;
    if (e.type === 128) {
      const S = surf128(e, s, M);
      const n = 9, P = [], G = [];
      for (let i = 0; i <= n; i++) { G[i] = []; for (let j = 0; j <= n; j++) { const u = S.u0 + (S.u1 - S.u0) * (0.02 + 0.96 * i / n), v = S.v0 + (S.v1 - S.v0) * (0.02 + 0.96 * j / n); const q = S.ev(u, v); G[i][j] = q; P.push(q); } }
      const N = [];
      for (let i = 1; i < n; i++) for (let j = 1; j < n; j++) { const du = sub(G[i + 1][j], G[i - 1][j]), dv = sub(G[i][j + 1], G[i][j - 1]); const c = cross(du, dv); if (len(c) > 1e-12) N.push(norm(c)); }
      return classifySurface(P, N, lineDirs);
    }
    const pt = d => { const q = doc.ents.get(d); return q ? apX(xformOf(doc, d), [real(q.p[1]) * s, real(q.p[2]) * s, real(q.p[3]) * s]) : null; };
    const dir = d => { const q = doc.ents.get(d); return q ? norm(apV(xformOf(doc, d), [real(q.p[1]), real(q.p[2]), real(q.p[3])])) : null; };
    if (e.type === 120) { // поверхность вращения: ось + образующая
      const ax = curvePts(doc, int(p[1])), gen = curvePts(doc, int(p[2]));
      if (ax && gen && ax.length >= 2 && gen.length >= 2) {
        const A0 = apX(M, ax[0]), A1 = apX(M, ax[ax.length - 1]), a = norm(sub(A1, A0));
        const G = gen.map(q => apX(M, q));
        const rad = q => { const d = sub(q, A0); return len(sub(d, mul(a, dot(d, a)))); };
        const r0 = rad(G[0]); let same = true; for (const q of G) if (Math.abs(rad(q) - r0) > 1e-4 * Math.max(1, r0)) { same = false; break; }
        if (same && r0 > 1e-6) return { kind: 'cylinder', a, p: A0, x: perp(a), r: r0 };
        let isLine = gen.length === 2; if (isLine) { const g = norm(sub(G[1], G[0])); if (Math.abs(dot(g, a)) > 1e-9) return { kind: 'cone', a, p: A0, x: perp(a), r: r0 }; }
        if (Math.abs(dot(norm(sub(G[G.length - 1], G[0])), a)) < 1e-9 && gen.length === 2) return { kind: 'plane', n: a, p: G[0], x: perp(a) };
      }
      return classifySurface(boundaryPts || [], null, lineDirs);
    }
    if (e.type === 190) { const P0 = pt(int(p[1])), n = dir(int(p[2])); if (P0 && n) return { kind: 'plane', n: norm(apV(M, n)), p: apX(M, P0), x: perp(n) }; }
    if (e.type === 192) { const P0 = pt(int(p[1])), a = dir(int(p[2])); if (P0 && a) return { kind: 'cylinder', a: norm(apV(M, a)), p: apX(M, P0), x: perp(a), r: real(p[3]) * s }; }
    if (e.type === 108 && int(p[5]) === 0) { const n = norm(apV(M, [real(p[1]), real(p[2]), real(p[3])])); return classifySurface(boundaryPts || [], null, lineDirs).kind === 'plane' ? classifySurface(boundaryPts, null, lineDirs) : { kind: 'plane', n, p: boundaryPts && boundaryPts[0] || [0, 0, 0], x: perp(n) }; }
    return classifySurface(boundaryPts || [], null, lineDirs);
  }

  // ---------------------------------------------------------------- модель
  const vkey = q => Math.round(q[0] * 200) + ':' + Math.round(q[1] * 200) + ':' + Math.round(q[2] * 200); // 0,005 мм
  function makeEdge(id, P, faces, va, vb) {
    const c = classifyCurve(P);
    const pts = c.kind === 'line' ? c.pts : simplify3(c.pts, 0.004);
    return { id, va, vb, faces, g: { len: c.len, pts, approx: false }, kind: c.kind, dir: c.dir || null, r: c.r || null, ring: c.kind === 'circle' && !!c.closed };
  }
  function simplify3(P, tol) { // Дуглас — Пекер, концы сохраняются
    if (P.length < 3) return P;
    const keep = new Uint8Array(P.length); keep[0] = keep[P.length - 1] = 1; const st = [[0, P.length - 1]];
    while (st.length) { const [a, b] = st.pop(); if (b - a < 2) continue; const A = P[a], B = P[b], ab = sub(B, A), L = len(ab); let bi = -1, bd = tol;
      for (let i = a + 1; i < b; i++) { const d = L > 1e-9 ? len(cross(sub(P[i], A), ab)) / L : dist(P[i], A); if (d > bd) { bd = d; bi = i; } }
      if (bi < 0 && L < 1e-9 && b - a > 2) bi = (a + b) >> 1; // замкнутая кривая
      if (bi >= 0) { keep[bi] = 1; st.push([a, bi], [bi, b]); } }
    const out = []; for (let i = 0; i < P.length; i++) if (keep[i]) out.push(P[i]); return out;
  }
  function thin(P, k) { if (k <= 1 || P.length < 10) return P; const out = []; for (let i = 0; i < P.length; i += k) out.push(P[i]); if (out[out.length - 1] !== P[P.length - 1]) out.push(P[P.length - 1]); return out; }

  // вариант 1: тело (186)
  function fromMSBO(doc) {
    const shells = [];
    for (const e of doc.ents.values()) if (e.type === 186) { shells.push(int(e.p[1])); const nv = int(e.p[3]); for (let k = 0; k < nv; k++) shells.push(int(e.p[4 + 2 * k])); }
    if (!shells.length) for (const e of doc.ents.values()) if (e.type === 514) shells.push(e.de);
    const faceDEs = [];
    for (const sd of shells) { const sh = doc.ents.get(sd); if (!sh || sh.type !== 514) continue; const n = int(sh.p[1]); for (let k = 0; k < n; k++) faceDEs.push(int(sh.p[2 + 2 * k])); }
    if (!faceDEs.length) return null;
    const vcache = new Map();
    const vertex = (vl, i) => { const k = vl + ':' + i; if (vcache.has(k)) return vcache.get(k); const v = doc.ents.get(vl); let q = null; if (v && v.type === 502) { const b = 2 + (i - 1) * 3; q = apX(xformOf(doc, vl), [real(v.p[b]) * doc.scale, real(v.p[b + 1]) * doc.scale, real(v.p[b + 2]) * doc.scale]); } vcache.set(k, q); return q; };
    const edgeMap = new Map(); // "504:i" -> {faces:[], ...}
    const faces = new Map();
    for (const fd of faceDEs) {
      const f = doc.ents.get(fd); if (!f || f.type !== 510) continue;
      const nl = int(f.p[2]); const loops = [];
      for (let k = 0; k < nl; k++) {
        const L = doc.ents.get(int(f.p[4 + k])); if (!L || L.type !== 508) continue;
        const ne = int(L.p[1]); let i = 2; const items = [];
        for (let m = 0; m < ne; m++) {
          const typ = int(L.p[i]), lst = int(L.p[i + 1]), idx = int(L.p[i + 2]), ori = int(L.p[i + 3]), kc = int(L.p[i + 4]);
          i += 5 + 2 * kc;
          if (typ !== 0) continue; // вершина вместо ребра
          items.push({ key: lst + ':' + idx, lst, idx, ori });
        }
        loops.push(items);
      }
      faces.set(fd, { fd, surfDE: int(f.p[1]), loopItems: loops });
      for (const items of loops) for (const it of items) {
        if (!edgeMap.has(it.key)) {
          const el = doc.ents.get(it.lst); if (!el || el.type !== 504) continue;
          const b = 2 + (it.idx - 1) * 5;
          const cde = int(el.p[b]), A = vertex(int(el.p[b + 1]), int(el.p[b + 2])), B = vertex(int(el.p[b + 3]), int(el.p[b + 4]));
          edgeMap.set(it.key, { key: it.key, cde, A, B, faces: [] });
        }
        const em = edgeMap.get(it.key); if (em) em.faces.push(fd); // шов цилиндра: одна грань дважды
      }
    }
    // геометрия рёбер
    const edges = [];
    for (const em of edgeMap.values()) {
      let P = curvePts(doc, em.cde);
      if (!P || P.length < 2) { if (em.A && em.B) P = [em.A, em.B]; else continue; }
      P = trimTo(P, em.A, em.B);
      const va = em.A ? vkey(em.A) : null, vb = em.B ? vkey(em.B) : null;
      const fl = em.faces.length >= 2 ? em.faces.slice(0, 2) : em.faces.slice();
      const e = makeEdge(em.key, P, fl, va, vb);
      if (va && vb && va === vb) { e.va = va; e.vb = va; if (e.kind === 'circle') e.ring = true; }
      em.e = e; edges.push(e);
    }
    const out = new Map();
    for (const f of faces.values()) {
      const loops = f.loopItems.map(items => chainLoop(items.map(it => edgeMap.get(it.key) && edgeMap.get(it.key).e).filter(Boolean)));
      const bpts = []; for (const L of loops) for (const q of L) bpts.push(q);
      const lineDirs = []; for (const items of f.loopItems) for (const it of items) { const em = edgeMap.get(it.key); if (em && em.e && em.e.kind === 'line') lineDirs.push(em.e.dir); }
      out.set(f.fd, { idx: f.fd, surf: surfaceInfo(doc, f.surfDE, bpts, lineDirs), loops, edges: [] });
    }
    for (const e of edges) for (const fi of e.faces) if (out.has(fi)) out.get(fi).edges.push(e);
    return { edges, faces: out };
  }
  // кривая может быть длиннее ребра — обрезаем по вершинам
  function trimTo(P, A, B) {
    if (!A || !B) return P;
    const near = q => { let bi = 0, bd = Infinity; for (let i = 0; i < P.length; i++) { const d = dist(P[i], q); if (d < bd) { bd = d; bi = i; } } return bi; };
    const ia = near(A), ib = near(B);
    if (dist(A, B) < 1e-6) { // замкнутое ребро
      if (dist(P[0], P[P.length - 1]) < 1e-6) return ia === 0 || ia === P.length - 1 ? P : P.slice(ia).concat(P.slice(1, ia + 1));
      return P;
    }
    let Q = ia <= ib ? P.slice(ia, ib + 1) : P.slice(ib, ia + 1).reverse();
    if (Q.length < 2) Q = [A, B];
    Q[0] = A.slice(); Q[Q.length - 1] = B.slice();
    return Q;
  }
  function chainLoop(es) {
    const pts = [];
    for (const e of es) {
      let seg = e.g.pts.slice();
      if (pts.length && seg.length) { const last = pts[pts.length - 1]; if (dist(seg[seg.length - 1], last) < dist(seg[0], last)) seg.reverse(); }
      pts.push(...seg);
    }
    return pts;
  }

  // вариант 2: обрезанные поверхности (144), рёбра — совпадающие куски границ
  function fromTrimmed(doc) {
    const tri = [...doc.ents.values()].filter(e => e.type === 144 || e.type === 143);
    if (!tri.length) return null;
    const segs = []; // {face, P}
    const faceInfo = [];
    for (const t of tri) {
      const p = t.p; const surfDE = int(p[1]);
      const bnds = [];
      if (t.type === 144) { const n2 = int(p[3]), outer = int(p[4]); if (outer) bnds.push(outer); for (let k = 0; k < n2; k++) bnds.push(int(p[5 + k])); }
      else { const nb = int(p[3]); for (let k = 0; k < nb; k++) bnds.push(int(p[4 + k])); }
      const fi = faceInfo.length; const loops = [];
      for (const bd of bnds) {
        const b = doc.ents.get(bd); if (!b) continue;
        let model = 0;
        if (b.type === 142) model = int(b.p[4]);
        else if (b.type === 141) model = 0;
        let parts = model ? curveSegments(doc, model) : [];
        if (!parts.length && b.type === 142) parts = pcurveSegments(doc, int(b.p[3]), int(b.p[2]));
        const L = [];
        for (const P of parts) { if (P.length < 2) continue; segs.push({ face: fi, P }); L.push(P); }
        loops.push(L);
      }
      faceInfo.push({ de: t.de, surfDE, loops });
    }
    if (!segs.length) return null;
    // общие рёбра: одинаковые концы и середина (0,02 мм)
    const q = v => Math.round(v * 50);
    const key = P => { const a = P[0], b = P[P.length - 1], m = P[Math.floor(P.length / 2)]; const ka = q(a[0]) + ',' + q(a[1]) + ',' + q(a[2]), kb = q(b[0]) + ',' + q(b[1]) + ',' + q(b[2]); return (ka < kb ? ka + '|' + kb : kb + '|' + ka) + '|' + q(m[0]) + ',' + q(m[1]) + ',' + q(m[2]); };
    const map = new Map();
    for (const s of segs) { const k = key(s.P); if (!map.has(k)) map.set(k, { P: s.P, faces: [] }); const m = map.get(k); if (!m.faces.includes(s.face)) m.faces.push(s.face); s.k = k; }
    const edges = []; let id = 0;
    for (const [k, m] of map) {
      const A = m.P[0], B = m.P[m.P.length - 1];
      const e = makeEdge('t' + (id++), m.P, m.faces.slice(0, 2).map(fi => faceInfo[fi].de), vkey(A), vkey(B));
      m.e = e; edges.push(e);
    }
    const faces = new Map();
    faceInfo.forEach((f, fi) => {
      const loops = f.loops.map(L => chainLoop(L.map(P => map.get(key(P)).e)));
      const bpts = []; for (const L of loops) bpts.push(...L);
      const lineDirs = []; for (const L of f.loops) for (const P of L) { const e = map.get(key(P)).e; if (e.kind === 'line') lineDirs.push(e.dir); }
      faces.set(f.de, { idx: f.de, surf: surfaceInfo(doc, f.surfDE, bpts, lineDirs), loops, edges: [] });
    });
    for (const e of edges) for (const fi of e.faces) if (faces.has(fi)) faces.get(fi).edges.push(e);
    return { edges, faces };
  }
  // кривая в параметрах поверхности -> пространство (если нет пространственной кривой)
  function pcurveSegments(doc, cde, sde) {
    const s = doc.ents.get(sde); if (!s || s.type !== 128) return [];
    const S = surf128(s, doc.scale, xformOf(doc, sde));
    const flat = (de, depth = 0) => {
      const e = doc.ents.get(de); if (!e || depth > 20) return [];
      if (e.type === 102) { const out = []; for (let k = 0; k < int(e.p[1]); k++) out.push(...flat(int(e.p[2 + k]), depth + 1)); return out; }
      let P = null;
      if (e.type === 126) { const save = doc.scale; P = curve126(e, 1, null).pts; doc.scale = save; }
      else if (e.type === 110) P = [[real(e.p[1]), real(e.p[2])], [real(e.p[4]), real(e.p[5])]];
      if (!P) return [];
      if (P.length === 2) { const a = P[0], b = P[1]; P = []; for (let k = 0; k <= 24; k++) P.push([a[0] + (b[0] - a[0]) * k / 24, a[1] + (b[1] - a[1]) * k / 24]); }
      return [P.map(uv => S.ev(uv[0], uv[1]))];
    };
    return flat(cde);
  }

  function toModel(src) {
    const doc = readIGES(src);
    const m = fromMSBO(doc) || fromTrimmed(doc);
    if (!m || !m.edges.length) throw new Error('В IGES не найдено твёрдое тело или поверхности (возможно, только каркас). Сохраните модель как тело (Solid) или в x_t.');
    m.info = { system: doc.system, scale: doc.scale };
    return m;
  }

  root.IGES = { toModel, readIGES, parseParams, classifySurface, classifyCurve, _int: { curvePts, surf128, eig3, makeEdge, trimTo, chainLoop, vkey, simplify3, findSpan, basis, perp } };
  if (typeof module !== 'undefined') module.exports = root.IGES;
})(typeof window !== 'undefined' ? window : globalThis);
