// ===== Листовой лазер: интерфейс (детали DXF, проверка, раскладка, Excel) =====
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const DC = window.DXFClean;
  const KEY = 'sheet.v1';
  const store = { get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } } };
  const fmt = (x, d = 1) => (isFinite(x) ? x : 0).toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });
  const esc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const num = v => { const s = String(v === undefined || v === null ? '' : v).trim().replace(',', '.'); return s === '' ? NaN : +s; };
  const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };
  const COLORS = ['#d9480f', '#1d6fd6', '#2b8a3e', '#8e44ad', '#c2185b', '#00838f', '#b7791f', '#5c6bc0', '#6d4c41', '#e8590c', '#2f9e44', '#7048e8'];
  const SHEETS = [[2500, 1250], [3000, 1500], [6000, 1500], [2000, 1000]];

  // материалы, толщины, газы
  const MATS = { st3: { name: 'Ст3', rho: 7850, gas: 'o2' }, aisi: { name: 'AISI', rho: 7900, gas: 'n2' }, '09g2s': { name: '09Г2С', rho: 7850, gas: 'o2' }, st20: { name: 'Ст20', rho: 7850, gas: 'o2' }, zn: { name: 'Цинк (оцинковка)', short: 'Цинк', rho: 7850, gas: 'n2' } };
  const THICK = [0.5, 0.8, 1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 14, 16, 20, 25, 35, 36, 40];
  const GASES = { air: { name: 'Воздух (компрессор)', short: 'воздух' }, o2: { name: 'Кислород', short: 'кислород' }, n2: { name: 'Азот', short: 'азот' } };
  const matName = m => MATS[m] ? (MATS[m].short || MATS[m].name) : '—';
  const tName = t => num(t) > 0 ? fmt(num(t), num(t) % 1 ? 1 : 0) + ' мм' : '';

  // ---------------------------------------------------------------- состояние
  const saved = store.get(KEY, null) || {};
  const st = {
    parts: saved.parts || [],
    def: Object.assign({ mat: 'st3', t: '', gas: 'o2' }, saved.def || {}),
    cfg: Object.assign({ W: 3000, H: 1500, gap: 5, margin: 10, lead: 3, mode: 'shape', rot: 90, mirror: false, holes: true, common: false }, saved.cfg || {}),
    tol: Object.assign({ join: 0.1, bridge: 1 }, saved.tol || {}),
    tab: 'parts', result: null, dirty: true, sel: new Set()
  };
  delete st.cfg.t;
  // старые записи: раньше всё исправлялось сразу
  for (const p of st.parts) { if (p.fixed === undefined) p.fixed = true; if (!p.mat) p.mat = st.def.mat; if (p.t === undefined) p.t = st.def.t; if (!p.gas) p.gas = MATS[p.mat] ? MATS[p.mat].gas : 'o2'; }
  let nextId = st.parts.reduce((m, p) => Math.max(m, p.id), 0) + 1;
  const raw = new Map(); // id -> bytes (только в памяти)
  function save() {
    const data = { parts: st.parts, def: st.def, cfg: st.cfg, tol: st.tol };
    if (!store.set(KEY, data)) store.set(KEY, Object.assign(data, { parts: st.parts.map(p => Object.assign({}, p, { an: null, lost: true })) }));
  }

  // анализ -> компактный вид для хранения
  const r3 = x => Math.round(x * 1000) / 1000;
  function lite(an) {
    const idx = new Map(an.contours.map((c, i) => [c, i]));
    return {
      sev: an.sev, cut: an.cut, pierces: an.pierces, rawCut: an.rawCut, rawPierces: an.rawPierces, w: an.w, h: an.h, bbox: an.bbox,
      issues: an.issues.map(i => ({ lvl: i.lvl, code: i.code, text: i.text, n: i.n, at: i.at.slice(0, 50).map(p => [r3(p[0]), r3(p[1])]) })),
      contours: an.contours.map(c => ({ closed: c.closed, depth: c.depth, len: c.len, area: c.area,
        circle: c.circle ? { c: [r3(c.circle.c[0]), r3(c.circle.c[1])], r: r3(c.circle.r) } : null,
        verts: c.verts ? c.verts.map(v => [r3(v[0]), r3(v[1]), Math.round(v[2] * 1e8) / 1e8]) : null,
        poly: c.poly.map(p => [r3(p[0]), r3(p[1])]) })),
      pieces: an.pieces.map(p => ({ outer: p.outer.fake ? -1 : idx.get(p.outer), hull: p.outer.fake ? p.outer.poly.map(q => [r3(q[0]), r3(q[1])]) : null, holes: p.holes.map(h => idx.get(h)), open: (p.open || []).map(o => idx.get(o)) }))
    };
  }

  // ---------------------------------------------------------------- состояние детали
  const hasFixes = p => !!(p.an && p.an.issues.some(i => i.lvl === 'fix'));
  const needsFix = p => hasFixes(p) && !p.fixed;           // ошибки есть, ещё не исправлено
  const unfixable = p => !!(p.err || (p.an && p.an.issues.some(i => i.lvl === 'err')));
  const cutOf = p => !p.an ? 0 : needsFix(p) ? p.an.rawCut : p.an.cut;
  const piercesOf = p => !p.an ? 0 : needsFix(p) ? p.an.rawPierces : p.an.pierces;
  const qtyOf = p => Math.max(1, Math.round(num(p.qty)) || 1);
  function polyArea(P) { let s = 0; for (let i = 0, n = P.length; i < n; i++) { const a = P[i], b = P[(i + 1) % n]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; }
  // площади (мм²) и вес (кг) одной детали
  function metrics(p) {
    if (!p.an) return null;
    const C = p.an.contours; let net = 0;
    for (const pc of p.an.pieces) {
      const outer = pc.outer >= 0 ? C[pc.outer].poly : pc.hull; if (!outer) continue;
      let a = Math.abs(polyArea(outer)); for (const h of pc.holes) a -= Math.abs(polyArea(C[h].poly)); net += Math.max(0, a);
    }
    const t = num(p.t), rho = MATS[p.mat] ? MATS[p.mat].rho : 7850;
    const has = t > 0;
    return { one: net, full: has ? 2 * net + p.an.cut * t : NaN, mass: has ? net * t * rho * 1e-9 : NaN };
  }
  function holeSize(c) { if (c.circle) return 2 * c.circle.r; const b = bb(c.poly); return Math.min(b[2] - b[0], b[3] - b[1]); }
  function bb(P) { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of P) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; } return [x0, y0, x1, y1]; }
  function smallHoles(p) { const t = num(p.t); if (!(t > 0) || !p.an) return []; return p.an.contours.filter(c => c.closed && c.depth % 2 === 1 && holeSize(c) < t); }
  // все замечания: из проверки + зависящие от толщины/газа
  function allIssues(p) {
    const L = p.an ? p.an.issues.slice() : [];
    const sh = smallHoles(p);
    if (sh.length) L.push({ lvl: 'warn', code: 'small', text: `Отверстия меньше толщины металла (${tName(p.t)}): ${sh.length} шт — лазер может не прорезать`, n: sh.length, at: sh.map(c => c.circle ? c.circle.c : c.poly[0]) });
    if (p.mat === 'aisi' && p.gas === 'o2') L.push({ lvl: 'warn', code: 'gas', text: 'Нержавейку обычно режут азотом, а не кислородом', n: 1, at: [] });
    return L;
  }
  // статус для метки
  function stateOf(p) {
    if (p.err || !p.an) return 'err';
    if (unfixable(p)) return 'err';
    if (needsFix(p)) return 'need';
    if (allIssues(p).some(i => i.lvl === 'warn')) return 'warn';
    return p.fixed && hasFixes(p) ? 'fixed' : 'ok';
  }
  const STATE = { ok: ['Без ошибок', 'ok'], fixed: ['Исправлено', 'fix'], need: ['Есть ошибки', 'need'], warn: ['Проверьте', 'warn'], err: ['Ошибка', 'err'] };

  // ---------------------------------------------------------------- файлы
  function readBytes(f) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(new Uint8Array(r.result)); r.onerror = () => rej(new Error('Не удалось прочитать файл')); r.readAsArrayBuffer(f); }); }
  const baseName = n => n.replace(/\.dxf$/i, '');
  const newPart = (name, file) => ({ id: nextId++, name, file, qty: 1, mat: st.def.mat, t: st.def.t, gas: st.def.gas, fixed: false });
  const SKETCH = /\.(pdf|tiff?|jpe?g|png|bmp)$/i;
  const sketches = []; // фото и сканы эскизов: открываются в редакторе по одному
  function nextSketch() { const f = sketches.shift(); if (f) window.__dxfedit.open({ name: f.name.replace(/\.[^.]+$/, ''), file: f, onClose: nextSketch }); }
  async function addFiles(list) {
    for (const f of [...list]) {
      if (SKETCH.test(f.name)) { sketches.push(f); continue; }
      if (!/\.dxf$/i.test(f.name)) { const p = newPart(f.name, f.name); p.err = 'Нужен файл DXF'; st.parts.push(p); continue; }
      addBytes(f.name, await readBytes(f));
      render(); await new Promise(r => setTimeout(r, 0));
    }
    st.dirty = true; save(); render();
    if (sketches.length && $('#dxm').hidden) nextSketch();
  }
  function addBytes(name, bytes, path) {
    const p = newPart(baseName(name), name); if (path) p.path = path;
    st.parts.push(p); raw.set(p.id, bytes); analyzePart(p);
    st.dirty = true; save();
    return p;
  }
  // детали из редактора: list = [{name, bytes, qty}]
  function addDrawn(list, path, at, like) {
    const out = [];
    for (const d of list) {
      const p = newPart(d.name, d.name + '.dxf'); p.qty = d.qty || 1; p.fixed = true; p.drawn = true;
      if (like) { p.mat = like.mat; p.t = like.t; p.gas = like.gas; }
      if (path && list.length === 1) p.path = path;
      if (at === undefined) st.parts.push(p); else st.parts.splice(at++, 0, p);
      raw.set(p.id, d.bytes); analyzePart(p); out.push(p);
    }
    st.dirty = true; save(); showTab('parts'); render();
    return out;
  }
  // деталь открывали в редакторе: вместо неё — то, что получилось (одна или несколько)
  function replacePart(id, list, path) {
    const i = st.parts.findIndex(x => x.id == id); if (i < 0) return addDrawn(list, path);
    const old = st.parts[i]; raw.delete(old.id); st.sel.delete(old.id); st.parts.splice(i, 1);
    return addDrawn(list, path, i, old);
  }
  function editPart(id) {
    const p = byId(id); if (!p || !p.an) return;
    window.__dxfedit.open({ name: p.name, contours: p.an.contours, origin: { id: p.id }, qty: qtyOf(p) });
  }
  function analyzePart(p) {
    const bytes = raw.get(p.id); if (!bytes) return;
    try { p.an = lite(DC.analyze(bytes, { tolJoin: st.tol.join, tolBridge: st.tol.bridge })); p.err = null; p.lost = false; }
    catch (e) { p.an = null; p.err = (e && e.message) || 'Не удалось прочитать DXF'; }
  }

  // ---------------------------------------------------------------- рисование детали
  const pathOf = (P, k) => { let s = ''; for (let i = 0; i < P.length; i++) s += (i ? 'L' : 'M') + (+P[i][0].toFixed(k)) + ' ' + (+P[i][1].toFixed(k)); return s; };
  function partPath(an, piece, k = 2) {
    const C = an.contours; let d = '';
    const outer = piece.outer >= 0 ? C[piece.outer].poly : piece.hull;
    d += pathOf(outer, k) + 'Z';
    for (const h of piece.holes) d += pathOf(C[h].poly, k) + 'Z';
    return d;
  }
  function thumb(p) {
    if (!p.an || !p.an.contours.length) return '<div class="thumb"></div>';
    const b = p.an.bbox, w = Math.max(b[2] - b[0], 1e-6), h = Math.max(b[3] - b[1], 1e-6);
    const pad = Math.max(w, h) * 0.06;
    const closedD = p.an.contours.filter(c => c.closed).map(c => pathOf(c.poly, 1) + 'Z').join('');
    const openD = p.an.contours.filter(c => !c.closed).map(c => pathOf(c.poly, 1)).join('');
    return `<svg class="thumb" viewBox="${b[0] - pad} ${-b[3] - pad} ${w + 2 * pad} ${h + 2 * pad}"><g transform="scale(1,-1)"><path d="${closedD}" fill="var(--soft)" fill-rule="evenodd" stroke="var(--ink)" stroke-width="${Math.max(w, h) / 70}"/>${openD ? `<path d="${openD}" fill="none" stroke="var(--err)" stroke-width="${Math.max(w, h) / 40}"/>` : ''}</g></svg>`;
  }

  // ---------------------------------------------------------------- выбор материала / толщины / газа
  const matOpts = sel => Object.entries(MATS).map(([k, m]) => `<option value="${k}"${k === sel ? ' selected' : ''}>${m.name}</option>`).join('');
  const thickOpts = sel => `<option value=""${!(num(sel) > 0) ? ' selected' : ''}>—</option>` + THICK.map(t => `<option value="${t}"${num(sel) === t ? ' selected' : ''}>${String(t).replace('.', ',')} мм</option>`).join('') + (num(sel) > 0 && !THICK.includes(num(sel)) ? `<option value="${num(sel)}" selected>${String(num(sel)).replace('.', ',')} мм</option>` : '');
  const gasOpts = sel => Object.entries(GASES).map(([k, g]) => `<option value="${k}"${k === sel ? ' selected' : ''}>${g.name}</option>`).join('');
  function bulkInputs() {
    $('#bMat').innerHTML = matOpts(st.def.mat); $('#bT').innerHTML = thickOpts(st.def.t); $('#bGas').innerHTML = gasOpts(st.def.gas);
    updateBulkBtn();
  }
  function updateBulkBtn() {
    const n = [...st.sel].filter(id => byId(id)).length;
    $('#bApply').textContent = n ? `Применить к выбранным (${n})` : 'Применить ко всем';
    $('#bApply').disabled = !st.parts.length;
  }
  $('#bMat').addEventListener('change', e => { st.def.mat = e.target.value; st.def.gas = MATS[st.def.mat].gas; $('#bGas').innerHTML = gasOpts(st.def.gas); save(); });
  $('#bT').addEventListener('change', e => { st.def.t = e.target.value; save(); });
  $('#bGas').addEventListener('change', e => { st.def.gas = e.target.value; save(); });
  $('#bApply').addEventListener('click', () => {
    const ids = [...st.sel].filter(id => byId(id));
    const list = ids.length ? ids.map(byId) : st.parts;
    for (const p of list) { p.mat = st.def.mat; p.t = st.def.t; p.gas = st.def.gas; }
    st.dirty = true; save(); render();
    toast(`${MATS[st.def.mat].name}${st.def.t ? ', ' + tName(st.def.t) : ''}, ${GASES[st.def.gas].short} — ${ids.length ? 'выбранным деталям: ' + ids.length : 'всем деталям'}`);
  });

  // ---------------------------------------------------------------- таблица деталей
  function render() {
    $('#sCnt').textContent = st.parts.length ? ' · ' + st.parts.length : '';
    renderBanner(); updateBulkBtn();
    const tb = $('#sRows');
    const nFix = st.parts.filter(needsFix).length;
    $('#sFixAll').hidden = !nFix; $('#sFixAll').textContent = `Исправить все (${nFix})`;
    $('#sSelAll').checked = st.parts.length > 0 && st.parts.every(p => st.sel.has(p.id));
    if (!st.parts.length) { tb.innerHTML = '<tr><td colspan="9" class="empty">Пока пусто — перетащите сюда файлы DXF</td></tr>'; $('#sFoot').hidden = true; return; }
    let html = '';
    for (const p of st.parts) {
      const chk = `<td class="ck"><input type="checkbox" data-sel="${p.id}"${st.sel.has(p.id) ? ' checked' : ''}></td>`;
      const acts = `<td class="acts">${p.an ? `<button class="ic" data-open="${p.id}" title="Открыть">🔍</button><button class="ic" data-edit="${p.id}" title="В редактор">✎</button>` : ''}<button class="ic" data-dup="${p.id}" title="Копия">⧉</button><button class="ic del" data-del="${p.id}" title="Убрать">×</button></td>`;
      if (p.err || !p.an) {
        html += `<tr>${chk}<td>${thumb(p)}</td><td><div class="name">${esc(p.name)}</div><div class="err">${esc(p.err || (p.lost ? 'Чертёж не сохранился между запусками — перетащите файл снова' : 'Нет данных'))}</div></td><td colspan="4"></td>${acts}</tr>`; continue;
      }
      const s = stateOf(p); const [sl, sc] = STATE[s];
      const iss = allIssues(p);
      const probs = iss.filter(i => i.lvl === 'err' || i.lvl === 'warn');
      const m = metrics(p);
      const qty = qtyOf(p);
      const tTxt = tName(p.t);
      html += `<tr class="${s === 'err' ? 'bad' : s === 'need' ? 'needr' : ''}">${chk}
        <td class="tcell" data-open="${p.id}">${thumb(p)}</td>
        <td><div class="name link" data-open="${p.id}">${esc(p.name)}<span class="sv ${sc}">${sl}</span>${needsFix(p) ? `<button class="btn small fixb" data-fix="${p.id}">Исправить</button>` : ''}${p.an.pieces.length > 1 ? `<button class="btn small fixb" data-edit="${p.id}">Разделить: ${p.an.pieces.length} дет.</button>` : ''}</div>
          <div class="meta"><span class="mt" data-open="${p.id}">${esc(matName(p.mat))} · ${tTxt ? tTxt : '<b class="missing">толщина?</b>'} · ${esc(GASES[p.gas] ? GASES[p.gas].short : '')}</span> · ${fmt(p.an.w, 1)} × ${fmt(p.an.h, 1)} мм</div>
          ${needsFix(p) ? `<div class="wtxt">${esc(iss.filter(i => i.lvl === 'fix').map(shortFix).join(' · '))}</div>` : ''}
          ${probs.map(i => `<div class="${i.lvl === 'err' ? 'err' : 'wtxt'}">${esc(i.text)}</div>`).join('')}</td>
        <td class="num"><input type="number" min="1" step="1" value="${qty}" data-qty="${p.id}"></td>
        <td class="num big">${fmt(cutOf(p), 1)}</td>
        <td class="num">${isFinite(m.mass) ? fmt(m.mass, m.mass < 1 ? 3 : 2) : '—'}</td>
        <td class="num big" data-tot="${p.id}">${fmt(cutOf(p) * qty / 1000, 3)}</td>${acts}</tr>`;
    }
    tb.innerHTML = html;
    updateTotals();
  }
  function shortFix(i) {
    const m = { junk: 'мусор', dup: 'двойной рез', near: 'круг в круге', join: 'концы не сходятся', micro: 'микроотрезки', tiny: 'микрообъекты', bridge: 'разрывы контура', overlap: 'наложения на стыках', zero: 'нулевые объекты', axis: 'осевые линии' };
    return m[i.code] ? m[i.code] + (i.n > 1 ? ' (' + i.n + ')' : '') : '';
  }
  function renderBanner() {
    const need = st.parts.filter(needsFix).length, bad = st.parts.filter(unfixable).length, noT = st.parts.filter(p => p.an && !(num(p.t) > 0)).length;
    const el = $('#sBanner');
    if (!st.parts.length || (!need && !bad && !noT)) { el.hidden = true; return; }
    el.hidden = false;
    el.className = 'banner' + (bad ? ' errb' : '');
    el.innerHTML = `<span>${need ? `Найдены ошибки в <b>${need}</b> ${plural(need, 'чертеже', 'чертежах', 'чертежах')} — пока не исправлены, длина реза посчитана как есть. ` : ''}${bad ? `Ошибки, которые нельзя исправить автоматически: <b>${bad}</b> — откройте и посмотрите отмеченные места. ` : ''}${noT ? `Не указана толщина: <b>${noT}</b> — без неё нет веса.` : ''}</span><span class="spacer"></span>${need ? '<button class="btn small primary" id="sFixAll2">Исправить все</button>' : ''}`;
    const b = $('#sFixAll2'); if (b) b.onclick = fixAll;
  }
  function updateTotals() {
    let tq = 0, tl = 0, tm = 0, mOk = true;
    for (const p of st.parts) {
      if (!p.an || p.err) continue; const q = qtyOf(p); const m = metrics(p);
      tq += q; tl += cutOf(p) * q / 1000; if (isFinite(m.mass)) tm += m.mass * q; else mOk = false;
      const c = document.querySelector(`[data-tot="${p.id}"]`); if (c) c.textContent = fmt(cutOf(p) * q / 1000, 3);
    }
    $('#sFoot').hidden = false; $('#sTQty').textContent = tq; $('#sTMass').textContent = tm ? fmt(tm, 2) + (mOk ? '' : '+') : '—'; $('#sTLen').textContent = fmt(tl, 3);
  }
  const byId = id => st.parts.find(p => p.id == id);
  $('#sRows').addEventListener('input', e => { const q = e.target.dataset.qty; if (!q) return; const v = Math.round(+e.target.value); if (v >= 1) { byId(q).qty = v; st.dirty = true; save(); updateTotals(); } });
  $('#sRows').addEventListener('change', e => {
    const q = e.target.dataset.qty; if (q) { byId(q).qty = qtyOf({ qty: e.target.value }); st.dirty = true; save(); render(); return; }
    const s = e.target.dataset.sel; if (s) { if (e.target.checked) st.sel.add(+s); else st.sel.delete(+s); updateBulkBtn(); $('#sSelAll').checked = st.parts.every(p => st.sel.has(p.id)); }
  });
  $('#sSelAll').addEventListener('change', e => { if (e.target.checked) st.parts.forEach(p => st.sel.add(p.id)); else st.sel.clear(); render(); });
  $('#sRows').addEventListener('click', e => {
    const t = e.target.closest('[data-edit],[data-open],[data-dup],[data-del],[data-fix]'); if (!t) return;
    if (t.dataset.edit) { editPart(+t.dataset.edit); return; }
    if (t.dataset.fix) { const p = byId(t.dataset.fix); p.fixed = true; st.dirty = true; save(); render(); return; }
    if (t.dataset.open) openView(+t.dataset.open);
    if (t.dataset.dup) { const p = byId(t.dataset.dup); const c = JSON.parse(JSON.stringify(p)); c.id = nextId++; c.name = p.name + ' (копия)'; if (raw.has(p.id)) raw.set(c.id, raw.get(p.id)); st.parts.splice(st.parts.indexOf(p) + 1, 0, c); st.dirty = true; save(); render(); }
    if (t.dataset.del) { const i = st.parts.findIndex(x => x.id == t.dataset.del); if (i >= 0) { raw.delete(st.parts[i].id); st.sel.delete(st.parts[i].id); st.parts.splice(i, 1); } st.dirty = true; save(); render(); }
  });
  function fixAll() { let n = 0; for (const p of st.parts) if (needsFix(p)) { p.fixed = true; n++; } st.dirty = true; save(); render(); if (view) { drawView(false); viewSide(); } if (n) toast(`Исправлено ${n} ${plural(n, 'чертёж', 'чертежа', 'чертежей')}`); return n; }
  $('#sFixAll').addEventListener('click', fixAll);
  $('#sDraw').addEventListener('click', () => window.__dxfedit.open({ name: 'Деталь ' + (st.parts.length + 1) }));
  $('#sClear').addEventListener('click', () => { if (st.parts.length && !confirm('Убрать все детали из списка?')) return; st.parts.length = 0; raw.clear(); st.sel.clear(); st.result = null; st.dirty = true; save(); render(); renderNest(); });
  $('#sSave').addEventListener('click', saveFixed);
  $('#sXls').addEventListener('click', exportExcel);

  // допуски проверки
  function tolInputs() { [['sTolJ', 'join'], ['sTolB', 'bridge']].forEach(([id, k]) => { const el = $('#' + id); if (document.activeElement !== el) el.value = String(st.tol[k]).replace('.', ','); }); }
  [['sTolJ', 'join'], ['sTolB', 'bridge']].forEach(([id, k]) => $('#' + id).addEventListener('change', e => {
    const v = num(e.target.value); if (!(v >= 0)) { tolInputs(); return; }
    st.tol[k] = v; let n = 0; for (const p of st.parts) if (raw.has(p.id)) { analyzePart(p); n++; }
    st.dirty = true; save(); render(); tolInputs();
    const miss = st.parts.filter(p => p.an && !raw.has(p.id)).length;
    if (miss) toast(`Пересчитано ${n} ${plural(n, 'файл', 'файла', 'файлов')}. ${miss} — загружены в прошлый раз, перетащите их снова, чтобы применить новые допуски.`);
  }));

  // перетаскивание
  const drop = $('#sDrop'), inp = $('#sFile');
  // в exe — окно «Открыть» Windows (путь запоминается в проекте)
  async function openNative() {
    const list = await Paths.pick('sheet');
    for (const f of list) { try { if (SKETCH.test(f.name)) { sketches.push(new File([await Paths.read(f.path)], f.name)); continue; } addBytes(f.name, await Paths.read(f.path), f.path); } catch (e) { const p = newPart(baseName(f.name), f.name); p.err = e.message; st.parts.push(p); } render(); await new Promise(r => setTimeout(r, 0)); }
    st.dirty = true; save(); render();
    if (sketches.length && $('#dxm').hidden) nextSketch();
  }
  const pickDxf = () => Paths.api ? openNative() : inp.click();
  drop.addEventListener('click', pickDxf);
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickDxf(); } });
  inp.addEventListener('change', () => { const f = [...inp.files]; inp.value = ''; addFiles(f); });
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
  window.addEventListener('drop', e => { if (window.__mode !== 'sheet') return; e.preventDefault(); if ($('#sModal').hidden && $('#dxm').hidden && e.dataTransfer && e.dataTransfer.files.length) { showTab('parts'); const fs = [...e.dataTransfer.files]; addFiles(fs).then(() => window.askWhere && window.askWhere(fs)); } });

  // вкладки
  function showTab(t) { st.tab = t; $('#sTabParts').hidden = t !== 'parts'; $('#sTabNest').hidden = t !== 'nest'; document.querySelectorAll('#sTabs button').forEach(b => b.classList.toggle('on', b.dataset.t === t)); if (t === 'nest') renderNest(); }
  $('#sTabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) showTab(b.dataset.t); });

  // ---------------------------------------------------------------- окно детали
  let view = null;
  function openView(id) {
    const p = byId(id); if (!p || !p.an) return;
    view = { id, scale: 1, tx: 0, ty: 0, showRaw: needsFix(p) && raw.has(p.id) };
    $('#sModal').hidden = false;
    $('#svTitle').textContent = p.file || p.name;
    drawView(true); viewSide();
  }
  function closeView() { $('#sModal').hidden = true; view = null; }
  $('#svClose').addEventListener('click', closeView);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#sModal').hidden) closeView(); });
  const m2 = a => a / 1e6;
  function viewSide() {
    const p = byId(view.id); const an = p.an;
    const iss = allIssues(p);
    const qty = qtyOf(p), m = metrics(p), nf = needsFix(p);
    const fixIcon = i => i.lvl === 'fix' ? (nf ? ['!', 'need'] : ['✓', 'fix']) : i.lvl === 'info' ? ['i', 'info'] : i.lvl === 'warn' ? ['!', 'warn'] : ['✕', 'err'];
    const kv = (a, b, cls) => `<div class="kv"><span>${a}</span><b${cls ? ` class="${cls}"` : ''}>${b}</b></div>`;
    const W = v => isFinite(v) ? fmt(v, v < 1 ? 3 : 2) + ' кг' : '—';
    const A = v => isFinite(v) ? fmt(m2(v), 4) + ' м²' : '—';
    $('#svBody').innerHTML = `
      <div class="fld w"><span>Название</span><input type="text" id="svName" value="${esc(p.name)}"></div>
      <div class="mtrow">
        <div class="fld"><span>Материал</span><select id="svMat">${matOpts(p.mat)}</select></div>
        <div class="fld"><span>Толщина</span><select id="svT">${thickOpts(p.t)}</select></div>
        <div class="fld"><span>Газ</span><select id="svGas">${gasOpts(p.gas)}</select></div>
      </div>
      <div class="kv"><span>Количество</span><input type="number" min="1" step="1" value="${qty}" id="svQty"></div>
      ${kv('Габарит', `${fmt(an.w, 2)} × ${fmt(an.h, 2)} мм`)}
      ${kv('Длина реза на 1 шт', fmt(cutOf(p), 1) + ' мм' + (nf ? ' <em class="asis">как есть</em>' : ''), 'acc')}
      ${nf ? kv('После исправления', fmt(an.cut, 1) + ' мм') : ''}
      ${kv('Врезок (контуров) на 1 шт', piercesOf(p))}
      ${kv('Длина реза на все', fmt(cutOf(p) * qty / 1000, 3) + ' м')}
      ${kv('Врезок на все', (piercesOf(p) * qty).toLocaleString('ru-RU'))}
      <div class="fs"><div class="t">Вес${MATS[p.mat] ? ` (${MATS[p.mat].rho} кг/м³)` : ''}</div>
      ${kv('1 шт', W(m.mass))}${kv(`Все ${qty} шт`, W(m.mass * qty))}</div>
      <div class="fs"><div class="t">Площадь под покрытие</div>
      ${kv('Одна сторона, 1 шт', A(m.one))}${kv('Полностью (2 стороны + торцы), 1 шт', A(m.full))}
      ${kv(`Одна сторона, все ${qty} шт`, A(m.one * qty))}${kv(`Полностью, все ${qty} шт`, A(m.full * qty))}
      ${!(num(p.t) > 0) ? '<div class="hint2 missing">Выберите толщину — без неё нет веса и полной площади.</div>' : ''}</div>
      <div class="fs"><div class="t">Проверка чертежа</div>
      ${iss.length ? iss.map(i => { const [ic, cl] = fixIcon(i); return `<div class="iss ${cl}"><i>${ic}</i><span>${esc(i.text)}${i.n > 1 && !/\(\d+\)|\d+ шт|: \d+$/.test(i.text) ? ` — ${i.n}` : ''}</span></div>`; }).join('') : '<div class="iss fix"><i>✓</i><span>Ошибок не найдено</span></div>'}
      ${hasFixes(p) ? `<div class="hint2">${nf ? 'Ошибки найдены, но чертёж ещё не исправлен. Нажмите «Исправить».' : 'Чертёж исправлен. «Вернуть как было» — отменить исправление.'}</div>` : ''}
      </div>`;
    $('#svName').addEventListener('input', e => { p.name = e.target.value; save(); render(); });
    $('#svQty').addEventListener('input', e => { const v = Math.round(+e.target.value); if (v >= 1) { p.qty = v; st.dirty = true; save(); render(); refreshSide(); } });
    $('#svMat').addEventListener('change', e => { p.mat = e.target.value; p.gas = MATS[p.mat].gas; st.dirty = true; save(); render(); viewSide(); drawView(false); });
    $('#svT').addEventListener('change', e => { p.t = e.target.value; st.dirty = true; save(); render(); viewSide(); drawView(false); });
    $('#svGas').addEventListener('change', e => { p.gas = e.target.value; save(); render(); viewSide(); });
    $('#svRaw').hidden = !raw.has(p.id);
    $('#svRaw').textContent = view.showRaw ? 'Показать исправленный' : 'Показать исходный';
    $('#svFix').hidden = !hasFixes(p);
    $('#svFix').textContent = nf ? 'Исправить' : 'Вернуть как было';
    $('#svFix').classList.toggle('primary', nf);
  }
  let sideT = null;
  function refreshSide() { clearTimeout(sideT); sideT = setTimeout(() => { if (view) { const a = document.activeElement && document.activeElement.id; viewSide(); if (a) { const el = document.getElementById(a); if (el) { el.focus(); if (el.setSelectionRange && el.type === 'text') el.setSelectionRange(el.value.length, el.value.length); } } } }, 400); }
  $('#svRaw').addEventListener('click', () => { if (!view) return; view.showRaw = !view.showRaw; viewSide(); drawView(false); });
  $('#svFix').addEventListener('click', () => { if (!view) return; const p = byId(view.id); if (needsFix(p)) { p.fixed = true; view.showRaw = false; } else { p.fixed = false; if (raw.has(p.id)) view.showRaw = true; } st.dirty = true; save(); render(); viewSide(); drawView(false); });
  $('#svFit').addEventListener('click', () => drawView(true));
  $('#svDl').addEventListener('click', () => { if (!view) return; const p = byId(view.id); const f = fixedFile(p); if (f) downloadBlob(new Blob([f.text], { type: 'application/dxf' }), f.name); });
  function drawView(fit) {
    const p = byId(view.id); const an = p.an; const box = $('#svCanvas');
    const b = an.bbox; const w = Math.max(b[2] - b[0], 1), h = Math.max(b[3] - b[1], 1);
    const pad = Math.max(w, h) * 0.08;
    const vb = [b[0] - pad, -b[3] - pad, w + 2 * pad, h + 2 * pad];
    let rawSvg = '';
    if (view.showRaw && raw.has(p.id)) {
      try {
        const doc = window.DXF.parse(raw.get(p.id)); const { prims } = window.DXF.primitives(doc);
        const segs = prims.map(e => e.k === 'L' ? `M${e.a[0]} ${e.a[1]}L${e.b[0]} ${e.b[1]}` : e.k === 'C' ? pathOf(DC._int.arcPts(e.c, e.r, 0, Math.PI * 2, 0.05), 3) : e.k === 'A' ? pathOf(DC._int.arcPts(e.c, e.r, e.a0, e.a1, 0.05), 3) : pathOf(e.pts, 3)).join('');
        rawSvg = `<path d="${segs}" fill="none" stroke="var(--ink)" stroke-width="1.4"/>`;
      } catch (e) { }
    }
    const closed = an.contours.filter(c => c.closed), open = an.contours.filter(c => !c.closed);
    const outer = closed.filter(c => c.depth % 2 === 0).map(c => pathOf(c.poly, 3) + 'Z').join('');
    const holes = closed.filter(c => c.depth % 2 === 1).map(c => pathOf(c.poly, 3) + 'Z').join('');
    const sh = new Set(smallHoles(p));
    const small = closed.filter(c => sh.has(c)).map(c => pathOf(c.poly, 3) + 'Z').join('');
    const nf = needsFix(p);
    const marks = [];
    for (const i of allIssues(p)) for (const q of i.at || []) marks.push(`<circle cx="${q[0]}" cy="${q[1]}" r="${Math.max(w, h) / 45}" class="mk ${i.lvl === 'fix' && nf ? 'need' : i.lvl}"><title>${esc(i.text)}</title></circle>`);
    box.innerHTML = `<div class="svlbl">${view.showRaw ? 'Исходный чертёж' : nf ? 'Как будет после исправления' : hasFixes(p) ? 'Исправленный чертёж' : ''}</div><svg viewBox="${vb.join(' ')}" id="svSvg"><g id="svG" transform="scale(1,-1)">
      ${view.showRaw ? '' : `<path d="${outer + holes}" fill="var(--soft)" fill-rule="evenodd" stroke="none"/>`}
      ${view.showRaw ? rawSvg : `<path d="${outer}" fill="none" stroke="var(--ink)" stroke-width="1.6"/><path d="${holes}" fill="none" stroke="#1d6fd6" stroke-width="1.4"/>`}
      ${small ? `<path d="${small}" fill="none" stroke="var(--warn)" stroke-width="3"/>` : ''}
      ${open.length ? `<path d="${open.map(c => pathOf(c.poly, 3)).join('')}" fill="none" stroke="var(--err)" stroke-width="3"/>` : ''}
      ${marks.join('')}</g></svg>`;
    if (fit) { view.scale = 1; view.tx = 0; view.ty = 0; }
    applyView();
  }
  function applyView() { const s = $('#svSvg'); if (s) s.style.transform = `translate(${view.tx}px,${view.ty}px) scale(${view.scale})`; }
  const vbox = $('#svCanvas');
  vbox.addEventListener('wheel', e => { if (!view) return; e.preventDefault(); const r = vbox.getBoundingClientRect(); const k = e.deltaY < 0 ? 1.2 : 1 / 1.2; const mx = e.clientX - r.left - r.width / 2 - view.tx, my = e.clientY - r.top - r.height / 2 - view.ty; view.tx -= mx * (k - 1); view.ty -= my * (k - 1); view.scale *= k; applyView(); }, { passive: false });
  let vdrag = null;
  vbox.addEventListener('mousedown', e => { if (!view) return; vdrag = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty }; e.preventDefault(); });
  window.addEventListener('mousemove', e => { if (!vdrag || !view) return; view.tx = vdrag.tx + e.clientX - vdrag.x; view.ty = vdrag.ty + e.clientY - vdrag.y; applyView(); });
  window.addEventListener('mouseup', () => { vdrag = null; });

  // ---------------------------------------------------------------- сохранение исправленных DXF
  function fixedFile(p) {
    if (!p.an || !p.an.contours.length) return null;
    const text = DC.writeDXF(p.an.contours);
    const nm = (p.name || baseName(p.file || 'деталь')).replace(/[\\/:*?"<>|]/g, '_');
    const tag = [MATS[p.mat] ? matName(p.mat) : '', num(p.t) > 0 ? String(num(p.t)).replace('.', ',') + 'мм' : ''].filter(Boolean).join(' ');
    return { name: nm + (tag ? ' ' + tag : '') + (unfixable(p) ? ' (проверить)' : '') + '.dxf', text };
  }
  async function saveFixed() {
    const need = st.parts.filter(needsFix);
    if (need.length) {
      const a = await ask(`${need.length} ${plural(need.length, 'чертёж ещё не исправлен', 'чертежа ещё не исправлены', 'чертежей ещё не исправлены')}.`, [['fix', 'Исправить все и сохранить', true], ['skip', 'Сохранить только исправленные'], ['cancel', 'Отмена']]);
      if (a === 'cancel' || !a) return;
      if (a === 'fix') fixAll();
    }
    const files = st.parts.filter(p => !needsFix(p)).map(fixedFile).filter(Boolean);
    if (!files.length) { toast('Нет чертежей для сохранения'); return; }
    const seen = new Map(); for (const f of files) { const k = f.name.toLowerCase(); const n = seen.get(k) || 0; seen.set(k, n + 1); if (n) f.name = f.name.replace(/\.dxf$/i, ` (${n + 1}).dxf`); }
    if (await hasApi()) {
      const to = window.SaveDlg ? await window.SaveDlg('dxf', files.length) : {};
      if (!to) return;
      try {
        const r = await fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: 'Исправленные DXF', base: to.base || '', name: to.name || '', files }) });
        const j = await r.json(); if (!r.ok || j.error) throw new Error(j.error || 'ошибка записи');
        toast(`Сохранено ${files.length} ${plural(files.length, 'файл', 'файла', 'файлов')} в папку<br><b>${esc(j.dir)}</b>`, () => fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: j.dir }) }), 'Открыть папку');
        return;
      } catch (e) { toast('Не удалось записать в папку (' + esc(e.message) + '). Скачиваю архивом.'); }
    }
    const zip = XLSX.zip(files.map(f => ({ name: f.name, data: new TextEncoder().encode(f.text) })));
    downloadBlob(new Blob([zip], { type: 'application/zip' }), `Исправленные DXF ${XLSX.stamp()}.zip`);
    if (!(await hasApi())) toast('Архив с исправленными чертежами — в папке «Загрузки».');
  }
  let apiP = null;
  function hasApi() {
    if (!/^https?:$/.test(location.protocol)) return Promise.resolve(false);
    if (!apiP) apiP = fetch('/api/ping').then(r => r.ok).catch(() => false);
    return apiP;
  }
  function downloadBlob(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }
  let toastT = null;
  function toast(html, act, actLabel) {
    const el = $('#sToast'); el.innerHTML = `<span>${html}</span>${act ? `<button class="btn small">${esc(actLabel)}</button>` : ''}<button class="ic" title="Закрыть">✕</button>`; el.hidden = false;
    if (act) el.querySelector('.btn').onclick = act; el.querySelector('.ic').onclick = () => { el.hidden = true; };
    clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 12000);
  }
  // окно с выбором: [[value, label, primary]]
  function ask(text, buttons) {
    return new Promise(res => {
      const el = $('#sAsk');
      el.innerHTML = `<div class="askbox"><p>${text}</p><div class="askbtns">${buttons.map(([v, l, pr]) => `<button class="btn${pr ? ' primary' : ''}" data-v="${v}">${esc(l)}</button>`).join('')}</div></div>`;
      el.hidden = false;
      const done = v => { el.hidden = true; el.onclick = null; document.removeEventListener('keydown', key); res(v); };
      const key = e => { if (e.key === 'Escape') done(null); };
      document.addEventListener('keydown', key);
      el.onclick = e => { const b = e.target.closest('[data-v]'); if (b) done(b.dataset.v); else if (e.target === el) done(null); };
      setTimeout(() => { const b = el.querySelector('.btn.primary'); b && b.focus(); }, 30);
    });
  }

  // ---------------------------------------------------------------- раскладка: настройки
  function cfgInputs() {
    const c = st.cfg;
    const preset = SHEETS.findIndex(([w, h]) => w === +c.W && h === +c.H);
    $('#nSheet').value = preset >= 0 ? String(preset) : 'own';
    $('#nOwn').hidden = preset >= 0;
    [['nW', 'W'], ['nH', 'H'], ['nGap', 'gap'], ['nMar', 'margin'], ['nLead', 'lead']].forEach(([id, k]) => { const el = $('#' + id); if (document.activeElement !== el) el.value = String(c[k]).replace('.', ','); });
    document.querySelectorAll('#nMode button').forEach(b => b.classList.toggle('on', b.dataset.v === c.mode));
    $('#nRot').value = String(c.rot);
    $('#nMir').checked = !!c.mirror; $('#nHoles').checked = !!c.holes && c.mode !== 'rect'; $('#nHoles').disabled = c.mode === 'rect'; $('#nCommon').checked = !!c.common;
  }
  $('#nSheet').addEventListener('change', e => { const v = e.target.value; if (v !== 'own') { const [w, h] = SHEETS[+v]; st.cfg.W = w; st.cfg.H = h; } $('#nOwn').hidden = v !== 'own'; changed(); });
  [['nW', 'W'], ['nH', 'H'], ['nGap', 'gap'], ['nMar', 'margin'], ['nLead', 'lead']].forEach(([id, k]) => $('#' + id).addEventListener('input', e => {
    const v = num(e.target.value); if (isFinite(v) && v >= 0) { st.cfg[k] = v; changed(k === 'lead'); }
  }));
  $('#nMode').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; st.cfg.mode = b.dataset.v; changed(); });
  $('#nRot').addEventListener('change', e => { st.cfg.rot = +e.target.value; changed(); });
  $('#nMir').addEventListener('change', e => { st.cfg.mirror = e.target.checked; changed(); });
  $('#nHoles').addEventListener('change', e => { st.cfg.holes = e.target.checked; changed(); });
  $('#nCommon').addEventListener('change', e => { st.cfg.common = e.target.checked; changed(); });
  function changed(soft) {
    if (!soft) st.dirty = true;
    save(); cfgInputs();
    if (soft && st.result) renderResult(); else renderNestState();
  }
  $('#nRun').addEventListener('click', runNest);
  $('#nXls').addEventListener('click', exportExcel);

  // ---------------------------------------------------------------- раскладка: запуск
  const groupKey = p => (p.mat || 'st3') + '|' + (num(p.t) > 0 ? num(p.t) : '');
  const groupLabel = (mat, t) => `${MATS[mat] ? MATS[mat].name : mat}, ${num(t) > 0 ? tName(t) : 'толщина не указана'}`;
  function nestParts() {
    const groups = new Map(); const skipped = [];
    st.parts.forEach((p, pi) => {
      if (!p.an || p.err) { skipped.push(p.name); return; }
      const qty = qtyOf(p), asIs = needsFix(p);
      const k = groupKey(p);
      if (!groups.has(k)) groups.set(k, { key: k, mat: p.mat, t: num(p.t) > 0 ? num(p.t) : '', list: [] });
      const g = groups.get(k);
      const C = p.an.contours, nP = p.an.pieces.length;
      p.an.pieces.forEach((pc, k2) => {
        const outer = pc.outer >= 0 ? C[pc.outer].poly : pc.hull;
        if (!outer || outer.length < 3) return;
        const holes = pc.holes.map(h => C[h].poly);
        let area = Math.abs(polyArea(outer)); for (const h of holes) area -= Math.abs(polyArea(h));
        const cs = [pc.outer >= 0 ? C[pc.outer] : null, ...pc.holes.map(h => C[h]), ...pc.open.map(o => C[o])].filter(Boolean);
        let cut = cs.reduce((s, c) => s + c.len, 0), pierces = cs.length;
        if (asIs && nP === 1) { cut = p.an.rawCut; pierces = p.an.rawPierces; } // как есть — с двойным резом
        const ob = bb(outer); const rect = pc.outer >= 0 && Math.abs(Math.abs(polyArea(outer)) - (ob[2] - ob[0]) * (ob[3] - ob[1])) < 1e-3 * (ob[2] - ob[0]) * (ob[3] - ob[1]);
        const t = num(p.t), rho = MATS[p.mat] ? MATS[p.mat].rho : 7850;
        g.list.push({ id: p.id + ':' + k2, pid: p.id, name: p.name + (nP > 1 ? ' №' + (k2 + 1) : ''), qty, polys: [outer, ...holes], area, cut, pierces, rect, asIs, gas: p.gas,
          mass: t > 0 ? area * t * rho * 1e-9 : NaN, full: t > 0 ? 2 * area + cut * t : NaN, color: COLORS[pi % COLORS.length], d: partPath(p.an, pc, 2) });
      });
    });
    return { groups: [...groups.values()].filter(g => g.list.length).sort((a, b) => (a.mat > b.mat ? 1 : a.mat < b.mat ? -1 : (+a.t || 0) - (+b.t || 0))), skipped };
  }

  let worker = null, running = false, cancelled = false;
  async function runNest() {
    if (running) { stopNest(); return; }
    const c = st.cfg;
    const W = Math.max(+c.W, +c.H), H = Math.min(+c.W, +c.H);
    if (!(W > 0 && H > 0)) { toast('Укажите размер листа'); return; }
    const need = st.parts.filter(needsFix);
    let asIs = false;
    if (need.length) {
      const a = await ask(`${need.length} ${plural(need.length, 'чертёж не исправлен', 'чертежа не исправлены', 'чертежей не исправлены')}: в ${need.length === 1 ? 'нём' : 'них'} двойной рез, разрывы или мусор. Лучше сначала исправить.`, [['fix', 'Исправить все и разложить', true], ['asis', 'Разложить как есть'], ['cancel', 'Отмена']]);
      if (a === 'cancel' || !a) return;
      if (a === 'fix') fixAll(); else asIs = true;
    }
    const { groups, skipped } = nestParts();
    if (!groups.length) { toast('Нет деталей для раскладки — добавьте DXF на вкладке «Детали»'); return; }
    const opt = { W, H, margin: +c.margin || 0, gap: +c.gap || 0, mode: c.mode, holes: c.mode !== 'rect' && !!c.holes, rotStep: +c.rot, mirror: !!c.mirror, common: !!c.common };
    running = true; cancelled = false; $('#nRun').textContent = 'Остановить'; $('#nRun').classList.remove('primary');
    $('#nProg').hidden = false; prog(0, 'Подготовка…');
    const out = [];
    for (let gi = 0; gi < groups.length && !cancelled; gi++) {
      const g = groups[gi];
      const parts = g.list.map(p => ({ id: p.id, qty: p.qty, polys: p.polys, area: p.area, cut: p.cut, pierces: p.pierces, rect: p.rect }));
      const lbl = groups.length > 1 ? groupLabel(g.mat, g.t) + ' — ' : '';
      const r = await nestOne(parts, opt, (f, t) => prog((gi + f) / groups.length, lbl + (t || '')));
      if (!r) break;
      out.push(Object.assign({}, g, { r }));
    }
    running = false; $('#nRun').textContent = 'Разложить'; $('#nRun').classList.add('primary'); $('#nProg').hidden = true;
    if (cancelled || out.length < groups.length) return;
    st.result = { groups: out, skipped, opt, asIs: asIs && need.length, cfg: JSON.parse(JSON.stringify(c)), when: new Date() };
    st.dirty = false; renderResult();
  }
  function nestOne(parts, opt, onProg) {
    return new Promise(resolve => {
      const viaPage = () => { if (!window.Nest2D) (0, eval)($('#src-nest').textContent); setTimeout(() => { try { resolve(window.Nest2D.nest(parts, opt, null)); } catch (e) { toast('Ошибка раскладки: ' + esc(e.message)); resolve(null); } }, 30); };
      try {
        const src = $('#src-nest').textContent + '\nself.onmessage=function(e){var r=Nest2D.nest(e.data.parts,e.data.opt,function(f,t){self.postMessage({p:f,t:t});});self.postMessage({done:r});};';
        worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        worker.onmessage = e => { if (e.data.done) { worker.terminate(); worker = null; resolve(e.data.done); } else onProg(e.data.p, e.data.t); };
        worker.onerror = () => { worker.terminate(); worker = null; viaPage(); };
        worker.__resolve = resolve;
        worker.postMessage({ parts, opt });
      } catch (e) { viaPage(); }
    });
  }
  function stopNest() { cancelled = true; if (worker) { const r = worker.__resolve; worker.terminate(); worker = null; r && r(null); } running = false; $('#nRun').textContent = 'Разложить'; $('#nRun').classList.add('primary'); $('#nProg').hidden = true; }
  function prog(f, t) { $('#nProgBar').style.width = Math.round(Math.max(0, Math.min(1, f)) * 100) + '%'; $('#nProgText').textContent = t || ''; }

  // ---------------------------------------------------------------- раскладка: результат
  function renderNest() { cfgInputs(); renderNestState(); if (st.result) renderResult(); }
  function renderNestState() {
    const el = $('#nState');
    if (!st.parts.length) { el.innerHTML = ''; $('#nOut').innerHTML = `<div class="ncard"><div class="empty">Добавьте детали на вкладке «Детали»</div></div>`; return; }
    el.innerHTML = st.result && st.dirty ? '<div class="banner">Детали или настройки изменились — нажмите «Разложить», чтобы обновить раскладку.</div>' : '';
    if (!st.result) $('#nOut').innerHTML = `<div class="ncard"><div class="empty">Задайте лист и зазоры, затем нажмите «Разложить». Детали разных материалов и толщин раскладываются на разные листы.</div></div>`;
  }
  // сводка по результату (общая для экрана и Excel)
  function summary() {
    const R = st.result; const lead = +st.cfg.lead || 0; const opt = R.opt;
    const groups = R.groups.map(g => {
      const byPid = new Map(g.list.map(p => [p.id, p]));
      let sheets = 0, parts = 0, cut = 0, pier = 0, shared = 0, area = 0, pm = 0, a1 = 0, af = 0, afOk = true;
      for (const s of g.r.sheets) {
        sheets += s.count; parts += s.items.length * s.count; cut += s.cut * s.count; pier += s.pierces * s.count; shared += s.shared * s.count; area += s.util * opt.W * opt.H * s.count;
        for (const it of s.items) { const p = byPid.get(it.id); if (!p) continue; if (isFinite(p.mass)) pm += p.mass * s.count; a1 += p.area * s.count; if (isFinite(p.full)) af += p.full * s.count; else afOk = false; }
      }
      const rho = MATS[g.mat] ? MATS[g.mat].rho : 7850;
      const metal = g.t > 0 ? opt.W * opt.H * g.t * rho * 1e-9 * sheets : NaN;
      let used = 0; for (const s of g.r.sheets) { const u = usedPart(s, opt, g); used += (u ? u.mass : (g.t > 0 ? opt.W * opt.H * g.t * rho * 1e-9 : NaN)) * s.count; }
      return { g, byPid, metalUsed: used, sheets, parts, cut, pier, shared, util: sheets ? area / (opt.W * opt.H * sheets) : 0, partsMass: pm, a1, af, afOk, metal, total: (cut + pier * lead) / 1000 };
    });
    const T = groups.reduce((a, x) => ({ sheets: a.sheets + x.sheets, parts: a.parts + x.parts, cut: a.cut + x.cut, pier: a.pier + x.pier, shared: a.shared + x.shared, pm: a.pm + (x.partsMass || 0), a1: a.a1 + x.a1, af: a.af + x.af, afOk: a.afOk && x.afOk, metal: a.metal + (isFinite(x.metal) ? x.metal : 0), metalUsed: a.metalUsed + (isFinite(x.metalUsed) ? x.metalUsed : 0), metalOk: a.metalOk && isFinite(x.metal) }), { sheets: 0, parts: 0, cut: 0, pier: 0, shared: 0, pm: 0, a1: 0, af: 0, afOk: true, metal: 0, metalUsed: 0, metalOk: true });
    T.total = (T.cut + T.pier * lead) / 1000; T.lead = lead;
    return { groups, T, opt };
  }
  const sqm = v => fmt(v / 1e6, v < 1e5 ? 4 : v < 1e6 ? 3 : 2) + ' м²';
  // площадь под покрытие: полная (обе стороны + торцы) и одна сторона
  const areaTxt = (one, full, ok) => ok && full ? `${sqm(full)}` : sqm(one);
  // использованная часть листа: от начала до линии отреза (за крайней деталью + зазор/край); null — лист занят почти целиком
  function usedPart(s, opt, g) {
    const cfg = st.result && st.result.cfg || {};
    const cutX = Math.min(opt.W, s.usedX + Math.max(+cfg.gap || 0, +opt.margin || 0, 5));
    if (opt.W - cutX < 50) return null;
    const rho = MATS[g.mat] ? MATS[g.mat].rho : 7850;
    return { cutX, len: cutX, rest: opt.W - cutX, mass: g.t > 0 ? cutX * opt.H * g.t * rho * 1e-9 : NaN, restMass: g.t > 0 ? (opt.W - cutX) * opt.H * g.t * rho * 1e-9 : NaN };
  }
  const usedSvg = (u, opt) => u ? `<rect x="${u.cutX}" y="0" width="${u.rest}" height="${opt.H}" class="shrest"/><line x1="${u.cutX}" y1="${-opt.H * 0.02}" x2="${u.cutX}" y2="${opt.H * 1.02}" class="shcut"/>` : '';
  const defId = (gi, id) => 'np' + gi + '_' + id.replace(':', '_');
  function renderResult() {
    const R = st.result; if (!R) return;
    renderNestState();
    const { groups, T, opt } = summary();
    let defs = '';
    groups.forEach((x, gi) => { for (const p of x.g.list) defs += `<path id="${defId(gi, p.id)}" d="${p.d}" fill-rule="evenodd"/>`; });
    $('#nDefs').innerHTML = defs;
    const multi = groups.length > 1;
    let html = `<div class="ncard sum">
      <div class="cutbig"><span>Длина реза${multi ? ' — весь заказ' : ''}</span><b>${fmt(T.total, 2)} м</b><em>${fmt(T.cut / 1000, 2)} м по контурам${T.lead ? ` + врезки ${T.pier.toLocaleString('ru-RU')} × ${fmt(T.lead, 1)} мм = ${fmt(T.pier * T.lead / 1000, 2)} м` : ''}${T.shared ? ` (общий рез сэкономил ${fmt(T.shared / 1000, 2)} м)` : ''}</em></div>
      <div class="sumgrid">
        <div><span>Листов</span><b>${T.sheets}</b><em>${fmt(opt.W, 0)} × ${fmt(opt.H, 0)} мм</em></div>
        <div><span>Деталей</span><b>${T.parts}</b></div>
        <div><span>Площадь покрытия</span><b>${areaTxt(T.a1, T.af, T.afOk)}</b><em>${T.afOk && T.af ? 'полная, обе стороны + торцы · одна сторона ' + sqm(T.a1) : 'одна сторона (задайте толщину для полной)'}</em></div>
        <div><span>Вес деталей</span><b>${T.pm ? fmt(T.pm, 1) + ' кг' : '—'}</b><em>металла ${T.metal ? '≈ ' + fmt(T.metal, 0) + ' кг' + (T.metalOk ? '' : '+') : '—'}${T.metal && T.metalUsed && T.metal - T.metalUsed > 0.5 ? ' · по факту (без остатков листов) ≈ ' + fmt(T.metalUsed, 0) + ' кг' : ''}</em></div>
      </div>
      ${R.asIs ? '<div class="nwarn">Разложено как есть: в неисправленных чертежах длина реза посчитана вместе с двойными линиями.</div>' : ''}
      ${R.skipped.length ? `<div class="nwarn">Пропущены (ошибка чтения): ${R.skipped.map(esc).join(', ')}</div>` : ''}
    </div>`;
    groups.forEach((x, gi) => {
      const g = x.g;
      const unpl = g.r.unplaced.map(u => { const p = x.byPid.get(u.id); return `${esc(p ? p.name : u.id)} — ${u.n} шт (${esc(u.reason)})`; });
      const gases = [...new Set(g.list.map(p => p.gas))].map(k => GASES[k] ? GASES[k].short : k).join(', ');
      html += `<div class="ghead"><h2>${esc(groupLabel(g.mat, g.t))}</h2><div class="stats"><span>листов <b>${x.sheets}</b></span><span>рез <b class="acc">${fmt(x.total, 2)} м</b></span><span>деталей <b>${x.parts}</b></span><span>покрытие <b>${areaTxt(x.a1, x.af, x.afOk)}</b></span><span>вес деталей <b>${x.partsMass ? fmt(x.partsMass, 1) + ' кг' : '—'}</b></span><span>металл <b>${isFinite(x.metal) ? fmt(x.metal, 0) + ' кг' : '—'}</b></span><span>газ: ${esc(gases)}</span></div></div>`;
      if (unpl.length) html += `<div class="ncard"><div class="nwarn">Не разложены: ${unpl.join('; ')}</div></div>`;
      let no = 0;
      g.r.sheets.forEach((s, si) => {
        const first = no + 1; no += s.count;
        const u = usedPart(s, opt, g);
        const cutS = (s.cut + s.pierces * T.lead) / 1000;
        const uses = s.items.map(it => { const p = x.byPid.get(it.id); const m = it.m; return `<use data-id="${esc(it.id)}" href="#${defId(gi, it.id)}" transform="matrix(${m.map(v => +v.toFixed(4)).join(' ')})" fill="${p.color}" fill-opacity=".22" stroke="${p.color}"><title>${esc(p.name)}</title></use>`; }).join('');
        const cnt = new Map(); for (const it of s.items) cnt.set(it.id, (cnt.get(it.id) || 0) + 1);
        html += `<div class="ncard"><div class="nhead"><h3>Лист ${s.count > 1 ? first + '–' + no : first}${s.count > 1 ? ` <span class="rep">×${s.count} одинаковых</span>` : ''}</h3>
          <div class="stats"><span>деталей <b>${s.items.length}</b></span><span>рез <b class="acc">${fmt(cutS, 2)} м</b>${s.count > 1 ? ' на лист' : ''}</span><span>использование <b>${fmt(s.util * 100, 1)}%</b></span>${u ? `<span class="used">используется <b>${fmt(u.len, 0)} × ${fmt(opt.H, 0)} мм</b>${isFinite(u.mass) ? ` · <b>${fmt(u.mass, 1)} кг</b>` : ''}</span><span>остаток <b>${fmt(u.rest, 0)} × ${fmt(opt.H, 0)}</b>${isFinite(u.restMass) ? ' · ' + fmt(u.restMass, 1) + ' кг' : ''}</span>` : ''}${s.shared ? `<span class="gain">общий рез <b>−${fmt(s.shared / 1000, 2)} м</b></span>` : ''}</div></div>
          <div class="sheetbox" data-sheet="${gi}:${si}" title="Нажмите — детали на этом листе"><svg viewBox="${-opt.W * 0.005} ${-opt.H * 1.005} ${opt.W * 1.01} ${opt.H * 1.01}" preserveAspectRatio="xMidYMid meet"><g transform="scale(1,-1)">
            <rect x="0" y="0" width="${opt.W}" height="${opt.H}" class="sh"/>
            ${opt.margin > 0 ? `<rect x="${opt.margin}" y="${opt.margin}" width="${Math.max(0, opt.W - 2 * opt.margin)}" height="${Math.max(0, opt.H - 2 * opt.margin)}" class="shm"/>` : ''}
            ${usedSvg(u, opt)}<g class="pp">${uses}</g>
          </g></svg></div>
          <div class="legend">${[...cnt].map(([id, n]) => { const p = x.byPid.get(id); return `<span title="Площадь покрытия 1 шт: ${isFinite(p.full) ? 'полная ' + sqm(p.full) + ', ' : ''}одна сторона ${sqm(p.area)}"><i style="background:${p.color}"></i>${esc(p.name)} × ${n}<em class="la">${isFinite(p.full) ? sqm(p.full) : sqm(p.area)} / шт</em></span>`; }).join('')}</div></div>`;
      });
    });
    $('#nOut').innerHTML = html;
  }


  // ---------------------------------------------------------------- окно листа
  let shv = null;
  function openSheet(gi, si) {
    if (!st.result) return;
    const { groups, T, opt } = summary(); const x = groups[gi]; if (!x) return; const s = x.g.r.sheets[si]; if (!s) return;
    let first = 1; for (let k = 0; k < si; k++) first += x.g.r.sheets[k].count; const last = first + s.count - 1;
    $('#shm').hidden = false;
    $('#shTitle').textContent = `${groupLabel(x.g.mat, x.g.t)} — лист ${s.count > 1 ? first + '–' + last : first}`;
    const cnt = new Map(); for (const it of s.items) cnt.set(it.id, (cnt.get(it.id) || 0) + 1);
    const lead = T.lead, cutS = (s.cut + s.pierces * lead) / 1000;
    let mass = 0, a1s = 0, afs = 0, afOk = true; for (const it of s.items) { const p = x.byPid.get(it.id); if (!p) continue; if (isFinite(p.mass)) mass += p.mass; a1s += p.area; if (isFinite(p.full)) afs += p.full; else afOk = false; }
    const kv = (a, b, cls) => `<div class="kv"><span>${a}</span><b${cls ? ` class="${cls}"` : ''}>${b}</b></div>`;
    $('#shBody').innerHTML = `
      ${kv('Лист', `${fmt(opt.W, 0)} × ${fmt(opt.H, 0)} мм`)}
      ${kv('Таких листов', '×' + s.count)}
      ${kv('Деталей на листе', s.items.length)}
      ${kv('Рез на лист', fmt(cutS, 2) + ' м', 'acc')}
      ${kv('Использование', fmt(s.util * 100, 1) + '%')}
      ${(u => u ? kv('Используется листа', `${fmt(u.len, 0)} × ${fmt(opt.H, 0)} мм${isFinite(u.mass) ? ' · ' + fmt(u.mass, 1) + ' кг' : ''}`, 'acc') + kv('Остаток листа', `${fmt(u.rest, 0)} × ${fmt(opt.H, 0)} мм${isFinite(u.restMass) ? ' · ' + fmt(u.restMass, 1) + ' кг' : ''}`) : '')(usedPart(s, opt, x.g))}
      ${mass ? kv('Вес деталей на листе', fmt(mass, 2) + ' кг') : ''}
      ${kv('Покрытие деталей на листе', areaTxt(a1s, afs, afOk) + (afOk ? ' <em>(1 ст. ' + sqm(a1s) + ')</em>' : ''))}
      ${s.shared ? kv('Общий рез', '−' + fmt(s.shared / 1000, 2) + ' м') : ''}
      <div class="fs"><div class="t">Детали на листе — наведите, чтобы подсветить</div>
      <div class="brow bhead"><i></i><span>Деталь</span><b>на листе</b><b>на ${s.count} л.</b></div>
      ${[...cnt].map(([id, n]) => { const p = x.byPid.get(id); return `<div class="brow" data-id="${esc(id)}"><i style="background:${p.color}"></i><span>${esc(p.name)}<em>рез ${fmt(p.cut, 1)} мм · покрытие 1 шт ${isFinite(p.full) ? sqm(p.full) + ' (1 ст. ' + sqm(p.area) + ')' : sqm(p.area)}${p.asIs ? ' · как есть' : ''}</em></span><b>${n} шт</b><b>${n * s.count} шт</b></div>`; }).join('')}
      </div>`;
    const uses = s.items.map(it => { const p = x.byPid.get(it.id); return `<use data-id="${esc(it.id)}" href="#${defId(gi, it.id)}" transform="matrix(${it.m.map(v => +v.toFixed(4)).join(' ')})" fill="${p.color}" fill-opacity=".25" stroke="${p.color}"><title>${esc(p.name)}</title></use>`; }).join('');
    $('#shCanvas').innerHTML = `<svg id="shSvg" viewBox="${-opt.W * 0.01} ${-opt.H * 1.01} ${opt.W * 1.02} ${opt.H * 1.02}" preserveAspectRatio="xMidYMid meet"><g transform="scale(1,-1)">
      <rect x="0" y="0" width="${opt.W}" height="${opt.H}" class="sh"/>
      ${opt.margin > 0 ? `<rect x="${opt.margin}" y="${opt.margin}" width="${Math.max(0, opt.W - 2 * opt.margin)}" height="${Math.max(0, opt.H - 2 * opt.margin)}" class="shm"/>` : ''}
      ${usedSvg(usedPart(s, opt, x.g), opt)}<g class="pp">${uses}</g></g></svg>`;
    shv = { scale: 1, tx: 0, ty: 0 }; shApply();
  }
  function shApply() { const el = $('#shSvg'); if (el && shv) el.style.transform = `translate(${shv.tx}px,${shv.ty}px) scale(${shv.scale})`; }
  function closeSheet() { $('#shm').hidden = true; shv = null; }
  function shHL(id) { document.querySelectorAll('#shSvg use').forEach(u => { u.style.opacity = !id || u.dataset.id === id ? '' : '.15'; u.style.fillOpacity = id && u.dataset.id === id ? '.55' : ''; }); }
  $('#nOut').addEventListener('click', e => { const b = e.target.closest('[data-sheet]'); if (!b) return; const [gi, si] = b.dataset.sheet.split(':').map(Number); openSheet(gi, si); });
  $('#shClose').addEventListener('click', closeSheet);
  $('#shm').addEventListener('click', e => { if (e.target.id === 'shm') closeSheet(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#shm').hidden) closeSheet(); });
  $('#shFit').addEventListener('click', () => { if (shv) { shv.scale = 1; shv.tx = 0; shv.ty = 0; shApply(); } });
  $('#shBody').addEventListener('mouseover', e => { const r = e.target.closest('[data-id]'); shHL(r ? r.dataset.id : null); });
  $('#shBody').addEventListener('mouseleave', () => shHL(null));
  { const box = $('#shCanvas'); let dr = null;
    box.addEventListener('wheel', e => { if (!shv) return; e.preventDefault(); const r = box.getBoundingClientRect(); const k = e.deltaY < 0 ? 1.25 : 1 / 1.25; const mx = e.clientX - r.left - r.width / 2 - shv.tx, my = e.clientY - r.top - r.height / 2 - shv.ty; shv.tx -= mx * (k - 1); shv.ty -= my * (k - 1); shv.scale *= k; shApply(); }, { passive: false });
    box.addEventListener('mousedown', e => { if (!shv) return; dr = { x: e.clientX, y: e.clientY, tx: shv.tx, ty: shv.ty }; e.preventDefault(); });
    window.addEventListener('mousemove', e => { if (!dr || !shv) return; shv.tx = dr.tx + e.clientX - dr.x; shv.ty = dr.ty + e.clientY - dr.y; shApply(); });
    window.addEventListener('mouseup', () => { dr = null; });
    box.addEventListener('mouseover', e => { const u = e.target.closest('use'); shHL(u ? u.dataset.id : null); });
    box.addEventListener('mouseleave', () => shHL(null));
  }

  // ---------------------------------------------------------------- Excel
  function sheetSvg(x, s, opt, px) {
    const k = px / opt.W, h = Math.round(opt.H * k);
    let body = '';
    const sw = (1.2 / k).toFixed(3);
    for (const it of s.items) {
      const p = x.byPid.get(it.id); const m = it.m;
      body += `<path d="${p.d}" fill-rule="evenodd" transform="matrix(${m.map(v => +v.toFixed(4)).join(' ')})" fill="${p.color}" fill-opacity="0.22" stroke="${p.color}" stroke-width="${sw}"/>`;
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${h}" viewBox="0 0 ${opt.W} ${opt.H}"><rect width="100%" height="100%" fill="#ffffff"/><g transform="translate(0 ${opt.H}) scale(1 -1)">`
      + `<rect x="0" y="0" width="${opt.W}" height="${opt.H}" fill="#fbfaf7" stroke="#6b6f76" stroke-width="${(2 / k).toFixed(3)}"/>`
      + (opt.margin > 0 ? `<rect x="${opt.margin}" y="${opt.margin}" width="${opt.W - 2 * opt.margin}" height="${opt.H - 2 * opt.margin}" fill="none" stroke="#cfcac0" stroke-width="${(1 / k).toFixed(3)}" stroke-dasharray="${(6 / k).toFixed(2)} ${(5 / k).toFixed(2)}"/>` : '')
      + (u => u ? `<rect x="${u.cutX}" y="0" width="${u.rest}" height="${opt.H}" fill="#e9e5dc" fill-opacity="0.6"/><line x1="${u.cutX}" y1="0" x2="${u.cutX}" y2="${opt.H}" stroke="#d9480f" stroke-width="${(2.5 / k).toFixed(3)}" stroke-dasharray="${(10 / k).toFixed(2)} ${(6 / k).toFixed(2)}"/>` : '')(usedPart(s, opt, x.g))
      + body + '</g></svg>';
    return { svg, w: px, h };
  }
  async function exportExcel() {
    const live = st.parts.filter(p => p.an && !p.err);
    if (!live.length) { toast('Нет деталей для выгрузки'); return; }
    const H = s => ({ v: s, s: 'h' });
    // 1. детали
    const rows = [[{ v: 'Детали — листовой лазер', s: 'title' }], [{ v: 'Сохранено: ' + new Date().toLocaleString('ru-RU'), s: 'muted' }], [],
      [H('№'), H('Деталь'), H('Материал'), H('Толщина, мм'), H('Газ'), H('Кол-во'), H('Габарит, мм'), H('Рез на 1 шт, мм'), H('Врезок на 1 шт'), H('Рез всего, м'), H('Врезок всего'), H('Вес 1 шт, кг'), H('Вес всего, кг'), H('Площадь 1 стороны, 1 шт, м²'), H('Площадь полная, 1 шт, м²'), H('Площадь 1 стороны, всего, м²'), H('Площадь полная, всего, м²'), H('Чертёж')]];
    let T = { q: 0, cut: 0, pier: 0, mass: 0, a1: 0, af: 0 };
    live.forEach((p, i) => {
      const q = qtyOf(p), m = metrics(p), c = cutOf(p), pr = piercesOf(p);
      const stt = needsFix(p) ? 'не исправлен (как есть)' : unfixable(p) ? 'ошибка — проверить' : p.fixed && hasFixes(p) ? 'исправлен' : 'без ошибок';
      rows.push([i + 1, p.name, matName(p.mat), num(p.t) > 0 ? num(p.t) : '', GASES[p.gas] ? GASES[p.gas].short : '', { v: q, s: 'int' }, `${fmt(p.an.w, 1)} × ${fmt(p.an.h, 1)}`, { v: c, s: 'n1' }, pr, { v: c * q / 1000, s: 'n3' }, pr * q,
        isFinite(m.mass) ? { v: m.mass, s: 'n3' } : '', isFinite(m.mass) ? { v: m.mass * q, s: 'n2' } : '', { v: m.one / 1e6, s: 'n4' }, isFinite(m.full) ? { v: m.full / 1e6, s: 'n4' } : '', { v: m.one * q / 1e6, s: 'n4' }, isFinite(m.full) ? { v: m.full * q / 1e6, s: 'n4' } : '', stt]);
      T.q += q; T.cut += c * q / 1000; T.pier += pr * q; if (isFinite(m.mass)) T.mass += m.mass * q; T.a1 += m.one * q / 1e6; if (isFinite(m.full)) T.af += m.full * q / 1e6;
    });
    rows.push([{ v: 'Итого', s: 'b' }, '', '', '', '', { v: T.q, s: 'bint' }, '', '', '', { v: T.cut, s: 'bn3' }, { v: T.pier, s: 'bint' }, '', { v: T.mass, s: 'bn2' }, '', '', { v: T.a1, s: 'bn4' }, { v: T.af, s: 'bn4' }]);
    const sheets = [{ name: 'Детали', cols: [5, 30, 12, 10, 10, 8, 16, 12, 10, 12, 10, 11, 12, 14, 14, 14, 14, 22], rows, freeze: 4, landscape: true, heights: { 3: 45 } }];
    // 2. раскладка
    if (st.result) {
      const { groups, T: S, opt } = summary(); const c = st.result.cfg;
      const r2 = [[{ v: 'Раскладка на листе', s: 'title' }], [{ v: st.dirty ? 'Внимание: после раскладки детали или настройки менялись — раскладка может быть устаревшей.' : 'Раскладка актуальна.', s: 'muted' }], [],
        ['Лист, мм', `${opt.W} × ${opt.H}`], ['Между деталями, мм', +c.gap || 0], ['От края листа, мм', +c.margin || 0], ['Врезка (подвод), мм', +c.lead || 0],
        ['Способ', c.mode === 'rect' ? 'по габариту' : 'свободная форма'], ['Поворот', { 0: 'без поворота', 180: '0° и 180°', 90: 'кратно 90°', 45: 'кратно 45°', 15: 'кратно 15°' }[c.rot] || ''],
        ['В отверстия', c.mode !== 'rect' && c.holes ? 'да' : 'нет'], ['Общий рез (впритык)', c.common ? 'да' : 'нет'], ['Зеркалить', c.mirror ? 'да' : 'нет'], [],
        [{ v: 'Длина реза всего, м', s: 'b' }, { v: S.total, s: 'acc' }], ['в т.ч. по контурам, м', { v: S.cut / 1000, s: 'n2' }], ['в т.ч. врезки, м', { v: S.pier * S.lead / 1000, s: 'n2' }], ['Общий рез сэкономил, м', { v: S.shared / 1000, s: 'n2' }],
        ['Листов', { v: S.sheets, s: 'int' }], ['Деталей', { v: S.parts, s: 'int' }], ['Врезок', { v: S.pier, s: 'int' }], ['Вес деталей, кг', { v: S.pm, s: 'n1' }], ['Металл по факту (без остатков листов), кг', S.metalUsed ? { v: S.metalUsed, s: 'n1' } : '—'], ['Вес листов (металл), кг', S.metalOk ? { v: S.metal, s: 'n1' } : (S.metal ? { v: S.metal, s: 'n1' } : '—')], ['Площадь покрытия полная, м²', S.afOk ? { v: S.af / 1e6, s: 'n3' } : '—'], ['Площадь покрытия, 1 сторона, м²', { v: S.a1 / 1e6, s: 'n3' }], [],
        [H('Материал'), H('Толщина, мм'), H('Листов'), H('Деталей'), H('Рез, м'), H('Врезок'), H('Использование, %'), H('Вес деталей, кг'), H('Металл, кг'), H('Газ'), H('Покрытие полное, м²'), H('Покрытие 1 стор., м²')]];
      for (const x of groups) r2.push([MATS[x.g.mat] ? MATS[x.g.mat].name : x.g.mat, x.g.t || '—', { v: x.sheets, s: 'int' }, { v: x.parts, s: 'int' }, { v: x.total, s: 'n2' }, { v: x.pier, s: 'int' }, { v: x.util * 100, s: 'n1' }, { v: x.partsMass, s: 'n1' }, isFinite(x.metal) ? { v: x.metal, s: 'n1' } : '—', [...new Set(x.g.list.map(p => GASES[p.gas] ? GASES[p.gas].short : p.gas))].join(', '), x.afOk ? { v: x.af / 1e6, s: 'n3' } : '—', { v: x.a1 / 1e6, s: 'n3' }]);
      r2.push([]);
      r2.push([H('Материал, толщина'), H('Лист №'), H('Таких листов'), H('Деталей на листе'), H('Рез на лист, м'), H('Врезок на лист'), H('Использование, %'), H('Используется листа, мм'), H('Вес использ. части, кг'), H('Состав листа')]);
      const imgRows = [[{ v: 'Картинки листов', s: 'title' }]]; const images = []; const heights = [];
      let ir = 2;
      for (const x of groups) {
        let no = 0;
        for (const s of x.g.r.sheets) {
          const first = no + 1; no += s.count;
          const cnt = new Map(); for (const it of s.items) cnt.set(it.id, (cnt.get(it.id) || 0) + 1);
          const comp = [...cnt].map(([id, n]) => (x.byPid.get(id) || {}).name + ' × ' + n).join('; ');
          const label = groupLabel(x.g.mat, x.g.t);
          r2.push([label, s.count > 1 ? `${first}–${no}` : String(first), { v: s.count, s: 'int' }, { v: s.items.length, s: 'int' }, { v: (s.cut + s.pierces * S.lead) / 1000, s: 'n2' }, { v: s.pierces, s: 'int' }, { v: s.util * 100, s: 'n1' }, ...(u => u ? [`${fmt(u.len, 0)} × ${fmt(opt.H, 0)}`, isFinite(u.mass) ? { v: u.mass, s: 'n1' } : ''] : ['весь лист', ''])(usedPart(s, opt, x.g)), { v: comp, s: 'wrap' }]);
          // картинка
          const im = sheetSvg(x, s, opt, 1100);
          const png = await XLSX.svgToPng(im.svg, im.w, im.h);
          imgRows[ir] = [{ v: `${label} — лист ${s.count > 1 ? first + '–' + no + ' (×' + s.count + ')' : first}: деталей ${s.items.length}, рез ${fmt((s.cut + s.pierces * S.lead) / 1000, 2)} м, использование ${fmt(s.util * 100, 1)}%`, s: 'b' }];
          if (png) { const ih = Math.round(900 * im.h / im.w); images.push({ png, col: 0, row: ir + 1, w: 900, h: ih }); heights[ir + 1] = Math.ceil(ih * 0.75) + 6; ir += 3; }
          else ir += 2;
        }
      }
      sheets.push({ name: 'Раскладка', cols: [24, 12, 12, 14, 14, 12, 16, 22, 16, 60, 16, 16], rows: r2 });
      sheets.push({ name: 'Листы', cols: [140], rows: imgRows, images, heights, landscape: true });
    }
    const bytes = XLSX.build(sheets);
    XLSX.download(bytes, `Лист_${st.result ? 'раскладка' : 'детали'}_${XLSX.stamp()}.xlsx`);
    toast('Файл Excel — в папке «Загрузки».');
  }

  // ---------------------------------------------------------------- запуск
  function init(startFiles) {
    bulkInputs(); render(); tolInputs(); cfgInputs();
    if (startFiles && startFiles.length) {
      for (const f of startFiles) {
        if (f.err) { const p = newPart(f.name, f.name); p.err = f.err; st.parts.push(p); continue; }
        const b = atob(f.b64 || ''); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
        addBytes(f.name, u, f.path);
      }
      st.dirty = true; save(); render();
    }
    // проект открыт заново: исходные DXF — по запомненным путям (нужны для «Исправить» и если данные не сохранились)
    if (Paths.api) (async () => {
      let n = 0;
      for (const p of st.parts) if (p.drawn && !p.path && p.an && !raw.has(p.id)) raw.set(p.id, new TextEncoder().encode(DC.writeDXF(p.an.contours)));
      for (const p of st.parts) { if (!p.path || raw.has(p.id)) continue;
        try { raw.set(p.id, await Paths.read(p.path)); if (p.lost || !p.an) { analyzePart(p); n++; } } catch (e) { if (p.lost) p.err = 'Чертёж не найден: ' + p.path; } }
      if (n) { save(); render(); }
    })();
  }
  window.__sheet = { st, save, init, addFiles, addBytes, addDrawn, replacePart, editPart, render, showTab, runNest, saveFixed, openView, openSheet, exportExcel, fixAll, metrics };
})();
