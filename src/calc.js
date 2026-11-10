// ===== Manual-part cut length, drawing-text parsing, 1D nesting =====
(function (root) {
  'use strict';
  const num = v => { if (v === null || v === undefined) return NaN; const s = String(v).trim().replace(',', '.'); return s === '' ? NaN : +s; };
  const fmtN = x => { const r = Math.round(x * 100) / 100; return String(r).replace('.', ','); };

  // "56°30'" | "56 30" | "56,5" -> degrees
  function parseAngle(s) {
    if (typeof s === 'number') return s;
    s = String(s || '').trim().replace(',', '.');
    if (!s) return 90;
    // градусы и минуты через двоеточие, дефис, пробел или знаки: 38:20, 38-20, 38 20, 38°20', 38°20′15″
    const c = /^(\d+(?:\.\d+)?)\s*(?:°|град\.?)?\s*[:\-–—\s]\s*(\d+(?:\.\d+)?)\s*['′’]?\s*(?:[:\-–—\s]\s*(\d+(?:\.\d+)?)\s*(?:"|″|'')?)?$/.exec(s);
    if (c && +c[2] < 60 && (!c[3] || +c[3] < 60)) return +c[1] + +c[2] / 60 + (c[3] ? +c[3] / 3600 : 0);
    const m = /^(\d+(?:\.\d+)?)\s*(?:°|град)?\s*(?:(\d+(?:\.\d+)?)\s*['′’]?)?\s*(?:(\d+(?:\.\d+)?)\s*(?:"|″|''))?$/.exec(s);
    if (!m) return NaN;
    return +m[1] + (m[2] ? +m[2] / 60 : 0) + (m[3] ? +m[3] / 3600 : 0);
  }

  const PROF = {
    rect: { name: 'Труба профильная', dims: ['A', 'B', 't'], hint: 'A — сторона, видимая на виде с углом торца' },
    round: { name: 'Труба круглая', dims: ['D', 't'] },
    angle: { name: 'Уголок', dims: ['A', 'B', 't'] },
    channel: { name: 'Швеллер', dims: ['H', 'B', 't'] },
  };

  function autoR(p) { const t = num(p.t) || 0; return Math.min(2 * t, Math.min(num(p.a), num(p.b)) / 2 - 0.01); }

  function profileLabel(p) {
    if (!p) return '';
    const a = num(p.a), b = num(p.b), t = num(p.t);
    const T = isFinite(t) && t > 0 ? '×' + fmtN(t) : '';
    if (p.type === 'round') return isFinite(a) ? 'Труба Ø' + fmtN(a) + T : '';
    if (!isFinite(a) || !isFinite(b)) return '';
    const hi = Math.max(a, b), lo = Math.min(a, b);
    if (p.type === 'rect') return 'Труба ' + fmtN(hi) + '×' + fmtN(lo) + T;
    if (p.type === 'angle') return 'Уголок ' + fmtN(hi) + '×' + fmtN(lo) + T;
    if (p.type === 'channel') return 'Швеллер ' + fmtN(a) + '×' + fmtN(b) + T;
    return '';
  }

  // outer cutting path of the section; u = direction visible in the view (stretched by 1/sin), w = depth
  function sectionPath(p, side) {
    const a = num(p.a), b = num(p.b);
    const pts = [];
    const arc = (cu, cw, r, a0, a1) => { const n = Math.max(16, Math.round(Math.abs(a1 - a0) / (Math.PI / 2) * 360)); for (let i = 0; i <= n; i++) { const t = a0 + (a1 - a0) * i / n; pts.push([cu + r * Math.cos(t), cw + r * Math.sin(t)]); } };
    if (p.type === 'round') { arc(0, 0, a / 2, 0, 2 * Math.PI); return pts; }
    // dims in view: U along u, Wd along w
    if (p.type === 'rect') {
      const U = side === 'b' ? b : a, Wd = side === 'b' ? a : b;
      let r = isFinite(num(p.r)) && num(p.r) >= 0 ? num(p.r) : autoR(p); r = Math.max(0, Math.min(r, Math.min(U, Wd) / 2));
      arc(U - r, Wd - r, r, 0, Math.PI / 2); arc(r, Wd - r, r, Math.PI / 2, Math.PI);
      arc(r, r, r, Math.PI, 1.5 * Math.PI); arc(U - r, r, r, 1.5 * Math.PI, 2 * Math.PI); pts.push(pts[0]);
      return pts;
    }
    if (p.type === 'angle') { // leg A in view (along u), leg B along depth
      const A = side === 'b' ? b : a, B = side === 'b' ? a : b;
      return [[A, 0], [0, 0], [0, B]];
    }
    if (p.type === 'channel') { // side 'a' = web visible
      const H = a, B = b;
      return side === 'b' ? [[B, 0], [0, 0], [0, H], [B, H]] : [[0, B], [0, 0], [H, 0], [H, B]];
    }
    return pts;
  }

  function endCutLen(p, angDeg, side) {
    const ang = parseAngle(angDeg); const s = Math.abs(Math.sin((isFinite(ang) ? ang : 90) * Math.PI / 180)) || 1;
    const P = sectionPath(p, side);
    let L = 0; for (let i = 1; i < P.length; i++) L += Math.hypot((P[i][0] - P[i - 1][0]) / s, P[i][1] - P[i - 1][1]);
    return L;
  }

  function validate(part) {
    const p = part.prof || {}; const miss = [];
    if (!p.type) miss.push('профиль');
    const dims = p.type ? PROF[p.type].dims : [];
    if (dims.includes('A') || dims.includes('H') || dims.includes('D')) { if (!(num(p.a) > 0)) miss.push('размер ' + dims[0]); }
    if (dims.length === 3 && !(num(p.b) > 0)) miss.push('размер ' + dims[1]);
    if (p.type && !(num(p.t) > 0)) miss.push('толщина стенки t');
    if (!(num(part.L) > 0)) miss.push('длина');
    return miss;
  }

  // returns same shape as XTCut.analyze(): contours + metadata
  function manualAnalyze(part) {
    const p = part.prof, contours = [];
    (part.ends || []).forEach((e, i) => {
      if (e && e.off) return;
      let ang = e ? parseAngle(e.ang) : 90; if (e && e.ref === 'face' && isFinite(ang)) ang = 90 - ang;
      contours.push({ isEnd: true, label: 'Торец', key: 'Торец', len: endCutLen(p, ang, e ? e.side : 'a'), ang });
    });
    for (const h of part.holes || []) {
      const n = Math.round(num(h.n)), d = num(h.d);
      if (n > 0 && d > 0) for (let i = 0; i < n; i++) contours.push({ isEnd: false, label: 'Отверстие Ø' + fmtN(d), key: 'Отверстие Ø' + fmtN(d), len: Math.PI * d });
    }
    for (const s of part.slots || []) {
      const n = Math.round(num(s.n)), l = num(s.l), w = num(s.w);
      if (n > 0 && l > 0 && w > 0) { const L = 2 * Math.max(0, l - w) + Math.PI * Math.min(w, l); for (let i = 0; i < n; i++) contours.push({ isEnd: false, label: 'Паз ' + fmtN(l) + '×' + fmtN(w), key: 'Паз ' + fmtN(l) + '×' + fmtN(w), len: L }); }
    }
    const ex = num(part.extra), exN = Math.max(0, Math.round(num(part.extraN) || 0));
    if (ex > 0) contours.push({ isEnd: false, label: 'Доп. рез', key: 'Доп. рез', len: ex, pierces: exN });
    return { length: num(part.L), profile: profileLabel(p), contours, warnings: [] };
  }

  // like XTCut.summarize but counts custom pierces for extra cut
  function summarize(res, mode) {
    const ends = res.contours.filter(c => c.isEnd).sort((a, b) => b.len - a.len);
    const keepN = mode === 'none' ? 0 : mode === 'one' ? Math.min(1, ends.length) : ends.length;
    const kept = ends.slice(0, keepN), others = res.contours.filter(c => !c.isEnd);
    const endsLen = kept.reduce((s, c) => s + c.len, 0), otherLen = others.reduce((s, c) => s + c.len, 0);
    const groups = new Map();
    for (const c of others) { const g = groups.get(c.key) || { label: c.label, n: 0, len: 0 }; g.n++; g.len += c.len; groups.set(c.key, g); }
    const pier = keepN + others.reduce((s, c) => s + (c.pierces !== undefined ? c.pierces : 1), 0);
    return { total: endsLen + otherLen, endsLen, nEndsKept: keepN, nEndsFound: ends.length, endLens: ends.map(c => c.len), otherLen, pierces: pier, groups: [...groups.values()] };
  }

  // ---------- drawing text -> proposal ----------
  const GOST_TYPE = { '8639': 'rect', '8645': 'rect', '30245': 'rect', '32931': 'rect', '8509': 'angle', '8510': 'angle', '8240': 'channel', '8732': 'round', '8734': 'round', '10704': 'round', '3262': 'round', '10705': 'round' };
  function parseDrawing(items) {
    const strs = items.map(s => String(s).trim()).filter(Boolean);
    const text = strs.join(' ');
    const out = { prof: null, L: null, holes: [], angles: [], name: '' };
    const des = /(?:[А-ЯЁA-Z]{2,6}\s?[.\s]?\s?)?\d{3,5}(?:\.\d{2,3}){1,3}(?:-\d{2,3}(?:\.\d{2,3}){1,3})?(?:-\d{2})?/.exec(text);
    if (des) out.name = des[0].replace(/\s+/g, '');
    const nm = '(\\d+(?:[.,]\\d+)?)', x = '\\s*[хxХX×*]\\s*';
    const re = new RegExp('(Труба|Профиль|Уголок|Швеллер)?[^0-9]{0,30}?([ØФ⌀]\\s*)?' + nm + x + nm + '(?:' + x + nm + ')?\\s*(?:мм\\s*)?(?:ГОСТ|ТУ|СТБ)\\s*(?:Р\\s*)?(\\d+)', 'i');
    const m = re.exec(text);
    if (m) {
      const kw = (m[1] || '').toLowerCase(); const g = GOST_TYPE[m[6]] || '';
      let type = kw.startsWith('уголок') ? 'angle' : kw.startsWith('швеллер') ? 'channel' : g || (m[5] ? 'rect' : 'round');
      if (m[2] || (!m[5] && type !== 'angle')) type = 'round';
      if (type === 'round') out.prof = { type, a: num(m[3]), b: '', t: num(m[5] || m[4]) };
      else out.prof = { type, a: num(m[3]), b: num(m[4]), t: num(m[5]) };
    }
    const pure = strs.map(s => /^(\d{2,5}(?:[.,]\d+)?)\s*\*?(?:\s*[-+±]\s*\d+(?:[.,]\d+)?)?$/.exec(s)).filter(Boolean).map(r => num(r[1])).filter(v => v >= 20 && v <= 13000);
    if (pure.length) out.L = Math.max(...pure);
    const hm = new Map();
    for (let i = 0; i < strs.length; i++) {
      const r = /(\d+)\s*отв/i.exec(strs[i]); if (!r) continue;
      const n = +r[1]; let d = null;
      const dm = /[Ø⌀ФD]\s*(\d+(?:[.,]\d+)?)/.exec(strs[i]) || /[Ø⌀ФD]\s*(\d+(?:[.,]\d+)?)/.exec(strs[i + 1] || '');
      if (dm) d = num(dm[1]);
      else for (const j of [i - 1, i + 1]) { const s = strs[j] || ''; const q = /^[Ø⌀Ф]?\s*(\d{1,3}(?:[.,]\d+)?)$/.exec(s); if (q && num(q[1]) >= 2 && num(q[1]) <= 200) { d = num(q[1]); break; } }
      const k = d === null ? '?' : d; hm.set(k, (hm.get(k) || 0) + n);
    }
    for (const [d, n] of hm) out.holes.push({ n, d: d === '?' ? '' : d });
    const am = text.matchAll(/(\d{1,3}(?:[.,]\d+)?)\s*°\s*(?:(\d{1,2})\s*['′’])?/g);
    for (const a of am) { const v = num(a[1]) + (a[2] ? +a[2] / 60 : 0); if (v > 0 && v < 180 && v !== 90) out.angles.push(a[2] ? `${a[1]}°${a[2]}'` : String(a[1]).replace('.', ',')); }
    return out;
  }

  // ---------- 1D nesting (best-fit decreasing) ----------
  function nest(pieces, S, kerf, trimStart, trimEnd) {
    const U = S - trimStart - trimEnd;
    const too = pieces.filter(p => p.len > U);
    const list = pieces.filter(p => p.len <= U).sort((a, b) => b.len - a.len);
    const run = strategy => {
      const bars = [];
      for (const p of list) {
        let best = null, bestRest = Infinity;
        for (const b of bars) {
          const need = p.len + (b.cuts.length ? kerf : 0), rest = U - b.used - need;
          if (rest >= -1e-9) { if (strategy === 'ff') { best = b; break; } if (rest < bestRest) { bestRest = rest; best = b; } }
        }
        if (!best) { best = { cuts: [], used: 0 }; bars.push(best); }
        best.used += p.len + (best.cuts.length ? kerf : 0); best.cuts.push(p);
      }
      return bars;
    };
    const A = run('bf'), B = run('ff');
    const score = bs => bs.length * 1e9 - Math.max(0, ...bs.map(b => U - b.used));
    const bars = score(B) < score(A) ? B : A;
    for (const b of bars) b.rest = U - b.used;
    // group identical bars
    const groups = new Map();
    for (const b of bars) {
      const key = b.cuts.map(c => c.key + ':' + c.len).join('|');
      const g = groups.get(key) || { cuts: b.cuts, used: b.used, rest: b.rest, n: 0 }; g.n++; groups.set(key, g);
    }
    const partsLen = list.reduce((s, p) => s + p.len, 0);
    return { bars: bars.length, patterns: [...groups.values()].sort((a, b) => b.n - a.n || a.rest - b.rest), partsLen, total: bars.length * S, too, U };
  }

  // ---------- part shape for nesting ----------
  // Corners k = i*2+j : i = low/high along A, j = low/high along B.
  // lo[k] / ro[k] = axial position of the left / right end at that corner (min lo = 0, max ro = L).
  function endAngleToAxis(e) { let a = parseAngle(e && e.ang); if (!isFinite(a) || a <= 0 || a >= 180) a = 90; if (e && e.ref === 'face') a = 90 - a; if (a > 90) a = 180 - a; return Math.max(1, Math.min(90, a)); }
  function sectionDims(p) {
    const a = num(p.a), b = num(p.b);
    if (p.type === 'round') return { A: a, B: a };
    return { A: a, B: b };
  }
  function symKind(p) {
    const { A, B } = sectionDims(p), eq = Math.abs(A - B) < 1e-6;
    if (p.type === 'round') return 'square';
    if (p.type === 'rect') return eq ? 'square' : 'rect';
    if (p.type === 'angle') return eq ? 'angleEq' : 'angle';
    if (p.type === 'channel') return 'channel';
    return 'none';
  }
  function manualShape(part) {
    const p = part.prof, L = num(part.L), { A, B } = sectionDims(p);
    const ends = part.ends || [{}, {}];
    const geo = ends.slice(0, 2).map((e, idx) => {
      const ang = endAngleToAxis(e), side = (e && e.side) === 'b' ? 'b' : 'a';
      const H = p.type === 'round' ? A : side === 'b' ? B : A;
      const d = ang >= 89.999 ? 0 : H / Math.tan(ang * Math.PI / 180);
      let tip = 'low'; if (idx === 1 && part.shape === 'para') tip = 'high';
      return { ang, side: p.type === 'round' ? 'a' : side, d, tip };
    });
    while (geo.length < 2) geo.push({ ang: 90, side: 'a', d: 0, tip: 'low' });
    const lo = [], ro = [];
    for (let k = 0; k < 4; k++) {
      const i = k >> 1, j = k & 1;
      const t0 = geo[0].side === 'b' ? j : i, t1 = geo[1].side === 'b' ? j : i;
      lo[k] = geo[0].d * (geo[0].tip === 'low' ? t0 : 1 - t0);
      ro[k] = L - geo[1].d * (geo[1].tip === 'low' ? t1 : 1 - t1);
    }
    const bad = geo[0].d + geo[1].d > L + 1e-6 && part.shape !== 'para';
    return { L, A, B, sym: symKind(p), lo, ro, angL: geo[0].ang, angR: geo[1].ang, bad };
  }
  const OPS = (() => {
    const id = k => k, fi = k => ((1 - (k >> 1)) << 1) | (k & 1), fj = k => (k & 2) | (1 - (k & 1)), sw = k => ((k & 1) << 1) | (k >> 1);
    const c = (f, g) => k => f(g(k));
    return {
      none: [[1, id]],
      rect: [[1, id], [1, c(fi, fj)], [-1, fi], [-1, fj]],
      square: [[1, id], [1, c(fi, fj)], [1, c(sw, fi)], [1, c(sw, fj)], [-1, fi], [-1, fj], [-1, sw], [-1, c(sw, c(fi, fj))]],
      angleEq: [[1, id], [-1, sw]],
      angle: [[1, id]],
      channel: [[1, id], [-1, fi]],
    };
  })();
  function orientations(g) {
    const out = [], seen = new Set();
    if (g.sym === 'path') { // открытый профиль: точки вдоль полок; разворот концами = обход точек в обратном порядке
      out.push({ lo: g.lo.slice(), ro: g.ro.slice(), angL: g.angL, angR: g.angR, flip: false, op: 0 });
      if (g.symmetric) { const n = g.lo.length; const lo = [], ro = []; for (let k = 0; k < n; k++) { lo[k] = g.L - g.ro[n - 1 - k]; ro[k] = g.L - g.lo[n - 1 - k]; }
        const key = lo.map(v => v.toFixed(2)).join(',') + '|' + ro.map(v => v.toFixed(2)).join(',');
        if (key !== g.lo.map(v => v.toFixed(2)).join(',') + '|' + g.ro.map(v => v.toFixed(2)).join(',')) out.push({ lo, ro, angL: g.angR, angR: g.angL, flip: true, op: 1 }); }
      return out;
    }
    for (const [sx, m] of OPS[g.sym] || OPS.none) {
      const lo = [], ro = [];
      for (let k = 0; k < 4; k++) {
        if (sx > 0) { lo[m(k)] = g.lo[k]; ro[m(k)] = g.ro[k]; }
        else { lo[m(k)] = g.L - g.ro[k]; ro[m(k)] = g.L - g.lo[k]; }
      }
      const key = lo.map(v => v.toFixed(2)).join(',') + '|' + ro.map(v => v.toFixed(2)).join(',');
      if (seen.has(key)) continue; seen.add(key);
      out.push({ lo, ro, angL: sx > 0 ? g.angL : g.angR, angR: sx > 0 ? g.angR : g.angL, flip: sx < 0, op: out.length });
    }
    return out;
  }

  // ---------- nesting with skew-aware placement ----------
  // pieces: [{key, name, g (shape)}]; returns same structure as nest() plus placements
  // kerf — расстояние между деталями; sharedKerf — ширина одного реза, когда соседние детали делят общий косой рез
  const SHARED_MAX_GAP = 5;
  function nestShapes(pieces, S, kerf, trimStart, trimEnd, sharedKerf) {
    const sk = isFinite(sharedKerf) && sharedKerf >= 0 ? Math.min(sharedKerf, kerf) : Math.min(0.3, kerf);
    const end = S - trimEnd;
    const too = pieces.filter(p => p.g.L > end - trimStart + 1e-6);
    const list = pieces.filter(p => !(p.g.L > end - trimStart + 1e-6)).map(p => Object.assign({}, p, { ors: orientations(p.g) }));
    const place = (bar, p, look = true) => { // best orientation appended at bar end
      let best = null;
      for (const o of p.ors) {
        let s, shared = false;
        if (!bar.items.length) s = trimStart;
        else {
          const last = bar.items[bar.items.length - 1];
          if (o.lo.length !== last.o.ro.length) { s = last.s + Math.max(...last.o.ro) + kerf - Math.min(...o.lo); }
          else {
            const K = o.lo.map((_, k) => k);
            const diffs = K.map(k => o.lo[k] - last.o.ro[k]);
            const spread = Math.max(...diffs) - Math.min(...diffs);
            // общий рез: торцы совпадают по форме (скос, ступенька), а не просто прямые
            const flat = v => Math.max(...v) - Math.min(...v) < 0.05;
            // при большом заданном зазоре (больше обычного, > 5 мм) общий рез не делаем — зазор соблюдается всегда
            shared = kerf <= SHARED_MAX_GAP && spread < 0.05 && !(flat(last.o.ro) && Math.abs(last.o.angR - 90) <= 0.01);
            const sinA = Math.sin(Math.min(last.o.angR, o.angL) * Math.PI / 180) || 1;
            const gap = shared ? sk / Math.max(0.3, sinA) : kerf;
            s = Math.max(...K.map(k => last.s + last.o.ro[k] + gap - o.lo[k]));
          }
        }
        const e = s + Math.max(...o.ro);
        if (e > end + 1e-6) continue;
        // look one step ahead: how well does another copy of the same part follow?
        let ahead = e + p.g.L;
        if (look) { const nx = place({ items: bar.items.concat([{ p, s, o, shared }]) }, p, false); if (nx) ahead = nx.e; }
        const sc = ahead + (shared ? -0.01 : 0);
        if (!best || sc < best.sc - 1e-6 || (Math.abs(sc - best.sc) <= 1e-6 && e < best.e)) best = { s, e, o, shared, sc };
      }
      return best;
    };
    const run = (order, strategy) => {
      const bars = [];
      for (const p of order) {
        let pick = null, pickBar = null;
        for (const b of bars) {
          const r = place(b, p); if (!r) continue;
          if (strategy === 'ff') { pick = r; pickBar = b; break; }
          const rest = end - r.e;
          if (!pick || rest < end - pick.e) { pick = r; pickBar = b; }
        }
        if (!pick) { pickBar = { items: [], end: trimStart }; bars.push(pickBar); pick = place(pickBar, p); }
        pickBar.items.push({ p, s: pick.s, o: pick.o, shared: pick.shared }); pickBar.end = Math.max(pickBar.end, pick.e);
      }
      return bars;
    };
    const byLen = list.slice().sort((a, b) => b.g.L - a.g.L || String(a.key).localeCompare(String(b.key)));
    const cands = [run(byLen, 'bf'), run(byLen, 'ff')];
    const score = bs => bs.length * 1e9 - Math.max(0, ...bs.map(b => end - b.end));
    const bars = cands.sort((a, b) => score(a) - score(b))[0];
    const groups = new Map();
    for (const b of bars) {
      b.rest = end - b.end;
      const key = b.items.map(it => it.p.key + ':' + it.o.op + ':' + it.s.toFixed(1)).join('|');
      const g = groups.get(key) || { items: b.items, rest: b.rest, end: b.end, n: 0 }; g.n++; groups.set(key, g);
    }
    const partsLen = list.reduce((s, p) => s + p.g.L, 0);
    const sharedCuts = bars.reduce((s, b) => s + b.items.filter(it => it.shared).length, 0);
    return { bars: bars.length, patterns: [...groups.values()].sort((a, b) => b.n - a.n || a.rest - b.rest).map(g => Object.assign(g, { S })), partsLen, total: bars.length * S, too, U: end - trimStart, sharedCuts };
  }

  // раскладка с деловыми отходами (трубы заказчика): сначала заполняем отходы, остальное — на целые хлысты
  // stock: [{L, n}] — длина отрезка и сколько их
  function nestWithStock(pieces, S, kerf, trimStart, trimEnd, stock, sharedKerf) {
    const P = pieces.map((p, i) => Object.assign({}, p, { _u: i }));
    let rest = P;
    const units = [];
    for (const s of stock || []) { const L = num(s.L), n = Math.max(0, Math.round(num(s.n) || 0)); if (L > 0) for (let k = 0; k < n; k++) units.push(L); }
    units.sort((a, b) => b - a);
    const usedP = [], unused = [];
    let shared = 0;
    for (const L of units) {
      if (!rest.length) { unused.push(L); continue; }
      const R = nestShapes(rest, L, kerf, trimStart, trimEnd, sharedKerf);
      if (!R.patterns.length) { unused.push(L); continue; }
      // самый заполненный отрезок
      const pt = R.patterns.slice().sort((a, b) => a.rest - b.rest || b.items.length - a.items.length)[0];
      const taken = new Set(pt.items.map(it => it.p._u));
      rest = rest.filter(p => !taken.has(p._u));
      shared += pt.items.filter(it => it.shared).length;
      // одинаковые отрезки с одинаковой схемой — вместе
      const key = L + '#' + pt.items.map(it => it.p.key + ':' + it.o.op + ':' + it.s.toFixed(1)).join('|');
      const same = usedP.find(u => u._key === key);
      if (same) same.n++; else usedP.push({ _key: key, items: pt.items, rest: pt.rest, end: pt.end, n: 1, S: L, stock: true });
    }
    const R = nestShapes(rest, S, kerf, trimStart, trimEnd, sharedKerf);
    const stockLen = usedP.reduce((s, u) => s + u.S * u.n, 0);
    return {
      bars: R.bars, stockBars: usedP.reduce((s, u) => s + u.n, 0), stockLen, unused,
      patterns: usedP.concat(R.patterns),
      partsLen: P.filter(p => !R.too.some(t => t._u === p._u)).reduce((s, p) => s + p.g.L, 0),
      total: R.total + stockLen, too: R.too, U: R.U, sharedCuts: R.sharedCuts + shared
    };
  }

  // section area, mm² (for mass estimate, steel 7850 kg/m³)
  function sectionArea(p) {
    const a = num(p.a), b = num(p.b), t = num(p.t);
    if (!(a > 0) || !(t > 0)) return NaN;
    if (p.type === 'round') return Math.PI / 4 * (a * a - Math.pow(Math.max(0, a - 2 * t), 2));
    if (!(b > 0)) return NaN;
    if (p.type === 'rect') {
      let R = isFinite(num(p.r)) && num(p.r) >= 0 ? num(p.r) : 2 * t; R = Math.min(R, Math.min(a, b) / 2); const r = Math.max(0, R - t);
      return a * b - (a - 2 * t) * (b - 2 * t) - (4 - Math.PI) * (R * R - r * r);
    }
    if (p.type === 'angle') return t * (a + b - t);
    if (p.type === 'channel') return t * (a + 2 * b - 2 * t);
    return NaN;
  }
  const kgPerM = p => sectionArea(p) * 7850 / 1e6;
  // периметр сечения под покрытие, мм: наружный и полный (снаружи + внутри + кромки)
  function coatPerim(p) {
    const a = num(p.a), b = num(p.b), t = num(p.t);
    if (!(a > 0)) return null;
    if (p.type === 'round') { const o = Math.PI * a; return { outer: o, full: t > 0 ? o + Math.PI * Math.max(0, a - 2 * t) : NaN }; }
    if (!(b > 0)) return null;
    if (p.type === 'rect') {
      let R = isFinite(num(p.r)) && num(p.r) >= 0 ? num(p.r) : 2 * (t || 0); R = Math.min(R, Math.min(a, b) / 2); const r = Math.max(0, R - (t || 0));
      const o = 2 * (a + b) - (8 - 2 * Math.PI) * R;
      return { outer: o, full: t > 0 ? o + 2 * (a - 2 * t + b - 2 * t) - (8 - 2 * Math.PI) * r : NaN };
    }
    if (p.type === 'angle') return { outer: a + b, full: 2 * (a + b) }; // снаружи a+b, внутри (a−t)+(b−t), кромки 2t
    if (p.type === 'channel') return { outer: a + 2 * b, full: t > 0 ? 2 * (a + 2 * b) - 2 * t : NaN };
    return null;
  }

  root.Calc = { num, fmtN, parseAngle, PROF, autoR, profileLabel, endCutLen, manualAnalyze, summarize, validate, parseDrawing, nest, manualShape, orientations, nestShapes, nestWithStock, sectionArea, kgPerM, coatPerim, endAngleToAxis };
  if (typeof module !== 'undefined') module.exports = root.Calc;
})(typeof window !== 'undefined' ? window : globalThis);
