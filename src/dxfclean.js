// ===== Проверка и исправление контуров DXF, длина реза, запись чистого DXF =====
(function (root) {
  'use strict';
  const TAU = Math.PI * 2;
  const hyp = Math.hypot;
  const d2 = (a, b) => hyp(a[0] - b[0], a[1] - b[1]);
  const normA = a => { a %= TAU; return a < 0 ? a + TAU : a; };
  const fmt = (x, n = 2) => String(Math.round(x * 10 ** n) / 10 ** n).replace('.', ',');

  const DEF = {
    tolDup: 0.02,     // совпадение линий/дуг (двойной рез), мм
    tolNear: 0.05,    // почти совпадающие окружности (круг в круге), мм
    tolJoin: 0.1,     // стянуть концы, мм
    tolBridge: 1.0,   // закрыть разрыв отрезком, мм
    tolMicro: 0.05,   // микроотрезки, мм
    chord: 0.01,      // точность аппроксимации дуг, мм
  };

  // ---------------------------------------------------------------- примитивы
  const P0 = e => e.k === 'L' ? e.a : e.k === 'A' ? e.pa || [e.c[0] + e.r * Math.cos(e.a0), e.c[1] + e.r * Math.sin(e.a0)] : e.pts[0];
  const P1 = e => e.k === 'L' ? e.b : e.k === 'A' ? e.pb || [e.c[0] + e.r * Math.cos(e.a1), e.c[1] + e.r * Math.sin(e.a1)] : e.pts[e.pts.length - 1];
  function plen(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += d2(pts[i - 1], pts[i]); return s; }
  function elen(e) { return e.k === 'L' ? d2(e.a, e.b) : e.k === 'A' ? e.r * (e.a1 - e.a0) : e.k === 'C' ? TAU * e.r : plen(e.pts); }
  function segDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1]; const L2 = dx * dx + dy * dy;
    let t = L2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
    return hyp(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  }
  function arcPts(c, r, a0, a1, chord) {
    const sw = a1 - a0; const step = 2 * Math.acos(Math.max(-1, 1 - chord / Math.max(r, 1e-9)));
    const n = Math.max(2, Math.ceil(Math.abs(sw) / Math.max(step, 1e-3)));
    const out = []; for (let i = 0; i <= n; i++) { const t = a0 + sw * i / n; out.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]); }
    return out;
  }
  function bbox(pts) { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; } return [x0, y0, x1, y1]; }
  function area(pts) { let s = 0; for (let i = 0, n = pts.length; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; }
  function inside(p, poly) { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; }
  const inSweep = (t, a0, a1) => { t = normA(t - a0); return t <= (a1 - a0) + 1e-12; };

  // ---------------------------------------------------------------- основной проход
  function clean(prims, notes, opt) {
    opt = Object.assign({}, DEF, opt || {});
    const issues = []; // {lvl:'fix'|'warn'|'err', code, text, n, at:[[x,y]...]}
    const add = (lvl, code, text, at, n) => { const it = issues.find(i => i.code === code && i.lvl === lvl); if (it && n !== undefined) { it.n += n; if (at) it.at.push(...at); return; } issues.push({ lvl, code, text, at: at || [], n: n === undefined ? 1 : n }); };

    if (notes) {
      const kinds = Object.entries(notes.junk || {});
      if (kinds.length) add('fix', 'junk', 'Лишнее в чертеже: ' + kinds.map(([k, n]) => k + ' (' + n + ')').join(', '), [], kinds.reduce((s, [, n]) => s + n, 0));
      if (notes.hidden) add('info', 'hidden', 'Объекты на выключенных слоях не учитываются: ' + notes.hidden, [], notes.hidden);
      if (notes.units) add('info', 'units', 'Чертёж не в мм — пересчитан в мм (×' + fmt(notes.units, 4) + ')', [], 1);
      for (const w of notes.warn || []) add('warn', 'w' + w, w, []);
    }

    let E = prims.map(p => Object.assign({}, p));

    // 1. нулевые и вырожденные
    let zero = 0;
    E = E.filter(e => { const ok = e.k === 'C' ? e.r > 1e-6 : e.k === 'S' ? plen(e.pts) > 1e-6 : elen(e) > 1e-6; if (!ok) zero++; return ok; });
    if (zero) add('fix', 'zero', 'Объекты нулевой длины', [], zero);

    // 2. дубли и наложения
    E = dedupe(E, opt, add);

    // 3. узлы: стягиваем концы
    let g = buildGraph(E, opt, add);

    // 4. цепочки
    let ch = chains(g);

    // 4а. мусор: крошечные контуры и обрывки (меньше 0,5 мм)
    ch = dropTiny(ch, g, add);

    // 5. закрываем разрывы
    const opens = ch.filter(c => !c.closed);
    if (opens.length) {
      const bridged = bridge(g, ch, opt, add);
      if (bridged) { g = buildGraph(g.E, Object.assign({}, opt, { quiet: true }), add); ch = dropTiny(chains(g), g, null); }
    }

    // 5а. наложения на стыках: элемент заходит за точку стыка, следующий идёт назад
    fixBacktracks(ch, opt, add);

    // 6. открытые цепочки: осевые удаляем, остальные — ошибка
    const res = [];
    for (const c of ch) {
      if (c.closed) { res.push(c); continue; }
      if (c.edges.every(x => x.e.src && x.e.src.dashed)) { add('fix', 'axis', 'Осевые/штриховые линии', [], c.edges.length); continue; }
      const a = c.p0, b = c.p1;
      add('err', 'open', 'Незамкнутый контур: разрыв ' + fmt(d2(a, b), 2) + ' мм', [a, b], 1);
      res.push(c);
    }

    // 7. контуры: полигоны, вложенность
    const contours = res.map(c => contourOf(c, opt));
    nestDepth(contours);
    // пересечения контуров
    crossings(contours, add);

    const outers = contours.filter(c => c.closed && c.depth % 2 === 0);
    const holes = contours.filter(c => c.closed && c.depth % 2 === 1);
    if (!contours.length) add('err', 'empty', 'В чертеже нет контуров для резки', []);
    else if (!outers.length) add('err', 'noouter', 'Не найден замкнутый наружный контур детали', []);
    if (outers.length > 1) add('info', 'multi', 'В файле ' + outers.length + ' отдельных деталей — раскладываются по отдельности', [], 1);

    // длины
    let cut = 0; for (const c of contours) cut += c.len;
    const all = contours.flatMap(c => c.poly);
    const bb = all.length ? bbox(all) : [0, 0, 0, 0];
    // детали (наружный контур + его отверстия), включая острова внутри отверстий
    const pieces = outers.map(o => ({ outer: o, holes: contours.filter(h => h.closed && h.parent === o) }));
    const openOnes = contours.filter(c => !c.closed);
    for (const oc of openOnes) { // открытый контур прикрепляем к детали, внутри которой он лежит
      const host = pieces.find(p => inside(oc.poly[0], p.outer.poly)); if (host) (host.open = host.open || []).push(oc);
    }
    if (!pieces.length && contours.length) { // нет замкнутого наружного — выпуклая оболочка как временная форма
      const hull = convexHull(all); pieces.push({ outer: { poly: hull, closed: false, len: 0, fake: true }, holes: [], open: contours });
    }

    const sev = issues.some(i => i.lvl === 'err') ? 'err' : issues.some(i => i.lvl === 'warn') ? 'warn' : issues.some(i => i.lvl === 'fix') ? 'fix' : 'ok';
    const rawSt = rawStats(prims);
    return { contours, pieces, issues, sev, cut, pierces: contours.length, bbox: bb, w: bb[2] - bb[0], h: bb[3] - bb[1], rawCut: rawSt.cut, rawPierces: rawSt.pierces };
  }

  // как есть: длина всех режущих объектов (с двойными) и число отдельных цепочек
  function rawStats(prims) {
    let cut = 0; const ends = []; let loops = 0;
    prims.forEach((e, i) => {
      const L = elen(e); if (!(L > 1e-6)) return; cut += L;
      if (e.k === 'C' || (e.k === 'S' && e.closed)) { loops++; return; }
      ends.push([P0(e), i], [P1(e), i]);
    });
    // компоненты связности по точному совпадению концов (0,001 мм)
    const par = new Map(); const find = x => { while (par.get(x) !== x) { par.set(x, par.get(par.get(x))); x = par.get(x); } return x; };
    const ids = [...new Set(ends.map(e => e[1]))]; ids.forEach(i => par.set(i, i));
    const key = p => Math.round(p[0] * 1000) + ':' + Math.round(p[1] * 1000);
    const seen = new Map();
    for (const [p, i] of ends) { const k = key(p); if (seen.has(k)) { const a = find(seen.get(k)), b = find(i); if (a !== b) par.set(a, b); } else seen.set(k, i); }
    const comps = new Set(ids.map(find));
    return { cut, pierces: loops + comps.size };
  }

  // ---------------------------------------------------------------- дубли
  function dedupe(E, opt, add) {
    const tol = opt.tolDup;
    const lines = E.filter(e => e.k === 'L'), circ = E.filter(e => e.k === 'A' || e.k === 'C'), spl = E.filter(e => e.k === 'S');
    const out = [];
    const at = [];

    // линии: группы на одной прямой
    const n = lines.length; const par = lines.map((_, i) => i);
    const find = i => { while (par[i] !== i) i = par[i] = par[par[i]]; return i; };
    const dir = lines.map(l => { const L = d2(l.a, l.b); return [(l.b[0] - l.a[0]) / L, (l.b[1] - l.a[1]) / L]; });
    const lb = lines.map(l => [Math.min(l.a[0], l.b[0]) - tol, Math.min(l.a[1], l.b[1]) - tol, Math.max(l.a[0], l.b[0]) + tol, Math.max(l.a[1], l.b[1]) + tol]);
    const idx = lines.map((_, i) => i).sort((i, j) => lb[i][0] - lb[j][0]);
    for (let ii = 0; ii < n; ii++) {
      const i = idx[ii];
      for (let jj = ii + 1; jj < n; jj++) {
        const j = idx[jj]; if (lb[j][0] > lb[i][2]) break;
        if (lb[j][1] > lb[i][3] || lb[j][3] < lb[i][1]) continue;
        const A = lines[i], B = lines[j];
        // B на прямой A и наоборот (по расстоянию до бесконечной прямой)
        const dl = (p, l, d) => Math.abs((p[0] - l.a[0]) * d[1] - (p[1] - l.a[1]) * d[0]);
        if (dl(B.a, A, dir[i]) > tol || dl(B.b, A, dir[i]) > tol || dl(A.a, B, dir[j]) > tol || dl(A.b, B, dir[j]) > tol) continue;
        // перекрытие по оси
        const pr = p => (p[0] - A.a[0]) * dir[i][0] + (p[1] - A.a[1]) * dir[i][1];
        const a0 = 0, a1 = pr(A.b), b0 = Math.min(pr(B.a), pr(B.b)), b1 = Math.max(pr(B.a), pr(B.b));
        const ov = Math.min(a1, b1) - Math.max(a0, b0);
        if (ov > tol) par[find(i)] = find(j);
      }
    }
    const groups = new Map(); lines.forEach((l, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(l); });
    let ndupL = 0;
    for (const grp of groups.values()) {
      if (grp.length === 1) { out.push(grp[0]); continue; }
      const A = grp.reduce((m, l) => d2(l.a, l.b) > d2(m.a, m.b) ? l : m, grp[0]);
      const L = d2(A.a, A.b); const d = [(A.b[0] - A.a[0]) / L, (A.b[1] - A.a[1]) / L];
      const pr = p => (p[0] - A.a[0]) * d[0] + (p[1] - A.a[1]) * d[1];
      const iv = grp.map(l => { const s = pr(l.a), e = pr(l.b); return s < e ? [s, e, l] : [e, s, l]; }).sort((x, y) => x[0] - y[0]);
      const merged = [];
      for (const v of iv) { const m = merged[merged.length - 1]; if (m && v[0] <= m[1] + tol) { m[1] = Math.max(m[1], v[1]); m.n++; } else { const nv = [v[0], v[1]]; nv.n = 1; nv.src = v[2].src; merged.push(nv); } }
      for (const m of merged) {
        out.push({ k: 'L', a: [A.a[0] + d[0] * m[0], A.a[1] + d[1] * m[0]], b: [A.a[0] + d[0] * m[1], A.a[1] + d[1] * m[1]], src: m.src });
        if (m.n > 1) { ndupL += m.n - 1; at.push([A.a[0] + d[0] * (m[0] + m[1]) / 2, A.a[1] + d[1] * (m[0] + m[1]) / 2]); }
      }
    }

    // дуги и окружности: общая окружность -> объединение углов
    const cg = [];
    for (const e of circ) {
      let g = cg.find(G => d2(G.c, e.c) <= tol && Math.abs(G.r - e.r) <= tol);
      let near = false;
      if (!g) { g = cg.find(G => d2(G.c, e.c) <= opt.tolNear && Math.abs(G.r - e.r) <= opt.tolNear && G.items.some(x => angOverlap(x, e) > 0.02)); near = !!g; }
      if (!g) { g = { c: e.c, r: e.r, items: [] }; cg.push(g); }
      if (near) g.near = true;
      g.items.push(e);
    }
    let ndupA = 0, nnear = 0;
    for (const G of cg) {
      if (G.items.length === 1) { out.push(G.items[0]); continue; }
      const r = Math.max(...G.items.map(e => e.r)); const c = G.items.find(e => e.r === r).c;
      const iv = [];
      for (const e of G.items) { if (e.k === 'C') iv.push([0, TAU]); else { const s = normA(e.a0), w = e.a1 - e.a0; if (s + w > TAU) { iv.push([s, TAU]); iv.push([0, s + w - TAU]); } else iv.push([s, s + w]); } }
      iv.sort((x, y) => x[0] - y[0]);
      const at0 = tol / Math.max(r, tol);
      const M = []; for (const v of iv) { const m = M[M.length - 1]; if (m && v[0] <= m[1] + at0) m[1] = Math.max(m[1], v[1]); else M.push([v[0], v[1]]); }
      // склейка через 0
      if (M.length > 1 && M[0][0] <= at0 && M[M.length - 1][1] >= TAU - at0) { const last = M.pop(); M[0] = [last[0] - TAU, M[0][1]]; }
      const sumIn = iv.reduce((s, v) => s + v[1] - v[0], 0), sumOut = M.reduce((s, v) => s + v[1] - v[0], 0);
      const src = G.items[0].src;
      if (!(sumIn - sumOut > at0 * 2) && !G.near) { out.push(...G.items); continue; } // просто соседние дуги одной окружности
      {
        if (G.near) nnear += G.items.length - 1; else ndupA += Math.max(1, G.items.length - M.length);
        at.push([c[0] + r, c[1]]);
      }
      for (const m of M) {
        if (m[1] - m[0] >= TAU - at0) out.push({ k: 'C', c, r, src });
        else out.push({ k: 'A', c, r, a0: normA(m[0]), a1: normA(m[0]) + (m[1] - m[0]), src });
      }
    }
    if (ndupL + ndupA) add('fix', 'dup', 'Двойные линии и дуги (двойной рез)', at, ndupL + ndupA);
    if (nnear) add('fix', 'near', 'Почти совпадающие окружности/дуги («круг в круге»)', [], nnear);

    // сплайны: одинаковые (все точки одного лежат на другом)
    const keep = spl.map(() => true); let nds = 0;
    const sb = spl.map(s => bbox(s.pts));
    for (let i = 0; i < spl.length; i++) for (let j = 0; j < spl.length; j++) {
      if (i === j || !keep[i] || !keep[j]) continue;
      const a = sb[i], b = sb[j];
      if (a[0] < b[0] - tol || a[1] < b[1] - tol || a[2] > b[2] + tol || a[3] > b[3] + tol) continue;
      if (spl[i].pts.every(p => polyDist(p, spl[j].pts) <= tol * 2)) { keep[i] = false; nds++; at.push(spl[i].pts[0]); }
    }
    spl.forEach((s, i) => { if (keep[i]) out.push(s); });
    if (nds) add('fix', 'dup', 'Двойные линии и дуги (двойной рез)', [], nds);
    return out;
  }
  // перекрытие угловых интервалов двух дуг/окружностей, рад
  function angOverlap(a, b) {
    const iv = e => { if (e.k === 'C') return [[0, TAU]]; const s = normA(e.a0), w = e.a1 - e.a0; return s + w > TAU ? [[s, TAU], [0, s + w - TAU]] : [[s, s + w]]; };
    let m = 0; for (const x of iv(a)) for (const y of iv(b)) m += Math.max(0, Math.min(x[1], y[1]) - Math.max(x[0], y[0]));
    return m;
  }
  function polyDist(p, pts) { let m = Infinity; for (let i = 1; i < pts.length; i++) { const d = segDist(p, pts[i - 1], pts[i]); if (d < m) m = d; } return m; }

  // ---------------------------------------------------------------- граф
  function buildGraph(E, opt, add) {
    // замкнутые сами по себе
    const loops = [], ends = [];
    const edges = [];
    for (const e of E) {
      if (e.k === 'C' || (e.k === 'S' && e.closed && d2(e.pts[0], e.pts[e.pts.length - 1]) <= opt.tolJoin)) { loops.push(e); continue; }
      edges.push(e);
    }
    // точки на концах
    const pts = []; edges.forEach((e, i) => { pts.push([P0(e), i, 0]); pts.push([P1(e), i, 1]); });
    // T-стыки: конец, лежащий на середине другого отрезка/дуги — разбиваем тот объект
    const tol = opt.tolJoin;
    // кластеризация концов
    const cell = Math.max(tol, 1e-3) * 2;
    const grid = new Map(); const key = (x, y) => Math.floor(x / cell) + ':' + Math.floor(y / cell);
    const par = pts.map((_, i) => i); const find = i => { while (par[i] !== i) i = par[i] = par[par[i]]; return i; };
    pts.forEach((p, i) => { const k = key(p[0][0], p[0][1]); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
    let maxGap = 0, joined = 0;
    pts.forEach((p, i) => {
      const cx = Math.floor(p[0][0] / cell), cy = Math.floor(p[0][1] / cell);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const L = grid.get((cx + dx) + ':' + (cy + dy)); if (!L) continue;
        for (const j of L) if (j > i) { const d = d2(p[0], pts[j][0]); if (d <= tol && find(i) !== find(j)) { par[find(i)] = find(j); if (d > 1e-4) { joined++; if (d > maxGap) maxGap = d; } } }
      }
    });
    const nodeOf = new Map(); const nodes = [];
    pts.forEach((p, i) => { const r = find(i); if (!nodeOf.has(r)) { nodeOf.set(r, nodes.length); nodes.push({ p: [0, 0], n: 0, inc: [] }); } const nd = nodes[nodeOf.get(r)]; nd.p[0] += p[0][0]; nd.p[1] += p[0][1]; nd.n++; });
    nodes.forEach(nd => { nd.p[0] /= nd.n; nd.p[1] /= nd.n; });
    const G = { E: E, edges: [], nodes, loops };
    edges.forEach((e, i) => {
      const n0 = nodeOf.get(find(2 * i)), n1 = nodeOf.get(find(2 * i + 1));
      const ed = { e, n0, n1, id: G.edges.length };
      G.edges.push(ed); nodes[n0].inc.push(ed); if (n1 !== n0) nodes[n1].inc.push(ed); else nodes[n0].inc.push(ed);
    });
    // микроотрезки: оба конца в одном узле
    let micro = 0;
    G.edges = G.edges.filter(ed => { if (ed.n0 === ed.n1 && elen(ed.e) < Math.max(opt.tolMicro, tol * 2)) { micro++; const nd = nodes[ed.n0]; nd.inc = nd.inc.filter(x => x !== ed); return false; } return true; });
    if (!opt.quiet) {
      if (joined) add('fix', 'join', 'Концы линий не сходятся (разрыв до ' + fmt(maxGap, 3) + ' мм)', [], joined);
      if (micro) add('fix', 'micro', 'Микроотрезки', [], micro);
    }
    return G;
  }

  // направление касательной на выходе из узла
  function tangentAt(ed, fromN0) {
    const e = ed.e;
    if (e.k === 'L') { const a = fromN0 ? e.a : e.b, b = fromN0 ? e.b : e.a; const L = d2(a, b); return [(b[0] - a[0]) / L, (b[1] - a[1]) / L]; }
    if (e.k === 'A') { const t = fromN0 ? e.a0 : e.a1; const s = fromN0 ? 1 : -1; return [-Math.sin(t) * s, Math.cos(t) * s]; }
    const p = e.pts; const a = fromN0 ? p[0] : p[p.length - 1]; let b = fromN0 ? p[1] : p[p.length - 2];
    for (let k = 2; d2(a, b) < 1e-6 && k < p.length; k++) b = fromN0 ? p[k] : p[p.length - 1 - k];
    const L = d2(a, b) || 1; return [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
  }

  function chains(G) {
    const used = new Set(); const out = [];
    for (const L of G.loops) out.push({ closed: true, loop: L, edges: [{ e: L, fwd: true }] });
    const walk = (startEd, fwd) => {
      const seq = [];
      let ed = startEd, f = fwd;
      for (;;) {
        used.add(ed.id); seq.push({ e: ed.e, fwd: f, ed });
        const nEnd = f ? ed.n1 : ed.n0;
        const nd = G.nodes[nEnd];
        const cand = nd.inc.filter(x => !used.has(x.id));
        if (!cand.length) return { seq, end: nEnd };
        // направление прихода
        const tin = tangentAt(ed, !f).map(v => -v);
        let best = null, bd = -Infinity;
        for (const c of cand) { const fw = c.n0 === nEnd; const t = tangentAt(c, fw); const dot = t[0] * tin[0] + t[1] * tin[1]; if (dot > bd) { bd = dot; best = [c, fw]; } }
        ed = best[0]; f = best[1];
      }
    };
    // начинаем с концов степени 1, затем всё остальное
    const order = G.nodes.map((nd, i) => i).sort((a, b) => (G.nodes[a].inc.length === 1 ? 0 : 1) - (G.nodes[b].inc.length === 1 ? 0 : 1));
    for (const ni of order) {
      const nd = G.nodes[ni];
      for (const ed of nd.inc) {
        if (used.has(ed.id)) continue;
        const fw = ed.n0 === ni;
        const { seq, end } = walk(ed, fw);
        const start = ni;
        const closed = end === start && seq.length > 0;
        const p0 = G.nodes[start].p, p1 = G.nodes[end].p;
        out.push({ closed, edges: seq, n0: start, n1: end, p0, p1 });
      }
    }
    // узловые точки -> координаты концов
    for (const c of out) for (const s of c.edges) if (s.ed) { s.a = G.nodes[s.fwd ? s.ed.n0 : s.ed.n1].p; s.b = G.nodes[s.fwd ? s.ed.n1 : s.ed.n0].p; }
    return out;
  }

  function chainPts(c) {
    if (c.loop) return c.loop.k === 'C' ? [[c.loop.c[0] - c.loop.r, c.loop.c[1] - c.loop.r], [c.loop.c[0] + c.loop.r, c.loop.c[1] + c.loop.r]] : c.loop.pts;
    const P = []; for (const s of c.edges) { const e = s.e; P.push(s.a, s.b); if (e.k === 'A') P.push([e.c[0] + e.r * Math.cos((e.a0 + e.a1) / 2), e.c[1] + e.r * Math.sin((e.a0 + e.a1) / 2)]); else if (e.k === 'S') P.push(...e.pts); }
    return P;
  }
  function dropTiny(ch, G, add) {
    const keep = []; let n = 0; const removed = new Set();
    for (const c of ch) {
      const b = bbox(chainPts(c)); const diag = hyp(b[2] - b[0], b[3] - b[1]);
      if (diag < 0.5) { n++; for (const s of c.edges) removed.add(s.e); continue; }
      keep.push(c);
    }
    if (n) { G.E = G.E.filter(e => !removed.has(e)); if (add) add('fix', 'tiny', 'Микрообъекты (меньше 0,5 мм)', [], n); }
    return keep;
  }

  function bridge(G, ch, opt, add) {
    // концы открытых цепочек
    const ends = [];
    ch.forEach((c, i) => { if (!c.closed) { ends.push({ c: i, n: c.n0, p: c.p0 }); ends.push({ c: i, n: c.n1, p: c.p1 }); } });
    const pairs = [];
    for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) {
      if (ends[i].n === ends[j].n) continue;
      const d = d2(ends[i].p, ends[j].p); if (d <= opt.tolBridge) pairs.push([d, i, j]);
    }
    pairs.sort((a, b) => a[0] - b[0]);
    const taken = new Set(); let k = 0, mx = 0; const at = [];
    for (const [d, i, j] of pairs) {
      if (taken.has(i) || taken.has(j)) continue;
      taken.add(i); taken.add(j);
      G.E.push({ k: 'L', a: ends[i].p.slice(), b: ends[j].p.slice(), src: { type: 'bridge' } });
      k++; mx = Math.max(mx, d); at.push(ends[i].p);
    }
    if (k) add('fix', 'bridge', 'Разрывы контуров до ' + fmt(mx, 2) + ' мм — закрываются отрезком', at, k);
    return k;
  }


  // ---------------------------------------------------------------- наложения на стыках
  function stepPts(s, chord) { // точки шага цепочки от s.a к s.b
    const e = s.e; let P;
    if (e.k === 'L') P = [s.a, s.b];
    else if (e.k === 'A') { P = arcPts(e.c, e.r, e.a0, e.a1, chord); if (!s.fwd) P.reverse(); P[0] = s.a; P[P.length - 1] = s.b; }
    else { P = s.fwd ? e.pts.slice() : e.pts.slice().reverse(); P[0] = s.a; P[P.length - 1] = s.b; }
    return P;
  }
  function trimStep(s, X, atStart) {
    const e = Object.assign({}, s.e); delete e.pa; delete e.pb; s.e = e;
    const startIsA = s.fwd === atStart; // меняется «первая» точка самого объекта (a / a0 / pts[0])
    if (e.k === 'L') { if (startIsA) e.a = X.slice(); else e.b = X.slice(); }
    else if (e.k === 'A') {
      const t = Math.atan2(X[1] - e.c[1], X[0] - e.c[0]);
      if (startIsA) { const nd = e.a0 + normA(t - e.a0); if (nd < e.a1) e.a0 = nd; }
      else { const nd = e.a1 - normA(e.a1 - t); if (nd > e.a0) e.a1 = nd; }
    } else {
      const P = e.pts.slice(); if (!startIsA) P.reverse();
      // ближайший к X участок ломаной; всё до него отрезаем, X — новый край
      let k = 0, best = Infinity; for (let i = 0; i + 1 < P.length; i++) { const d = segDist(X, P[i], P[i + 1]); if (d < best) { best = d; k = i; } }
      const Q = [X.slice()]; for (let i = k + 1; i < P.length; i++) if (d2(P[i], Q[Q.length - 1]) > 1e-9) Q.push(P[i]);
      if (Q.length < 2) Q.push(X.slice());
      if (!startIsA) Q.reverse(); e.pts = Q;
    }
    if (atStart) s.a = X.slice(); else s.b = X.slice();
  }
  function fixBacktracks(ch, opt, add) {
    let n = 0; const at = [];
    const tol = Math.max(opt.tolDup, 0.02);
    for (const c of ch) {
      if (c.loop || c.edges.length < 2) continue;
      const m = c.closed ? c.edges.length : c.edges.length - 1;
      for (let i = 0; i < m; i++) {
        const A = c.edges[i], B = c.edges[(i + 1) % c.edges.length];
        const PA = stepPts(A, 0.002), PB = stepPts(B, 0.002);
        if (PA.length < 2 || PB.length < 2) continue;
        // направления у стыка
        const ta = [PA[PA.length - 1][0] - PA[PA.length - 2][0], PA[PA.length - 1][1] - PA[PA.length - 2][1]];
        const tb = [PB[1][0] - PB[0][0], PB[1][1] - PB[0][1]];
        const la = hyp(ta[0], ta[1]), lb = hyp(tb[0], tb[1]); if (!la || !lb) continue;
        if ((ta[0] * tb[0] + ta[1] * tb[1]) / (la * lb) > -0.9) continue;
        // идём по B от стыка, пока он лежит на A
        const RA = PA.slice().reverse();
        let X = null, walked = 0;
        for (let k = 1; k < PB.length && walked < 3; k++) {
          const p0 = PB[k - 1], p1 = PB[k]; const L = d2(p0, p1); const N = Math.max(1, Math.ceil(L / 0.005));
          let stop = false;
          for (let j = 1; j <= N; j++) { const p = [p0[0] + (p1[0] - p0[0]) * j / N, p0[1] + (p1[1] - p0[1]) * j / N]; if (polyDist(p, RA) <= tol) X = p; else { stop = true; break; } }
          walked += L; if (stop) break;
        }
        if (!X || d2(X, PB[0]) < 1e-4 || walked >= 3) continue;
        if (d2(X, PB[PB.length - 1]) < 1e-6) X = PB[PB.length - 1].slice(); // B целиком лежит на A
        trimStep(B, X, true); trimStep(A, X, false);
        n++; at.push(X);
      }
      // элементы, целиком ушедшие в наложение
      c.edges = c.edges.filter(st => d2(st.a, st.b) > 1e-6);
    }
    if (n) add('fix', 'overlap', 'Наложения на стыках (двойной рез)', at, n);
  }

  // ---------------------------------------------------------------- контур
  // вершины с выпуклостью (для записи) + полигон (для раскладки и картинки)
  function contourOf(c, opt) {
    const chord = opt.chord;
    if (c.loop) {
      const e = c.loop;
      if (e.k === 'C') {
        const poly = arcPts(e.c, e.r, 0, TAU, chord); poly.pop();
        return { closed: true, circle: { c: e.c, r: e.r }, poly, len: TAU * e.r, verts: null };
      }
      const pts = e.pts.slice(); if (d2(pts[0], pts[pts.length - 1]) > 1e-9) pts.push(pts[0]);
      const verts = fitArcs(pts, chord); const poly = pts.slice(0, -1);
      return { closed: true, poly, len: plen(pts), verts };
    }
    const verts = []; const poly = []; let len = 0;
    for (const s of c.edges) {
      const e = s.e;
      if (e.k === 'L') { verts.push([s.a[0], s.a[1], 0]); poly.push(s.a); len += d2(s.a, s.b); }
      else if (e.k === 'A') {
        const sw = e.a1 - e.a0; len += e.r * sw;
        verts.push([s.a[0], s.a[1], (s.fwd ? 1 : -1) * Math.tan(sw / 4)]);
        const P = arcPts(e.c, e.r, e.a0, e.a1, chord); if (!s.fwd) P.reverse();
        P[0] = s.a; P[P.length - 1] = s.b; for (let i = 0; i < P.length - 1; i++) poly.push(P[i]);
      } else {
        const P = s.fwd ? e.pts.slice() : e.pts.slice().reverse(); P[0] = s.a; P[P.length - 1] = s.b;
        len += plen(P);
        const V = fitArcs(P, chord); V.pop(); verts.push(...V);
        for (let i = 0; i < P.length - 1; i++) poly.push(P[i]);
      }
    }
    if (!c.closed) { const last = c.edges[c.edges.length - 1]; verts.push([last.b[0], last.b[1], 0]); poly.push(last.b); }
    return { closed: c.closed, poly, len, verts };
  }

  // ломаная -> вершины с выпуклостями (дуги + отрезки) с точностью tol
  function fitArcs(P, tol) {
    const out = [];
    const rec = (i, j, depth) => {
      if (j - i <= 1) { out.push([P[i][0], P[i][1], 0]); return; }
      const a = P[i], b = P[j];
      let ok = true; for (let k = i + 1; k < j && ok; k++) if (segDist(P[k], a, b) > tol) ok = false;
      if (ok) { out.push([a[0], a[1], 0]); return; }
      const m = P[(i + j) >> 1]; const c = circum(a, m, b);
      if (c && depth < 40) {
        const r = d2(c, a);
        let ok2 = r < 1e6; for (let k = i + 1; k < j && ok2; k++) if (Math.abs(d2(P[k], c) - r) > tol) ok2 = false;
        if (ok2) {
          // направление и угол
          const ccw = (m[0] - a[0]) * (b[1] - a[1]) - (m[1] - a[1]) * (b[0] - a[0]) > 0; // середина справа от хорды — против часовой
          const t0 = Math.atan2(a[1] - c[1], a[0] - c[0]), t1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
          let sw = ccw ? normA(t1 - t0) : -normA(t0 - t1);
          // проверка, что промежуточные точки по углу идут монотонно (не дуга «с обратной стороны»)
          const tm = Math.atan2(m[1] - c[1], m[0] - c[0]); const sm = ccw ? normA(tm - t0) : -normA(t0 - tm);
          if (Math.abs(sm) < Math.abs(sw) && Math.abs(sw) < TAU - 1e-6) { out.push([a[0], a[1], Math.tan(sw / 4)]); return; }
        }
      }
      const mid = (i + j) >> 1; rec(i, mid, depth + 1); rec(mid, j, depth + 1);
    };
    rec(0, P.length - 1, 0);
    out.push([P[P.length - 1][0], P[P.length - 1][1], 0]);
    return out;
  }
  function circum(a, b, c) {
    const ax = a[0], ay = a[1], bx = b[0], by = b[1], cx = c[0], cy = c[1];
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by)); if (Math.abs(d) < 1e-12) return null;
    const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
    return [(a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d, (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d];
  }

  function nestDepth(cs) {
    const closed = cs.filter(c => c.closed);
    for (const c of cs) { c.area = c.closed ? Math.abs(area(c.poly)) : 0; c.bb = bbox(c.poly); }
    for (const c of cs) {
      c.depth = 0; c.parent = null;
      const p = c.poly[0];
      let best = null;
      for (const o of closed) {
        if (o === c || o.area <= c.area) continue;
        if (o.bb[0] > c.bb[0] + 1e-9 || o.bb[1] > c.bb[1] + 1e-9 || o.bb[2] < c.bb[2] - 1e-9 || o.bb[3] < c.bb[3] - 1e-9) continue;
        // берём несколько точек контура — устойчивее к касаниям
        let votes = 0, tot = 0; const step = Math.max(1, Math.floor(c.poly.length / 7));
        for (let i = 0; i < c.poly.length; i += step) { tot++; if (inside(c.poly[i], o.poly)) votes++; }
        if (votes * 2 > tot) { c.depth++; if (!best || o.area < best.area) best = o; }
      }
      c.parent = best;
    }
  }

  // пересечение рёбер разных контуров (и самопересечения)
  function crossings(cs, add) {
    const segs = [];
    cs.forEach((c, ci) => { const P = c.poly, n = P.length; const m = c.closed ? n : n - 1; for (let i = 0; i < m; i++) segs.push([P[i], P[(i + 1) % n], ci, i, n]); });
    if (segs.length > 60000) return;
    const sb = segs.map(s => [Math.min(s[0][0], s[1][0]), Math.min(s[0][1], s[1][1]), Math.max(s[0][0], s[1][0]), Math.max(s[0][1], s[1][1])]);
    const ord = segs.map((_, i) => i).sort((a, b) => sb[a][0] - sb[b][0]);
    const hits = []; const seen = new Set();
    for (let ii = 0; ii < ord.length; ii++) {
      const i = ord[ii];
      for (let jj = ii + 1; jj < ord.length; jj++) {
        const j = ord[jj]; if (sb[j][0] > sb[i][2]) break;
        if (sb[j][1] > sb[i][3] || sb[j][3] < sb[i][1]) continue;
        const A = segs[i], B = segs[j];
        if (A[2] === B[2]) { const n = A[4]; const di = Math.abs(A[3] - B[3]); if (di <= 1 || di === n - 1) continue; }
        const X = segX(A[0], A[1], B[0], B[1]);
        if (X) { const key = A[2] + ':' + B[2]; if (!seen.has(key)) { seen.add(key); hits.push(X); } }
      }
    }
    if (hits.length) add('err', 'cross', 'Контуры пересекаются или касаются — проверьте чертёж', hits, hits.length);
  }
  function segX(p, p2, q, q2) {
    const r = [p2[0] - p[0], p2[1] - p[1]], s = [q2[0] - q[0], q2[1] - q[1]];
    const den = r[0] * s[1] - r[1] * s[0]; if (Math.abs(den) < 1e-12) return null;
    const t = ((q[0] - p[0]) * s[1] - (q[1] - p[1]) * s[0]) / den, u = ((q[0] - p[0]) * r[1] - (q[1] - p[1]) * r[0]) / den;
    const e = 1e-7; if (t > e && t < 1 - e && u > e && u < 1 - e) return [p[0] + t * r[0], p[1] + t * r[1]];
    return null;
  }
  function convexHull(P) {
    const p = P.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]); if (p.length < 3) return p;
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    up.pop(); lo.pop(); return lo.concat(up);
  }

  // ---------------------------------------------------------------- запись DXF (R12)
  // contours: [{verts|circle, closed}], сдвиг/поворот не применяется
  function writeDXF(contours, opt) {
    opt = opt || {};
    const o = [];
    const P = (c, v) => { o.push(String(c)); o.push(String(v)); };
    const f = x => { const s = (Math.round(x * 1e6) / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0'); return s === '-0.0' ? '0.0' : s; };
    let bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (const c of contours) for (const p of c.poly || []) { bb[0] = Math.min(bb[0], p[0]); bb[1] = Math.min(bb[1], p[1]); bb[2] = Math.max(bb[2], p[0]); bb[3] = Math.max(bb[3], p[1]); }
    if (!isFinite(bb[0])) bb = [0, 0, 0, 0];
    P(0, 'SECTION'); P(2, 'HEADER');
    P(9, '$ACADVER'); P(1, 'AC1009');
    P(9, '$INSUNITS'); P(70, 4);
    P(9, '$EXTMIN'); P(10, f(bb[0])); P(20, f(bb[1])); P(30, '0.0');
    P(9, '$EXTMAX'); P(10, f(bb[2])); P(20, f(bb[3])); P(30, '0.0');
    P(0, 'ENDSEC');
    P(0, 'SECTION'); P(2, 'TABLES');
    P(0, 'TABLE'); P(2, 'LTYPE'); P(70, 1); P(0, 'LTYPE'); P(2, 'CONTINUOUS'); P(70, 0); P(3, 'Solid line'); P(72, 65); P(73, 0); P(40, '0.0'); P(0, 'ENDTAB');
    P(0, 'TABLE'); P(2, 'LAYER'); P(70, 1); P(0, 'LAYER'); P(2, '0'); P(70, 0); P(62, 7); P(6, 'CONTINUOUS'); P(0, 'ENDTAB');
    P(0, 'ENDSEC');
    P(0, 'SECTION'); P(2, 'ENTITIES');
    for (const c of contours) {
      if (c.circle) { P(0, 'CIRCLE'); P(8, '0'); P(10, f(c.circle.c[0])); P(20, f(c.circle.c[1])); P(30, '0.0'); P(40, f(c.circle.r)); continue; }
      const V = c.verts; if (!V || V.length < 2) continue;
      // замкнутый контур: последняя вершина = первой — убираем, ставим флаг замкнутости
      let vs = V.slice(); if (c.closed && d2(vs[0], vs[vs.length - 1]) < 1e-9) vs.pop();
      P(0, 'POLYLINE'); P(8, '0'); P(66, 1); P(10, '0.0'); P(20, '0.0'); P(30, '0.0'); P(70, c.closed ? 1 : 0);
      for (const v of vs) { P(0, 'VERTEX'); P(8, '0'); P(10, f(v[0])); P(20, f(v[1])); P(30, '0.0'); if (Math.abs(v[2]) > 1e-12) P(42, f(v[2])); }
      P(0, 'SEQEND'); P(8, '0');
    }
    P(0, 'ENDSEC'); P(0, 'EOF');
    return o.join('\r\n') + '\r\n';
  }

  // точная длина по вершинам с выпуклостью (для проверки записи)
  function vertsLen(V, closed) {
    let s = 0; const n = V.length; const m = closed ? n : n - 1;
    for (let i = 0; i < m; i++) { const a = V[i], b = V[(i + 1) % n]; const L = d2(a, b); const bl = a[2]; if (!bl) s += L; else { const th = 4 * Math.atan(Math.abs(bl)); s += L * th / (2 * Math.sin(th / 2)); } }
    return s;
  }

  // всё вместе: байты -> анализ
  function analyze(bytes, opt) {
    const doc = root.DXF.parse(bytes);
    const { prims, notes } = root.DXF.primitives(doc);
    const r = clean(prims, notes, opt);
    r.raw = { prims: prims.length, ents: doc.ents.length };
    return r;
  }

  root.DXFClean = { analyze, clean, writeDXF, vertsLen, fitArcs, DEF, _int: { area, inside, bbox, arcPts } };
  if (typeof module !== 'undefined') module.exports = root.DXFClean;
})(typeof window !== 'undefined' ? window : globalThis);
