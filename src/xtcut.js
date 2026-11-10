// ===== Parasolid text X_T reader + tube cut-length calculator =====
// Works fully offline. Units in result: millimetres.
(function (root) {
  'use strict';

  // ---------- low level reader ----------
  function Reader(s, p) { this.s = s; this.p = p; }
  Reader.prototype.ws = function () { const s = this.s; while (this.p < s.length && s.charCodeAt(this.p) === 32) this.p++; };
  Reader.prototype.int = function () {
    this.ws(); const s = this.s; let p = this.p, st = p;
    if (s[p] === '-') p++;
    const d0 = p; while (p < s.length && s.charCodeAt(p) >= 48 && s.charCodeAt(p) <= 57) p++;
    if (p === d0) throw 0;
    if (s[p] === '.' || s[p] === 'e' || s[p] === 'E') throw 0; // not an integer
    this.p = p; return parseInt(s.slice(st, p), 10);
  };
  Reader.prototype.real = function (allowNull) {
    this.ws(); const s = this.s; let p = this.p;
    if (s[p] === '?') { if (!allowNull) throw 0; this.p = p + 1; return null; }
    const m = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(s.slice(p, p + 40));
    if (!m) throw 0; this.p = p + m[0].length; return parseFloat(m[0]);
  };
  Reader.prototype.sense = function () {
    this.ws(); const c = this.s[this.p];
    if (c !== '+' && c !== '-') throw 0; this.p++; return c;
  };
  Reader.prototype.vec = function () { return [this.real(), this.real(), this.real()]; };

  // record layouts (fields after type [and optional 255] and idx)
  const CURVE_HDR = r => ({ node: r.int(), attr: r.int(), owner: r.int(), next: r.int(), prev: r.int(), gowner: r.int(), sense: r.sense() });
  const LAYOUT = {
    14: r => ({ node: r.int(), attr: r.int(), tol: r.real(true), next: r.int(), prev: r.int(), loop: r.int(), shell: r.int(), surface: r.int(), sense: r.sense() }),
    15: r => ({ node: r.int(), attr: r.int(), fin: r.int(), face: r.int(), next: r.int() }),
    16: r => ({ node: r.int(), attr: r.int(), tol: r.real(true), fin: r.int(), prev: r.int(), next: r.int(), curve: r.int() }),
    17: r => ({ attr: r.int(), loop: r.int(), forward: r.int(), backward: r.int(), vertex: r.int(), other: r.int(), edge: r.int(), curve: r.int(), nextvx: r.int(), sense: r.sense() }),
    18: r => ({ node: r.int(), attr: r.int(), fin: r.int(), prev: r.int(), next: r.int(), point: r.int() }),
    29: r => ({ node: r.int(), attr: r.int(), owner: r.int(), next: r.int(), prev: r.int(), pos: r.vec() }),
    30: r => Object.assign(CURVE_HDR(r), { kind: 'line', p: r.vec(), d: r.vec() }),
    31: r => Object.assign(CURVE_HDR(r), { kind: 'circle', c: r.vec(), n: r.vec(), x: r.vec(), r: r.real() }),
    32: r => Object.assign(CURVE_HDR(r), { kind: 'ellipse', c: r.vec(), n: r.vec(), x: r.vec(), R: r.real(), r: r.real() }),
    50: r => Object.assign(CURVE_HDR(r), { kind: 'plane', p: r.vec(), n: r.vec(), x: r.vec() }),
    51: r => Object.assign(CURVE_HDR(r), { kind: 'cylinder', p: r.vec(), a: r.vec(), r: r.real(), x: r.vec() }),
    52: r => Object.assign(CURVE_HDR(r), { kind: 'cone', p: r.vec(), a: r.vec(), r: r.real(), sin: r.real(), cos: r.real(), x: r.vec() }),
    53: r => Object.assign(CURVE_HDR(r), { kind: 'sphere', c: r.vec(), r: r.real(), a: r.vec(), x: r.vec() }),
    54: r => Object.assign(CURVE_HDR(r), { kind: 'torus', c: r.vec(), a: r.vec(), R: r.real(), r: r.real(), x: r.vec() }),
  };
  const CURVES = new Set([30, 31, 32]);
  const SURFS = new Set([50, 51, 52, 53, 54]);

  function bodyText(text) {
    const lines = text.split(/\r?\n/);
    let i = lines.findIndex(l => l.indexOf('END_OF_HEADER') >= 0);
    if (i < 0) {
      if (/^\s*\*\*/.test(text) || text.indexOf('PARASOLID') < 0) throw new Error('Не похоже на текстовый x_t (Parasolid)');
      i = -1;
    }
    return lines.slice(i + 1).join('');
  }

  // ---------- candidate scan ----------
  function scan(S) {
    const cands = []; // all parsed candidates
    const isD = c => c >= 48 && c <= 57;
    for (let i = 0; i < S.length; i++) {
      const c = S.charCodeAt(i);
      if (!isD(c)) continue;
      const pc = i ? S[i - 1] : ' ';
      if ((pc >= '0' && pc <= '9') || pc === '.') continue;
      // read type
      let j = i; while (j < S.length && isD(S.charCodeAt(j))) j++;
      if (S[j] !== ' ') continue;
      const T = +S.slice(i, j);
      const lay = LAYOUT[T]; if (!lay) continue;
      for (const skip255 of [false, true]) {
        const r = new Reader(S, j);
        try {
          if (skip255) { if (r.int() !== 255) continue; }
          const idx = r.int(); if (idx <= 0) continue;
          const f = lay(r); f.type = T; f.idx = idx; f.start = i; f.end = r.p;
          cands.push(f);
        } catch (e) { /* not a record */ }
      }
    }
    return cands;
  }

  function resolve(cands) {
    let alive = cands.slice();
    for (let iter = 0; iter < 20; iter++) {
      const by = new Map(); // idx -> list
      for (const c of alive) { if (!by.has(c.idx)) by.set(c.idx, []); by.get(c.idx).push(c); }
      const get = (i, pred) => (by.get(i) || []).filter(pred);
      const ok = c => {
        switch (c.type) {
          case 17: return get(c.loop, x => x.type === 15).length && get(c.edge, x => x.type === 16).length && get(c.other, x => x.type === 17 && x.other === c.idx && x.edge === c.edge).length && (c.vertex === 0 || get(c.vertex, x => x.type === 18).length);
          case 16: return get(c.fin, x => x.type === 17 && x.edge === c.idx).length && (c.curve === 0 || get(c.curve, x => CURVES.has(x.type) || x.type > 54 || true).length || true);
          case 15: return get(c.fin, x => x.type === 17 && x.loop === c.idx).length && get(c.face, x => x.type === 14).length;
          case 14: return get(c.loop, x => x.type === 15 && x.face === c.idx).length && get(c.surface, x => SURFS.has(x.type) || true).length >= 0;
          case 18: return get(c.point, x => x.type === 29 && x.owner === c.idx).length && get(c.fin, x => x.type === 17 && x.vertex === c.idx).length;
          case 29: return get(c.owner, x => x.type === 18 && x.point === c.idx).length > 0;
          default: // curves & surfaces: must be owned by an edge/face referencing them
            if (CURVES.has(c.type)) return get(c.owner, x => x.type === 16 && x.curve === c.idx).length > 0;
            if (SURFS.has(c.type)) return get(c.owner, x => x.type === 14 && x.surface === c.idx).length > 0;
            return false;
        }
      };
      const next = alive.filter(ok);
      if (next.length === alive.length) break;
      alive = next;
    }
    const map = new Map();
    for (const c of alive) {
      if (map.has(c.idx)) { // ambiguity: keep the longer (more complete) parse
        const o = map.get(c.idx); if (c.end - c.start > o.end - o.start) map.set(c.idx, c);
      } else map.set(c.idx, c);
    }
    return map;
  }

  // ---------- vector helpers ----------
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = a => Math.hypot(a[0], a[1], a[2]);
  const norm = a => { const l = len(a) || 1; return mul(a, 1 / l); };

  // ---------- build model ----------
  function buildModel(text) {
    const S = bodyText(text);
    const M = resolve(scan(S));
    const faces = [], edges = [];
    for (const n of M.values()) { if (n.type === 14) faces.push(n); if (n.type === 16) edges.push(n); }
    if (!faces.length || !edges.length) throw new Error('Не удалось прочитать геометрию из файла');
    const point = vi => { if (!vi) return null; const v = M.get(vi); const p = v && M.get(v.point); return p ? mul(p.pos, 1000) : null; };
    const faceOfFin = fi => { const f = M.get(fi); const l = f && M.get(f.loop); return l ? l.face : 0; };
    // edge objects
    const E = edges.map(e => {
      const f1 = M.get(e.fin), f2 = M.get(f1.other);
      const crv = M.get(e.curve) || null;
      return { idx: e.idx, curve: crv, fin: f1, va: f1.vertex, vb: f2 ? f2.vertex : 0, A: point(f1.vertex), B: point(f2 ? f2.vertex : 0), faces: [faceOfFin(f1.idx), faceOfFin(f2 ? f2.idx : 0)] };
    });
    const F = new Map();
    for (const f of faces) F.set(f.idx, { idx: f.idx, surf: M.get(f.surface) || null, edges: [] });
    for (const e of E) for (const fi of e.faces) if (F.has(fi)) F.get(fi).edges.push(e);
    return { M, E, F };
  }

  // ---------- edge geometry ----------
  // Returns sample points (mm) along edge and exact length.
  function edgeGeom(e, arcMode) {
    const c = e.curve;
    if (!c) return { len: e.A && e.B ? len(sub(e.A, e.B)) : 0, pts: [e.A, e.B].filter(Boolean), approx: true };
    if (c.kind === 'line') {
      if (!e.A || !e.B) return { len: 0, pts: [], approx: true };
      return { len: len(sub(e.A, e.B)), pts: [e.A, e.B] };
    }
    if (c.kind === 'circle' || c.kind === 'ellipse') {
      const C = mul(c.c, 1000), N = norm(c.n), X = norm(c.x), Y = cross(N, X);
      const R1 = (c.kind === 'circle' ? c.r : c.R) * 1000, R2 = c.r * 1000;
      const ang = P => { const d = sub(P, C); return Math.atan2(dot(d, Y) / R2, dot(d, X) / R1); };
      let t0 = 0, t1 = 2 * Math.PI;
      if (e.A && e.B && len(sub(e.A, e.B)) > 1e-6) {
        // direction: edge runs along fin; fin '+' => same as curve; curve sense '-' flips
        let a = ang(e.A), b = ang(e.B);
        let dir = -(e.fin.sense === '+' ? 1 : -1) * (c.sense === '+' ? 1 : -1);
        let d = b - a; if (dir > 0) { while (d <= 0) d += 2 * Math.PI; } else { while (d >= 0) d -= 2 * Math.PI; }
        t0 = a; t1 = a + d;
      }
      const n = Math.max(8, Math.ceil(Math.abs(t1 - t0) / (Math.PI / 36)));
      const pts = []; let L = 0, prev = null;
      for (let i = 0; i <= n; i++) {
        const t = t0 + (t1 - t0) * i / n;
        const P = add(C, add(mul(X, R1 * Math.cos(t)), mul(Y, R2 * Math.sin(t))));
        if (prev) L += len(sub(P, prev)); pts.push(P); prev = P;
      }
      if (c.kind === 'circle') L = R1 * Math.abs(t1 - t0);
      else { // refine ellipse length
        let LL = 0, pp = null; const m = 2000;
        for (let i = 0; i <= m; i++) { const t = t0 + (t1 - t0) * i / m; const P = add(C, add(mul(X, R1 * Math.cos(t)), mul(Y, R2 * Math.sin(t)))); if (pp) LL += len(sub(P, pp)); pp = P; }
        L = LL;
      }
      return { len: L, pts };
    }
    return { len: e.A && e.B ? len(sub(e.A, e.B)) : 0, pts: [e.A, e.B].filter(Boolean), approx: true };
  }

  // наименьший собственный вектор симметричной 3×3 (Якоби)
  function smallestEig(M) {
    const a = M.map(r => r.slice()), V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let it = 0; it < 50; it++) {
      let p = 0, q = 1; if (Math.abs(a[0][2]) > Math.abs(a[p][q])) { p = 0; q = 2; } if (Math.abs(a[1][2]) > Math.abs(a[p][q])) { p = 1; q = 2; }
      if (Math.abs(a[p][q]) < 1e-12) break;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]); const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)); const c = 1 / Math.sqrt(t * t + 1), sn = t * c;
      for (let k = 0; k < 3; k++) { const x = a[k][p], y = a[k][q]; a[k][p] = c * x - sn * y; a[k][q] = sn * x + c * y; }
      for (let k = 0; k < 3; k++) { const x = a[p][k], y = a[q][k]; a[p][k] = c * x - sn * y; a[q][k] = sn * x + c * y; }
      for (let k = 0; k < 3; k++) { const x = V[k][p], y = V[k][q]; V[k][p] = c * x - sn * y; V[k][q] = sn * x + c * y; }
    }
    let m = 0; for (let i = 1; i < 3; i++) if (a[i][i] < a[m][m]) m = i;
    return norm([V[0][m], V[1][m], V[2][m]]);
  }

  // ---------- 2D helpers ----------
  function hull2(P) {
    const p = P.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 1e-9) lo.pop(); lo.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 1e-9) up.pop(); up.push(q); }
    up.pop(); lo.pop(); return lo.concat(up);
  }
  function distToPoly(q, H) {
    let best = Infinity;
    for (let i = 0; i < H.length; i++) {
      const a = H[i], b = H[(i + 1) % H.length];
      const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1e-12;
      let t = ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L2; t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dy));
    }
    return best;
  }
  function shoelace(P) { let s = 0; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; s += a[0] * b[1] - a[1] * b[0]; } return s / 2; }

  // ---------- x_t -> общая модель (мм) ----------
  // модель: { edges:[{id, va, vb, faces:[f1,f2], g:{len,pts,approx}, kind:'line'|'circle'|..., dir, r, ring}],
  //           faces: Map(id -> {idx, surf:{kind:'plane',n,p,x}|{kind:'cylinder',a,p,x,r}|{kind:'other'}, loops:[[pts]], edges:[]}) }
  function fromXT(text) {
    const { M, E, F } = buildModel(text);
    const EG = new Map();
    for (const e of E) { e.g = edgeGeom(e); EG.set(e.idx, e); }
    function loopPolys(faceIdx) {
      const f = M.get(faceIdx); const out = [];
      for (let li = f.loop, guard = 0; li && guard < 1000; guard++) {
        const L = M.get(li); if (!L) break;
        const pts = []; let fi = L.fin, g2 = 0;
        do {
          const fin = M.get(fi); if (!fin) break;
          const e = EG.get(fin.edge);
          if (e) {
            let seg = e.g.pts.slice();
            if (pts.length && seg.length) {
              const last = pts[pts.length - 1];
              if (len(sub(seg[seg.length - 1], last)) < len(sub(seg[0], last))) seg.reverse();
            }
            for (const p of seg) pts.push(p);
          }
          fi = fin.forward;
        } while (fi && fi !== L.fin && ++g2 < 2000);
        out.push(pts); li = L.next;
      }
      return out;
    }
    const surfMM = s => {
      if (!s) return { kind: 'other' };
      if (s.kind === 'plane') return { kind: 'plane', n: s.n, x: s.x, p: mul(s.p, 1000) };
      if (s.kind === 'cylinder' || s.kind === 'cone') return { kind: s.kind, a: s.a, x: s.x, p: mul(s.p, 1000), r: s.r * 1000 };
      return { kind: s.kind || 'other' };
    };
    const edges = E.map(e => ({ id: e.idx, va: e.va, vb: e.vb, faces: e.faces, g: e.g,
      kind: e.curve ? e.curve.kind : 'other', dir: e.curve && e.curve.kind === 'line' ? e.curve.d : null,
      r: e.curve && e.curve.kind === 'circle' ? e.curve.r * 1000 : null, ring: !!(e.curve && e.curve.kind === 'circle' && !e.A) }));
    const faces = new Map();
    for (const fc of F.values()) faces.set(fc.idx, { idx: fc.idx, surf: surfMM(fc.surf), loops: loopPolys(fc.idx), edges: [] });
    for (const e of edges) for (const fi of e.faces) if (faces.has(fi)) faces.get(fi).edges.push(e);
    return { edges, faces };
  }

  // ---------- main analysis ----------
  function analyze(text) { return analyzeModel(fromXT(text)); }
  function analyzeModel(model) {
    const E = model.edges, F = model.faces;
    const warnings = new Set();
    for (const e of E) if (e.g.approx) warnings.add('Есть кривые сложной формы — их длина посчитана приближённо');
    const allPts = []; for (const e of E) for (const p of e.g.pts) allPts.push(p);
    if (!allPts.length) throw new Error('Не удалось прочитать геометрию из файла');

    // face metrics
    for (const fc of F.values()) {
      const s = fc.surf; fc.pts = []; for (const e of fc.edges) for (const p of e.g.pts) fc.pts.push(p);
      fc.area = 0;
      if (s && s.kind === 'plane') {
        const N = norm(s.n), X = norm(s.x), Y = cross(N, X);
        const areas = (fc.loops || []).map(P => Math.abs(shoelace(P.map(p => [dot(p, X), dot(p, Y)]))));
        areas.sort((a, b) => b - a); fc.area = areas.length ? areas[0] - areas.slice(1).reduce((a, b) => a + b, 0) : 0;
      } else if (s && (s.kind === 'cylinder' || s.kind === 'cone')) {
        const A = norm(s.a), P0 = s.p, X = norm(s.x), Y = cross(A, X);
        let hs = fc.pts.map(p => dot(sub(p, P0), A)); const span = hs.length ? Math.max(...hs) - Math.min(...hs) : 0;
        const ang = fc.pts.map(p => { const d = sub(p, P0); return Math.atan2(dot(d, Y), dot(d, X)); }).sort((a, b) => a - b);
        let gap = 0; for (let i = 0; i < ang.length; i++) { const g = i ? ang[i] - ang[i - 1] : ang[0] + 2 * Math.PI - ang[ang.length - 1]; gap = Math.max(gap, g); }
        const cov = ang.length ? Math.max(0, 2 * Math.PI - gap) : 0;
        fc.area = s.r * (cov > 6.0 ? 2 * Math.PI : cov) * span;
      }
    }

    // tube axis: direction maximising area of faces "parallel" to it
    const dirs = [];
    const addDir = d => { d = norm(d); if (!dirs.some(x => Math.abs(dot(x, d)) > 0.9999)) dirs.push(d); };
    for (const fc of F.values()) if (fc.surf && fc.surf.kind === 'cylinder') addDir(fc.surf.a);
    for (const e of E) if (e.kind === 'line' && e.dir) addDir(e.dir);
    if (!dirs.length) throw new Error('Не удалось определить ось трубы');
    const compat = (fc, d) => {
      const s = fc.surf; if (!s) return false;
      if (s.kind === 'plane') return Math.abs(dot(norm(s.n), d)) < 1e-4;
      if (s.kind === 'cylinder') return Math.abs(dot(norm(s.a), d)) > 1 - 1e-6;
      return false;
    };
    let axis = dirs[0], best = -1;
    for (const d of dirs) { let sc = 0; for (const fc of F.values()) if (compat(fc, d)) sc += fc.area; if (sc > best) { best = sc; axis = d; } }

    // 2D projection on plane perpendicular to axis
    let U = norm(cross(axis, Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), V = cross(axis, U);
    const to2 = p => [dot(p, U), dot(p, V)];
    const H = hull2(allPts.map(to2));
    const tol = 0.05;
    for (const fc of F.values()) {
      fc.outer = compat(fc, axis) && fc.pts.length > 0 && fc.pts.every(p => distToPoly(to2(p), H) < tol);
    }
    if (![...F.values()].some(f => f.outer)) throw new Error('Не найдена наружная поверхность трубы (профиль не выпуклый?)');
    const r1 = x => Math.round(x * 10) / 10;
    // толщина стенки
    let t = Infinity;
    const faces = [...F.values()];
    for (const o of faces) {
      if (!o.outer || !o.surf) continue;
      if (o.surf.kind === 'plane') {
        const n = norm(o.surf.n), p0 = o.surf.p;
        for (const f of faces) if (!f.outer && f.surf && f.surf.kind === 'plane' && compat(f, axis) && Math.abs(dot(norm(f.surf.n), n)) > 0.9999) {
          const d = Math.abs(dot(sub(f.surf.p, p0), n)); if (d > 0.2 && d < t) t = d;
        }
      } else if (o.surf.kind === 'cylinder') {
        const a = norm(o.surf.a), c0 = o.surf.p;
        for (const f of faces) if (!f.outer && f.surf && f.surf.kind === 'cylinder' && Math.abs(dot(norm(f.surf.a), a)) > 0.9999) {
          const dv = sub(f.surf.p, c0); const off = len(sub(dv, mul(a, dot(dv, a))));
          const d = o.surf.r - f.surf.r; if (off < 0.05 && d > 0.2 && d < t) t = d;
        }
      }
    }

    // ---- открытый профиль (уголок, швеллер): часть выпуклой оболочки сечения не покрыта наружными гранями
    const segs = []; let PER = 0;
    for (let i = 0; i < H.length; i++) { const a = H[i], b = H[(i + 1) % H.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); segs.push({ a, b, s0: PER, L }); PER += L; }
    const sOf = q => { let best = Infinity, sv = 0; for (const g of segs) { const dx = g.b[0] - g.a[0], dy = g.b[1] - g.a[1]; let tt = g.L ? ((q[0] - g.a[0]) * dx + (q[1] - g.a[1]) * dy) / (g.L * g.L) : 0; tt = Math.max(0, Math.min(1, tt)); const d = Math.hypot(q[0] - g.a[0] - tt * dx, q[1] - g.a[1] - tt * dy); if (d < best) { best = d; sv = g.s0 + tt * g.L; } } return sv; };
    const intervalOf = P2 => { // дуга периметра [s0, s1] (с переходом через 0), которую занимают точки
      const ss = P2.map(sOf).sort((x, y) => x - y); if (!ss.length) return null;
      let gi = -1, gmax = PER - ss[ss.length - 1] + ss[0];
      for (let i = 1; i < ss.length; i++) if (ss[i] - ss[i - 1] > gmax) { gmax = ss[i] - ss[i - 1]; gi = i; }
      return gi < 0 ? [ss[0], ss[ss.length - 1]] : [ss[gi], ss[gi - 1] + PER];
    };
    const outerF = [...F.values()].filter(f => f.outer);
    for (const f of outerF) f.iv = intervalOf(f.pts.map(to2));
    // покрытие периметра
    const cov = []; for (const f of outerF) if (f.iv) { const [a, b] = f.iv; if (b <= PER) cov.push([a, b]); else { cov.push([a, PER]); cov.push([0, b - PER]); } }
    cov.sort((x, y) => x[0] - y[0]);
    let openGap = null; {
      const M = []; for (const c of cov) { const m = M[M.length - 1]; if (m && c[0] <= m[1] + 1e-3) m[1] = Math.max(m[1], c[1]); else M.push(c.slice()); }
      if (M.length) { let best = PER - M[M.length - 1][1] + M[0][0], g = [M[M.length - 1][1], M[0][0] + PER];
        for (let i = 1; i < M.length; i++) { const d = M[i][0] - M[i - 1][1]; if (d > best) { best = d; g = [M[i - 1][1], M[i][0]]; } }
        if (best > 0.12 * PER && best > 2 * (isFinite(t) ? t : 1)) openGap = { s0: g[0], s1: g[1], len: best }; }
    }
    let kind = 'closed';
    if (openGap && isFinite(t)) {
      // торцы полок (кромки шириной ~t у края разрыва) — не режутся отдельно и не входят в путь реза
      const w = 1.6 * t, cyc = x => ((x % PER) + PER) % PER;
      const inRange = (iv, a, b) => { const x0 = cyc(iv[0]), L = iv[1] - iv[0]; const A = cyc(a); const off = cyc(x0 - A); return off + L <= cyc(b - a) + 1e-6; };
      for (const f of outerF) if (f.iv && (inRange(f.iv, openGap.s0 - w, openGap.s0) || inRange(f.iv, openGap.s1, openGap.s1 + w))) f.tip = true;
      const legs = outerF.filter(f => !f.tip && f.surf.kind === 'plane');
      const ns = []; for (const f of legs) { const n = norm(f.surf.n); if (!ns.some(m => Math.abs(dot(m, n)) > 0.999 && dot(m, n) > 0)) ns.push(n); }
      kind = ns.length >= 3 ? 'channel' : 'angle';
    }
    const pathLen = PER - (openGap ? openGap.len : 0) - outerF.filter(f => f.tip && f.iv).reduce((s2, f) => s2 + (f.iv[1] - f.iv[0]), 0);

    // cut edges
    const cut = E.filter(e => { const a = F.get(e.faces[0]), b = F.get(e.faces[1]);
      if ((a && a.tip) || (b && b.tip)) return false; // кромки полок открытого профиля
      return (!!(a && a.outer)) !== (!!(b && b.outer)); });

    // group into contours by shared vertices
    const parent = new Map(); const fnd = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    const uni = (a, b) => parent.set(fnd(a), fnd(b));
    for (const e of cut) { parent.set('e' + e.id, 'e' + e.id); }
    const vOwner = new Map();
    for (const e of cut) for (const v of [e.va, e.vb]) if (v) { if (vOwner.has(v)) uni('e' + e.id, vOwner.get(v)); else vOwner.set(v, 'e' + e.id); }
    const groups = new Map();
    for (const e of cut) { const r = fnd('e' + e.id); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(e); }

    const hs = allPts.map(p => dot(p, axis));
    const zmin = Math.min(...hs), zmax = Math.max(...hs);
    const cx = H.reduce((s, p) => s + p[0], 0) / H.length, cy = H.reduce((s, p) => s + p[1], 0) / H.length;
    const contours = [], endPts = [];
    let gid = -1;
    for (const es of groups.values()) {
      gid++;
      const L = es.reduce((s, e) => s + e.g.len, 0);
      const pts = []; for (const e of es) { const q = e.g.pts; for (let i = 0; i < q.length; i++) { pts.push(q[i]); if (i + 1 < q.length) for (let k = 1; k < 24; k++) pts.push(add(q[i], mul(sub(q[i + 1], q[i]), k / 24))); } }
      const ang = pts.map(p => { const q = to2(p); return Math.atan2(q[1] - cy, q[0] - cx); }).sort((a, b) => a - b);
      let gap = 0; for (let i = 0; i < ang.length; i++) { const g = i ? ang[i] - ang[i - 1] : ang[0] + 2 * Math.PI - ang[ang.length - 1]; gap = Math.max(gap, g); }
      let isEnd = gap < Math.PI / 4; // wraps around the whole profile
      if (kind !== 'closed') { const iv = intervalOf(pts.map(to2)); isEnd = !!iv && (iv[1] - iv[0]) >= 0.85 * pathLen; }
      const zs = pts.map(p => dot(p, axis));
      let label = isEnd ? 'Торец' : 'Вырез';
      let key = label;
      if (!isEnd && es.length === 1 && es[0].ring && es[0].r) {
        const d = Math.round(es[0].r * 2 * 100) / 100; label = 'Отверстие Ø' + d; key = label;
      } else if (!isEnd && es.length > 1 && es.every(e => e.kind === 'circle' && e.r && Math.abs(e.r - es[0].r) < 0.01) && Math.abs(L - 2 * Math.PI * es[0].r) < 0.005 * L) {
        const d = Math.round(es[0].r * 2 * 100) / 100; label = 'Отверстие Ø' + d; key = label; // окружность из нескольких дуг
      }
      contours.push({ isEnd, label, key, len: L, gid, z: (Math.min(...zs) + Math.max(...zs)) / 2 - zmin });
      if (isEnd) endPts.push({ z: zs.reduce((a, b) => a + b, 0) / zs.length, pts });
    }
    contours.sort((a, b) => a.z - b.z);

    // profile description
    const us = H.map(p => p[0]), vs = H.map(p => p[1]);
    let w = Math.max(...us) - Math.min(...us), h = Math.max(...vs) - Math.min(...vs);
    // align to outer planar faces if present
    const op = [...F.values()].find(f => f.outer && f.surf.kind === 'plane');
    if (op) {
      const n = norm(op.surf.n); const a2 = [dot(n, U), dot(n, V)]; const b2 = [-a2[1], a2[0]];
      const pa = H.map(p => p[0] * a2[0] + p[1] * a2[1]), pb = H.map(p => p[0] * b2[0] + p[1] * b2[1]);
      w = Math.max(...pa) - Math.min(...pa); h = Math.max(...pb) - Math.min(...pb);
    }
    const round = kind === 'closed' && ![...F.values()].some(f => f.outer && f.surf.kind === 'plane');
    const thick = isFinite(t) ? r1(t) : null;
    let pa_ = r1(Math.max(w, h)), pb_ = r1(Math.min(w, h));
    if (kind === 'channel') { // высота стенки (вдоль стенки) и ширина полки (поперёк)
      const mid = [cx, cy]; const gm = (() => { const sv = ((openGap.s0 + openGap.s1) / 2) % PER; for (const g of segs) if (sv >= g.s0 && sv <= g.s0 + g.L) { const tt = g.L ? (sv - g.s0) / g.L : 0; return [g.a[0] + (g.b[0] - g.a[0]) * tt, g.a[1] + (g.b[1] - g.a[1]) * tt]; } return mid; })();
      const gd = [gm[0] - mid[0], gm[1] - mid[1]]; const gl = Math.hypot(gd[0], gd[1]) || 1; const g2 = [gd[0] / gl, gd[1] / gl];
      const along = H.map(p => p[0] * g2[0] + p[1] * g2[1]), across = H.map(p => -p[0] * g2[1] + p[1] * g2[0]);
      pb_ = r1(Math.max(...along) - Math.min(...along)); pa_ = r1(Math.max(...across) - Math.min(...across));
    }
    const profile = round ? 'Ø' + r1(Math.max(w, h)) : pa_ + '×' + pb_;
    const prof = { type: round ? 'round' : kind === 'angle' ? 'angle' : kind === 'channel' ? 'channel' : 'rect', a: round ? r1(Math.max(w, h)) : pa_, b: round ? '' : pb_, t: thick };

    // end shape for nesting: axial position of each end at the 4 corners of the profile box
    let shape = null;
    {
      let dA = [1, 0];
      if (op) { const n = norm(op.surf.n); dA = [dot(n, U), dot(n, V)]; }
      const dB = [-dA[1], dA[0]];
      const pa = H.map(p => p[0] * dA[0] + p[1] * dA[1]), pb = H.map(p => p[0] * dB[0] + p[1] * dB[1]);
      const aMin = Math.min(...pa), aMax = Math.max(...pa), bMin = Math.min(...pb), bMax = Math.max(...pb);
      const A = aMax - aMin, B = bMax - bMin;
      const corner = k => { const ca = (k >> 1) ? aMax : aMin, cb = (k & 1) ? bMax : bMin; return [ca * dA[0] + cb * dB[0], ca * dA[1] + cb * dB[1]]; };
      const sorted = endPts.slice().sort((x, y) => x.z - y.z);
      const atCorners = e => [0, 1, 2, 3].map(k => { const c = corner(k); let best = Infinity, z = 0; for (const p of e.pts) { const q = to2(p); const d = (q[0] - c[0]) ** 2 + (q[1] - c[1]) ** 2; if (d < best) { best = d; z = dot(p, axis); } } return z - zmin; });
      const L = zmax - zmin;
      const lo = sorted.length >= 1 && sorted[0].z - zmin < L / 2 ? atCorners(sorted[0]) : [0, 0, 0, 0];
      const right = sorted.length && sorted[sorted.length - 1].z - zmin >= L / 2 ? sorted[sorted.length - 1] : null;
      const ro = right ? atCorners(right) : [L, L, L, L];
      const mn = Math.min(...lo); for (let k = 0; k < 4; k++) { lo[k] -= mn; ro[k] -= mn; }
      const angOf = (v, sgn) => { const sa = Math.abs(v[2] - v[0]), sb = Math.abs(v[1] - v[0]); const sp = Math.max(sa, sb); if (sp < 0.05) return 90; return Math.atan2(sa >= sb ? A : B, sp) * 180 / Math.PI; };
      shape = { L, A: r1(A), B: r1(B), sym: kind === 'angle' ? (Math.abs(A - B) < 0.05 ? 'angleEq' : 'angle') : kind === 'channel' ? 'channel' : round || Math.abs(A - B) < 0.05 ? 'square' : 'rect', lo: lo.map(v => Math.round(v * 100) / 100), ro: ro.map(v => Math.round(v * 100) / 100), angL: angOf(lo), angR: angOf(ro) };
      // открытый профиль: форма торцов — по точкам вдоль наружных полок (от кромки одной полки до кромки другой)
      if (kind !== 'closed' && openGap) {
        const NS = 17, pathS0 = openGap.s1, pathS1 = openGap.s0 + (openGap.s0 < openGap.s1 ? PER : 0);
        const tipW = 0.5;
        const at = sv => { sv = ((sv % PER) + PER) % PER; for (const g of segs) if (sv >= g.s0 - 1e-9 && sv <= g.s0 + g.L + 1e-9) { const tt = g.L ? (sv - g.s0) / g.L : 0; return [g.a[0] + (g.b[0] - g.a[0]) * tt, g.a[1] + (g.b[1] - g.a[1]) * tt]; } return H[0]; };
        const samp = []; for (let k = 0; k < NS; k++) samp.push(at(pathS0 + tipW + (pathS1 - pathS0 - 2 * tipW) * k / (NS - 1)));
        // положение торца в точке: ближайшая точка контура торца; для левого торца — дальняя по оси (там начинается металл)
        const zAt = (e, q, left) => { let bd = Infinity; for (const p of e.pts) { const d = Math.hypot(to2(p)[0] - q[0], to2(p)[1] - q[1]); if (d < bd) bd = d; }
          let z = left ? -Infinity : Infinity; for (const p of e.pts) { const q2 = to2(p); if (Math.hypot(q2[0] - q[0], q2[1] - q[1]) <= bd + 0.3) { const zz = dot(p, axis); z = left ? Math.max(z, zz) : Math.min(z, zz); } } return z - zmin; };
        const srt = endPts.slice().sort((x, y) => x.z - y.z);
        const Lp = zmax - zmin;
        const leftE = srt.length && srt[0].z - zmin < Lp / 2 ? srt[0] : null, rightE = srt.length && srt[srt.length - 1].z - zmin >= Lp / 2 ? srt[srt.length - 1] : null;
        const plo = samp.map(q => leftE ? zAt(leftE, q, true) : 0), pro = samp.map(q => rightE ? zAt(rightE, q, false) : Lp);
        const mn = Math.min(...plo); for (let k = 0; k < NS; k++) { plo[k] = Math.round((plo[k] - mn) * 100) / 100; pro[k] = Math.round((pro[k] - mn) * 100) / 100; }
        const symm = kind === 'channel' || Math.abs(pa_ - pb_) < 0.05;
        Object.assign(shape, { sym: 'path', symmetric: symm, lo: plo, ro: pro });
      }
    }
    // углы торцов к оси — по плоскости, в которой лежит контур торца
    const endAng = endPts.slice().sort((x, y) => x.z - y.z).map(ep => {
      const P = ep.pts; const c = mul(P.reduce((a, q) => add(a, q), [0, 0, 0]), 1 / P.length);
      const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; for (const q of P) { const d = sub(q, c); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) A[i][j] += d[i] * d[j]; }
      const n = smallestEig(A); let flat = 0; for (const q of P) flat = Math.max(flat, Math.abs(dot(sub(q, c), n)));
      if (flat > 0.5) return null; // не плоский торец (седло и т.п.)
      return Math.asin(Math.min(1, Math.abs(dot(n, axis)))) * 180 / Math.PI;
    });
    if (shape && endAng.length === 2) { if (endAng[0] !== null) shape.angL = endAng[0]; if (endAng[1] !== null) shape.angR = endAng[1]; }
    // для 3D-просмотра: рёбра (0,1 мм), номер контура реза у режущих
    const cutOf = new Map(); let ci = 0; for (const es of groups.values()) { for (const e of es) cutOf.set(e, ci); ci++; }
    const q1 = v => Math.round(v * 10) / 10;
    const dp3 = (P, tol) => { // упрощение ломаной (Дуглас — Пекер)
      if (P.length < 3) return P;
      const keep = new Uint8Array(P.length); keep[0] = keep[P.length - 1] = 1; const st = [[0, P.length - 1]];
      while (st.length) { const [a, b] = st.pop(); const A = P[a], B = P[b], ab = sub(B, A), L = len(ab); let bi = -1, bd = tol;
        for (let i = a + 1; i < b; i++) { const d = L > 1e-9 ? len(cross(sub(P[i], A), ab)) / L : len(sub(P[i], A)); if (d > bd) { bd = d; bi = i; } }
        if (bi >= 0) { keep[bi] = 1; st.push([a, bi], [bi, b]); } }
      return P.filter((_, i) => keep[i]);
    };
    const view = E.map(e => ({ p: dp3(e.g.pts, 0.05).map(p => [q1(p[0]), q1(p[1]), q1(p[2])]), c: cutOf.has(e) ? cutOf.get(e) : -1 }));
    // площадь под покрытие: наружная (грани наружной оболочки) и полная (все грани: снаружи, внутри, торцы)
    const allF = [...F.values()];
    const unknown = allF.some(f => !(f.area > 0) && f.pts.length > 2);
    let areaOuter = outerF.reduce((s2, f) => s2 + (f.area || 0), 0), areaFull = allF.reduce((s2, f) => s2 + (f.area || 0), 0), areaApprox = false;
    if (unknown || !(areaOuter > 0)) { // грани сложной формы — по периметру сечения
      areaOuter = Math.max(areaOuter, (PER - (openGap ? openGap.len : 0)) * (zmax - zmin));
      if (!(areaFull > 1.5 * areaOuter)) areaFull = 2 * areaOuter;
      areaApprox = true;
    }
    return { length: zmax - zmin, profile: profile + (thick ? '×' + String(thick).replace('.', ',') : ''), prof, shape, contours, warnings: [...warnings], nEdges: E.length, nFaces: F.size, view: { edges: view, axis }, endAng, areaOuter, areaFull, areaApprox };
  }

  // summary for a torcovka mode: 'both' | 'one' | 'none'
  function summarize(res, mode) {
    const ends = res.contours.filter(c => c.isEnd).sort((a, b) => b.len - a.len);
    const keepN = mode === 'none' ? 0 : mode === 'one' ? Math.min(1, ends.length) : ends.length;
    const keptEnds = ends.slice(0, keepN);
    const others = res.contours.filter(c => !c.isEnd);
    const endsLen = keptEnds.reduce((s, c) => s + c.len, 0);
    const otherLen = others.reduce((s, c) => s + c.len, 0);
    const groups = new Map();
    for (const c of others) { const g = groups.get(c.key) || { label: c.label, n: 0, len: 0 }; g.n++; g.len += c.len; groups.set(c.key, g); }
    return { total: endsLen + otherLen, endsLen, nEndsKept: keepN, nEndsFound: ends.length, endLens: ends.map(c => c.len), otherLen, pierces: keepN + others.length, groups: [...groups.values()] };
  }

  root.XTCut = { buildModel, edgeGeom, analyze, analyzeModel, fromXT, summarize, scan, resolve, bodyText, vec: { sub, add, mul, dot, cross, len, norm } };
  if (typeof module !== 'undefined') module.exports = root.XTCut;
})(typeof window !== 'undefined' ? window : globalThis);
