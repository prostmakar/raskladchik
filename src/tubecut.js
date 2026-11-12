// ===== Раскрой труб в 3D: детали из IGES/STEP раскладываются по хлыстам — один файл на хлыст =====
// Геометрия не пересчитывается: исходные сущности копируются как есть, меняются только координаты (поворот + сдвиг).
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- матрицы 3×4 (строки: [r00 r01 r02 t0, r10 ..., r20 ...])
  const I3 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  function compose(A, B) { // A∘B
    const r = [];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) r[i * 4 + j] = A[i * 4] * B[j] + A[i * 4 + 1] * B[4 + j] + A[i * 4 + 2] * B[8 + j];
      r[i * 4 + 3] = A[i * 4] * B[3] + A[i * 4 + 1] * B[7] + A[i * 4 + 2] * B[11] + A[i * 4 + 3];
    }
    return r;
  }
  const apP = (M, p) => [M[0] * p[0] + M[1] * p[1] + M[2] * p[2] + M[3], M[4] * p[0] + M[5] * p[1] + M[6] * p[2] + M[7], M[8] * p[0] + M[9] * p[1] + M[10] * p[2] + M[11]];
  const apV = (M, v) => [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[4] * v[0] + M[5] * v[1] + M[6] * v[2], M[8] * v[0] + M[9] * v[1] + M[10] * v[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const scaleM = (M, s) => [M[0] * s, M[1] * s, M[2] * s, M[3], M[4] * s, M[5] * s, M[6] * s, M[7], M[8] * s, M[9] * s, M[10] * s, M[11]];

  // мир детали (мм) → хлыст (мм): X вдоль хлыста от его начала, Y/Z — сечение, ось трубы по центру габарита
  // fr — система координат из анализа, g — форма, o — разворот из раскладки, s — где начинается деталь
  function barMatrix(fr, g, o, s) {
    const map = root.Calc.orientMap(g, o, fr.box, fr.C || 0);
    const cc = [(fr.box[0] + fr.box[1]) / 2, (fr.box[2] + fr.box[3]) / 2];
    const f = p => { const q = map(dot(p, fr.ax) - fr.x0, dot(p, fr.e1) - fr.a0, dot(p, fr.e2) - fr.b0); return [s + q[0], q[1] - cc[0], q[2] - cc[1]]; };
    const t = f([0, 0, 0]), X = f([1, 0, 0]), Y = f([0, 1, 0]), Z = f([0, 0, 1]);
    const c = (v, i) => v[i] - t[i];
    return [c(X, 0), c(Y, 0), c(Z, 0), t[0], c(X, 1), c(Y, 1), c(Z, 1), t[1], c(X, 2), c(Y, 2), c(Z, 2), t[2]];
  }

  // ---------------------------------------------------------------- IGES
  const latin = b => { let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return s; };
  const toBytes = s => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; };
  // много строк → байты, кусками (одна строка на сотни мегабайт не помещается в память браузера)
  function linesToBytes(lines, sep) {
    const parts = []; let cur = [], len = 0, total = 0;
    const flush = () => { if (!cur.length) return; const b = toBytes(cur.join('')); parts.push(b); total += b.length; cur = []; len = 0; };
    for (const l of lines) { cur.push(l, sep); len += l.length + sep.length; if (len > 4e6) flush(); }
    flush();
    const out = new Uint8Array(total); let o = 0; for (const b of parts) { out.set(b, o); o += b.length; }
    return out;
  }
  const ival = t => { const x = parseFloat(String(t || '').replace(/[dD]/, 'e')); return isFinite(x) ? Math.round(x) : 0; };
  const rval = t => { const x = parseFloat(String(t || '').replace(/[dD]/, 'e')); return isFinite(x) ? x : 0; };
  // параметры как есть (строки Hollerith целиком), [0] — номер типа
  function rawParams(str, pd, rd) {
    const out = []; let i = 0; const n = str.length;
    while (i < n) {
      let j = i; while (j < n && str[j] === ' ') j++;
      let k = j; while (k < n && str[k] >= '0' && str[k] <= '9') k++;
      if (k > j && str[k] === 'H') { const len = +str.slice(j, k); const e = k + 1 + len; out.push(str.slice(j, e)); i = e; while (i < n && str[i] === ' ') i++; if (i >= n || str[i] === rd) return out; i++; continue; }
      let e = i; while (e < n && str[e] !== pd && str[e] !== rd) e++;
      out.push(str.slice(i, e).trim()); if (e >= n || str[e] === rd) return out; i = e + 1;
    }
    return out;
  }
  function readRaw(bytes) {
    const text = latin(bytes); const lines = text.split(/\r\n|\n|\r/);
    let G = ''; const D = []; const P = new Map();
    for (const raw of lines) {
      if (raw.length < 73) continue; const sec = raw[72];
      if (sec === 'G') G += raw.slice(0, 72);
      else if (sec === 'D') D.push(raw.slice(0, 72));
      else if (sec === 'P') { const de = parseInt(raw.slice(64, 72), 10); if (!P.has(de)) P.set(de, []); P.get(de).push(raw.slice(0, 64)); }
    }
    if (!D.length) throw new Error('это не IGES');
    let pd = ',', rd = ';'; const g0 = G.trimStart(); if (/^1H./.test(g0)) pd = g0[2];
    const gp = rawParams(G, pd, rd); if (/^1H.$/.test(gp[1] || '')) rd = gp[1][2];
    const gq = rawParams(G, pd, rd);
    const unitFlag = ival(gq[13]) || 2;
    const UNIT = { 1: 25.4, 2: 1, 3: 1, 4: 304.8, 5: 1609344, 6: 1000, 7: 1e6, 8: 0.0254, 9: 0.001, 10: 10, 11: 0.0000254 };
    let scale = UNIT[unitFlag] || 1;
    if (unitFlag === 3 && gq[14]) { const u = gq[14].replace(/^\d+H/, '').toUpperCase(); scale = { IN: 25.4, INCH: 25.4, FT: 304.8, MM: 1, M: 1000, CM: 10 }[u] || 1; }
    const ents = new Map();
    for (let k = 0; k + 1 < D.length; k += 2) {
      const f1 = [], f2 = []; for (let i = 0; i < 9; i++) { f1.push(D[k].slice(i * 8, i * 8 + 8)); f2.push(D[k + 1].slice(i * 8, i * 8 + 8)); }
      const de = k + 1; const type = ival(f1[0]);
      const pl = P.get(de); const toks = pl ? rawParams(pl.join(''), pd, rd) : [String(type)];
      ents.set(de, { de, type, form: ival(f2[4]), f1, f2, xf: ival(f1[6]), status: f1[8], toks });
    }
    return { ents, scale };
  }
  // где в параметрах ссылки на другие сущности и где кончаются «свои» параметры
  function layout(e) {
    const t = e.toks, I = k => ival(t[k]), ptr = [];
    const range = (a, b) => { for (let k = a; k < b; k++) ptr.push(k); };
    let end;
    switch (e.type) {
      case 100: end = 8; break;
      case 102: end = 2 + I(1); range(2, end); break;
      case 104: end = 12; break;
      case 106: { const ip = I(1), n = I(2); end = 3 + (ip === 1 ? 1 + 2 * n : ip === 2 ? 3 * n : 6 * n); break; }
      case 108: end = 10; ptr.push(5); break;
      case 110: end = 7; break;
      case 116: end = Math.min(t.length, 5); if (t.length > 4) ptr.push(4); break;
      case 118: end = 5; ptr.push(1, 2); break;
      case 120: end = 5; ptr.push(1, 2); break;
      case 122: end = 5; ptr.push(1); break;
      case 123: end = 4; break;
      case 124: end = 13; break;
      case 126: { const K = I(1), M = I(2); end = 7 + (K + M + 2) + (K + 1) * 4 + 2 + 3; break; }
      case 128: { const K1 = I(1), K2 = I(2), M1 = I(3), M2 = I(4), W = (K1 + 1) * (K2 + 1); end = 10 + (K1 + M1 + 2) + (K2 + M2 + 2) + 4 * W + 4; break; }
      case 141: { const n = I(4); let k = 5; ptr.push(3); for (let i = 0; i < n; i++) { ptr.push(k); const K = I(k + 2); range(k + 3, k + 3 + K); k += 3 + K; } end = k; break; }
      case 142: end = 6; ptr.push(2, 3, 4); break;
      case 143: end = 4 + I(3); ptr.push(2); range(4, end); break;
      case 144: end = 5 + I(3); ptr.push(1, 4); range(5, end); break;
      case 186: { const n = I(3); end = 4 + 2 * n; ptr.push(1); for (let i = 0; i < n; i++) ptr.push(4 + 2 * i); break; }
      case 190: end = e.form === 1 ? 4 : 3; ptr.push(1, 2); if (e.form === 1) ptr.push(3); break;
      case 192: end = e.form === 1 ? 5 : 4; ptr.push(1, 2); if (e.form === 1) ptr.push(4); break;
      case 194: end = e.form === 1 ? 6 : 5; ptr.push(1, 2); if (e.form === 1) ptr.push(5); break;
      case 196: end = e.form === 1 ? 5 : 3; ptr.push(1); if (e.form === 1) ptr.push(3, 4); break;
      case 198: end = e.form === 1 ? 6 : 5; ptr.push(1, 2); if (e.form === 1) ptr.push(5); break;
      case 308: end = 4 + I(3); range(4, end); break;
      case 314: end = Math.min(t.length, 5); break;
      case 402: end = 2 + I(1); range(2, end); break;
      case 406: end = 2 + I(1); break;
      case 408: end = 6; ptr.push(1); break;
      case 502: end = 2 + 3 * I(1); break;
      case 504: { const n = I(1); end = 2 + 5 * n; for (let i = 0; i < n; i++) ptr.push(2 + 5 * i, 3 + 5 * i, 5 + 5 * i); break; }
      case 508: { const n = I(1); let k = 2; for (let i = 0; i < n; i++) { ptr.push(k + 1); const K = I(k + 4); for (let j = 0; j < K; j++) ptr.push(k + 6 + 2 * j); k += 5 + 2 * K; } end = k; break; }
      case 510: end = 4 + I(2); ptr.push(1); range(4, end); break;
      case 514: { const n = I(1); end = 2 + 2 * n; for (let i = 0; i < n; i++) ptr.push(2 + 2 * i); break; }
      default: return null;
    }
    // хвост: ссылки на ассоциации и свойства
    if (t.length > end) { const nv = I(end); range(end + 1, end + 1 + nv); const k = end + 1 + nv; if (t.length > k) { const np = I(k); range(k + 1, k + 1 + np); } }
    return { ptr, end };
  }
  const DROP = new Set([202, 206, 208, 210, 212, 214, 216, 218, 220, 222, 228, 230, 304, 404, 410, 312, 320]); // размеры, надписи, виды — на раскрое не нужны
  const COORD_XF = new Set([100, 104]); // заданы в своей плоскости — сдвигаются только через матрицу 124
  // одна деталь → список сущностей с уже применённым положением M (мм детали → мм хлыста)
  function placeIGES(doc, M) {
    const { ents, scale } = doc; const Q = scaleM(M, scale);
    for (const e of ents.values()) {
      if (DROP.has(e.type)) { e.drop = true; continue; }
      e.lay = layout(e);
      if (!e.lay) throw new Error('сущность IGES типа ' + e.type + ' пока не поддерживается');
    }
    // кривые в параметрах поверхности (2D) не двигаем
    const param = new Set(); const mark = de => { const e = ents.get(de); if (!e || param.has(de)) return; param.add(de); if (e.type === 102) for (const k of e.lay.ptr) mark(ival(e.toks[k])); };
    for (const e of ents.values()) {
      if (e.drop) continue; const t = e.toks, I = k => ival(t[k]);
      if (e.type === 508) { const n = I(1); let k = 2; for (let i = 0; i < n; i++) { const K = I(k + 4); for (let j = 0; j < K; j++) mark(I(k + 6 + 2 * j)); k += 5 + 2 * K; } }
      if (e.type === 142) mark(I(3));
      if (e.type === 141) { const n = I(4); let k = 5; for (let i = 0; i < n; i++) { const K = I(k + 2); for (let j = 0; j < K; j++) mark(I(k + 3 + j)); k += 3 + K; } }
    }
    const chain = (de, d = 0) => { const t = ents.get(de); if (!t || t.type !== 124 || d > 20) return I3; const m = t.toks.slice(1, 13).map(rval); return t.xf ? compose(chain(t.xf, d + 1), m) : m; };
    const newXf = []; // новые матрицы 124 (по ключу — чтобы не плодить одинаковые)
    const xfKey = new Map(); const needXf = m => { const key = m.map(v => v.toFixed(9)).join(','); if (!xfKey.has(key)) { xfKey.set(key, newXf.length); newXf.push(m); } return xfKey.get(key); };
    const num = v => { if (Math.abs(v) < 1e-12) v = 0; let s = (+v.toPrecision(15)).toString().replace('e', 'E'); if (!/[.E]/.test(s)) s += '.'; else if (/E/.test(s) && !/\./.test(s.split('E')[0])) s = s.replace('E', '.E'); return s; };
    const setP = (e, k, p) => { const q = apP(Q, p.map(rval)); e.toks[k] = num(q[0]); e.toks[k + 1] = num(q[1]); e.toks[k + 2] = num(q[2]); };
    const setV = (e, k) => { const v = apV(M, [rval(e.toks[k]), rval(e.toks[k + 1]), rval(e.toks[k + 2])]); e.toks[k] = num(v[0]); e.toks[k + 1] = num(v[1]); e.toks[k + 2] = num(v[2]); };
    const P3 = (e, k) => setP(e, k, [e.toks[k], e.toks[k + 1], e.toks[k + 2]]);
    for (const e of ents.values()) {
      if (e.drop || e.type === 124 || param.has(e.de)) continue;
      const t = e.toks, I = k => ival(t[k]);
      const coord = [100, 104, 106, 108, 110, 116, 122, 123, 126, 128, 502].includes(e.type);
      if (e.xf) {
        if (!coord) throw new Error('вложенные преобразования (124) у сущности ' + e.type + ' пока не поддерживаются');
        e.newXf = needXf(compose(Q, chain(e.xf))); continue;
      }
      if (COORD_XF.has(e.type) || (e.type === 106 && I(1) === 1)) { e.newXf = needXf(Q); continue; }
      switch (e.type) {
        case 106: { const ip = I(1), n = I(2); for (let i = 0; i < n; i++) { if (ip === 2) P3(e, 3 + 3 * i); else { P3(e, 3 + 6 * i); setV(e, 6 + 6 * i); } } break; }
        case 108: { const n0 = [rval(t[1]), rval(t[2]), rval(t[3])], n1 = apV(M, n0); const tq = [Q[3], Q[7], Q[11]]; t[1] = num(n1[0]); t[2] = num(n1[1]); t[3] = num(n1[2]); t[4] = num(rval(t[4]) * scale + dot(n1, tq)); P3(e, 6); t[9] = num(rval(t[9]) * scale); break; }
        case 110: P3(e, 1); P3(e, 4); break;
        case 116: P3(e, 1); break;
        case 122: P3(e, 2); break;
        case 123: setV(e, 1); break;
        case 126: { const K = I(1), Mm = I(2); const c0 = 7 + (K + Mm + 2) + (K + 1); for (let i = 0; i <= K; i++) P3(e, c0 + 3 * i); const nn = c0 + 3 * (K + 1) + 2; if (I(3) === 1) setV(e, nn); break; }
        case 128: { const K1 = I(1), K2 = I(2), M1 = I(3), M2 = I(4), W = (K1 + 1) * (K2 + 1); const c0 = 10 + (K1 + M1 + 2) + (K2 + M2 + 2) + W; for (let i = 0; i < W; i++) P3(e, c0 + 3 * i); break; }
        case 502: { const n = I(1); for (let i = 0; i < n; i++) P3(e, 2 + 3 * i); break; }
        case 192: case 194: case 198: t[3] = num(rval(t[3]) * scale); if (e.type === 198) t[4] = num(rval(t[4]) * scale); break;
        case 196: t[2] = num(rval(t[2]) * scale); break;
      }
    }
    return { ents, newXf, num };
  }
  const pad8 = v => { const s = String(v); return s.length >= 8 ? s.slice(-8) : ' '.repeat(8 - s.length) + s; };
  const holl = s => s.length + 'H' + s;
  // parts: [{bytes, M, name}] → текст IGES (мм)
  function buildIGES(parts, info) {
    // P пишется сразу в байты по ходу (на больших хлыстах строка целиком не помещается в память), D копится строками — он небольшой
    const line = (s, sec, n) => (s + ' '.repeat(72)).slice(0, 72) + sec + String(n).padStart(7, '0');
    const Dl = [], Pbytes = []; let pCount = 0, nEnt = 0, pBuf = [], pLen = 0;
    const pFlush = () => { if (pBuf.length) { Pbytes.push(toBytes(pBuf.join(''))); pBuf = []; pLen = 0; } };
    const emit = (f1, f2, toks) => {
      const de = 2 * nEnt + 1; nEnt++; const pstart = pCount + 1;
      const chunks = []; let cur = '';
      toks.forEach((tk, k) => { const s = tk + (k === toks.length - 1 ? ';' : ','); if (cur.length + s.length > 64) { if (cur) { chunks.push(cur); cur = ''; } let r = s; while (r.length > 64) { chunks.push(r.slice(0, 64)); r = r.slice(64); } cur = r; } else cur += s; });
      if (cur) chunks.push(cur);
      for (const c of chunks) { pCount++; pBuf.push((c + ' '.repeat(64)).slice(0, 64) + pad8(de) + 'P' + String(pCount).padStart(7, '0') + '\r\n'); pLen += 82; }
      if (pLen > 4e6) pFlush();
      f1[1] = pad8(pstart); f2[3] = pad8(chunks.length);
      Dl.push(f1.join('') + 'D' + String(de).padStart(7, '0'), f2.join('') + 'D' + String(de + 1).padStart(7, '0'));
    };
    for (const part of parts) {
      const doc = readRaw(part.bytes);
      const { ents, newXf, num } = placeIGES(doc, part.M);
      const order = [...ents.values()].filter(e => !e.drop);
      const base = nEnt; const map = new Map(); order.forEach((e, i) => map.set(e.de, 2 * (base + i) + 1));
      const xfBase = base + order.length;
      const shift = v => { v = ival(v); if (!v) return 0; const m = map.get(Math.abs(v)); return m ? (v < 0 ? -m : m) : 0; };
      for (const e of order) {
        const f1 = e.f1.slice(), f2 = e.f2.slice(), toks = e.toks;
        for (const k of e.lay.ptr) if (k < toks.length) toks[k] = String(shift(toks[k]));
        // ссылки из каталога: структура, тип линии, слой (отрицательные), вид, матрица, подпись, цвет (отрицательный)
        for (const i of [2, 3, 4]) { const v = ival(f1[i]); if (v < 0) f1[i] = pad8(shift(v)); }
        for (const i of [5, 7]) { const v = ival(f1[i]); if (v > 0) f1[i] = pad8(shift(v)); }
        { const v = ival(f2[2]); if (v < 0) f2[2] = pad8(shift(v)); }
        f1[6] = pad8(e.newXf !== undefined ? 2 * (xfBase + e.newXf) + 1 : e.xf ? shift(e.xf) : 0);
        emit(f1, f2, toks); e.toks = null;
      }
      for (const m of newXf) emit([124, 0, 0, 0, 0, 0, 0, 0, '00000000'].map(pad8), [124, 0, 0, 0, 0, '', '', 'POSITION', 0].map(pad8), ['124', ...m.map(num)]);
    }
    pFlush();
    const S = (info.comment || ['Raskladchik']).map((s, i) => line(s, 'S', i + 1));
    const d = new Date(); const ds = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '.' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0') + String(d.getSeconds()).padStart(2, '0');
    const gTok = ['1H,', '1H;', holl('Raskladchik'), holl(info.file || 'bar.igs'), holl('Raskladchik'), holl(info.ver || '1'), '32', '38', '6', '308', '15', holl('Raskladchik'), '1.', '2', '2HMM', '1', '1.', holl(ds), '0.001', '0.', '', '', '11', '0', holl(ds)];
    const G = []; { let cur = ''; for (let i = 0; i < gTok.length; i++) { const tk = gTok[i] + (i === gTok.length - 1 ? ';' : ','); if (cur.length + tk.length > 72) { G.push(cur); cur = ''; } cur += tk; } if (cur) G.push(cur); }
    const T = 'S' + String(S.length).padStart(7, '0') + 'G' + String(G.length).padStart(7, '0') + 'D' + String(Dl.length).padStart(7, '0') + 'P' + String(pCount).padStart(7, '0');
    const head = linesToBytes([...S, ...G.map((g, i) => line(g, 'G', i + 1)), ...Dl], '\r\n'), tail = toBytes(line(T, 'T', 1) + '\r\n');
    let total = head.length + tail.length; for (const b of Pbytes) total += b.length;
    const out = new Uint8Array(total); let o = 0; out.set(head, o); o += head.length; for (const b of Pbytes) { out.set(b, o); o += b.length; } out.set(tail, o);
    return out;
  }

  // ---------------------------------------------------------------- STEP
  function stepRecords(text) { // DATA → [{id, body}] (body без «#id=» и «;»)
    const di = text.search(/\bDATA\s*;/); if (di < 0) throw new Error('в STEP нет раздела DATA');
    const head = text.slice(0, di); const recs = [];
    let i = text.indexOf(';', di) + 1; const n = text.length; let start = i, q = false;
    for (; i < n; i++) {
      const c = text[i];
      if (q) { if (c === "'") { if (text[i + 1] === "'") i++; else q = false; } continue; }
      if (c === "'") { q = true; continue; }
      if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 1; continue; }
      if (c === ';') {
        const s = text.slice(start, i).trim(); start = i + 1;
        if (/^ENDSEC/.test(s)) break;
        const m = /^#(\d+)\s*=\s*([\s\S]*)$/.exec(s); if (m) recs.push({ id: +m[1], body: m[2] });
      }
    }
    return { head, recs };
  }
  function stepScale(recs) {
    for (const r of recs) {
      if (!/LENGTH_UNIT/.test(r.body)) continue;
      if (/SI_UNIT\s*\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)/.test(r.body)) return 1;
      if (/SI_UNIT\s*\(\s*\.CENTI\.\s*,\s*\.METRE\.\s*\)/.test(r.body)) return 10;
      if (/SI_UNIT\s*\(\s*\$\s*,\s*\.METRE\.\s*\)/.test(r.body)) return 1000;
      if (/INCH/i.test(r.body)) return 25.4;
      if (/FOOT|FEET/i.test(r.body)) return 304.8;
    }
    return 1;
  }
  const snum = v => { if (Math.abs(v) < 1e-12) v = 0; let s = (+v.toPrecision(15)).toString().toUpperCase(); if (!/[.E]/.test(s)) s += '.'; else if (/E/.test(s) && !/\./.test(s.split('E')[0])) s = s.replace('E', '.E'); return s; };
  // замена #N вне строк
  function renum(body, off) { let out = '', q = false; for (let i = 0; i < body.length; i++) { const c = body[i]; if (q) { out += c; if (c === "'") { if (body[i + 1] === "'") { out += "'"; i++; } else q = false; } continue; } if (c === "'") { q = true; out += c; continue; } if (c === '#') { let j = i + 1; while (j < body.length && body[j] >= '0' && body[j] <= '9') j++; out += '#' + (+body.slice(i + 1, j) + off); i = j - 1; continue; } out += c; } return out; }
  function buildSTEP(parts, info) {
    let head = null, off = 0; const lines = [];
    for (const part of parts) {
      const text = latin(part.bytes);
      const { head: h, recs } = stepRecords(text); if (!head) head = h;
      const s = stepScale(recs); const M = part.M; const t = [M[3] / s, M[7] / s, M[11] / s];
      let mx = 0;
      for (const r of recs) {
        let b = r.body;
        const m = /^(CARTESIAN_POINT|DIRECTION)\s*\(\s*('(?:[^']|'')*')\s*,\s*\(\s*([^,()]+)\s*,\s*([^,()]+)\s*,\s*([^,()]+)\s*\)\s*\)\s*$/.exec(b);
        if (m) {
          const v = [+m[3], +m[4], +m[5]];
          const w = m[1] === 'DIRECTION' ? apV(M, v) : (q => [q[0] + t[0], q[1] + t[1], q[2] + t[2]])(apV(M, v));
          b = `${m[1]}(${m[2]},(${w.map(snum).join(',')}))`;
        }
        lines.push('#' + (r.id + off) + '=' + renum(b, off) + ';'); mx = Math.max(mx, r.id);
      }
      off += mx;
    }
    const sch = (/FILE_SCHEMA\s*\([\s\S]*?\)\s*\)\s*;/.exec(head || '') || ["FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));"])[0];
    const d = new Date().toISOString().slice(0, 19);
    const headL = ['ISO-10303-21;', 'HEADER;', `FILE_DESCRIPTION(('${(info.comment || []).join(' / ').replace(/'/g, '')}'),'2;1');`, `FILE_NAME('${(info.file || 'bar.stp').replace(/'/g, '')}','${d}',(''),(''),'Raskladchik','Raskladchik','');`, sch, 'ENDSEC;', 'DATA;'];
    return linesToBytes(headL.concat(lines, ['ENDSEC;', 'END-ISO-10303-21;']), '\n');
  }

  root.TubeCut = { barMatrix, buildIGES, buildSTEP, _int: { readRaw, layout, placeIGES, compose, apP } };
  if (typeof module !== 'undefined') module.exports = root.TubeCut;
})(typeof window !== 'undefined' ? window : globalThis);
