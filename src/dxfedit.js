// ===== Лист: простой редактор — нарисовать деталь, разобрать общий DXF на детали, перерисовать эскиз по подложке =====
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const DC = window.DXFClean;
  const num = v => { const s = String(v === undefined || v === null ? '' : v).trim().replace(',', '.'); return s === '' ? NaN : +s; };
  const fmt = (x, d = 1) => { const v = Math.round((isFinite(x) ? x : 0) * 10 ** d) / 10 ** d; return String(v).replace('.', ','); };
  const esc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const TAU = Math.PI * 2;
  const B90 = Math.tan(Math.PI / 8); // выпуклость дуги 90°

  let E = null; // состояние открытого редактора
  let lastIn = { w: '', h: '', d: '' };

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
  const closedOf = s => s.type === 'imp' ? !!s.closed : true;
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
    if (s.type === 'poly') return { closed: true, verts: s.pts.map(p => [p[0], p[1], 0]), poly };
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
    if (E.under) P = P.concat([[E.under.x, E.under.y], [E.under.x + E.under.w * E.under.s, E.under.y - E.under.h * E.under.s]]);
    if (!P.length) P = [[0, 0], [300, 200]];
    const b = bboxOf(P), w = Math.max(b[2] - b[0], 1), h = Math.max(b[3] - b[1], 1);
    const k = Math.min((r.width - 80) / w, (r.height - 80) / h);
    E.v = { k, tx: r.width / 2 - (b[0] + w / 2) * k, ty: r.height / 2 + (b[1] + h / 2) * k };
  }
  // привязка: сначала к точкам фигур, потом к сетке
  function snap(w, skip) {
    const tol = 9 / E.v.k; let best = null, bd = tol;
    for (const s of E.shapes) {
      if (skip && skip.has(s.id)) continue;
      let pts;
      if (s.type === 'circle') pts = [[s.cx, s.cy], [s.cx + s.r, s.cy], [s.cx - s.r, s.cy], [s.cx, s.cy + s.r], [s.cx, s.cy - s.r]];
      else if (s.type === 'rect') pts = [[s.x, s.y], [s.x + s.w, s.y], [s.x + s.w, s.y + s.h], [s.x, s.y + s.h], [s.x + s.w / 2, s.y + s.h / 2], [s.x + s.w / 2, s.y], [s.x + s.w / 2, s.y + s.h], [s.x, s.y + s.h / 2], [s.x + s.w, s.y + s.h / 2]];
      else if (s.type === 'poly') pts = s.pts;
      else pts = s.circle ? [s.circle.c] : (s.verts || []).map(v => [v[0], v[1]]);
      for (const p of pts) { const d = Math.hypot(p[0] - w[0], p[1] - w[1]); if (d < bd) { bd = d; best = [p[0], p[1]]; } }
    }
    if (best) return best;
    const g = E.grid > 0 ? E.grid : 0; return g ? [Math.round(w[0] / g) * g, Math.round(w[1] / g) * g] : w;
  }

  // ---------------------------------------------------------------- история правок
  function commit() { E.undo.push(JSON.stringify(E.shapes)); if (E.undo.length > 60) E.undo.shift(); E.dirty = true; }
  function undo() { const j = E.undo.pop(); if (!j) return; E.shapes = JSON.parse(j); E.sel.clear(); draw(); side(); }
  const newId = () => E.nextId++;

  // ---------------------------------------------------------------- рисование
  const pathD = P => { let d = ''; for (let i = 0; i < P.length; i++) d += (i ? 'L' : 'M') + (+P[i][0].toFixed(3)) + ' ' + (+P[i][1].toFixed(3)); return d; };
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
    if (E.under) { const u = E.under; h += `<image href="${u.src}" transform="translate(${u.x} ${u.y}) scale(${u.s} ${-u.s})" width="${u.w}" height="${u.h}" opacity="${u.op}" preserveAspectRatio="none" style="pointer-events:none"/>`; }
    // детали: заливка наружный минус отверстия
    pieces.forEach((pc, i) => { let d = pathD(info.get(pc.outer.id).P) + 'Z'; for (const hh of pc.holes) d += pathD(info.get(hh.id).P) + 'Z'; h += `<path d="${d}" fill-rule="evenodd" class="dxfill${E.hot === i ? ' hot' : ''}"/>`; });
    for (const s of E.shapes) {
      const sel = E.sel.has(s.id), a = info.get(s.id);
      const cls = 'dxs' + (sel ? ' sel' : '') + (!closedOf(s) ? ' open' : a.depth % 2 ? ' hole' : '') + (pieceOf.get(s.id) === undefined && closedOf(s) ? ' loose' : '');
      h += `<path d="${pathD(a.P)}${closedOf(s) ? 'Z' : ''}" class="${cls}"/>`;
    }
    if (E.draft) {
      const d = E.draft;
      if (d.type === 'rect') h += `<path d="${pathD(polyOf(d))}Z" class="dxs draft"/>`;
      else if (d.type === 'circle' && d.r > 0) h += `<path d="${pathD(polyOf(d))}Z" class="dxs draft"/>`;
      else if (d.type === 'poly') h += `<path d="${pathD(d.pts.concat(d.cur ? [d.cur] : []))}" class="dxs draft"/>`;
      else if (d.type === 'cal' && d.a) h += `<path d="${pathD([d.a, d.cur || d.a])}" class="dxs cal"/>`;
    }
    h += '</g>';
    // подписи деталей и точки выбранных фигур — в экранных координатах
    if (pieces.length > 1 || pieces.some(pc => (pc.outer.qty || 1) > 1)) pieces.forEach((pc, i) => { const p = W2S([pc.bb[0], pc.bb[3]]); h += `<g class="dxlab${E.hot === i ? ' hot' : ''}"><rect x="${p[0]}" y="${p[1] - 20}" width="${String(i + 1).length * 8 + (pc.outer.qty > 1 ? String(pc.outer.qty).length * 8 + 22 : 12)}" height="18" rx="4"/><text x="${p[0] + 6}" y="${p[1] - 7}">${i + 1}${pc.outer.qty > 1 ? ' × ' + pc.outer.qty : ''}</text></g>`; });
    if (E.draft && E.draft.type === 'poly') for (const p of E.draft.pts) { const q = W2S(p); h += `<circle cx="${q[0]}" cy="${q[1]}" r="3.5" class="dxpt"/>`; }
    if (E.snapPt) { const q = W2S(E.snapPt); h += `<circle cx="${q[0]}" cy="${q[1]}" r="5" class="dxsnap"/>`; }
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
      h += `<div class="dxsec"><div class="t">${s.type === 'rect' ? 'Прямоугольник' : s.type === 'circle' ? 'Окружность' : 'Контур'}${a.depth % 2 ? ' — отверстие' : ''}</div><div class="dxgrid">`;
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
    if (host) { const b = bboxOf(polyOf(host)); c = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; }
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

  // ---------------------------------------------------------------- мышь и клавиши
  function hit(w) {
    const tol = 7 / E.v.k; let best = null, ba = Infinity;
    for (const s of E.shapes) { if (outlineDist(w, s) <= tol) { const a = closedOf(s) ? areaOf(polyOf(s)) : 0; if (a < ba) { ba = a; best = s; } } }
    if (best) return best;
    for (const s of E.shapes) { if (!closedOf(s)) continue; const P = polyOf(s); if (inside(w, P)) { const a = areaOf(P); if (a < ba) { ba = a; best = s; } } }
    return best;
  }
  let drag = null;
  function onDown(e) {
    if (!E) return; const [sx, sy] = evPt(e); const w = S2W(sx, sy);
    if (e.button === 1 || e.button === 2 || e.altKey) { drag = { pan: true, sx, sy, tx: E.v.tx, ty: E.v.ty }; e.preventDefault(); return; }
    if (e.button !== 0) return;
    e.preventDefault(); if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const p = snap(w);
    if (E.tool === 'rect') { drag = { rect: true, a: p }; E.draft = { type: 'rect', x: p[0], y: p[1], w: 0, h: 0 }; return; }
    if (E.tool === 'circle') { drag = { circle: true, a: p }; E.draft = { type: 'circle', cx: p[0], cy: p[1], r: 0 }; return; }
    if (E.tool === 'poly') {
      const d = E.draft && E.draft.type === 'poly' ? E.draft : (E.draft = { type: 'poly', pts: [] });
      let q = p; if (e.shiftKey && d.pts.length) q = ortho(d.pts[d.pts.length - 1], p);
      if (d.pts.length >= 3 && Math.hypot(q[0] - d.pts[0][0], q[1] - d.pts[0][1]) * E.v.k < 10) { finishPoly(); return; }
      const l = d.pts[d.pts.length - 1]; if (!l || Math.hypot(q[0] - l[0], q[1] - l[1]) > 1e-6) d.pts.push(q);
      draw(); return;
    }
    if (E.tool === 'cal') {
      const d = E.draft && E.draft.type === 'cal' ? E.draft : (E.draft = { type: 'cal' });
      if (!d.a) { d.a = w; draw(); return; }
      const dist = Math.hypot(w[0] - d.a[0], w[1] - d.a[1]); E.draft = null;
      const real = num(prompt('Сколько это в мм?', ''));
      if (real > 0 && dist > 1e-6 && E.under) { const f = real / dist, u = E.under; u.x = d.a[0] - (d.a[0] - u.x) * f; u.y = d.a[1] - (d.a[1] - u.y) * f; u.s *= f; fit(); }
      setTool('sel'); return;
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
  function ortho(a, p) { return Math.abs(p[0] - a[0]) >= Math.abs(p[1] - a[1]) ? [p[0], a[1]] : [a[0], p[1]]; }
  function onMove(e) {
    if (!E) return; const svg = $('#dxSvg'); if (!svg) return;
    const [sx, sy] = evPt(e); const w = S2W(sx, sy); E.cur = w; E.msg = '';
    if (drag && drag.pan) { E.v.tx = drag.tx + sx - drag.sx; E.v.ty = drag.ty + sy - drag.sy; if (Math.hypot(sx - drag.sx, sy - drag.sy) > 3) drag.clear = false; draw(); return; }
    if (drag && drag.rect) { const p = snap(w); const a = drag.a; E.draft = { type: 'rect', x: Math.min(a[0], p[0]), y: Math.min(a[1], p[1]), w: Math.abs(p[0] - a[0]), h: Math.abs(p[1] - a[1]) }; E.msg = `${fmt(E.draft.w)} × ${fmt(E.draft.h)} мм`; draw(); return; }
    if (drag && drag.circle) { const p = snap(w); E.draft.r = Math.hypot(p[0] - drag.a[0], p[1] - drag.a[1]); E.msg = `Ø ${fmt(2 * E.draft.r)} мм`; draw(); return; }
    if (drag && drag.move) {
      if (!drag.moved) { if (Math.hypot(w[0] - drag.w0[0], w[1] - drag.w0[1]) * E.v.k < 4) return; drag.moved = true; commit(); drag.base = JSON.stringify(E.shapes); }
      // опорная точка фигуры ложится на привязку
      const target = snap([drag.ref[0] + w[0] - drag.w0[0], drag.ref[1] + w[1] - drag.w0[1]], drag.mv);
      const dx = target[0] - drag.ref[0], dy = target[1] - drag.ref[1];
      E.shapes = JSON.parse(drag.base); for (const s of E.shapes) if (drag.mv.has(s.id)) moveShape(s, dx, dy);
      draw(); return;
    }
    if (E.tool === 'poly' && E.draft && E.draft.type === 'poly') { let p = snap(w); const l = E.draft.pts[E.draft.pts.length - 1]; if (e.shiftKey && l) p = ortho(l, p); E.draft.cur = p; if (l) E.msg = `отрезок ${fmt(Math.hypot(p[0] - l[0], p[1] - l[1]))} мм`; E.snapPt = p; draw(); return; }
    if (E.tool === 'cal' && E.draft && E.draft.a) { E.draft.cur = w; draw(); return; }
    E.snapPt = E.tool !== 'sel' && E.tool !== 'cal' ? snap(w) : null;
    draw();
  }
  function onUp() {
    if (!E || !drag) return; const d = drag; drag = null;
    if (d.rect) { const r = E.draft; E.draft = null; if (r && r.w > 1e-6 && r.h > 1e-6) { commit(); r.id = newId(); r.r = 0; E.shapes.push(r); E.sel = new Set([r.id]); setTool('sel'); } draw(); side(); return; }
    if (d.circle) { const c = E.draft; E.draft = null; if (c && c.r > 1e-6) { commit(); c.id = newId(); E.shapes.push(c); E.sel = new Set([c.id]); setTool('sel'); } draw(); side(); return; }
    if (d.move) { draw(); side(); return; }
    if (d.pan && d.clear) { draw(); side(); }
  }
  function finishPoly() { const d = E.draft; E.draft = null; E.snapPt = null; if (d && d.pts.length >= 3) { commit(); const s = { id: newId(), type: 'poly', pts: d.pts }; E.shapes.push(s); E.sel = new Set([s.id]); } setTool('sel'); side(); }
  function onWheel(e) { if (!E) return; e.preventDefault(); const [sx, sy] = evPt(e); const w = S2W(sx, sy); const f = e.deltaY < 0 ? 1.2 : 1 / 1.2; E.v.k = Math.max(0.01, Math.min(400, E.v.k * f)); E.v.tx = sx - w[0] * E.v.k; E.v.ty = sy + w[1] * E.v.k; draw(); }
  function onKey(e) {
    if (!E || $('#dxm').hidden) return;
    const inInput = /^(INPUT|SELECT|TEXTAREA)$/.test((e.target && e.target.tagName) || '');
    if (e.key === 'Escape') { if (E.draft) { E.draft = null; E.snapPt = null; setTool('sel'); } else if (inInput) e.target.blur(); else if (E.sel.size) { E.sel.clear(); draw(); side(); } e.stopPropagation(); return; }
    if (inInput) { if (e.key === 'Enter') e.target.blur(); return; }
    if (e.key === 'Enter' && E.draft && E.draft.type === 'poly') { finishPoly(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { delSel(); e.preventDefault(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'я')) { undo(); e.preventDefault(); return; }
    const mv = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];
    if (mv && E.sel.size) { commit(); const g = E.grid > 0 ? E.grid : 1; for (const s of E.shapes) if (E.sel.has(s.id)) moveShape(s, mv[0] * g, mv[1] * g); draw(); side(); e.preventDefault(); }
  }
  function setTool(t) { E.tool = t; E.draft = null; E.snapPt = null; document.querySelectorAll('#dxTools [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t)); $('#dxSvg').classList.toggle('drawing', t !== 'sel'); draw(); }

  // ---------------------------------------------------------------- подложка: фото, скан, PDF
  async function underFromFile(f) {
    const name = f.name || ''; const e = (name.split('.').pop() || '').toLowerCase();
    let bytes = new Uint8Array(await f.arrayBuffer());
    if (/^(pdf|tif|tiff)$/.test(e)) {
      if (e !== 'pdf') bytes = Media.tiffToPdf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      const doc = await window.__pdf.open(bytes); const page = await doc.getPage(1);
      const v1 = page.getViewport({ scale: 1 }); const k = Math.min(150 / 72, 3000 / Math.max(v1.width, v1.height)); const vp = page.getViewport({ scale: k });
      const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); await page.render({ canvasContext: g, viewport: vp }).promise;
      return { src: c.toDataURL('image/jpeg', 0.85), w: c.width, h: c.height, mm: 25.4 / (72 * k) };
    }
    const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('Не удалось прочитать файл')); r.readAsDataURL(new Blob([bytes], { type: e === 'png' ? 'image/png' : e === 'bmp' ? 'image/bmp' : 'image/jpeg' })); });
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Это не картинка')); i.src = url; });
    return { src: url, w: img.naturalWidth, h: img.naturalHeight, mm: 400 / Math.max(img.naturalWidth, img.naturalHeight) }; // размер неизвестен — задаётся по двум точкам
  }
  function setUnder(u) { E.under = u ? { src: u.src, w: u.w, h: u.h, s: u.mm, x: 0, y: u.h * u.mm, op: +$('#dxOp').value || 0.5 } : null; $('#dxUnderBox').hidden = !E.under; if (E.under) fit(); draw(); }

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
  // opt: {name, contours, origin:{id}, under:{src,w,h,mm}, file}
  async function open(opt) {
    opt = opt || {};
    E = { shapes: [], sel: new Set(), tool: 'sel', v: { k: 1, tx: 0, ty: 0 }, grid: 1, under: null, nextId: 1, undo: [], name: opt.name || 'Деталь', origin: opt.origin || null, last: lastIn, draft: null, dirty: false, saved: '', onClose: opt.onClose || null, hot: null };
    for (const c of opt.contours || []) { const s = importContour(c); s.id = newId(); E.shapes.push(s); }
    if (opt.qty > 1) { const s0 = structure(); if (s0.pieces.length === 1) s0.pieces[0].outer.qty = opt.qty; }
    $('#dxName').value = E.name; $('#dxGridIn').value = '1'; $('#dxOp').value = '0.5'; $('#dxUnderBox').hidden = true;
    $('#dxm').hidden = false;
    fit(); setTool('sel'); side();
    if (opt.under) setUnder(opt.under);
    else if (opt.file) { try { setUnder(await underFromFile(opt.file)); } catch (err) { alert(err.message); } }
  }
  function close(force) {
    if (!E) return;
    if (!force && E.dirty && E.shapes.length && !confirm('Закрыть редактор? Нарисованное не сохранится.')) return;
    lastIn = E.last; const cb = E.onClose; $('#dxm').hidden = true; E = null; drag = null;
    if (cb) setTimeout(cb, 0);
  }
  const allBytes = shapes => new TextEncoder().encode(DC.writeDXF(shapes.map(contourOf)));
  function done() {
    const { pieces } = structure(); if (!pieces.length) return;
    E.name = $('#dxName').value.trim() || 'Деталь';
    const list = pieces.map((pc, i) => ({ name: pieceName(pc, i, pieces.length), bytes: allBytes(pieceShapes(pc)), qty: pc.outer.qty || 1 }));
    const path = pieces.length === 1 ? E.saved : '';
    if (E.origin) window.__sheet.replacePart(E.origin.id, list, path); else window.__sheet.addDrawn(list, path);
    close(true);
  }
  async function saveDxf() {
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
    svg.addEventListener('wheel', onWheel, { passive: false }); svg.addEventListener('contextmenu', e => e.preventDefault());
    svg.addEventListener('dblclick', () => { if (E && E.draft && E.draft.type === 'poly') finishPoly(); });
    document.addEventListener('keydown', onKey, true);
    $('#dxTools').addEventListener('click', e => { const b = e.target.closest('[data-tool]'); if (b && E) setTool(b.dataset.tool); });
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
    $('#dxUnder').addEventListener('click', async () => {
      if (window.Paths && Paths.api) { const ps = await Paths.pick('pdf'); if (!ps.length) return; try { const b = await Paths.read(ps[0].path); setUnder(await underFromFile(new File([b], ps[0].name))); } catch (err) { alert(err.message); } }
      else $('#dxUnderFile').click();
    });
    $('#dxUnderFile').addEventListener('change', async e => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { setUnder(await underFromFile(f)); } catch (err) { alert(err.message); } });
    $('#dxOp').addEventListener('input', e => { if (E && E.under) { E.under.op = +e.target.value; draw(); } });
    $('#dxUnderDel').addEventListener('click', () => setUnder(null));
    window.addEventListener('resize', () => { if (E && !$('#dxm').hidden) draw(); });
    // перетаскивание файла в редактор: картинка/PDF — подложка
    svg.addEventListener('dragover', e => e.preventDefault());
    svg.addEventListener('drop', async e => { e.preventDefault(); e.stopPropagation(); const f = e.dataTransfer.files[0]; if (!f || !E) return; if (/\.(pdf|tiff?|jpe?g|png|bmp)$/i.test(f.name)) { try { setUnder(await underFromFile(f)); } catch (err) { alert(err.message); } } });
  }
  init();
  window.__dxfedit = { open, close, underFromFile, get state() { return E; }, _int: { structure, contourOf, polyOf, importContour } };
})();
