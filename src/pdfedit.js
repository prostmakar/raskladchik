// ===== Редактирование PDF: закраска названий организаций, печатей, фамилий; сохранение в PDF; перенос в трубы =====
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const esc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };
  // шрифты Компаса без таблицы Unicode: кириллица сдвинута на 0x247 (К -> Ǔ)
  const fixText = s => s.replace(/[ǉ-Ȉ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x247));

  const st = { files: [], cur: null, page: 0, zoom: 0, tool: false, preview: false, busy: false };
  let nextId = 1;

  // ---------------------------------------------------------------- загрузка
  function readBytes(f) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(new Uint8Array(r.result)); r.onerror = () => rej(new Error('Не удалось прочитать файл')); r.readAsArrayBuffer(f); }); }
  const extOf = n => ((n.match(/\.([^.]+)$/) || [])[1] || '').toLowerCase();
  const baseName = n => n.replace(/\.[^.]+$/, '');
  // картинка (jpg/png/…) -> PDF с одной страницей (JPEG)
  function imageToPdf(bytes, type) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(new Blob([bytes], { type }));
      const img = new Image();
      img.onload = async () => {
        const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
        const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        const k = 72 / 150; // считаем, что скан — 150 dpi
        res(await buildPdf([await encodePage(c, c.width * k, c.height * k)]));
      };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Не удалось открыть картинку')); };
      img.src = url;
    });
  }
  async function addFiles(list) {
    for (const f of [...list]) {
      const e = extOf(f.name);
      const file = { id: nextId++, name: f.name, pages: [], status: 'load', err: null, origin: f.origin || null };
      st.files.push(file); renderList();
      try {
        let bytes = await readBytes(f);
        if (e === 'tif' || e === 'tiff') bytes = Media.tiffToPdf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        else if (/^(jpe?g|png|bmp|gif|webp)$/.test(e)) bytes = await imageToPdf(bytes, e === 'png' ? 'image/png' : e === 'jpg' || e === 'jpeg' ? 'image/jpeg' : 'image/' + e);
        else if (e !== 'pdf') throw new Error('Нужен PDF, TIF, JPG или PNG');
        file.src = bytes;
        file.doc = await window.__pdf.open(bytes);
        for (let i = 1; i <= file.doc.numPages; i++) { const pg = await file.doc.getPage(i); const vp = pg.getViewport({ scale: 1 }); file.pages.push({ w: vp.width, h: vp.height, boxes: [], items: null, scanned: false }); }
        file.status = 'new';
        await findAuto(file);
      } catch (err) { file.err = (err && err.message) || 'Не удалось открыть файл'; file.status = 'err'; }
      if ((!st.cur || f.origin) && !file.err) { st.cur = file; st.page = 0; st.zoom = 0; }
      renderList(); if (st.cur === file) showPage();
    }
    renderAll();
  }

  // ---------------------------------------------------------------- автопоиск
  const RX_ORG = /(^|[\s«"„“(])(ООО|ОАО|ЗАО|ПАО|АО|ОДО|ЧУП|ЧТУП|ЧПУП|УП|РУП|КУП|ИП|СООО|ИООО|ЧП|ТОВ|LLC|LTD|GMBH|INC|JSC)(?=[\s«"„“]|$)/i;
  const RX_QUOTE = /[«"„“][^«»"„“”]{2,}[»"”]/;
  const RX_STAMP = /коммерческ|тайна|конфиденц|опытн\w*\s+образ|для\s+служебн|копия\s+верна|утверждаю|согласовано|не\s+для\s+печат|экз\.?\s*№|учт[её]нн/i;
  const RX_ADDR = /(^|\s)(г\.\s*[А-ЯЁ]|ул\.|пр-т|просп\.|пер\.|д\.\s*\d|каб\.|оф\.|тел\.|факс|e-?mail|www\.)|@|\+375|\+7\s*\(|\b\d{6},\s*г/i;
  const RX_LABEL = /^(разраб|разработ|пров|проверил|контр|нормоконтр|утв|утвердил|нач|согл|исполн|чертил|конструкт|технолог|гл\.?\s*констр|рук)/i;

  const ap = (m, p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
  async function pageItems(file, pi) {
    const pg = file.pages[pi]; if (pg.items) return pg.items;
    const page = await file.doc.getPage(pi + 1); const vp = page.getViewport({ scale: 1 }); const lib = await window.__pdf.lib();
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      const s = fixText(it.str || ''); if (!s.trim()) continue;
      const T = it.transform; const fs = Math.hypot(T[2], T[3]) || Math.hypot(T[0], T[1]) || 10;
      const ux = T[0] / (Math.hypot(T[0], T[1]) || 1), uy = T[1] / (Math.hypot(T[0], T[1]) || 1); // направление строки (в единицах PDF)
      const vx = -uy, vy = ux; // вверх
      const w = it.width || s.length * fs * 0.5;
      const P = [[0, -0.25], [w, -0.25], [w, 0.95], [0, 0.95]].map(([a, b]) => [T[4] + ux * a + vx * b * fs, T[5] + uy * a + vy * b * fs]).map(p => ap(vp.transform, p));
      const xs = P.map(p => p[0]), ys = P.map(p => p[1]);
      const tv = lib.Util.transform(vp.transform, T);
      items.push({ s, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), fs, ang: Math.round(Math.atan2(tv[1], tv[0]) * 180 / Math.PI), bx: tv[4], by: tv[5] });
    }
    // картинки на странице (печати, логотипы, фон скана)
    const imgs = [];
    try {
      const ops = await page.getOperatorList(); const O = lib.OPS; let ctm = [1, 0, 0, 1, 0, 0]; const stk = [];
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i], a = ops.argsArray[i];
        if (fn === O.save) stk.push(ctm.slice()); else if (fn === O.restore) ctm = stk.pop() || [1, 0, 0, 1, 0, 0];
        else if (fn === O.transform) ctm = lib.Util.transform(ctm, a);
        else if (fn === O.paintImageXObject || fn === O.paintInlineImageXObject || fn === O.paintImageMaskXObject || fn === O.paintImageXObjectRepeat) {
          const m = lib.Util.transform(vp.transform, ctm); const P = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
          imgs.push({ x0: Math.min(...P.map(p => p[0])), y0: Math.min(...P.map(p => p[1])), x1: Math.max(...P.map(p => p[0])), y1: Math.max(...P.map(p => p[1])) });
        }
      }
    } catch (e) { }
    pg.items = items; pg.imgs = imgs;
    const pageA = pg.w * pg.h;
    const imgA = imgs.reduce((s2, r) => s2 + (r.x1 - r.x0) * (r.y1 - r.y0), 0);
    pg.scanned = imgA > 0.5 * pageA && items.length < 10; // скан (в т.ч. из полос)
    return items;
  }
  // строки: соседние слова на одной линии
  function lines(items) {
    const L = []; const used = new Set();
    const srt = items.slice().sort((a, b) => a.ang - b.ang || a.by - b.by || a.bx - b.bx);
    for (const it of srt) {
      if (used.has(it)) continue; used.add(it);
      const line = [it]; let grow = true;
      while (grow) { grow = false;
        for (const o of srt) { if (used.has(o) || o.ang !== it.ang) continue;
          const near = line.some(l => { const dy = it.ang === 0 ? Math.abs(o.by - l.by) : Math.abs(o.bx - l.bx); const gap = it.ang === 0 ? Math.max(o.x0 - l.x1, l.x0 - o.x1) : Math.max(o.y0 - l.y1, l.y0 - o.y1); return dy < 0.45 * Math.max(o.fs, l.fs) && gap < 1.6 * Math.max(o.fs, l.fs); });
          if (near) { line.push(o); used.add(o); grow = true; } } }
      line.sort((a, b) => a.ang === 0 ? a.x0 - b.x0 : a.y0 - b.y0);
      L.push({ items: line, s: line.map(x => x.s).join(' '), x0: Math.min(...line.map(x => x.x0)), y0: Math.min(...line.map(x => x.y0)), x1: Math.max(...line.map(x => x.x1)), y1: Math.max(...line.map(x => x.y1)) });
    }
    return L;
  }
  const pad = (r, p) => ({ x: r.x0 - p, y: r.y0 - p, w: r.x1 - r.x0 + 2 * p, h: r.y1 - r.y0 + 2 * p });
  async function findPage(file, pi) {
    const pg = file.pages[pi];
    const items = await pageItems(file, pi);
    const found = [];
    const add = (r, label) => found.push(Object.assign(r, { src: 'auto', label, on: true }));
    const L = lines(items);
    for (const l of L) {
      if (RX_ORG.test(' ' + l.s) || (RX_QUOTE.test(l.s) && /[А-ЯЁA-Z]/.test(l.s) && !/ГОСТ|ТУ|СТБ|ОСТ/.test(l.s))) add(pad(l, 1.5), 'Организация');
      else if (RX_STAMP.test(l.s)) add(pad(l, 2), 'Надпись печати');
      else if (RX_ADDR.test(l.s)) add(pad(l, 1.5), 'Адрес / контакты');
    }
    // основная надпись: фамилии, подписи и даты в строках «Разраб.», «Пров.», …, «Утв.»
    const labels = items.filter(it => it.ang === 0 && RX_LABEL.test(it.s.trim()));
    if (labels.length) {
      // группы подписей (основных надписей может быть несколько)
      const groups = [];
      for (const lb of labels) { let g = groups.find(g => Math.abs(g.x - lb.x0) < 30 && lb.y0 < g.y1 + 3 * lb.fs && lb.y1 > g.y0 - 3 * lb.fs); if (!g) { g = { x: lb.x0, y0: lb.y0, y1: lb.y1, L: [] }; groups.push(g); } g.L.push(lb); g.y0 = Math.min(g.y0, lb.y0); g.y1 = Math.max(g.y1, lb.y1); }
      for (const g of groups) {
        if (g.L.length < 2) continue;
        const fs = Math.max(...g.L.map(l => l.fs));
        const xL = Math.max(...g.L.map(l => l.x1)) + 1;
        // правая граница — до колонки «Дата» (над строками)
        const dat = items.find(it => it.ang === 0 && /^дата$/i.test(it.s.trim()) && it.x0 > xL && it.x0 < xL + 260 && it.y1 <= g.y0 + fs && it.y1 > g.y0 - 8 * fs);
        let xR;
        if (dat) xR = dat.x1 + Math.max(8, 0.8 * fs);
        else { const nm = items.filter(it => it.ang === 0 && it.x0 > xL && it.x0 < xL + 160 && it.y1 > g.y0 && it.y0 < g.y1); xR = nm.length ? Math.max(...nm.map(n => n.x1)) + 70 : xL + 160; }
        // точечно: слова с буквами в строке каждой метки, между меткой и графой «Дата» (сама дата не трогается)
        const xD = dat ? dat.x0 - 1 : xR;
        let n = 0;
        for (const lb of g.L) {
          const yc = (lb.y0 + lb.y1) / 2, hh = (lb.y1 - lb.y0) / 2 + 0.3 * lb.fs;
          for (const it of items) {
            if (it.ang !== 0 || it === lb || it.x0 < xL - 1 || it.x1 > xD + 2) continue;
            const ic = (it.y0 + it.y1) / 2; if (Math.abs(ic - yc) > hh) continue;
            if (!/[A-Za-zА-Яа-яЁё]{2}/.test(it.s) || RX_LABEL.test(it.s.trim())) continue;
            const b = pad(it, 0.5 * it.fs); b.one = true; /* с запасом (хвосты букв, курсив) — потом ужимается до чернил в своей клетке */ add(b, 'Фамилия: ' + it.s.trim().slice(0, 30)); n++;
          }
        }
        // фамилии не текстом (кривыми) — закрасить колонку целиком
        if (!n) add({ x: xL, y: g.y0 - 1, w: xR - xL, h: g.y1 - g.y0 + 2, src: 'auto' }, 'Фамилии, подписи, даты');
      }
    }
    // картинки-печати (не фон скана)
    const pageA = pg.w * pg.h;
    if (!pg.scanned) for (const r of pg.imgs || []) { const a = (r.x1 - r.x0) * (r.y1 - r.y0); if (a < 40 || a > 0.3 * pageA) continue; add(pad(r, 2), 'Печать / картинка'); }
    // скан: цветные чернила (синие/фиолетовые/красные печати и подписи)
    if (pg.scanned || !items.length) {
      for (const r of await inkBoxes(file, pi)) add(r, 'Цветная печать / подпись');
      for (const r of await gostBoxes(file, pi)) { const lb = r.label; delete r.label; add(r, lb); }
    }
    // фамилии — рамка впритык к буквам, чтобы закраска не съела линии штампа
    await tighten(file, pi, found.filter(b => b.one));
    // не дублировать уже стоящие автоматические
    pg.boxes = pg.boxes.filter(b => b.src !== 'auto').concat(mergeBoxes(found));
  }
  // ужать рамки до чернил внутри (линии таблицы — строки/столбцы, тёмные почти по всей ширине/высоте рамки, — не считаются)
  async function tighten(file, pi, boxes) {
    if (!boxes.length) return;
    const pg = file.pages[pi]; const page = await file.doc.getPage(pi + 1);
    const k = Math.min(5, 4200 / Math.max(pg.w, pg.h)); const vp = page.getViewport({ scale: k });
    const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    for (const b of boxes) {
      const X0 = Math.max(0, Math.floor(b.x * k)), Y0 = Math.max(0, Math.floor(b.y * k));
      const X1 = Math.min(c.width, Math.ceil((b.x + b.w) * k)), Y1 = Math.min(c.height, Math.ceil((b.y + b.h) * k));
      const W = X1 - X0, H = Y1 - Y0; if (W < 3 || H < 3) continue;
      const D = g.getImageData(X0, Y0, W, H).data;
      const dk = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) dk[i] = D[i * 4] * 0.3 + D[i * 4 + 1] * 0.59 + D[i * 4 + 2] * 0.11 < 170 ? 1 : 0;
      const rowL = new Uint8Array(H), colL = new Uint8Array(W);
      for (let y = 0; y < H; y++) { let n = 0; for (let x = 0; x < W; x++) n += dk[y * W + x]; if (n > 0.55 * W) rowL[y] = 1; }
      for (let x = 0; x < W; x++) { let n = 0; for (let y = 0; y < H; y++) n += dk[y * W + x]; if (n > 0.55 * H) colL[x] = 1; }
      // линия с размытыми краями — захватить соседние пиксели
      const grow = (A, N) => { const B = A.slice(); for (let i = 0; i < N; i++) if (A[i]) for (let d = -2; d <= 2; d++) if (i + d >= 0 && i + d < N) B[i + d] = 1; return B; };
      const rL = grow(rowL, H), cL = grow(colL, W);
      // только своя клетка: между ближайшими к центру линиями (буквы соседней строки не захватывать)
      const span = (L, N) => { let m = N >> 1; if (L[m]) { let d = 1; while (d < N && (m + d >= N || L[m + d]) && (m - d < 0 || L[m - d])) d++; m = m + d < N && !L[m + d] ? m + d : m - d; } let a = m, z = m; while (a > 0 && !L[a - 1]) a--; while (z < N - 1 && !L[z + 1]) z++; return [a, z]; };
      const [ya, yz] = span(rL, H), [xa, xz] = span(cL, W);
      const rc = new Uint32Array(H), cc = new Uint32Array(W);
      for (let y = ya; y <= yz; y++) for (let x = xa; x <= xz; x++) if (dk[y * W + x]) { rc[y]++; cc[x]++; }
      const minN = 1;
      let y0 = 0, y1 = H - 1, x0 = 0, x1 = W - 1;
      while (y0 < H && rc[y0] < minN) y0++; while (y1 > y0 && rc[y1] < minN) y1--;
      while (x0 < W && cc[x0] < minN) x0++; while (x1 > x0 && cc[x1] < minN) x1--;
      if (y0 >= H || x0 >= W) continue; // чернил нет — оставить как есть
      const padPx = Math.max(1, 0.6 * k);
      // не заходить на линии
      let ny0 = y0 - padPx, ny1 = y1 + 1 + padPx, nx0 = x0 - padPx, nx1 = x1 + 1 + padPx;
      for (let y = y0; y >= 0 && y >= y0 - padPx; y--) if (rL[y]) { ny0 = y + 1; break; }
      for (let y = y1; y < H && y <= y1 + padPx; y++) if (rL[y]) { ny1 = y; break; }
      for (let x = x0; x >= 0 && x >= x0 - padPx; x--) if (cL[x]) { nx0 = x + 1; break; }
      for (let x = x1; x < W && x <= x1 + padPx; x++) if (cL[x]) { nx1 = x; break; }
      ny0 = Math.max(0, ny0); nx0 = Math.max(0, nx0); ny1 = Math.min(H, ny1); nx1 = Math.min(W, nx1);
      b.x = (X0 + nx0) / k; b.y = (Y0 + ny0) / k; b.w = (nx1 - nx0) / k; b.h = (ny1 - ny0) / k;
    }
  }
  function mergeBoxes(B) {
    const out = [];
    for (const b of B) {
      if (b.one) { out.push(Object.assign({}, b)); continue; }
      const o = out.find(o => o.label === b.label && b.x < o.x + o.w + 4 && b.x + b.w > o.x - 4 && b.y < o.y + o.h + 4 && b.y + b.h > o.y - 4);
      if (o) { const x0 = Math.min(o.x, b.x), y0 = Math.min(o.y, b.y), x1 = Math.max(o.x + o.w, b.x + b.w), y1 = Math.max(o.y + o.h, b.y + b.h); Object.assign(o, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }); }
      else out.push(Object.assign({}, b));
    }
    return out;
  }
  // цветные пятна на картинке страницы
  async function inkBoxes(file, pi) {
    const pg = file.pages[pi]; const page = await file.doc.getPage(pi + 1);
    const k = Math.min(2, 1400 / Math.max(pg.w, pg.h)); const vp = page.getViewport({ scale: k });
    const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    const D = g.getImageData(0, 0, c.width, c.height).data;
    const cell = 8, nx = Math.ceil(c.width / cell), ny = Math.ceil(c.height / cell); const cnt = new Uint16Array(nx * ny);
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4, r = D[i], gg = D[i + 1], b = D[i + 2];
      const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
      if (mx - mn > 55 && mn < 200 && mx > 60) cnt[Math.floor(y / cell) * nx + Math.floor(x / cell)]++;
    }
    const on = new Uint8Array(nx * ny); for (let i = 0; i < on.length; i++) on[i] = cnt[i] >= 3 ? 1 : 0;
    // склейка соседних клеток (с зазором 2 клетки)
    const seen = new Uint8Array(nx * ny), out = [];
    for (let i = 0; i < on.length; i++) {
      if (!on[i] || seen[i]) continue;
      let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0; const q = [i]; seen[i] = 1;
      while (q.length) { const j = q.pop(); const cx = j % nx, cy = (j / nx) | 0; n++; x0 = Math.min(x0, cx); x1 = Math.max(x1, cx); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy);
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const X = cx + dx, Y = cy + dy; if (X < 0 || Y < 0 || X >= nx || Y >= ny) continue; const k2 = Y * nx + X; if (on[k2] && !seen[k2]) { seen[k2] = 1; q.push(k2); } } }
      const W = (x1 - x0 + 1) * cell / k, H = (y1 - y0 + 1) * cell / k;
      if (n < 6 || Math.max(W, H) < 12) continue;
      if (W * H > 0.35 * pg.w * pg.h) continue; // весь лист цветной — не печать
      out.push({ x: x0 * cell / k - 3, y: y0 * cell / k - 3, w: W + 6, h: H + 6 });
    }
    return out;
  }
  // скан: основная надпись по ГОСТ 2.104 (форма 1) от найденной рамки чертежа
  async function gostBoxes(file, pi) {
    const pg = file.pages[pi]; const page = await file.doc.getPage(pi + 1);
    const k = Math.min(2, 1600 / Math.max(pg.w, pg.h)); const vp = page.getViewport({ scale: k });
    const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    const W = c.width, H = c.height, D = g.getImageData(0, 0, W, H).data;
    const dark = (x, y) => { const i = (y * W + x) * 4; return D[i] * 0.3 + D[i + 1] * 0.59 + D[i + 2] * 0.11 < 120; };
    // линия рамки: столбец/строка, тёмные на большей части длины (с допуском ±1 пиксель)
    const colRatio = x => { let n = 0; for (let y = 0; y < H; y += 2) if (dark(x, y) || (x > 0 && dark(x - 1, y)) || (x + 1 < W && dark(x + 1, y))) n++; return n / (H / 2); };
    const rowRatio = y => { let n = 0; for (let x = 0; x < W; x += 2) if (dark(x, y) || (y > 0 && dark(x, y - 1)) || (y + 1 < H && dark(x, y + 1))) n++; return n / (W / 2); };
    let R = -1, B = -1;
    for (let x = W - 1; x > W * 0.6; x--) if (colRatio(x) > 0.6) { R = x; break; }
    for (let y = H - 1; y > H * 0.6; y--) if (rowRatio(y) > 0.6) { B = y; break; }
    if (R < 0 || B < 0) return [];
    // слева бывают полосы «Перв. примен.», «Инв. №» левее рамки — берём самую правую линию, подходящую под формат (рамка = лист − 25 мм)
    const portrait = H > W;
    const cands = portrait ? [[210, 185 / 210], [297, 272 / 297], [420, 395 / 420]] : [[297, 272 / 297], [420, 395 / 420], [594, 569 / 594]];
    let best = null;
    for (let x = 0, prev = false; x < W * 0.45; x++) {
      const on = colRatio(x) > 0.6;
      if (on && !prev) { const ratio = (R - x) / W; for (const c of cands) { const err = Math.abs(c[1] - ratio); if (err < 0.015 && (!best || x > best.Lx)) best = { err, Lx: x, Wmm: c[0] }; } }
      prev = on;
    }
    if (!best) return [];
    const Lx = best.Lx, Wmm = best.Wmm;
    const mm = (R - Lx) / (Wmm - 25); // пикселей в мм
    if (185 * mm > (R - Lx) * 1.02) return [];
    const toPt = v => v / k;
    const blockL = R - 185 * mm;
    // графа «Фамилия» (17…40 мм от левого края штампа), 6 нижних строк по 5 мм: Разраб., Пров., Т.контр., —, Н.контр., Утв.
    const ROWS = ['Разраб.', 'Пров.', 'Т. контр.', '', 'Н. контр.', 'Утв.'];
    const ink = (x0, y0, x1, y1) => { let n = 0, t = 0; for (let y = Math.round(y0); y < y1; y++) for (let x = Math.round(x0); x < x1; x++) { t++; if (dark(x, y)) n++; } return t ? n / t : 0; };
    const out = [];
    ROWS.forEach((nm, i) => {
      const y0 = B - (30 - 5 * i) * mm, x0 = blockL + 17 * mm, x1 = blockL + 40 * mm;
      const inset = 0.7 * mm;
      if (ink(x0 + inset, y0 + inset, x1 - inset, y0 + 5 * mm - inset) < 0.015) return; // пустая клетка
      out.push({ x: toPt(x0) + 1, y: toPt(y0) + 1, w: toPt(23 * mm) - 2, h: toPt(5 * mm) - 2, one: true, label: 'Фамилия' + (nm ? ' (' + nm + ')' : '') + ' — по ГОСТ' });
    });
    out.push({ x: toPt(R - 50 * mm) + 1, y: toPt(B - 15 * mm) + 1, w: toPt(50 * mm) - 2, h: toPt(15 * mm) - 2, label: 'Организация (по ГОСТ — проверьте)' });
    return out;
  }
  async function findAuto(file) { for (let i = 0; i < file.pages.length; i++) await findPage(file, i); file.status = 'found'; }

  // ---------------------------------------------------------------- список файлов
  const nBoxes = f => f.pages.reduce((s, p) => s + p.boxes.filter(b => b.on).length, 0);
  function renderList() {
    const el = $('#pList');
    if (!st.files.length) { el.innerHTML = '<div class="empty">Файлов нет</div>'; return; }
    el.innerHTML = st.files.map(f => `<div class="pfile${f === st.cur ? ' on' : ''}${f.err ? ' bad' : ''}" data-f="${f.id}">
      <div class="nm">${esc(f.name)}</div>
      <div class="meta">${f.err ? `<span class="err">${esc(f.err)}</span>` : f.status === 'load' ? 'Открываю…' : `${f.pages.length} ${plural(f.pages.length, 'стр.', 'стр.', 'стр.')} · закрасить: <b>${nBoxes(f)}</b>${f.pages.some(p => p.scanned) ? ' · скан' : ''}`}${f.checked ? ' · <span class="okt">проверено</span>' : ''}</div>
      <button class="ic del" data-del="${f.id}" title="Убрать">×</button></div>`).join('');
    $('#pCnt').textContent = st.files.length ? ' · ' + st.files.length : '';
  }
  $('#pList').addEventListener('click', e => {
    const d = e.target.closest('[data-del]'); if (d) { const i = st.files.findIndex(f => f.id == d.dataset.del); if (i >= 0) { if (st.cur === st.files[i]) st.cur = null; st.files.splice(i, 1); } if (!st.cur && st.files.length) st.cur = st.files.find(f => !f.err) || null; st.page = 0; st.zoom = 0; renderAll(); return; }
    const r = e.target.closest('[data-f]'); if (r) { const f = st.files.find(x => x.id == r.dataset.f); if (f && !f.err) { st.cur = f; st.page = 0; st.zoom = 0; renderAll(); } }
  });

  // ---------------------------------------------------------------- просмотр страницы
  let renderTask = null;
  async function showPage() {
    const f = st.cur; const stage = $('#pStage');
    if (!f || !f.doc) { $('#pCanvas').hidden = true; $('#pOver').innerHTML = ''; $('#pMsg').hidden = false; $('#pMsg').textContent = st.files.length ? 'Выберите файл слева' : 'Перетащите сюда PDF, TIF, JPG или PNG'; $('#pPage').textContent = ''; renderSide(); return; }
    $('#pMsg').hidden = true; $('#pCanvas').hidden = false;
    const pg = f.pages[st.page];
    if (!st.zoom) st.zoom = Math.min((stage.clientWidth - 30) / pg.w, (stage.clientHeight - 30) / pg.h);
    const z = st.zoom, dpr = window.devicePixelRatio || 1;
    const page = await f.doc.getPage(st.page + 1); const vp = page.getViewport({ scale: z * dpr });
    const cv = $('#pCanvas'); cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height); cv.style.width = (vp.width / dpr) + 'px'; cv.style.height = (vp.height / dpr) + 'px';
    const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
    if (renderTask) { try { renderTask.cancel(); } catch (e) { } }
    renderTask = page.render({ canvasContext: g, viewport: vp });
    try { await renderTask.promise; } catch (e) { }
    const ov = $('#pOver'); ov.style.width = cv.style.width; ov.style.height = cv.style.height;
    $('#pPage').textContent = `стр. ${st.page + 1} из ${f.pages.length}`;
    $('#pPrev').disabled = st.page <= 0; $('#pNext').disabled = st.page >= f.pages.length - 1;
    drawBoxes(); renderSide();
  }
  function drawBoxes() {
    const f = st.cur; if (!f || !f.pages[st.page]) return; const z = st.zoom;
    $('#pOver').classList.toggle('prev', st.preview); $('#pOver').classList.toggle('tool', st.tool);
    $('#pOver').innerHTML = f.pages[st.page].boxes.map((b, i) => `<div class="pbox ${b.src}${b.on ? '' : ' off'}" data-i="${i}" style="left:${b.x * z}px;top:${b.y * z}px;width:${b.w * z}px;height:${b.h * z}px" title="${esc(b.label)}"><span class="pdel" data-bdel="${i}" title="Убрать">×</span><span class="prs" data-rs="${i}"></span></div>`).join('');
  }
  function renderSide() {
    const f = st.cur; const el = $('#pSide');
    if (!f || !f.pages[st.page]) { el.innerHTML = ''; return; }
    const pg = f.pages[st.page];
    el.innerHTML = `<div class="fs"><div class="t">Закрасить на странице</div>
      ${pg.boxes.length ? pg.boxes.map((b, i) => `<label class="prow"><input type="checkbox" data-on="${i}"${b.on ? ' checked' : ''}><span>${esc(b.label)}</span><em>${b.src === 'auto' ? 'авто' : 'вручную'}</em><button class="ic del" data-bdel="${i}" title="Убрать">×</button></label>`).join('') : '<div class="meta">Ничего не найдено</div>'}
      </div>
      
      <label class="prow ck2"><input type="checkbox" id="pChecked"${f.checked ? ' checked' : ''}><span>Файл проверен</span></label>
      <button class="btn primary pnext" id="pGoNext">${st.page < f.pages.length - 1 ? 'Дальше: стр. ' + (st.page + 2) + ' →' : 'Проверено, следующий файл →'}</button>
      <div class="meta">${(() => { const left = st.files.filter(x => !x.err && !x.checked && x !== f).length; return left ? 'Осталось: ' + left : ''; })()}</div>`;
    $('#pChecked').onchange = e => { f.checked = e.target.checked; renderList(); };
    $('#pGoNext').onclick = goNext;
  }
  // как в трубах: «Проверено → следующий»
  function goNext() {
    const f = st.cur; if (!f) return;
    if (st.page < f.pages.length - 1) { st.page++; showPage(); return; }
    f.checked = true;
    const i = st.files.indexOf(f);
    const nx = st.files.slice(i + 1).find(x => !x.err && !x.checked && x.doc) || st.files.slice(0, i).find(x => !x.err && !x.checked && x.doc);
    if (nx) { st.cur = nx; st.page = 0; st.zoom = 0; $('#pStage').scrollTo(0, 0); renderAll(); }
    else { renderList(); renderSide(); toast('Все файлы проверены.', saveAll, 'Сохранить все в PDF'); }
  }
  $('#pSide').addEventListener('change', e => { const i = e.target.dataset.on; if (i === undefined) return; st.cur.pages[st.page].boxes[+i].on = e.target.checked; drawBoxes(); renderList(); });
  document.addEventListener('click', e => {
    const d = e.target.closest('[data-bdel]'); if (!d || !st.cur || !$('#appPdf') || $('#appPdf').hidden) return;
    e.stopPropagation(); st.cur.pages[st.page].boxes.splice(+d.dataset.bdel, 1); drawBoxes(); renderSide(); renderList();
  }, true);

  // рисование, перенос, растягивание прямоугольников
  {
    const ov = $('#pOver'); let act = null;
    const pt = e => { const r = ov.getBoundingClientRect(); return [(e.clientX - r.left) / st.zoom, (e.clientY - r.top) / st.zoom]; };
    ov.addEventListener('mousedown', e => {
      if (!st.cur || e.button !== 0 || e.target.closest('[data-bdel]')) return;
      const pg = st.cur.pages[st.page]; const p = pt(e);
      const rs = e.target.closest('[data-rs]'); const bx = e.target.closest('.pbox');
      if (rs) { act = { mode: 'rs', b: pg.boxes[+rs.dataset.rs], p }; }
      else if (bx && !st.tool) { const b = pg.boxes[+bx.dataset.i]; act = { mode: 'mv', b, p, x: b.x, y: b.y }; }
      else if (st.tool || e.shiftKey) { const b = { x: p[0], y: p[1], w: 0, h: 0, src: 'hand', label: 'Выделено вручную', on: true }; pg.boxes.push(b); act = { mode: 'new', b, p }; }
      else return;
      e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
      if (!act) return; const p = pt(e), b = act.b;
      if (act.mode === 'new') { b.x = Math.min(act.p[0], p[0]); b.y = Math.min(act.p[1], p[1]); b.w = Math.abs(p[0] - act.p[0]); b.h = Math.abs(p[1] - act.p[1]); }
      else if (act.mode === 'mv') { b.x = act.x + p[0] - act.p[0]; b.y = act.y + p[1] - act.p[1]; }
      else if (act.mode === 'rs') { b.w = Math.max(3, p[0] - b.x); b.h = Math.max(3, p[1] - b.y); }
      drawBoxes();
    });
    window.addEventListener('mouseup', () => {
      if (!act) return; const pg = st.cur && st.cur.pages[st.page];
      if (act.mode === 'new' && pg && (act.b.w < 3 || act.b.h < 3)) pg.boxes.splice(pg.boxes.indexOf(act.b), 1);
      act = null; drawBoxes(); renderSide(); renderList();
    });
  }
  $('#pPrev').addEventListener('click', () => { if (st.page > 0) { st.page--; showPage(); } });
  $('#pNext').addEventListener('click', () => { if (st.cur && st.page < st.cur.pages.length - 1) { st.page++; showPage(); } });
  // масштаб: колесо — к точке под курсором; перетаскивание пустого места (или правой/средней кнопкой) — двигать лист
  let reTimer = null;
  function zoomTo(nz, cx, cy) {
    const f = st.cur; if (!f || !f.pages[st.page]) return; const pg = f.pages[st.page];
    const stage = $('#pStage'), wrap = stage.querySelector('.pwrap'), cv = $('#pCanvas'), ov = $('#pOver');
    const fit = Math.min((stage.clientWidth - 30) / pg.w, (stage.clientHeight - 30) / pg.h);
    nz = Math.max(fit * 0.5, Math.min(12, nz));
    const sr = stage.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
    if (cx === undefined) { cx = sr.left + sr.width / 2; cy = sr.top + sr.height / 2; }
    const px = (cx - wr.left) / st.zoom, py = (cy - wr.top) / st.zoom;
    st.zoom = nz;
    cv.style.width = ov.style.width = pg.w * nz + 'px'; cv.style.height = ov.style.height = pg.h * nz + 'px';
    drawBoxes();
    stage.scrollLeft = wrap.offsetLeft + px * nz - (cx - sr.left);
    stage.scrollTop = wrap.offsetTop + py * nz - (cy - sr.top);
    clearTimeout(reTimer); reTimer = setTimeout(() => { const l = stage.scrollLeft, t = stage.scrollTop; showPage().then(() => { stage.scrollLeft = l; stage.scrollTop = t; }); }, 180);
  }
  {
    const stage = $('#pStage'); let pan = null;
    stage.addEventListener('wheel', e => { if (!st.cur) return; e.preventDefault(); zoomTo(st.zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX, e.clientY); }, { passive: false });
    stage.addEventListener('mousedown', e => {
      if (!st.cur || e.defaultPrevented) return;
      if (e.button === 0 && (st.tool || e.shiftKey || e.target.closest('.pbox'))) return;
      pan = { x: e.clientX, y: e.clientY, l: stage.scrollLeft, t: stage.scrollTop }; stage.classList.add('panning'); e.preventDefault();
    });
    window.addEventListener('mousemove', e => { if (!pan) return; stage.scrollLeft = pan.l - (e.clientX - pan.x); stage.scrollTop = pan.t - (e.clientY - pan.y); });
    window.addEventListener('mouseup', () => { if (pan) { pan = null; stage.classList.remove('panning'); } });
    stage.addEventListener('contextmenu', e => { if (st.cur) e.preventDefault(); });
  }
  $('#pIn').addEventListener('click', () => zoomTo(st.zoom * 1.25));
  $('#pOut').addEventListener('click', () => zoomTo(st.zoom / 1.25));
  $('#pFit').addEventListener('click', () => { st.zoom = 0; showPage(); });
  $('#pTool').addEventListener('click', () => { st.tool = !st.tool; $('#pTool').classList.toggle('on', st.tool); drawBoxes(); });
  $('#pPrevw').addEventListener('click', () => { st.preview = !st.preview; $('#pPrevw').classList.toggle('on', st.preview); drawBoxes(); });
  $('#pFindPage').addEventListener('click', async () => { if (!st.cur) return; await findPage(st.cur, st.page); drawBoxes(); renderSide(); renderList(); });
  $('#pClearPage').addEventListener('click', () => { if (!st.cur) return; st.cur.pages[st.page].boxes = []; drawBoxes(); renderSide(); renderList(); });
  window.addEventListener('resize', () => { if (window.__mode === 'pdf' && st.cur) { st.zoom = 0; showPage(); } });

  // ---------------------------------------------------------------- вывод: страница -> картинка -> PDF
  async function renderOut(file, pi) {
    const pg = file.pages[pi]; const page = await file.doc.getPage(pi + 1);
    const k = Math.min(220 / 72, 3600 / Math.max(pg.w, pg.h)); const vp = page.getViewport({ scale: k });
    const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    g.fillStyle = '#fff'; for (const b of pg.boxes) if (b.on) g.fillRect(Math.floor(b.x * k), Math.floor(b.y * k), Math.ceil(b.w * k) + 1, Math.ceil(b.h * k) + 1);
    return encodePage(c, pg.w, pg.h);
  }
  async function encodePage(c, wPt, hPt) {
    const g = c.getContext('2d'); const D = g.getImageData(0, 0, c.width, c.height).data;
    let colored = 0; const n = c.width * c.height;
    for (let i = 0; i < D.length; i += 4 * 7) { const r = D[i], gg = D[i + 1], b = D[i + 2]; if (Math.max(r, gg, b) - Math.min(r, gg, b) > 18) colored++; }
    const gray = colored < (n / 7) * 0.002;
    if (gray && typeof CompressionStream !== 'undefined') {
      const G = new Uint8Array(n); for (let i = 0, j = 0; j < n; i += 4, j++) G[j] = (D[i] * 299 + D[i + 1] * 587 + D[i + 2] * 114) / 1000;
      const z = new Uint8Array(await new Response(new Blob([G]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
      return { w: wPt, h: hPt, pw: c.width, ph: c.height, data: z, filter: 'FlateDecode', cs: 'DeviceGray' };
    }
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
    return { w: wPt, h: hPt, pw: c.width, ph: c.height, data: new Uint8Array(await blob.arrayBuffer()), filter: 'DCTDecode', cs: 'DeviceRGB' };
  }
  async function buildPdf(pages) {
    const enc = new TextEncoder(); const parts = []; let size = 0; const off = [];
    const push = b => { if (typeof b === 'string') b = enc.encode(b); parts.push(b); size += b.length; };
    const objs = []; let id = 3; const kids = [];
    for (const p of pages) {
      const im = id++, ct = id++, pgid = id++; kids.push(pgid);
      objs.push({ id: im, dict: `<< /Type /XObject /Subtype /Image /Width ${p.pw} /Height ${p.ph} /ColorSpace /${p.cs} /BitsPerComponent 8 /Filter /${p.filter} /Length ${p.data.length} >>`, stream: p.data });
      const cs = enc.encode(`q ${p.w.toFixed(3)} 0 0 ${p.h.toFixed(3)} 0 0 cm /Im0 Do Q\n`);
      objs.push({ id: ct, dict: `<< /Length ${cs.length} >>`, stream: cs });
      objs.push({ id: pgid, dict: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.w.toFixed(3)} ${p.h.toFixed(3)}] /Resources << /XObject << /Im0 ${im} 0 R >> >> /Contents ${ct} 0 R >>` });
    }
    objs.push({ id: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' }, { id: 2, dict: `<< /Type /Pages /Kids [${kids.map(k => k + ' 0 R').join(' ')}] /Count ${kids.length} >>` });
    objs.sort((a, b) => a.id - b.id);
    push('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n');
    for (const o of objs) { off[o.id] = size; push(`${o.id} 0 obj\n${o.dict}\n`); if (o.stream) { push('stream\n'); push(o.stream); push('\nendstream\n'); } push('endobj\n'); }
    const xref = size, N = objs.length + 1; let x = `xref\n0 ${N}\n0000000000 65535 f \n`; for (let i = 1; i < N; i++) x += String(off[i]).padStart(10, '0') + ' 00000 n \n';
    push(x + `trailer\n<< /Size ${N} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const out = new Uint8Array(size); let q = 0; for (const b of parts) { out.set(b, q); q += b.length; } return out;
  }
  async function outFile(file) { const pages = []; for (let i = 0; i < file.pages.length; i++) pages.push(await renderOut(file, i)); return buildPdf(pages); }
  // текст для разбора в трубах — без закрашенных мест
  async function keptText(file) {
    const out = [];
    for (let i = 0; i < file.pages.length; i++) { const pg = file.pages[i]; const items = await pageItems(file, i); for (const it of items) { const hit = pg.boxes.some(b => b.on && it.x1 > b.x && it.x0 < b.x + b.w && it.y1 > b.y && it.y0 < b.y + b.h); if (!hit) out.push(it.s); } }
    return out;
  }

  function progress(t) { const el = $('#pBusy'); if (!t) { el.hidden = true; return; } el.hidden = false; el.textContent = t; }
  const ready = () => st.files.filter(f => !f.err && f.doc);
  async function saveAll() {
    if (st.busy) return; const list = ready(); if (!list.length) { toast('Нет файлов'); return; }
    st.busy = true;
    try {
      const files = [];
      for (let i = 0; i < list.length; i++) { progress(`Готовлю PDF ${i + 1} из ${list.length}…`); const b = await outFile(list[i]); files.push({ name: baseName(list[i].name) + '.pdf', bytes: b }); }
      const seen = new Map(); for (const f of files) { const k = f.name.toLowerCase(); const n = seen.get(k) || 0; seen.set(k, n + 1); if (n) f.name = f.name.replace(/\.pdf$/i, ` (${n + 1}).pdf`); }
      if (/^https?:$/.test(location.protocol)) {
        progress(null);
        const to = window.SaveDlg ? await window.SaveDlg('pdf', files.length) : {};
        if (!to) return;
        progress('Сохраняю…');
        try {
          const b64 = u => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
          const r = await fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: 'Отредактированные PDF', base: to.base || '', name: to.name || '', files: files.map(f => ({ name: f.name, b64: b64(f.bytes) })) }) });
          const j = await r.json(); if (!r.ok || j.error) throw new Error(j.error || 'ошибка записи');
          toast(`Сохранено ${files.length} ${plural(files.length, 'файл', 'файла', 'файлов')} в папку<br><b>${esc(j.dir)}</b>`, () => fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: j.dir }) }), 'Открыть папку');
          return;
        } catch (e) { toast('Не удалось записать в папку (' + esc(e.message) + '). Скачиваю архивом.'); }
      }
      const zip = XLSX.zip(files.map(f => ({ name: f.name, data: f.bytes })));
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([zip], { type: 'application/zip' })); a.download = `Отредактированные PDF ${XLSX.stamp()}.zip`; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    } finally { st.busy = false; progress(null); }
  }
  async function toTubes() {
    if (st.busy) return; const list = ready(); if (!list.length) { toast('Нет файлов'); return; }
    st.busy = true;
    try {
      for (let i = 0; i < list.length; i++) {
        progress(`Переношу в трубы: ${i + 1} из ${list.length}…`);
        const f = list[i]; const bytes = await outFile(f); const items = await keptText(f);
        // пришёл из «Труб» — возвращаем в ту же деталь, иначе — новая деталь
        if (f.origin && f.origin.mod === 'tube' && window.__app.setDrawing && window.__app.setDrawing(f.origin.id, bytes)) continue;
        await window.__app.addOne(baseName(f.name) + '.pdf', async () => '', async () => bytes, items);
      }
      document.querySelector('#appPdf .modesw [data-go=tube]').click();
      window.__app.showTab('parts');
    } finally { st.busy = false; progress(null); }
  }
  async function findAll() { if (st.busy) return; st.busy = true; try { const L = ready(); for (let i = 0; i < L.length; i++) { progress(`Ищу ${i + 1} из ${L.length}…`); await findAuto(L[i]); } } finally { st.busy = false; progress(null); renderAll(); } }
  $('#pFindAll').addEventListener('click', findAll);
  $('#pSave').addEventListener('click', saveAll);
  $('#pToTube').addEventListener('click', toTubes);
  $('#pToSheet').addEventListener('click', () => toast('Чертежи PDF на листе — скоро'));
  // принять чертёж из «Труб» (или «Листа») на редактирование
  async function takeBytes(name, bytes, origin) {
    const f = new File([bytes], name); f.origin = origin;
    const old = st.files.find(x => x.origin && origin && x.origin.mod === origin.mod && x.origin.id === origin.id);
    if (old) st.files.splice(st.files.indexOf(old), 1);
    if (st.cur === old) st.cur = null;
    await addFiles([f]);
  }
  $('#pClear').addEventListener('click', () => { if (st.files.length && !confirm('Убрать все файлы?')) return; st.files = []; st.cur = null; renderAll(); });

  let toastT = null;
  function toast(html, act, actLabel) {
    const el = $('#sToast'); el.innerHTML = `<span>${html}</span>${act ? `<button class="btn small">${esc(actLabel)}</button>` : ''}<button class="ic" title="Закрыть">✕</button>`; el.hidden = false;
    if (act) el.querySelector('.btn').onclick = act; el.querySelector('.ic').onclick = () => { el.hidden = true; };
    clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 12000);
  }

  // перетаскивание
  const drop = $('#pDrop'), inp = $('#pFile');
  drop.addEventListener('click', () => inp.click());
  inp.addEventListener('change', () => { const f = [...inp.files]; inp.value = ''; addFiles(f); });
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
  window.addEventListener('drop', e => { if (window.__mode !== 'pdf') return; e.preventDefault(); if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });

  function renderAll() { renderList(); showPage(); }
  window.__pdfedit = { st, takeBytes, addFiles, renderAll, findAll, saveAll, toTubes, outFile, keptText, fixText, show: () => { st.zoom = 0; renderAll(); } };
})();
