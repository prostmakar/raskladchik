// ===== DXF: чтение, проверка, исправление, длина реза, запись чистого DXF =====
(function (root) {
  'use strict';
  const TAU = Math.PI * 2;
  const hyp = Math.hypot;
  const d2 = (a, b) => hyp(a[0] - b[0], a[1] - b[1]);
  const normA = a => { a %= TAU; return a < 0 ? a + TAU : a; };
  const r3 = x => Math.round(x * 1000) / 1000;

  // ---------------------------------------------------------------- чтение
  // bytes (Uint8Array) | string -> текст
  function decode(src) {
    if (typeof src === 'string') return src;
    const head = new TextDecoder('latin1').decode(src.subarray(0, 22));
    if (head.startsWith('AutoCAD Binary DXF')) throw new Error('Двоичный DXF не поддерживается. Пересохраните чертёж как текстовый DXF (ASCII).');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(src); }
    catch (e) { return new TextDecoder('windows-1251').decode(src); }
  }

  function tokenize(text) {
    const L = text.split(/\r\n|\n|\r/);
    const out = [];
    for (let i = 0; i + 1 < L.length; i += 2) {
      const c = parseInt(L[i], 10);
      if (isNaN(c)) { i--; continue; } // сбой выравнивания — пробуем следующую строку
      out.push([c, L[i + 1]]);
    }
    return out;
  }

  const JUNK = { TEXT: 'текст', MTEXT: 'текст', ATTRIB: 'текст', ATTDEF: 'текст', DIMENSION: 'размеры', ARC_DIMENSION: 'размеры',
    LEADER: 'выноски', MLEADER: 'выноски', MULTILEADER: 'выноски', TOLERANCE: 'допуски', HATCH: 'штриховка', SOLID: 'заливка', TRACE: 'заливка',
    XLINE: 'вспомогательные прямые', RAY: 'вспомогательные прямые', POINT: 'точки', IMAGE: 'картинки', WIPEOUT: 'маскировка',
    VIEWPORT: null, '3DFACE': '3D-объекты', '3DSOLID': '3D-объекты', REGION: 'области', BODY: '3D-объекты', MESH: '3D-объекты', OLE2FRAME: 'вставки OLE', TABLE: 'таблицы' };

  // разбор: { ents:[{type, layer, ltype, color, g:[[code,val]...]}], blocks:{name:{base,ents}}, header:{}, layers:{} }
  function parse(src) {
    const text = decode(src);
    const T = tokenize(text);
    const header = {}, layers = {}, ltypes = {}, blocks = {}, ents = [];
    let i = 0, sec = null;
    let curBlock = null;
    let cur = null;
    const flush = () => {
      if (!cur) return;
      if (sec === 'ENTITIES') ents.push(cur);
      else if (sec === 'BLOCKS' && curBlock) curBlock.ents.push(cur);
      else if (sec === 'TABLES' && cur.type === 'LAYER') {
        const g = gmap(cur.g); const nm = g[2];
        if (nm !== undefined) layers[nm] = { color: +g[62] || 7, off: (+g[62] || 0) < 0, frozen: ((+g[70] || 0) & 1) === 1, ltype: g[6] || '' };
      }
      else if (sec === 'TABLES' && cur.type === 'LTYPE') {
        const g = gmap(cur.g); if (g[2] !== undefined) ltypes[g[2]] = { dashed: (+g[73] || 0) > 0, desc: g[3] || '' };
      }
      cur = null;
    };
    for (; i < T.length; i++) {
      const [c, vRaw] = T[i]; const v = vRaw.trim();
      if (c === 0) {
        flush();
        if (v === 'SECTION') { const n = T[i + 1]; sec = n && n[0] === 2 ? n[1].trim() : null; i++; continue; }
        if (v === 'ENDSEC') { sec = null; continue; }
        if (v === 'EOF') break;
        if (sec === 'BLOCKS') {
          if (v === 'BLOCK') { curBlock = { name: '', base: [0, 0], ents: [], hdr: [] }; cur = null; let j = i + 1;
            for (; j < T.length && T[j][0] !== 0; j++) { const [cc, vv] = T[j]; if (cc === 2) curBlock.name = vv.trim(); else if (cc === 10) curBlock.base[0] = +vv; else if (cc === 20) curBlock.base[1] = +vv; }
            i = j - 1; continue; }
          if (v === 'ENDBLK') { if (curBlock && curBlock.name) blocks[curBlock.name] = curBlock; curBlock = null; let j = i + 1; while (j < T.length && T[j][0] !== 0) j++; i = j - 1; continue; }
        }
        if (sec === 'ENTITIES' || sec === 'BLOCKS' || sec === 'TABLES') cur = { type: v, g: [] };
        continue;
      }
      if (sec === 'HEADER') {
        if (c === 9) { header._k = v; }
        else if (header._k) { if (header[header._k] === undefined) header[header._k] = v; }
        continue;
      }
      if (cur) cur.g.push([c, vRaw.trim()]);
    }
    flush();
    delete header._k;
    // POLYLINE + VERTEX + SEQEND -> одна запись
    const glue = list => {
      const out = [];
      for (let k = 0; k < list.length; k++) {
        const e = list[k];
        if (e.type === 'POLYLINE') { e.verts = []; k++; while (k < list.length && list[k].type === 'VERTEX') { e.verts.push(list[k]); k++; } if (k < list.length && list[k].type !== 'SEQEND') k--; out.push(e); }
        else if (e.type === 'INSERT') { // атрибуты после INSERT
          out.push(e); let j = k + 1; if (+gmap(e.g)[66] === 1) { while (j < list.length && (list[j].type === 'ATTRIB')) j++; if (j < list.length && list[j].type === 'SEQEND') j++; k = j - 1; }
        }
        else if (e.type === 'VERTEX' || e.type === 'SEQEND') continue;
        else out.push(e);
      }
      return out;
    };
    const E = glue(ents);
    for (const b of Object.values(blocks)) b.ents = glue(b.ents);
    return { ents: E, blocks, header, layers, ltypes, version: header.$ACADVER || '' };
  }

  function gmap(g) { const m = {}; for (const [c, v] of g) if (m[c] === undefined) m[c] = v; return m; }
  function gall(g, code) { const r = []; for (const [c, v] of g) if (c === code) r.push(v); return r; }

  // ---------------------------------------------------------------- геометрия
  // примитивы: {k:'L', a, b} {k:'A', c, r, a0, a1 (против часовой a0->a1, a1>a0)} {k:'C', c, r} {k:'S', pts, closed} (сплайн/эллипс как ломаная)
  // каждой — src: {i: номер объекта, type, layer, ltype}
  const ident = { m: [1, 0, 0, 1, 0, 0] }; // [a b c d e f]: x' = a x + c y + e, y' = b x + d y + f
  const mul = (A, B) => [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3], A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]];
  const ap = (M, p) => [M[0] * p[0] + M[2] * p[1] + M[4], M[1] * p[0] + M[3] * p[1] + M[5]];

  function ocs(g) { // нормаль (0,0,-1) — зеркальная система координат объекта
    const z = +(gmap(g)[230]); return isFinite(z) && z < 0 ? -1 : 1;
  }

  // сплайн NURBS -> точки
  function splinePoints(g, tol) {
    const m = gmap(g);
    const deg = +m[71] || 3;
    const flags = +m[70] || 0;
    const knots = gall(g, 40).map(Number);
    const w = gall(g, 41).map(Number);
    const xs = gall(g, 10).map(Number), ys = gall(g, 20).map(Number);
    const fx = gall(g, 11).map(Number), fy = gall(g, 21).map(Number);
    const ctrl = xs.map((x, i) => [x, ys[i]]);
    if (ctrl.length >= 2 && knots.length >= ctrl.length + deg + 1) {
      const n = ctrl.length;
      const W = w.length === n ? w : ctrl.map(() => 1);
      const lo = knots[deg], hi = knots[n];
      const ev = t => { // de Boor (рациональный)
        let s = deg; while (s < n - 1 && t >= knots[s + 1]) s++;
        const d = []; for (let j = 0; j <= deg; j++) { const P = ctrl[s - deg + j], ww = W[s - deg + j]; d.push([P[0] * ww, P[1] * ww, ww]); }
        for (let r = 1; r <= deg; r++) for (let j = deg; j >= r; j--) {
          const ii = s - deg + j; const den = knots[ii + deg - r + 1] - knots[ii]; const a = den ? (t - knots[ii]) / den : 0;
          d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1], (1 - a) * d[j - 1][2] + a * d[j][2]];
        }
        return [d[deg][0] / d[deg][2], d[deg][1] / d[deg][2]];
      };
      // разбиение по интервалам узлов + адаптивное деление по прогибу
      const pts = [ev(lo)];
      const spans = [];
      for (let k = deg; k < n; k++) if (knots[k + 1] > knots[k]) spans.push([knots[k], knots[k + 1]]);
      const rec = (t0, p0, t1, p1, depth) => {
        const tm = (t0 + t1) / 2, pm = ev(tm);
        const q1 = ev(t0 + (t1 - t0) * 0.25), q3 = ev(t0 + (t1 - t0) * 0.75);
        const dev = Math.max(segDist(pm, p0, p1), segDist(q1, p0, p1), segDist(q3, p0, p1));
        if (depth < 14 && (dev > tol || depth < 2)) { rec(t0, p0, tm, pm, depth + 1); rec(tm, pm, t1, p1, depth + 1); }
        else pts.push(p1);
      };
      for (const [a, b] of spans) rec(a, ev(a), b, ev(b), 0);
      if (knots.slice(0, deg + 1).every(k => k === knots[0])) pts[0] = ctrl[0].slice();
      if (clampedEnd(knots, deg, n)) pts[pts.length - 1] = ctrl[n - 1].slice();
      return { pts, closed: !!(flags & 1) };
    }
    if (fx.length >= 2) { // только точки интерполяции — сглаженная ломаная Катмулла-Рома
      const F = fx.map((x, i) => [x, fy[i]]);
      const pts = [F[0]];
      for (let i = 0; i < F.length - 1; i++) {
        const p0 = F[Math.max(0, i - 1)], p1 = F[i], p2 = F[i + 1], p3 = F[Math.min(F.length - 1, i + 2)];
        const N = 16;
        for (let s = 1; s <= N; s++) { const t = s / N, t2 = t * t, t3 = t2 * t;
          pts.push([0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
                    0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)]); }
      }
      return { pts, closed: !!(flags & 1) };
    }
    return null;
  }
  function clampedEnd(knots, deg, n) { const v = knots[n]; for (let k = n; k <= n + deg; k++) if (knots[k] !== v) return false; return true; }

  function segDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1]; const L2 = dx * dx + dy * dy;
    let t = L2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
    return hyp(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  }

  function ellipsePoints(c, maj, ratio, t0, t1, tol) {
    const R = hyp(maj[0], maj[1]); const rot = Math.atan2(maj[1], maj[0]);
    while (t1 <= t0) t1 += TAU;
    const n = Math.max(8, Math.ceil((t1 - t0) / (2 * Math.acos(Math.max(-1, 1 - tol / Math.max(R, 1e-9))) || 0.05)));
    const pts = [];
    for (let i = 0; i <= n; i++) { const t = t0 + (t1 - t0) * i / n; const x = R * Math.cos(t), y = R * ratio * Math.sin(t);
      pts.push([c[0] + x * Math.cos(rot) - y * Math.sin(rot), c[1] + x * Math.sin(rot) + y * Math.cos(rot)]); }
    return pts;
  }

  // дуга по выпуклости (bulge) между p0 и p1
  function bulgeArc(p0, p1, b) {
    const th = 4 * Math.atan(b); const L = d2(p0, p1); if (L < 1e-12) return null;
    const r = L / (2 * Math.sin(Math.abs(th) / 2));
    const mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2;
    const h = r * Math.cos(th / 2) * Math.sign(b); // расстояние от середины хорды до центра (со знаком)
    const nx = -(p1[1] - p0[1]) / L, ny = (p1[0] - p0[0]) / L;
    const c = [mx + nx * h * (1), my + ny * h * (1)];
    // для b>0 (против часовой) центр слева от хорды при |th|<pi
    let a0 = Math.atan2(p0[1] - c[1], p0[0] - c[0]), a1 = Math.atan2(p1[1] - c[1], p1[0] - c[0]);
    // pa/pb — точные концы (у дуг большого радиуса углы теряют точность)
    if (b > 0) { a0 = normA(a0); a1 = normA(a1); if (a1 <= a0) a1 += TAU; return { k: 'A', c, r: Math.abs(r), a0, a1, pa: p0.slice(), pb: p1.slice() }; }
    // по часовой: дуга от p1 к p0 против часовой
    let s = normA(a1), e = normA(a0); if (e <= s) e += TAU; return { k: 'A', c, r: Math.abs(r), a0: s, a1: e, rev: true, pa: p1.slice(), pb: p0.slice() };
  }

  // объект -> примитивы в мировых координатах
  function toPrims(e, M, idx, out, ctx, depth) {
    const g = e.g, m = gmap(g);
    const layer = m[8] || '0';
    let ltype = m[6] || 'BYLAYER'; if (/^bylayer$/i.test(ltype)) ltype = (ctx.layers[layer] && ctx.layers[layer].ltype) || '';
    const dashed = !!(ctx.ltypes[ltype] && ctx.ltypes[ltype].dashed) || /center|dash|hidden|phantom|dot|axis|осев|штрих/i.test(ltype);
    const src = { i: idx, type: e.type, layer, ltype, dashed };
    const P = (x, y) => ap(M, [+x || 0, +y || 0]);
    const det = M[0] * M[3] - M[1] * M[2];
    const sc = Math.sqrt(Math.abs(det));
    const z = ocs(g);
    const O = (x, y) => P(z * (+x || 0), +y || 0); // учёт зеркальной OCS
    const uniform = Math.abs(hyp(M[0], M[1]) - hyp(M[2], M[3])) < 1e-9 * Math.max(1, hyp(M[0], M[1])) && Math.abs(M[0] * M[2] + M[1] * M[3]) < 1e-9;
    switch (e.type) {
      case 'LINE': {
        const a = P(m[10], m[20]), b = P(m[11], m[21]);
        out.push({ k: 'L', a, b, src }); break;
      }
      case 'CIRCLE': {
        const c = O(m[10], m[20]); const r = (+m[40] || 0) * sc;
        if (!uniform) { const pts = []; for (let i = 0; i <= 128; i++) { const t = TAU * i / 128; pts.push(P(z * (+m[10] || 0) + (+m[40]) * Math.cos(t), (+m[20] || 0) + (+m[40]) * Math.sin(t))); } out.push({ k: 'S', pts, closed: true, src }); break; }
        out.push({ k: 'C', c, r, src }); break;
      }
      case 'ARC': {
        const cx = +m[10] || 0, cy = +m[20] || 0, r0 = +m[40] || 0;
        const s = (+m[50] || 0) * Math.PI / 180, en = (+m[51] || 0) * Math.PI / 180;
        let sweep = normA(en - s); if (sweep < 1e-12) sweep = TAU;
        // концы и середина в OCS -> мир
        const pt = t => O(cx + r0 * Math.cos(t), cy + r0 * Math.sin(t));
        if (!uniform) { const pts = []; const n = Math.max(8, Math.ceil(sweep / 0.05)); for (let i = 0; i <= n; i++) pts.push(pt(s + sweep * i / n)); out.push({ k: 'S', pts, closed: false, src }); break; }
        const c = O(cx, cy), r = r0 * sc;
        const ps = pt(s), pe = pt(s + sweep);
        let A0 = Math.atan2(ps[1] - c[1], ps[0] - c[0]), A1 = Math.atan2(pe[1] - c[1], pe[0] - c[0]);
        const flip = (z < 0) !== (det < 0); // направление обхода поменялось
        if (flip) { const t = A0; A0 = A1; A1 = t; }
        A0 = normA(A0); A1 = normA(A1); if (A1 <= A0 + 1e-12) A1 += TAU; if (sweep >= TAU - 1e-12) A1 = A0 + TAU;
        out.push({ k: 'A', c, r, a0: A0, a1: A1, src }); break;
      }
      case 'LWPOLYLINE': {
        const flags = +m[70] || 0; const vs = []; let cur = null;
        for (const [c, v] of g) { if (c === 10) { cur = [+v, 0, 0]; vs.push(cur); } else if (c === 20 && cur) cur[1] = +v; else if (c === 42 && cur) cur[2] = +v; }
        polyPrims(vs, !!(flags & 1), z, P, uniform, det, out, src); break;
      }
      case 'POLYLINE': {
        const flags = +m[70] || 0;
        if (flags & (16 | 64)) { ctx.junk('3D-сетки'); break; }
        const vs = [];
        for (const v of e.verts || []) { const vm = gmap(v.g); const vf = +vm[70] || 0; if (vf & 16) continue; vs.push([+vm[10] || 0, +vm[20] || 0, +vm[42] || 0]); }
        if (flags & 4) { // сглаженная сплайном: точки уже аппроксимация (флаг 8 у вершин)
          const vv = []; for (const v of e.verts || []) { const vm = gmap(v.g); const vf = +vm[70] || 0; if (vf & 16) continue; vv.push([+vm[10] || 0, +vm[20] || 0, 0]); }
          polyPrims(vv, !!(flags & 1), z, P, uniform, det, out, src); break;
        }
        polyPrims(vs, !!(flags & 1), z, P, uniform, det, out, src); break;
      }
      case 'SPLINE': {
        // сплайн рисуем в мировых координатах: точки преобразуем матрицей
        const sp = splinePoints(g, 0.002 / Math.max(sc, 1e-9));
        if (!sp) { ctx.warn('Не удалось прочитать сплайн — пропущен'); break; }
        let pts = sp.pts.map(p => P(p[0], p[1]));
        const deg = +m[71] || 3;
        if (deg === 1) { for (let k = 1; k < pts.length; k++) out.push({ k: 'L', a: pts[k - 1], b: pts[k], src }); if (sp.closed && d2(pts[0], pts[pts.length - 1]) > 1e-9) out.push({ k: 'L', a: pts[pts.length - 1], b: pts[0], src }); break; }
        if (sp.closed && d2(pts[0], pts[pts.length - 1]) > 1e-9) pts.push(pts[0].slice());
        out.push({ k: 'S', pts, closed: d2(pts[0], pts[pts.length - 1]) < 1e-9, src }); break;
      }
      case 'ELLIPSE': {
        const c0 = [+m[10] || 0, +m[20] || 0], maj = [+m[11] || 0, +m[21] || 0]; const ratio = +m[40] || 1;
        let t0 = +m[41] || 0, t1 = m[42] === undefined ? TAU : +m[42];
        const full = Math.abs(normA(t1 - t0)) < 1e-9 || Math.abs(t1 - t0 - TAU) < 1e-9;
        const ez = z; // эллипс задаётся в мировых координатах, но направление обхода может быть зеркальным
        let pts = ellipsePoints(c0, maj, ratio, t0, full ? t0 + TAU : t1, 0.002);
        if (ez < 0) pts = pts.map(p => [-p[0], p[1]]);
        pts = pts.map(p => P(p[0], p[1]));
        if (Math.abs(ratio - 1) < 1e-9 && uniform) { // на самом деле окружность/дуга
          const c = P(ez < 0 ? -c0[0] : c0[0], c0[1]); const r = hyp(maj[0], maj[1]) * sc;
          if (full) { out.push({ k: 'C', c, r, src }); break; }
          let A0 = normA(Math.atan2(pts[0][1] - c[1], pts[0][0] - c[0])), A1 = normA(Math.atan2(pts[pts.length - 1][1] - c[1], pts[pts.length - 1][0] - c[0]));
          const mid = pts[pts.length >> 1]; let Am = normA(Math.atan2(mid[1] - c[1], mid[0] - c[0]));
          if (A1 <= A0) A1 += TAU; if (!(Am >= A0 && Am <= A1) && !(Am + TAU >= A0 && Am + TAU <= A1)) { const t = A0; A0 = normA(A1); A1 = t; if (A1 <= A0) A1 += TAU; }
          out.push({ k: 'A', c, r, a0: A0, a1: A1, src }); break;
        }
        out.push({ k: 'S', pts, closed: full, src }); break;
      }
      case 'INSERT': {
        const bn = m[2]; const B = ctx.blocks[bn];
        if (!B) break;
        if (depth > 12) { ctx.warn('Слишком глубокая вложенность блоков'); break; }
        const sx = m[41] === undefined ? 1 : +m[41], sy = m[42] === undefined ? 1 : +m[42];
        const rot = (+m[50] || 0) * Math.PI / 180;
        const cols = Math.max(1, +m[70] || 1), rows = Math.max(1, +m[71] || 1), dc = +m[44] || 0, dr = +m[45] || 0;
        for (let ci = 0; ci < cols; ci++) for (let ri = 0; ri < rows; ri++) {
          const ins = [+m[10] || 0, +m[20] || 0];
          // OCS вставки
          const zx = z;
          const cr = Math.cos(rot), sr = Math.sin(rot);
          const off = [ci * dc * cr - ri * dr * sr, ci * dc * sr + ri * dr * cr];
          let L = [cr * sx, sr * sx, -sr * sy, cr * sy, ins[0] + off[0], ins[1] + off[1]];
          L = mul(L, [1, 0, 0, 1, -B.base[0], -B.base[1]]);
          if (zx < 0) L = mul([-1, 0, 0, 1, 0, 0], L);
          const MM = mul(M, L);
          for (const be of B.ents) toPrimsSafe(be, MM, idx, out, ctx, depth + 1);
        }
        break;
      }
      default: {
        if (e.type in JUNK) { if (JUNK[e.type]) ctx.junk(JUNK[e.type], e.type); }
        else ctx.junk('прочие объекты (' + e.type + ')', e.type);
      }
    }
  }
  function toPrimsSafe(e, M, idx, out, ctx, depth) {
    const m = gmap(e.g);
    if (+m[67] === 1) return; // пространство листа
    const ly = ctx.layers[m[8]];
    if (ly && (ly.off || ly.frozen) && !(e.type in JUNK)) { ctx.hidden++; return; }
    toPrims(e, M, idx, out, ctx, depth);
  }

  function polyPrims(vs, closed, z, P, uniform, det, out, src) {
    const n = vs.length; if (n < 2) return;
    const cnt = closed ? n : n - 1;
    for (let k = 0; k < cnt; k++) {
      const v0 = vs[k], v1 = vs[(k + 1) % n];
      const a = P(z * v0[0], v0[1]), b = P(z * v1[0], v1[1]);
      let bl = v0[2] || 0;
      if (Math.abs(bl) < 1e-9) { out.push({ k: 'L', a, b, src }); continue; }
      if (z < 0) bl = -bl; if (det < 0) bl = -bl;
      if (!uniform) { // ломаная
        const A = bulgeArc([z * v0[0], v0[1]], [z * v1[0], v1[1]], z < 0 ? -v0[2] : v0[2]); if (!A) continue;
        const pts = []; const N = Math.max(8, Math.ceil((A.a1 - A.a0) / 0.05));
        for (let i = 0; i <= N; i++) { const t = A.a0 + (A.a1 - A.a0) * i / N; pts.push(P(A.c[0] + A.r * Math.cos(t), A.c[1] + A.r * Math.sin(t))); }
        if (A.rev) pts.reverse(); out.push({ k: 'S', pts, closed: false, src }); continue;
      }
      const A = bulgeArc(a, b, bl); if (!A) continue;
      delete A.rev; A.src = src; out.push(A);
    }
  }

  // единицы чертежа -> мм
  const UNITS = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 8: 0.0000254, 9: 0.0254, 10: 914.4, 13: 0.001, 14: 100 };

  function primitives(doc) {
    const notes = { junk: {}, warn: [], hidden: 0 };
    const ctx = { blocks: doc.blocks, layers: doc.layers, ltypes: doc.ltypes || {}, junk: (k) => { notes.junk[k] = (notes.junk[k] || 0) + 1; }, warn: w => { if (!notes.warn.includes(w)) notes.warn.push(w); }, hidden: 0 };
    const out = [];
    const u = +doc.header.$INSUNITS; let M = [1, 0, 0, 1, 0, 0];
    if (UNITS[u] && UNITS[u] !== 1) { const s = UNITS[u]; M = [s, 0, 0, s, 0, 0]; notes.units = s; }
    doc.ents.forEach((e, i) => toPrimsSafe(e, M, i, out, ctx, 0));
    notes.hidden = ctx.hidden;
    return { prims: out, notes };
  }

  root.DXF = { parse, primitives, decode, gmap, _int: { splinePoints, bulgeArc, segDist } };
  if (typeof module !== 'undefined') module.exports = root.DXF;
})(typeof window !== 'undefined' ? window : globalThis);
