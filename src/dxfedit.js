// ===== Лист: простой редактор — нарисовать деталь, разобрать общий DXF на детали, перерисовать эскиз (чертёж сбоку) =====
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const DC = window.DXFClean;
  const num = v => { const s = String(v === undefined || v === null ? '' : v).trim().replace(',', '.'); return s === '' ? NaN : +s; };
  const fmt = (x, d = 1) => { const v = Math.round((isFinite(x) ? x : 0) * 10 ** d) / 10 ** d; return String(Object.is(v, -0) ? 0 : v).replace('.', ','); };
  const esc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const TAU = Math.PI * 2;
  const B90 = Math.tan(Math.PI / 8); // выпуклость дуги 90°
  const near = (a, b, e = 1e-6) => Math.abs(a[0] - b[0]) < e && Math.abs(a[1] - b[1]) < e;

  let E = null; // состояние открытого редактора
  let lastIn = { w: '', h: '', d: '' };
  let ortho = true; // как «Орто» в Компасе: отрезки только по горизонтали и вертикали; Shift — наоборот

  // ---------------------------------------------------------------- геометрия фигур
  function arc(cx, cy, r, a0, a1, n) { const o = []; for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; o.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); } return o; }
  function rr(s) { return Math.max(0, Math.min(s.r || 0, s.w / 2, s.h / 2)); }
  // плотный многоугольник фигуры (для рисования, попадания мышью, вложенности)
  function polyOf(s) {
    if (s.type === 'circle') { const p = arc(s.cx, s.cy, s.r, 0, TAU, 64); p.pop(); return p; }
    if (s.type === 'rect') {
      const r = rr(s), x = s.x, y = s.y, w = s.w, h = s.h;
      if (!(r > 1e-9)) return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
      return [...arc(x + w - r, y + r, r, -Math.PI / 2, 0, 8), ...arc(x + w - r, y + h - r, r, 0, Math.PI / 2, 8), ...arc(x + r, y + h - r, r, Math.PI / 2, Math.PI, 8), ...arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI, 8)];
    }
    if (s.type === 'poly') return s.pts.map(p => [p[0], p[1]]);
    return s.poly; // imp
  }
  const closedOf = s => s.type === 'imp' ? !!s.closed : s.type === 'poly' ? s.closed !== false : true;
  // контур для записи в DXF
  function contourOf(s) {
    const poly = polyOf(s);
    if (s.type === 'circle') return { closed: true, circle: { c: [s.cx, s.cy], r: s.r }, poly };
    if (s.type === 'rect') {
      const r = rr(s), x = s.x, y = s.y, w = s.w, h = s.h;
      const verts = r > 1e-9
        ? [[x + r, y, 0], [x + w - r, y, B90], [x + w, y + r, 0], [x + w, y + h - r, B90], [x + w - r, y + h, 0], [x + r, y + h, B90], [x, y + h - r, 0], [x, y + r, B90]]
        : [[x, y, 0], [x + w, y, 0], [x + w, y + h, 0], [x, y + h, 0]];
      return { closed: true, verts, poly };
    }
    if (s.type === 'poly') return { closed: closedOf(s), verts: s.pts.map(p => [p[0], p[1], 0]), poly };
    return { closed: s.closed, circle: s.circle || null, verts: s.verts, poly: s.poly };
  }
  function bboxOf(P) { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of P) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; } return [x0, y0, x1, y1]; }
  function areaOf(P) { let a = 0; for (let i = 0, n = P.length; i < n; i++) { const p = P[i], q = P[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a) / 2; }
  function inside(p, P) { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const a = P[i], b = P[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; }
  function segDist(p, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1]; const L = dx * dx + dy * dy; let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); }
  function outlineDist(p, s) { const P = polyOf(s); let m = Infinity; const n = closedOf(s) ? P.length : P.length - 1; for (let i = 0; i < n; i++) m = Math.min(m, segDist(p, P[i], P[(i + 1) % P.length])); return m; }
  function moveShape(s, dx, dy) {
    if (s.type === 'rect') { s.x += dx; s.y += dy; }
    else if (s.type === 'circle') { s.cx += dx; s.cy += dy; }
    else if (s.type === 'poly') s.pts = s.pts.map(p => [p[0] + dx, p[1] + dy]);
    else { s.poly = s.poly.map(p => [p[0] + dx, p[1] + dy]); if (s.verts) s.verts = s.verts.map(v => [v[0] + dx, v[1] + dy, v[2]]); if (s.circle) s.circle = { c: [s.circle.c[0] + dx, s.circle.c[1] + dy], r: s.circle.r }; }
  }
  // опорная точка фигуры: у круга — центр, у остальных — левый нижний угол габарита
  function refOf(s) { if (s.type === 'circle') return [s.cx, s.cy]; const b = bboxOf(polyOf(s)); return [b[0], b[1]]; }
  function centerOf(s) { if (s.type === 'circle') return [s.cx, s.cy]; if (s.type === 'imp' && s.circle) return s.circle.c; const b = bboxOf(polyOf(s)); return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; }

  // ---------------------------------------------------------------- детали: наружный контур + его отверстия
  function structure() {
    const S = E.shapes; const info = new Map();
    for (const s of S) { const P = polyOf(s); info.set(s.id, { P, bb: bboxOf(P), area: closedOf(s) ? areaOf(P) : 0, parent: null, depth: 0 }); }
    for (const s of S) {
      const a = info.get(s.id); let best = null, depth = 0;
      for (const o of S) {
        if (o === s || !closedOf(o)) continue; const b = info.get(o.id);
        if (b.area <= a.area || b.bb[0] > a.bb[0] + 1e-6 || b.bb[1] > a.bb[1] + 1e-6 || b.bb[2] < a.bb[2] - 1e-6 || b.bb[3] < a.bb[3] - 1e-6) continue;
        let votes = 0, tot = 0; const step = Math.max(1, Math.floor(a.P.length / 7));
        for (let i = 0; i < a.P.length; i += step) { tot++; if (inside(a.P[i], b.P)) votes++; }
        if (votes * 2 > tot) { depth++; if (!best || b.area < info.get(best.id).area) best = o; }
      }
      a.parent = best; a.depth = depth;
    }
    const pieces = [];
    for (const s of S) { const a = info.get(s.id); if (closedOf(s) && a.depth % 2 === 0) pieces.push({ outer: s, holes: [], open: [], bb: a.bb }); }
    for (const s of S) {
      const a = info.get(s.id);
      if (closedOf(s) && a.depth % 2 === 1) { const pc = pieces.find(p => p.outer === a.parent); if (pc) pc.holes.push(s); }
      else if (!closedOf(s)) { const pc = pieces.find(p => p.outer === a.parent) || pieces.find(p => inside(a.P[0], info.get(p.outer.id).P)); if (pc) pc.open.push(s); }
    }
    // порядок как на чертеже: слева направо, сверху вниз — так проще сверять
    pieces.sort((p, q) => (p.bb[0] - q.bb[0]) || (q.bb[3] - p.bb[3]));
    return { info, pieces };
  }
  const pieceShapes = pc => [pc.outer, ...pc.holes, ...pc.open];
  function pieceName(pc, i, n) { return pc.outer.pname || (n > 1 ? `${E.name} — ${i + 1}` : E.name); }

  // ---------------------------------------------------------------- вид
  const W2S = p => [E.v.tx + p[0] * E.v.k, E.v.ty - p[1] * E.v.k];
  const S2W = (x, y) => [(x - E.v.tx) / E.v.k, (E.v.ty - y) / E.v.k];
  function evPt(e) { const r = $('#dxSvg').getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  function fit() {
    const r = $('#dxSvg').getBoundingClientRect(); let P = E.shapes.flatMap(polyOf);
    if (!P.length) P = [[0, 0], [300, 200]];
    const b = bboxOf(P), w = Math.max(b[2] - b[0], 1), h = Math.max(b[3] - b[1], 1);
    const k = Math.max(0.01, Math.min((r.width - 100) / w, (r.height - 100) / h));
    E.v = { k, tx: r.width / 2 - (b[0] + w / 2) * k, ty: r.height / 2 + (b[1] + h / 2) * k };
  }

  // ---------------------------------------------------------------- привязки, как в Компасе: вершина, середина, центр, квадрант, выравнивание
  const KIND = { end: 'вершина', mid: 'середина', cen: 'центр', quad: 'квадрант' };
  function candidates(skip) {
    const out = []; const add = (p, k) => out.push({ p, k });
    const segs = (P, closed) => { const n = closed ? P.length : P.length - 1; for (let i = 0; i < n; i++) { const a = P[i], b = P[(i + 1) % P.length]; add([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], 'mid'); } };
    for (const s of E.shapes) {
      if (skip && skip.has(s.id)) continue;
      if (s.type === 'circle' || (s.type === 'imp' && s.circle)) {
        const c = s.type === 'circle' ? [s.cx, s.cy] : s.circle.c, r = s.type === 'circle' ? s.r : s.circle.r;
        add(c, 'cen'); add([c[0] + r, c[1]], 'quad'); add([c[0] - r, c[1]], 'quad'); add([c[0], c[1] + r], 'quad'); add([c[0], c[1] - r], 'quad');
      } else if (s.type === 'rect') {
        const { x, y, w, h } = s; const r = rr(s);
        if (r < 1e-9) for (const p of [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]) add(p, 'end');
        add([x + w / 2, y], 'mid'); add([x + w / 2, y + h], 'mid'); add([x, y + h / 2], 'mid'); add([x + w, y + h / 2], 'mid');
        add([x + w / 2, y + h / 2], 'cen');
      } else if (s.type === 'poly') {
        for (const p of s.pts) add(p, 'end'); segs(s.pts, closedOf(s));
        if (closedOf(s) && s.pts.length > 2) add(centerOf(s), 'cen');
      } else {
        const V = s.verts || []; for (const v of V) add([v[0], v[1]], 'end');
        const n = s.closed ? V.length : V.length - 1;
        for (let i = 0; i < n; i++) { const a = V[i], b = V[(i + 1) % V.length]; if (Math.abs(a[2] || 0) < 1e-9) add([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], 'mid'); }
        if (s.closed) add(centerOf(s), 'cen');
      }
    }
    if (E.draft && E.draft.type === 'seg') for (const p of E.draft.pts) add(p, 'end');
    return out;
  }
  const gridV = v => { const g = E.grid > 0 ? E.grid : 0; return g ? Math.round(v / g) * g : v; };
  // {p, k: вид привязки или '', ax/ay: точки, по которым выровнялись}
  function snap(w, skip, extra) {
    const C = candidates(skip); if (extra) for (const p of extra) if (p) C.push({ p, k: 'end' });
    const tol = 10 / E.v.k; let best = null, bd = tol;
    for (const c of C) { const d = Math.hypot(c.p[0] - w[0], c.p[1] - w[1]); if (d < bd || (best && Math.abs(d - bd) < 1e-9 && c.k === 'cen')) { bd = d; best = c; } }
    if (best) return { p: [best.p[0], best.p[1]], k: best.k };
    const at = 7 / E.v.k; let ax = null, ay = null, dx = at, dy = at;
    for (const c of C) {
      const ex = Math.abs(c.p[0] - w[0]), ey = Math.abs(c.p[1] - w[1]);
      if (ex < dx) { dx = ex; ax = c.p; } if (ey < dy) { dy = ey; ay = c.p; }
    }
    return { p: [ax ? ax[0] : gridV(w[0]), ay ? ay[1] : gridV(w[1])], k: '', ax, ay };
  }
  // точка отрезка: «Орто» держит горизонталь или вертикаль от предыдущей точки, привязки работают по свободной оси
  function segPoint(w, from, shift) {
    const s = snap(w, null, [from]);
    if (!from || ortho === !!shift) return s;
    const hz = Math.abs(w[0] - from[0]) >= Math.abs(w[1] - from[1]);
    const i = hz ? 0 : 1; // свободная координата
    let v, src = null;
    if (s.k) { v = s.p[i]; src = s.p; } else if (hz ? s.ax : s.ay) { src = hz ? s.ax : s.ay; v = src[i]; } else v = gridV(w[i]);
    const p = hz ? [v, from[1]] : [from[0], v];
    const k = src && near(src, p, 1e-9) ? s.k : '';
    return { p, k, ax: hz && src && !k ? src : null, ay: !hz && src && !k ? src : null };
  }

  // ---------------------------------------------------------------- история правок
  function commit() { E.undo.push(JSON.stringify(E.shapes)); if (E.undo.length > 60) E.undo.shift(); E.dirty = true; }
  function undo() { const j = E.undo.pop(); if (!j) return; E.shapes = JSON.parse(j); E.sel.clear(); E.draft = null; draw(); side(); }
  const newId = () => E.nextId++;

  // ---------------------------------------------------------------- рисование
  const pathD = P => { let d = ''; for (let i = 0; i < P.length; i++) d += (i ? 'L' : 'M') + (+P[i][0].toFixed(3)) + ' ' + (+P[i][1].toFixed(3)); return d; };
  const sp = p => { const q = W2S(p); return [+q[0].toFixed(1), +q[1].toFixed(1)]; };
  // подсказка у курсора: «Ширина = 81» и т.п.
  function tipSvg(lines, W, H) {
    if (!lines || !lines.length || !E.scur) return '';
    const lw = Math.max(...lines.map(l => l.length)) * 7.4 + 14, lh = lines.length * 17 + 8;
    let x = E.scur[0] + 18, y = E.scur[1] + 18; if (x + lw > W - 4) x = E.scur[0] - lw - 12; if (y + lh > H - 4) y = E.scur[1] - lh - 12;
    return `<g class="dxtip"><rect x="${x}" y="${y}" width="${lw}" height="${lh}" rx="5"/>${lines.map((l, i) => `<text x="${x + 7}" y="${y + 17 + i * 17}">${esc(l)}</text>`).join('')}</g>`;
  }
  // размерная линия между точками экрана a и b, со смещением off (px) по нормали
  function dimSvg(a, b, off, text) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy); if (L < 2) return '';
    const ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
    const A = [a[0] + nx * off, a[1] + ny * off], B = [b[0] + nx * off, b[1] + ny * off]; const ext = 4 * (Math.sign(off) || 1);
    const ar = (P, k) => `M${P[0] + k * ux * 8 + nx * 3} ${P[1] + k * uy * 8 + ny * 3}L${P[0]} ${P[1]}L${P[0] + k * ux * 8 - nx * 3} ${P[1] + k * uy * 8 - ny * 3}`;
    let ang = Math.atan2(dy, dx) * 180 / Math.PI; if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
    const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2;
    return `<g class="dxdim"><path d="M${a[0]} ${a[1]}L${A[0] + nx * ext} ${A[1] + ny * ext}M${b[0]} ${b[1]}L${B[0] + nx * ext} ${B[1] + ny * ext}M${A[0]} ${A[1]}L${B[0]} ${B[1]}${ar(A, 1)}${ar(B, -1)}"/><text transform="translate(${mx} ${my}) rotate(${ang})" text-anchor="middle" dy="-5">${esc(text)}</text></g>`;
  }
  function snapSvg(s) {
    if (!s) return '';
    let h = '';
    const q = sp(s.p);
    for (const a of [s.ax, s.ay]) if (a) { const A = sp(a); h += `<path class="dxguide" d="M${A[0]} ${A[1]}L${q[0]} ${q[1]}"/><circle class="dxsnap" cx="${A[0]}" cy="${A[1]}" r="3"/>`; }
    if (s.k === 'end') h += `<rect class="dxsnap" x="${q[0] - 5}" y="${q[1] - 5}" width="10" height="10"/>`;
    else if (s.k === 'mid') h += `<path class="dxsnap" d="M${q[0]} ${q[1] - 6}L${q[0] + 6} ${q[1] + 5}L${q[0] - 6} ${q[1] + 5}Z"/>`;
    else if (s.k === 'cen') h += `<circle class="dxsnap" cx="${q[0]}" cy="${q[1]}" r="6"/><path class="dxsnap" d="M${q[0] - 9} ${q[1]}H${q[0] + 9}M${q[0]} ${q[1] - 9}V${q[1] + 9}"/>`;
    else if (s.k === 'quad') h += `<path class="dxsnap" d="M${q[0]} ${q[1] - 6}L${q[0] + 6} ${q[1]}L${q[0]} ${q[1] + 6}L${q[0] - 6} ${q[1]}Z"/>`;
    if (s.k) h += `<text class="dxsnapt" x="${q[0] + 10}" y="${q[1] - 9}">${KIND[s.k]}</text>`;
    return h;
  }
  const L2 = v => fmt(v, 2);
  function draw() {
    if (!E) return;
    const svg = $('#dxSvg'); const r = svg.getBoundingClientRect(); const v = E.v;
    const { info, pieces } = E.st = structure();
    // сетка: шаг на экране не мельче 12 px
    let gs = E.grid > 0 ? E.grid : 10; while (gs * v.k < 12) gs *= (String(gs)[0] === '2' ? 2.5 : 2); const gpx = gs * v.k;
    const ox = ((v.tx % gpx) + gpx) % gpx, oy = ((v.ty % gpx) + gpx) % gpx;
    const pieceOf = new Map(); pieces.forEach((pc, i) => pieceShapes(pc).forEach(s => pieceOf.set(s.id, i)));
    let h = `<defs><pattern id="dxGrid" width="${gpx}" height="${gpx}" patternUnits="userSpaceOnUse" x="${ox}" y="${oy}"><path d="M ${gpx} 0 L 0 0 0 ${gpx}" class="dxg"/></pattern></defs><rect width="100%" height="100%" fill="url(#dxGrid)"/>`;
    h += `<line x1="0" y1="${v.ty}" x2="${r.width}" y2="${v.ty}" class="dxax"/><line x1="${v.tx}" y1="0" x2="${v.tx}" y2="${r.height}" class="dxax"/>`;
    h += `<g transform="translate(${v.tx} ${v.ty}) scale(${v.k} ${-v.k})">`;
    pieces.forEach((pc, i) => { let d = pathD(info.get(pc.outer.id).P) + 'Z'; for (const hh of pc.holes) d += pathD(info.get(hh.id).P) + 'Z'; h += `<path d="${d}" fill-rule="evenodd" class="dxfill${E.hot === i ? ' hot' : ''}"/>`; });
    for (const s of E.shapes) {
      const sel = E.sel.has(s.id), a = info.get(s.id);
      const cls = 'dxs' + (sel ? ' sel' : '') + (!closedOf(s) ? ' open' : a.depth % 2 ? ' hole' : '') + (pieceOf.get(s.id) === undefined && closedOf(s) ? ' loose' : '');
      h += `<path d="${pathD(a.P)}${closedOf(s) ? 'Z' : ''}" class="${cls}"/>`;
    }
    const d = E.draft;
    if (d && d.type === 'rect' && d.w > 0) h += `<path d="${pathD(polyOf(d))}Z" class="dxs draft"/>`;
    else if (d && d.type === 'circle' && d.r > 0) h += `<path d="${pathD(polyOf(d))}Z" class="dxs draft"/>`;
    else if (d && d.type === 'seg') h += `<path d="${pathD(d.pts.concat(d.cur ? [d.cur] : []))}" class="dxs draft"/>`;
    h += '</g>';
    // экранный слой: номера деталей, центр под курсором, размеры, привязки, подсказка
    if (pieces.length > 1 || pieces.some(pc => (pc.outer.qty || 1) > 1)) pieces.forEach((pc, i) => { const p = W2S([pc.bb[0], pc.bb[3]]); h += `<g class="dxlab${E.hot === i ? ' hot' : ''}"><rect x="${p[0]}" y="${p[1] - 20}" width="${String(i + 1).length * 8 + (pc.outer.qty > 1 ? String(pc.outer.qty).length * 8 + 22 : 12)}" height="18" rx="4"/><text x="${p[0] + 6}" y="${p[1] - 7}">${i + 1}${pc.outer.qty > 1 ? ' × ' + pc.outer.qty : ''}</text></g>`; });
    if (E.tool !== 'sel' && E.hov) { const c = sp(centerOf(E.hov)); h += `<path class="dxcen" d="M${c[0] - 12} ${c[1]}H${c[0] + 12}M${c[0]} ${c[1] - 12}V${c[1] + 12}"/>`; }
    let tip = null;
    if (E.tool === 'ruler' && E.shapes.length) { // габариты всего чертежа
      const b = bboxOf(E.shapes.flatMap(s => info.get(s.id).P));
      h += dimSvg(sp([b[0], b[1]]), sp([b[2], b[1]]), 26, L2(b[2] - b[0])) + dimSvg(sp([b[2], b[3]]), sp([b[2], b[1]]), -26, L2(b[3] - b[1]));
    }
    const ms = d && d.type === 'ruler' ? (d.cur ? [d.a, d.cur] : null) : E.meas;
    if (ms) {
      const [a, b] = ms; const A = sp(a), B = sp(b);
      h += `<path class="dxruler" d="M${A[0]} ${A[1]}L${B[0]} ${B[1]}"/><circle class="dxpt" cx="${A[0]}" cy="${A[1]}" r="3"/><circle class="dxpt" cx="${B[0]}" cy="${B[1]}" r="3"/>`;
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]); h += dimSvg(A, B, -14, L2(L));
      if (d && d.type === 'ruler') tip = [`Расстояние = ${L2(L)}`, `по X = ${L2(Math.abs(b[0] - a[0]))}`, `по Y = ${L2(Math.abs(b[1] - a[1]))}`];
    }
    if (d && d.type === 'rect' && d.a) {
      const b = [d.x, d.y, d.x + d.w, d.y + d.h];
      if (d.w > 0) h += dimSvg(sp([b[0], b[3]]), sp([b[2], b[3]]), -18, L2(d.w)) + dimSvg(sp([b[2], b[3]]), sp([b[2], b[1]]), -18, L2(d.h));
      tip = [`Ширина = ${L2(d.w)}`, `Высота = ${L2(d.h)}`];
    }
    if (d && d.type === 'circle' && d.a) { if (d.r > 0) { const c = sp([d.cx, d.cy]), q = sp([d.cx + d.r, d.cy]); h += `<path class="dxguide" d="M${c[0]} ${c[1]}L${q[0]} ${q[1]}"/>`; } tip = [`Диаметр = ${L2(2 * d.r)}`]; }
    if (d && d.type === 'seg') {
      for (const p of d.pts) { const q = sp(p); h += `<circle cx="${q[0]}" cy="${q[1]}" r="3" class="dxpt"/>`; }
      const l = d.pts[d.pts.length - 1];
      if (l && d.cur) { const L = Math.hypot(d.cur[0] - l[0], d.cur[1] - l[1]); let ang = Math.atan2(d.cur[1] - l[1], d.cur[0] - l[0]) * 180 / Math.PI; if (ang < 0) ang += 360; tip = [`Длина = ${L2(L)}`, `Угол = ${fmt(L > 1e-9 ? ang : 0, 1)}`]; }
    }
    h += snapSvg(E.snap);
    if (!E.typing) h += tipSvg(tip, r.width, r.height);
    svg.innerHTML = h;
    const tot = E.shapes.length ? bboxOf(E.shapes.flatMap(s => info.get(s.id).P)) : null;
    $('#dxStat').textContent = (E.msg ? E.msg + '   ' : '') + (tot ? `Всё: ${fmt(tot[2] - tot[0])} × ${fmt(tot[3] - tot[1])} мм` : '') + (E.cur ? `   X ${fmt(E.cur[0])}  Y ${fmt(E.cur[1])}` : '');
    $('#dxDone').textContent = E.origin ? (pieces.length > 1 ? `Разделить на ${pieces.length} дет.` : 'Готово') : (pieces.length > 1 ? `В лист: ${pieces.length} дет.` : 'В лист');
    $('#dxDone').disabled = !pieces.length;
    $('#dxSave').disabled = !E.shapes.length;
    $('#dxUndo').disabled = !E.undo.length;
  }

  // ---------------------------------------------------------------- правая панель
  const fld = (label, key, val, w) => `<label class="dxf"><span>${label}</span><input type="text" inputmode="decimal" class="nm" data-p="${key}" value="${esc(val)}"${w ? ` style="width:${w}px"` : ''}></label>`;
  function side() {
    if (!E) return;
    const { info, pieces } = E.st || (E.st = structure());
    const sel = E.shapes.filter(s => E.sel.has(s.id));
    let h = `<div class="dxsec"><div class="t">Добавить</div>
      <div class="dxrow"><span class="dxl">▭</span><input type="text" inputmode="decimal" class="nm" id="dxRW" placeholder="ширина" value="${esc(E.last.w)}"><span>×</span><input type="text" inputmode="decimal" class="nm" id="dxRH" placeholder="высота" value="${esc(E.last.h)}"><button class="btn small" id="dxAddR">＋</button></div>
      <div class="dxrow"><span class="dxl">◯</span><span class="meta">Ø</span><input type="text" inputmode="decimal" class="nm" id="dxCD" placeholder="диаметр" value="${esc(E.last.d)}"><button class="btn small" id="dxAddC">＋</button><span class="meta">${sel.length === 1 && closedOf(sel[0]) ? 'в центр выбранной' : ''}</span></div></div>`;
    if (sel.length === 1) {
      const s = sel[0], a = info.get(s.id), par = a.parent, b = a.bb;
      h += `<div class="dxsec"><div class="t">${s.type === 'rect' ? 'Прямоугольник' : s.type === 'circle' ? 'Окружность' : closedOf(s) ? 'Контур' : 'Отрезки'}${a.depth % 2 ? ' — отверстие' : ''}</div><div class="dxgrid">`;
      if (s.type === 'rect') h += fld('Ширина', 'w', fmt(s.w, 3)) + fld('Высота', 'h', fmt(s.h, 3));
      else if (s.type === 'circle') h += fld('Диаметр', 'd', fmt(2 * s.r, 3));
      else h += `<span class="meta" style="grid-column:1/-1">${fmt(b[2] - b[0])} × ${fmt(b[3] - b[1])} мм</span>`;
      const rf = refOf(s);
      if (par) { const pb = info.get(par.id).bb; h += fld(s.type === 'circle' ? 'Центр от левого края' : 'От левого края', 'px', fmt(rf[0] - pb[0], 3)) + fld(s.type === 'circle' ? 'Центр от низа' : 'От низа', 'py', fmt(rf[1] - pb[1], 3)); }
      else h += fld('X', 'x', fmt(rf[0], 3)) + fld('Y', 'y', fmt(rf[1], 3));
      if (s.type === 'rect') h += fld('Скругление R', 'r', fmt(s.r || 0, 3));
      h += '</div>';
      if (s.type === 'poly') h += `<div class="dxpts">${s.pts.map((p, i) => `<div class="dxrow"><span class="dxl">${i + 1}</span><input type="text" class="nm" data-pt="${i}:0" value="${fmt(p[0], 3)}"><input type="text" class="nm" data-pt="${i}:1" value="${fmt(p[1], 3)}"></div>`).join('')}</div>`;
      h += `<div class="dxrow wr">${par ? '<button class="btn small" id="dxCenter">По центру</button>' : ''}<button class="btn small" id="dxCopy">Копия</button><button class="btn small" id="dxDel">Удалить</button></div>
        <div class="dxrow"><span class="meta">Размножить:</span><input type="text" class="nm" id="dxArrN" placeholder="шт" style="width:48px"><span class="meta">шаг X</span><input type="text" class="nm" id="dxArrX" style="width:56px"><span class="meta">Y</span><input type="text" class="nm" id="dxArrY" style="width:56px"><button class="btn small" id="dxArr">＋</button></div></div>`;
    } else if (sel.length > 1) h += `<div class="dxsec"><div class="t">Выбрано: ${sel.length}</div><div class="dxrow"><button class="btn small" id="dxCopy">Копия</button><button class="btn small" id="dxDel">Удалить</button></div></div>`;
    h += `<div class="dxsec"><div class="t">Детали${pieces.length ? ' · ' + pieces.length : ''}</div>`;
    if (!pieces.length) h += '<div class="meta">Нарисуйте замкнутый контур</div>';
    pieces.forEach((pc, i) => {
      const on = pieceShapes(pc).some(s => E.sel.has(s.id));
      h += `<div class="dxpc${on ? ' on' : ''}" data-pc="${i}"><b>${i + 1}</b><input type="text" class="pn" data-pn="${i}" value="${esc(pieceName(pc, i, pieces.length))}"><span class="meta">${fmt(pc.bb[2] - pc.bb[0])}×${fmt(pc.bb[3] - pc.bb[1])}${pc.holes.length ? ' · отв. ' + pc.holes.length : ''}</span><input type="number" min="1" step="1" data-pq="${i}" value="${pc.outer.qty || 1}" title="Количество"></div>`;
    });
    const loose = E.shapes.filter(s => !closedOf(s)).length;
    if (loose) h += `<div class="err">Незамкнутых контуров: ${loose}</div>`;
    h += '</div>';
    $('#dxSide').innerHTML = h;
  }

  // ---------------------------------------------------------------- действия панели
  function addShape(s) {
    commit();
    const sel = E.shapes.filter(x => E.sel.has(x.id)); const host = sel.length === 1 && closedOf(sel[0]) ? sel[0] : null;
    let c;
    if (host) c = centerOf(host);
    else if (E.shapes.length) { const b = bboxOf(E.shapes.flatMap(polyOf)); c = [b[2] + 20 + (s.type === 'circle' ? s.r : s.w / 2), b[1] + (s.type === 'circle' ? s.r : s.h / 2)]; }
    else c = s.type === 'circle' ? [s.r, s.r] : [s.w / 2, s.h / 2];
    if (s.type === 'circle') { s.cx = c[0]; s.cy = c[1]; } else { s.x = c[0] - s.w / 2; s.y = c[1] - s.h / 2; }
    s.id = newId(); E.shapes.push(s); E.sel = new Set([s.id]);
    if (!host) fit();
    draw(); side();
  }
  function onSideClick(e) {
    const t = e.target;
    if (t.id === 'dxAddR') { const w = num($('#dxRW').value), h = num($('#dxRH').value); if (!(w > 0 && h > 0)) return; E.last.w = $('#dxRW').value; E.last.h = $('#dxRH').value; addShape({ type: 'rect', w, h, r: 0 }); return; }
    if (t.id === 'dxAddC') { const d = num($('#dxCD').value); if (!(d > 0)) return; E.last.d = $('#dxCD').value; addShape({ type: 'circle', r: d / 2 }); return; }
    const sel = E.shapes.filter(s => E.sel.has(s.id));
    if (t.id === 'dxDel') { delSel(); return; }
    if (t.id === 'dxCopy' && sel.length) { commit(); const b = bboxOf(sel.flatMap(polyOf)); const dx = Math.max(b[2] - b[0], 10) + 10; const ns = sel.map(s => { const c = JSON.parse(JSON.stringify(s)); c.id = newId(); delete c.qty; delete c.pname; moveShape(c, dx, 0); return c; }); E.shapes.push(...ns); E.sel = new Set(ns.map(s => s.id)); draw(); side(); return; }
    if (t.id === 'dxCenter' && sel.length === 1) { const s = sel[0], st = structure(), par = st.info.get(s.id).parent; if (!par) return; commit(); const pb = st.info.get(par.id).bb, b = st.info.get(s.id).bb; moveShape(s, (pb[0] + pb[2]) / 2 - (b[0] + b[2]) / 2, (pb[1] + pb[3]) / 2 - (b[1] + b[3]) / 2); draw(); side(); return; }
    if (t.id === 'dxArr' && sel.length === 1) { const n = Math.round(num($('#dxArrN').value)), dx = num($('#dxArrX').value) || 0, dy = num($('#dxArrY').value) || 0; if (!(n >= 2) || n > 500 || (!dx && !dy)) return; commit(); for (let i = 1; i < n; i++) { const c = JSON.parse(JSON.stringify(sel[0])); c.id = newId(); delete c.qty; delete c.pname; moveShape(c, dx * i, dy * i); E.shapes.push(c); } draw(); side(); return; }
    const pc = t.closest('[data-pc]'); if (pc && !t.matches('input')) { const p = E.st.pieces[+pc.dataset.pc]; E.sel = new Set(pieceShapes(p).map(s => s.id)); draw(); side(); }
  }
  function onSideChange(e) {
    const t = e.target;
    if (t.dataset.pq !== undefined) { const pc = E.st.pieces[+t.dataset.pq]; pc.outer.qty = Math.max(1, Math.round(+t.value) || 1); E.dirty = true; draw(); return; }
    if (t.dataset.pn !== undefined) { const pc = E.st.pieces[+t.dataset.pn]; pc.outer.pname = t.value.trim(); E.dirty = true; return; }
    const sel = E.shapes.filter(s => E.sel.has(s.id)); if (sel.length !== 1) return; const s = sel[0];
    if (t.dataset.pt !== undefined) { const [i, k] = t.dataset.pt.split(':').map(Number); const v = num(t.value); if (!isFinite(v)) { side(); return; } commit(); s.pts[i][k] = v; draw(); side(); return; }
    const key = t.dataset.p; if (!key) return; const v = num(t.value); if (!isFinite(v)) { side(); return; }
    commit();
    if (key === 'w' && v > 0) s.w = v; else if (key === 'h' && v > 0) s.h = v; else if (key === 'r' && v >= 0) s.r = v; else if (key === 'd' && v > 0) s.r = v / 2;
    else { const rf = refOf(s); const st = structure(), par = st.info.get(s.id).parent, pb = par ? st.info.get(par.id).bb : [0, 0];
      if (key === 'x') moveShape(s, v - rf[0], 0); else if (key === 'y') moveShape(s, 0, v - rf[1]); else if (key === 'px') moveShape(s, pb[0] + v - rf[0], 0); else if (key === 'py') moveShape(s, 0, pb[1] + v - rf[1]); }
    draw(); side();
  }
  function delSel() { if (!E.sel.size) return; commit(); E.shapes = E.shapes.filter(s => !E.sel.has(s.id)); E.sel.clear(); draw(); side(); }

  // ---------------------------------------------------------------- готовые фигуры
  function putRect(d) { if (!(d.w > 1e-6 && d.h > 1e-6)) return; commit(); const s = { id: newId(), type: 'rect', x: d.x, y: d.y, w: d.w, h: d.h, r: 0 }; E.shapes.push(s); E.sel = new Set([s.id]); }
  function putCircle(d) { if (!(d.r > 1e-6)) return; commit(); const s = { id: newId(), type: 'circle', cx: d.cx, cy: d.cy, r: d.r }; E.shapes.push(s); E.sel = new Set([s.id]); }
  function rectFrom(a, p) { return { type: 'rect', a, x: Math.min(a[0], p[0]), y: Math.min(a[1], p[1]), w: Math.abs(p[0] - a[0]), h: Math.abs(p[1] - a[1]) }; }
  // отрезки: цепочка; щелчок в начало — контур замкнулся; продолжение с конца уже нарисованной цепочки
  function openEnds() { return E.shapes.filter(s => s.type === 'poly' && !closedOf(s)); }
  function startSeg(p) {
    const d = E.draft = { type: 'seg', pts: [p], cur: null, ext: null };
    for (const s of openEnds()) {
      if (near(s.pts[s.pts.length - 1], p)) { d.pts = s.pts.map(q => q.slice()); d.ext = s.id; break; }
      if (near(s.pts[0], p)) { d.pts = s.pts.map(q => q.slice()).reverse(); d.ext = s.id; break; }
    }
  }
  function addSegPt(p) {
    const d = E.draft, l = d.pts[d.pts.length - 1];
    if (near(l, p, 1e-6)) return;
    if (d.pts.length >= 3 && near(d.pts[0], p, 1e-6)) { finishSeg(true); return; }
    d.pts.push(p);
  }
  function finishSeg(close) {
    const d = E.draft; E.draft = null; if (!d || d.type !== 'seg') return;
    let pts = d.pts; let drop = new Set(d.ext ? [d.ext] : []);
    if (!close) { // конец лёг на конец другой цепочки — склеиваем
      for (const s of openEnds()) {
        if (drop.has(s.id)) continue; const l = pts[pts.length - 1];
        if (near(s.pts[0], l)) { pts = pts.concat(s.pts.slice(1)); drop.add(s.id); break; }
        if (near(s.pts[s.pts.length - 1], l)) { pts = pts.concat(s.pts.slice(0, -1).reverse()); drop.add(s.id); break; }
      }
      if (pts.length >= 4 && near(pts[0], pts[pts.length - 1])) { pts = pts.slice(0, -1); close = true; }
    }
    if (pts.length < 2 || (d.ext && pts.length === E.shapes.find(s => s.id === d.ext).pts.length && !close)) { draw(); side(); return; }
    commit();
    E.shapes = E.shapes.filter(s => !drop.has(s.id));
    const s = { id: newId(), type: 'poly', pts, closed: !!close }; E.shapes.push(s); E.sel = new Set([s.id]);
    draw(); side();
  }

  // ---------------------------------------------------------------- ввод размера с клавиатуры (как в Компасе: начал рисовать — набрал число — Enter)
  function showIn(ch) {
    const inp = $('#dxIn'); E.typing = true;
    const q = E.scur || [100, 100]; inp.style.left = Math.max(4, q[0] + 16) + 'px'; inp.style.top = Math.max(4, q[1] + 16) + 'px';
    const d = E.draft; inp.placeholder = d.type === 'rect' ? 'ширина высота' : d.type === 'circle' ? 'диаметр' : 'длина  угол';
    inp.hidden = false; inp.value = ch; inp.focus(); draw();
  }
  function hideIn() { const inp = $('#dxIn'); inp.hidden = true; inp.value = ''; if (E) { E.typing = false; draw(); } }
  function applyIn() {
    const n = $('#dxIn').value.replace(/,/g, '.').split(/[\s*xхX×;]+/).filter(Boolean).map(Number).filter(isFinite);
    hideIn(); const d = E.draft; if (!d || !n.length) return;
    if (d.type === 'rect') {
      const c = E.cur || [d.a[0] + 1, d.a[1] + 1]; const sx = c[0] < d.a[0] ? -1 : 1, sy = c[1] < d.a[1] ? -1 : 1;
      const w = Math.abs(n[0]), h = n.length > 1 ? Math.abs(n[1]) : (d.h > 0 ? d.h : w);
      putRect(rectFrom(d.a, [d.a[0] + sx * w, d.a[1] + sy * h])); E.draft = null; draw(); side(); return;
    }
    if (d.type === 'circle') { putCircle({ cx: d.a[0], cy: d.a[1], r: Math.abs(n[0]) / 2 }); E.draft = null; draw(); side(); return; }
    if (d.type === 'seg') {
      const l = d.pts[d.pts.length - 1]; let ang;
      if (n.length > 1) ang = n[1] * Math.PI / 180;
      else { const c = d.cur || [l[0] + 1, l[1]]; ang = Math.hypot(c[0] - l[0], c[1] - l[1]) > 1e-9 ? Math.atan2(c[1] - l[1], c[0] - l[0]) : 0; }
      const L = n[0]; const p = [l[0] + L * Math.cos(ang), l[1] + L * Math.sin(ang)].map(v => Math.round(v * 1e6) / 1e6);
      addSegPt(p); if (E.draft) E.draft.cur = p; draw(); side();
    }
  }

  // ---------------------------------------------------------------- мышь и клавиши
  function hit(w, closedOnly) {
    const tol = 7 / E.v.k; let best = null, ba = Infinity;
    for (const s of E.shapes) { if (closedOnly && !closedOf(s)) continue; if (outlineDist(w, s) <= tol) { const a = closedOf(s) ? areaOf(polyOf(s)) : 0; if (a < ba) { ba = a; best = s; } } }
    if (best) return best;
    for (const s of E.shapes) { if (!closedOf(s)) continue; const P = polyOf(s); if (inside(w, P)) { const a = areaOf(P); if (a < ba) { ba = a; best = s; } } }
    return best;
  }
  let drag = null;
  function toolPoint(w, e) {
    const d = E.draft;
    if (E.tool === 'seg' && d && d.type === 'seg') return segPoint(w, d.pts[d.pts.length - 1], e.shiftKey);
    return snap(w);
  }
  function onDown(e) {
    if (!E) return; if (E.typing) hideIn();
    const [sx, sy] = evPt(e); const w = S2W(sx, sy);
    if (e.button === 1 || (e.button === 2 && E.tool === 'sel') || e.altKey) { drag = { pan: true, sx, sy, tx: E.v.tx, ty: E.v.ty }; e.preventDefault(); return; }
    if (e.button === 2) { // правая кнопка в инструменте: закончить
      e.preventDefault();
      if (E.draft && E.draft.type === 'seg') finishSeg(false); else if (E.draft) { E.draft = null; draw(); } else setTool('sel');
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault(); if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const s0 = toolPoint(w, e), p = s0.p, d = E.draft;
    if (E.tool === 'rect') {
      if (d && d.type === 'rect') { putRect(rectFrom(d.a, p)); E.draft = null; draw(); side(); return; }
      E.draft = rectFrom(p, p); drag = { shape: true, sx, sy }; draw(); return;
    }
    if (E.tool === 'circle') {
      if (d && d.type === 'circle') { putCircle({ cx: d.a[0], cy: d.a[1], r: Math.hypot(p[0] - d.a[0], p[1] - d.a[1]) }); E.draft = null; draw(); side(); return; }
      E.draft = { type: 'circle', a: p, cx: p[0], cy: p[1], r: 0 }; drag = { shape: true, sx, sy }; draw(); return;
    }
    if (E.tool === 'seg') { if (d && d.type === 'seg') addSegPt(p); else startSeg(p); if (E.draft) E.draft.cur = p; draw(); return; }
    if (E.tool === 'ruler') {
      if (d && d.type === 'ruler') { E.meas = [d.a, p]; E.draft = null; draw(); return; }
      E.meas = null; E.draft = { type: 'ruler', a: p, cur: p }; draw(); return;
    }
    // выбор / перенос
    const s = hit(w);
    if (!s) { if (!e.shiftKey) E.sel.clear(); drag = { pan: true, sx, sy, tx: E.v.tx, ty: E.v.ty, clear: true }; draw(); side(); return; }
    if (e.shiftKey) { if (E.sel.has(s.id)) E.sel.delete(s.id); else E.sel.add(s.id); }
    else if (!E.sel.has(s.id)) E.sel = new Set([s.id]);
    // вместе с наружным контуром едут его отверстия
    const st = structure(); const mv = new Set(E.sel);
    let grow = true; while (grow) { grow = false; for (const x of E.shapes) { const par = st.info.get(x.id).parent; if (par && mv.has(par.id) && !mv.has(x.id)) { mv.add(x.id); grow = true; } } }
    drag = { move: true, w0: w, ref: refOf(s), mv, base: null, moved: false };
    draw(); side();
  }
  function onMove(e) {
    if (!E) return; const svg = $('#dxSvg'); if (!svg) return;
    const [sx, sy] = evPt(e); const w = S2W(sx, sy); E.cur = w; E.scur = [sx, sy]; E.msg = '';
    if (drag && drag.pan) { E.v.tx = drag.tx + sx - drag.sx; E.v.ty = drag.ty + sy - drag.sy; if (Math.hypot(sx - drag.sx, sy - drag.sy) > 3) drag.clear = false; draw(); return; }
    if (drag && drag.move) {
      if (!drag.moved) { if (Math.hypot(w[0] - drag.w0[0], w[1] - drag.w0[1]) * E.v.k < 4) return; drag.moved = true; commit(); drag.base = JSON.stringify(E.shapes); }
      // опорная точка фигуры ложится на привязку
      const s = snap([drag.ref[0] + w[0] - drag.w0[0], drag.ref[1] + w[1] - drag.w0[1]], drag.mv); E.snap = s;
      const dx = s.p[0] - drag.ref[0], dy = s.p[1] - drag.ref[1];
      E.shapes = JSON.parse(drag.base); for (const x of E.shapes) if (drag.mv.has(x.id)) moveShape(x, dx, dy);
      draw(); return;
    }
    if (E.tool === 'sel') { E.snap = null; E.hov = null; draw(); return; }
    if (E.typing) return; // пока вводится число — картинка стоит
    const s = toolPoint(w, e); const p = s.p; E.snap = s; const d = E.draft;
    E.hov = hit(w, true);
    if (d && d.type === 'rect') Object.assign(d, rectFrom(d.a, p));
    else if (d && d.type === 'circle') d.r = Math.hypot(p[0] - d.a[0], p[1] - d.a[1]);
    else if (d && (d.type === 'seg' || d.type === 'ruler')) d.cur = p;
    draw();
  }
  function onUp(e) {
    if (!E || !drag) return; const d = drag; drag = null;
    if (d.shape) { // протянул — фигура готова; просто щёлкнул — ждём второй щелчок
      const q = e ? evPt(e) : [d.sx, d.sy];
      if (Math.hypot(q[0] - d.sx, q[1] - d.sy) > 4 && E.draft) { if (E.draft.type === 'rect') putRect(E.draft); else putCircle(E.draft); E.draft = null; draw(); side(); }
      return;
    }
    if (d.move) { E.snap = null; draw(); side(); return; }
    if (d.pan && d.clear) { draw(); side(); }
  }
  function onWheel(e) { if (!E) return; e.preventDefault(); const [sx, sy] = evPt(e); const w = S2W(sx, sy); const f = e.deltaY < 0 ? 1.2 : 1 / 1.2; E.v.k = Math.max(0.01, Math.min(400, E.v.k * f)); E.v.tx = sx - w[0] * E.v.k; E.v.ty = sy + w[1] * E.v.k; draw(); }
  function onKey(e) {
    if (!E || $('#dxm').hidden) return;
    if (e.target && e.target.id === 'dxIn') {
      if (e.key === 'Enter') { e.preventDefault(); applyIn(); } else if (e.key === 'Escape') hideIn();
      e.stopPropagation(); return;
    }
    const inInput = /^(INPUT|SELECT|TEXTAREA)$/.test((e.target && e.target.tagName) || '');
    if (e.key === 'Escape') {
      if (inInput) e.target.blur();
      else if (E.draft) { if (E.draft.type === 'seg') finishSeg(false); else { E.draft = null; draw(); } }
      else if (E.meas) { E.meas = null; draw(); }
      else if (E.tool !== 'sel') setTool('sel');
      else if (E.sel.size) { E.sel.clear(); draw(); side(); }
      e.stopPropagation(); return;
    }
    if (inInput) { if (e.key === 'Enter') e.target.blur(); return; }
    if (e.key === 'F8') { e.preventDefault(); setOrtho(!ortho); return; }
    if (E.draft && E.draft.type !== 'ruler' && /^[0-9.,-]$/.test(e.key) && !e.ctrlKey && !e.metaKey) { e.preventDefault(); showIn(e.key); return; }
    if (e.key === 'Enter' && E.draft && E.draft.type === 'seg') { finishSeg(false); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { delSel(); e.preventDefault(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'я' || e.code === 'KeyZ')) { undo(); e.preventDefault(); return; }
    const mv = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
    if (mv && E.sel.size) { commit(); const g = E.grid > 0 ? E.grid : 1; for (const s of E.shapes) if (E.sel.has(s.id)) moveShape(s, mv[0] * g, mv[1] * g); draw(); side(); e.preventDefault(); }
  }
  function setTool(t) {
    if (E.draft && E.draft.type === 'seg') finishSeg(false);
    E.tool = t; E.draft = null; E.snap = null; E.hov = null; if (t !== 'ruler') E.meas = null; if (E.typing) hideIn();
    document.querySelectorAll('#dxTools [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
    $('#dxSvg').classList.toggle('drawing', t !== 'sel'); draw();
  }
  function setOrtho(v) { ortho = v; $('#dxOrtho').classList.toggle('on', ortho); if (E) draw(); }

  // ---------------------------------------------------------------- чертёж (фото, скан, PDF) — сбоку, рисуем рядом
  async function underFromFile(f) {
    const name = f.name || ''; const e = (name.split('.').pop() || '').toLowerCase();
    let bytes = new Uint8Array(await f.arrayBuffer());
    if (/^(pdf|tif|tiff)$/.test(e)) {
      if (e !== 'pdf') bytes = Media.tiffToPdf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      const doc = await window.__pdf.open(bytes); const page = await doc.getPage(1);
      const v1 = page.getViewport({ scale: 1 }); const k = Math.min(200 / 72, 4000 / Math.max(v1.width, v1.height)); const vp = page.getViewport({ scale: k });
      const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); await page.render({ canvasContext: g, viewport: vp }).promise;
      return { src: c.toDataURL('image/jpeg', 0.88), w: c.width, h: c.height };
    }
    const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('Не удалось прочитать файл')); r.readAsDataURL(new Blob([bytes], { type: e === 'png' ? 'image/png' : e === 'bmp' ? 'image/bmp' : 'image/jpeg' })); });
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Это не картинка')); i.src = url; });
    return { src: url, w: img.naturalWidth, h: img.naturalHeight };
  }
  function skApply() { if (!E || !E.sk) return; const v = E.sk.v; $('#dxSkImg').style.transform = `translate(${v.tx}px,${v.ty}px) scale(${v.k})`; }
  function skFit() {
    if (!E || !E.sk) return; const r = $('#dxSk').getBoundingClientRect(); const u = E.sk;
    const k = Math.min((r.width - 16) / u.w, (r.height - 16) / u.h) || 1;
    u.v = { k, tx: (r.width - u.w * k) / 2, ty: (r.height - u.h * k) / 2 }; skApply();
  }
  function setUnder(u) {
    E.sk = u ? { src: u.src, w: u.w, h: u.h, v: { k: 1, tx: 0, ty: 0 } } : null;
    $('#dxSk').hidden = !E.sk; $('#dxSkImg').src = E.sk ? E.sk.src : '';
    requestAnimationFrame(() => { if (!E) return; skFit(); fit(); draw(); });
  }
  let skDrag = null;
  function skInit() {
    const box = $('#dxSk');
    box.addEventListener('wheel', e => { if (!E || !E.sk) return; e.preventDefault(); const r = box.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top; const v = E.sk.v; const f = e.deltaY < 0 ? 1.2 : 1 / 1.2; const k = Math.max(0.02, Math.min(20, v.k * f)); v.tx = x - (x - v.tx) * k / v.k; v.ty = y - (y - v.ty) * k / v.k; v.k = k; skApply(); }, { passive: false });
    box.addEventListener('mousedown', e => { if (!E || !E.sk || e.target.closest('button')) return; e.preventDefault(); skDrag = { x: e.clientX, y: e.clientY, tx: E.sk.v.tx, ty: E.sk.v.ty }; box.classList.add('grab'); });
    window.addEventListener('mousemove', e => { if (!skDrag || !E || !E.sk) return; E.sk.v.tx = skDrag.tx + e.clientX - skDrag.x; E.sk.v.ty = skDrag.ty + e.clientY - skDrag.y; skApply(); });
    window.addEventListener('mouseup', () => { skDrag = null; box.classList.remove('grab'); });
    box.addEventListener('dblclick', skFit);
  }

  // ---------------------------------------------------------------- вход и выход
  function importContour(c) {
    if (c.circle) return { type: 'circle', cx: c.circle.c[0], cy: c.circle.c[1], r: c.circle.r };
    const V = c.verts;
    if (c.closed && V && V.length === 4 && V.every(v => Math.abs(v[2]) < 1e-9)) {
      const b = bboxOf(V); const onCorner = V.every(v => (Math.abs(v[0] - b[0]) < 1e-6 || Math.abs(v[0] - b[2]) < 1e-6) && (Math.abs(v[1] - b[1]) < 1e-6 || Math.abs(v[1] - b[3]) < 1e-6));
      if (onCorner && b[2] - b[0] > 1e-6 && b[3] - b[1] > 1e-6) return { type: 'rect', x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1], r: 0 };
    }
    return { type: 'imp', closed: !!c.closed, verts: V ? V.map(v => [v[0], v[1], v[2] || 0]) : null, poly: c.poly.map(p => [p[0], p[1]]) };
  }
  // opt: {name, contours, origin:{id}, qty, under:{src,w,h}, file, onClose}
  async function open(opt) {
    opt = opt || {};
    E = { shapes: [], sel: new Set(), tool: 'sel', v: { k: 1, tx: 0, ty: 0 }, grid: 1, sk: null, nextId: 1, undo: [], name: opt.name || 'Деталь', origin: opt.origin || null, last: lastIn, draft: null, dirty: false, saved: '', onClose: opt.onClose || null, hot: null, snap: null, hov: null, meas: null, typing: false };
    for (const c of opt.contours || []) { const s = importContour(c); s.id = newId(); E.shapes.push(s); }
    if (opt.qty > 1) { const s0 = structure(); if (s0.pieces.length === 1) s0.pieces[0].outer.qty = opt.qty; }
    $('#dxName').value = E.name; $('#dxGridIn').value = '1'; $('#dxSk').hidden = true; $('#dxIn').hidden = true;
    $('#dxm').hidden = false; setOrtho(ortho);
    fit(); setTool('sel'); side();
    if (opt.under) setUnder(opt.under);
    else if (opt.file) { try { setUnder(await underFromFile(opt.file)); } catch (err) { alert(err.message); } }
  }
  function close(force) {
    if (!E) return;
    if (!force && E.dirty && E.shapes.length && !confirm('Закрыть редактор? Нарисованное не сохранится.')) return;
    lastIn = E.last; const cb = E.onClose; $('#dxm').hidden = true; $('#dxSkImg').src = ''; E = null; drag = null;
    if (cb) setTimeout(cb, 0);
  }
  const allBytes = shapes => new TextEncoder().encode(DC.writeDXF(shapes.map(contourOf)));
  function done() {
    if (E.draft && E.draft.type === 'seg') finishSeg(false);
    const { pieces } = structure(); if (!pieces.length) return;
    E.name = $('#dxName').value.trim() || 'Деталь';
    const list = pieces.map((pc, i) => ({ name: pieceName(pc, i, pieces.length), bytes: allBytes(pieceShapes(pc)), qty: pc.outer.qty || 1 }));
    const path = pieces.length === 1 ? E.saved : '';
    if (E.origin) window.__sheet.replacePart(E.origin.id, list, path); else window.__sheet.addDrawn(list, path);
    close(true);
  }
  async function saveDxf() {
    if (E.draft && E.draft.type === 'seg') finishSeg(false);
    if (!E.shapes.length) return;
    const name = ($('#dxName').value.trim() || 'Деталь') + '.dxf'; const bytes = allBytes(E.shapes);
    if (window.Paths && Paths.api) {
      let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      const r = await fetch('/api/savefile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, kind: 'dxf', b64: btoa(s) }) }).then(r => r.json()).catch(e => ({ error: e.message }));
      if (r.error) { alert('Не сохранилось: ' + r.error); return; }
      if (r.path) { E.saved = r.path; E.dirty = false; E.msg = 'Сохранено: ' + r.path; draw(); }
    } else { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/dxf' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000); E.dirty = false; }
  }

  // ---------------------------------------------------------------- привязка к странице
  function init() {
    const svg = $('#dxSvg'); if (!svg) return;
    svg.addEventListener('mousedown', onDown); window.addEventListener('mousemove', e => { if (E && !$('#dxm').hidden && (drag || e.target.closest('#dxSvg'))) onMove(e); }); window.addEventListener('mouseup', onUp);
    svg.addEventListener('mouseleave', () => { if (E && !drag && !E.typing) { E.snap = null; E.scur = null; draw(); } });
    svg.addEventListener('wheel', onWheel, { passive: false }); svg.addEventListener('contextmenu', e => e.preventDefault());
    svg.addEventListener('dblclick', () => { if (E && E.draft && E.draft.type === 'seg') finishSeg(false); });
    document.addEventListener('keydown', onKey, true);
    $('#dxTools').addEventListener('click', e => { const b = e.target.closest('[data-tool]'); if (b && E) setTool(b.dataset.tool); });
    $('#dxOrtho').addEventListener('click', () => setOrtho(!ortho));
    $('#dxSide').addEventListener('click', onSideClick); $('#dxSide').addEventListener('change', onSideChange);
    $('#dxSide').addEventListener('mouseover', e => { const pc = e.target.closest('[data-pc]'); const i = pc ? +pc.dataset.pc : null; if (E && E.hot !== i) { E.hot = i; draw(); } });
    $('#dxSide').addEventListener('mouseleave', () => { if (E && E.hot !== null) { E.hot = null; draw(); } });
    $('#dxGridIn').addEventListener('change', e => { const v = num(e.target.value); E.grid = v >= 0 ? v : 1; draw(); });
    $('#dxFit').addEventListener('click', () => { fit(); draw(); });
    $('#dxUndo').addEventListener('click', undo);
    $('#dxClose').addEventListener('click', () => close());
    $('#dxDone').addEventListener('click', done);
    $('#dxSave').addEventListener('click', saveDxf);
    $('#dxName').addEventListener('change', e => { E.name = e.target.value.trim() || 'Деталь'; side(); });
    $('#dxIn').addEventListener('blur', () => { if (E && E.typing) setTimeout(() => { if (E && E.typing && document.activeElement !== $('#dxIn')) hideIn(); }, 150); });
    $('#dxUnder').addEventListener('click', async () => {
      if (window.Paths && Paths.api) { const ps = await Paths.pick('pdf'); if (!ps.length) return; try { const b = await Paths.read(ps[0].path); setUnder(await underFromFile(new File([b], ps[0].name))); } catch (err) { alert(err.message); } }
      else $('#dxUnderFile').click();
    });
    $('#dxUnderFile').addEventListener('change', async e => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { setUnder(await underFromFile(f)); } catch (err) { alert(err.message); } });
    $('#dxUnderDel').addEventListener('click', () => setUnder(null));
    skInit();
    window.addEventListener('resize', () => { if (E && !$('#dxm').hidden) { skFit(); draw(); } });
    // перетаскивание файла в редактор: картинка/PDF — чертёж сбоку
    const drop = async e => { e.preventDefault(); e.stopPropagation(); const f = e.dataTransfer.files[0]; if (!f || !E) return; if (/\.(pdf|tiff?|jpe?g|png|bmp)$/i.test(f.name)) { try { setUnder(await underFromFile(f)); } catch (err) { alert(err.message); } } };
    for (const el of [svg, $('#dxSk')]) { el.addEventListener('dragover', e => e.preventDefault()); el.addEventListener('drop', drop); }
  }
  init();
  window.__dxfedit = { open, close, underFromFile, get state() { return E; }, _int: { structure, contourOf, polyOf, importContour, snap, segPoint } };
})();
