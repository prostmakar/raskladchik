// Генератор проверочных STEP-моделей: профиль, вытянутый вдоль оси, с плоскими торцами (прямыми и косыми) и отверстиями.
// Нужен, чтобы расчёт проверялся без файлов заказчиков: всё, что должно получиться (рез, вес, профиль), известно заранее.
'use strict';
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// ---- сечения: контуры из отрезков и дуг (против часовой — наружный, по часовой — внутренний)
const L = (a, b, cut) => ({ t: 'L', a, b, cut: !!cut });
const A = (c, r, a0, a1, cut) => ({ t: 'A', c, r, a0, a1, cut: !!cut, a: [c[0] + r * Math.cos(a0), c[1] + r * Math.sin(a0)], b: [c[0] + r * Math.cos(a1), c[1] + r * Math.sin(a1)] });
function roundRect(w, h, r, cut, x0 = 0, y0 = 0) { // против часовой
  const s = [], P = Math.PI;
  if (!(r > 0)) return [L([x0, y0], [x0 + w, y0], cut), L([x0 + w, y0], [x0 + w, y0 + h], cut), L([x0 + w, y0 + h], [x0, y0 + h], cut), L([x0, y0 + h], [x0, y0], cut)];
  s.push(L([x0 + r, y0], [x0 + w - r, y0], cut), A([x0 + w - r, y0 + r], r, -P / 2, 0, cut), L([x0 + w, y0 + r], [x0 + w, y0 + h - r], cut), A([x0 + w - r, y0 + h - r], r, 0, P / 2, cut),
    L([x0 + w - r, y0 + h], [x0 + r, y0 + h], cut), A([x0 + r, y0 + h - r], r, P / 2, P, cut), L([x0, y0 + h - r], [x0, y0 + r], cut), A([x0 + r, y0 + r], r, P, 1.5 * P, cut));
  return s;
}
const sections = {
  rect(a, b, t, R) { const r = Math.max(0, R - t); return { loops: [roundRect(a, b, R, true), roundRect(a - 2 * t, b - 2 * t, r, false, t, t)], area: a * b - (a - 2 * t) * (b - 2 * t) - (4 - Math.PI) * (R * R - r * r), cutLen: 2 * (a + b) - (8 - 2 * Math.PI) * R }; },
  round(d, t) { const P = Math.PI, c = [0, 0], ri = d / 2 - t; return { loops: [[A(c, d / 2, 0, P, true), A(c, d / 2, P, 2 * P, true)], [A(c, ri, 0, P), A(c, ri, P, 2 * P)]], area: P * (d * d / 4 - ri * ri), cutLen: P * d }; },
  // уголок: полки a (по x) и b (по y), наружный угол в нуле; режутся наружные стороны полок
  angle(a, b, t) { return { loops: [[L([0, 0], [a, 0], true), L([a, 0], [a, t]), L([a, t], [t, t]), L([t, t], [t, b]), L([t, b], [0, b]), L([0, b], [0, 0], true)]], area: t * (a + b - t), cutLen: a + b }; },
  // уголок горячекатаный: скругление R во внутреннем углу
  angleR(a, b, t, R) { const P = Math.PI; return { loops: [[L([0, 0], [a, 0], true), L([a, 0], [a, t]), L([a, t], [t + R, t]), A([t + R, t + R], R, -P / 2, -P), L([t, t + R], [t, b]), L([t, b], [0, b]), L([0, b], [0, 0], true)]], area: t * (a + b - t) + (1 - P / 4) * R * R, cutLen: a + b }; },
  // швеллер горячекатаный П: скругления R между стенкой и полками и r на кромках полок
  channelR(h, b, s, tf, R, r) { const P = Math.PI; return { loops: [[L([0, 0], [b, 0], true), L([b, 0], [b, tf - r]), A([b - r, tf - r], r, 0, P / 2), L([b - r, tf], [s + R, tf]), A([s + R, tf + R], R, -P / 2, -P), L([s, tf + R], [s, h - tf - R]), A([s + R, h - tf - R], R, P, P / 2), L([s + R, h - tf], [b - r, h - tf]), A([b - r, h - tf + r], r, -P / 2, 0), L([b, h - tf + r], [b, h]), L([b, h], [0, h], true), L([0, h], [0, 0], true)]],
    area: h * s + 2 * (b - s) * tf + 2 * (1 - P / 4) * R * R - 2 * (1 - P / 4) * r * r, cutLen: h + 2 * b }; },
  // швеллер: высота h (по y), полка b (по x), стенка s, полка толщиной tf (у горячекатаного tf > s)
  channel(h, b, s, tf) { tf = tf || s; return { loops: [[L([0, 0], [b, 0], true), L([b, 0], [b, tf]), L([b, tf], [s, tf]), L([s, tf], [s, h - tf]), L([s, h - tf], [b, h - tf]), L([b, h - tf], [b, h]), L([b, h], [0, h], true), L([0, h], [0, 0], true)]], area: h * s + 2 * (b - s) * tf, cutLen: h + 2 * b }; },
};

// ---- запись STEP
function build(sec, len, opt = {}) {
  const seed = opt.seed || 1; let rs = seed * 9301 + 49297; const rnd = () => { rs = (rs * 9301 + 49297) % 233280; return rs / 233280; };
  const lines = []; let id = 10;
  const put = body => { lines.push('#' + (++id) + '=' + body + ';'); return '#' + id; };
  const f = v => { if (Math.abs(v) < 1e-12) v = 0; let s = (+v.toPrecision(15)).toString().toUpperCase(); if (!/[.E]/.test(s)) s += '.'; else if (/E/.test(s) && !/\./.test(s.split('E')[0])) s = s.replace('E', '.E'); return s; };
  // поворот и сдвиг всей детали, единицы
  const R = opt.rot || [[1, 0, 0], [0, 1, 0], [0, 0, 1]], T = opt.shift || [0, 0, 0], k = 1 / (opt.unit || 1);
  const W = p => add([dot(R[0], p), dot(R[1], p), dot(R[2], p)], T), Wd = d => [dot(R[0], d), dot(R[1], d), dot(R[2], d)];
  const pnt = p => put(`CARTESIAN_POINT('',(${W(p).map(v => f(v * k)).join(',')}))`);
  const dir = d => put(`DIRECTION('',(${norm(Wd(d)).map(f).join(',')}))`);
  const ax = (o, z, x) => put(`AXIS2_PLACEMENT_3D('',${pnt(o)},${dir(z)},${dir(x)})`);
  const vert = p => ({ p, ref: put(`VERTEX_POINT('',${pnt(p)})`) });
  const line = (a, b) => put(`LINE('',${pnt(a)},${put(`VECTOR('',${dir(sub(b, a))},1.)`)})`);
  const edge = (va, vb, curve) => put(`EDGE_CURVE('',${va.ref},${vb.ref},${curve},.T.)`);
  const loop = es => put(`EDGE_LOOP('',(${es.map(e => put(`ORIENTED_EDGE('',*,*,${e},${rnd() < 0.5 ? '.T.' : '.F.'})`)).join(',')}))`);
  const faces = [];
  const face = (loops, surf) => faces.push(put(`ADVANCED_FACE('',(${loops.map((l, i) => put(`${i ? 'FACE_BOUND' : 'FACE_OUTER_BOUND'}('',${loop(l)},.T.)`)).join(',')}),${surf},${rnd() < 0.5 ? '.T.' : '.F.'})`));
  const flip = () => rnd() < 0.5 ? 1 : -1; // направление нормали плоскости и оси цилиндра в файле бывает любым
  const plane = (o, n, x) => put(`PLANE('',${ax(o, mul(n, flip()), x)})`);
  const cyl = (o, z, x, r) => put(`CYLINDRICAL_SURFACE('',${ax(o, mul(z, flip()), x)},${f(r * k)})`);

  // торцы: z = z0 + ka·x + kb·y
  const ends = [opt.left || [0, 0], opt.right || [0, 0]].map((e, i) => ({ ka: e[0], kb: e[1], z0: i ? len : 0 }));
  const zOf = (e, q) => e.z0 + e.ka * q[0] + e.kb * q[1];
  const P3 = (e, q) => [q[0], q[1], zOf(e, q)];
  const nOf = e => norm([-e.ka, -e.kb, 1]);
  // кривая торца над дугой сечения: окружность (прямой рез) или эллипс (косой)
  const capCurve = (e, s) => {
    const n = nOf(e), c = P3(e, s.c);
    if (Math.abs(e.ka) < 1e-12 && Math.abs(e.kb) < 1e-12) return put(`CIRCLE('',${ax(c, [0, 0, 1], [1, 0, 0])},${f(s.r * k)})`);
    const minor = norm(cross([0, 0, 1], n)), major = norm(cross(minor, n));
    return put(`ELLIPSE('',${ax(c, n, major)},${f(s.r / n[2] * k)},${f(s.r * k)})`);
  };
  let cut = 0; const capLoops = [[], []];
  const sideFaces = []; // для отверстий: {seg, bounds, surfArgs}
  for (const lp of sec.loops) {
    const n = lp.length;
    const V = ends.map(e => lp.map(s => vert(P3(e, s.a))));
    const long = lp.map((s, i) => edge(V[0][i], V[1][i], line(V[0][i].p, V[1][i].p)));
    const capE = ends.map((e, ei) => lp.map((s, i) => {
      const va = V[ei][i], vb = V[ei][(i + 1) % n];
      const c = s.t === 'L' ? line(va.p, vb.p) : capCurve(e, s);
      if (s.cut) { if (s.t === 'L') cut += Math.hypot(vb.p[0] - va.p[0], vb.p[1] - va.p[1], vb.p[2] - va.p[2]); else { const N = 2000; let q0 = va.p; for (let j = 1; j <= N; j++) { const a = s.a0 + (s.a1 - s.a0) * j / N, q = P3(e, [s.c[0] + s.r * Math.cos(a), s.c[1] + s.r * Math.sin(a)]); cut += Math.hypot(q[0] - q0[0], q[1] - q0[1], q[2] - q0[2]); q0 = q; } } }
      return s.t === 'A' && s.a1 < s.a0 ? edge(vb, va, c) : edge(va, vb, c); // дуга по часовой (вогнутое скругление) — ребро в обратную сторону
    }));
    capLoops[0].push(capE[0]); capLoops[1].push(capE[1]);
    lp.forEach((s, i) => { sideFaces.push({ s, bound: [capE[0][i], long[(i + 1) % n], capE[1][i], long[i]], holes: [] }); });
  }
  // отверстия: в прямой стенке насквозь через одну стенку; hole = {seg: номер отрезка наружного контура, u: 0..1 вдоль отрезка, z, d}
  const holeFaces = []; let holeCut = 0;
  for (const h of opt.holes || []) {
    const out = sideFaces[h.seg], s = out.s; const dx = norm([s.b[0] - s.a[0], s.b[1] - s.a[1], 0]), nrm = [dx[1], -dx[0], 0]; // наружу для контура против часовой
    // противоположная сторона стенки: ближайший параллельный отрезок внутрь
    let best = null, bd = Infinity; const c2 = [s.a[0] + (s.b[0] - s.a[0]) * h.u, s.a[1] + (s.b[1] - s.a[1]) * h.u];
    for (const sf of sideFaces) { if (sf === out || sf.s.t !== 'L') continue; const d2 = norm([sf.s.b[0] - sf.s.a[0], sf.s.b[1] - sf.s.a[1], 0]); if (Math.abs(Math.abs(dot(d2, dx)) - 1) > 1e-9) continue;
      const dist = -((sf.s.a[0] - c2[0]) * nrm[0] + (sf.s.a[1] - c2[1]) * nrm[1]); if (dist > 1e-6 && dist < bd) { bd = dist; best = sf; } }
    const r = h.d / 2, cO = [c2[0], c2[1], h.z], cI = add(cO, mul(nrm, -bd)), zx = [0, 0, 1], y = cross(nrm, zx);
    const ring = c => { const v1 = vert(add(c, mul(zx, r))), v2 = vert(add(c, mul(zx, -r))); const mk = () => put(`CIRCLE('',${ax(c, nrm, zx)},${f(r * k)})`); return { v1, v2, e1: edge(v1, v2, mk()), e2: edge(v2, v1, mk()) }; };
    const o = ring(cO), i = ring(cI);
    out.holes.push([o.e1, o.e2]); best.holes.push([i.e1, i.e2]);
    const s1 = edge(o.v1, i.v1, line(o.v1.p, i.v1.p)), s2 = edge(o.v2, i.v2, line(o.v2.p, i.v2.p));
    holeFaces.push([[o.e1, s2, i.e1, s1], cO, nrm, r], [[o.e2, s1, i.e2, s2], cO, nrm, r]);
    holeCut += 2 * Math.PI * r;
  }
  for (const sf of sideFaces) { const s = sf.s;
    if (s.t === 'L') { const d = [s.b[0] - s.a[0], s.b[1] - s.a[1], 0]; face([sf.bound, ...sf.holes], plane([s.a[0], s.a[1], 0], [d[1], -d[0], 0], [0, 0, 1])); }
    else face([sf.bound], cyl([s.c[0], s.c[1], 0], [0, 0, 1], [1, 0, 0], s.r)); }
  for (const [b, o, z, r] of holeFaces) face([b], cyl(o, z, [0, 0, 1], r));
  ends.forEach((e, ei) => face(capLoops[ei], plane([0, 0, e.z0], nOf(e), norm(cross([0, 1, 0], nOf(e))))));
  const shell = put(`CLOSED_SHELL('',(${faces.join(',')}))`);
  put(`MANIFOLD_SOLID_BREP('',${shell})`);
  const unit = opt.unit === 1000 ? '$' : opt.unit === 25.4 ? null : '.MILLI.';
  const head = ['ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');", "FILE_NAME('test.stp','2026-01-01T00:00:00',(''),(''),'','','');", "FILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));", 'ENDSEC;', 'DATA;',
    unit === null ? "#1=(CONVERSION_BASED_UNIT('INCH',#2)LENGTH_UNIT()NAMED_UNIT(#3));" : `#1=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(${unit},.METRE.));`];
  const text = head.concat(lines, ['ENDSEC;', 'END-ISO-10303-21;']).join('\n');
  // длина по оси: от самой левой до самой правой точки наружного контура
  let z0 = Infinity, z1 = -Infinity; for (const lp of sec.loops) for (const s of lp) { const N = s.t === 'A' ? 90 : 1; for (let j = 0; j <= N; j++) { const q = s.t === 'A' ? [s.c[0] + s.r * Math.cos(s.a0 + (s.a1 - s.a0) * j / N), s.c[1] + s.r * Math.sin(s.a0 + (s.a1 - s.a0) * j / N)] : j ? s.b : s.a; z0 = Math.min(z0, zOf(ends[0], q)); z1 = Math.max(z1, zOf(ends[1], q)); } }
  return { bytes: new Uint8Array(Buffer.from(text, 'latin1')), text, cut, holeCut, length: z1 - z0, area: sec.area };
}
// поворот вокруг оси на угол
function rot(axis, ang) { const [x, y, z] = norm(axis), c = Math.cos(ang), s = Math.sin(ang), C = 1 - c; return [[c + x * x * C, x * y * C - z * s, x * z * C + y * s], [y * x * C + z * s, c + y * y * C, y * z * C - x * s], [z * x * C - y * s, z * y * C + x * s, c + z * z * C]]; }
module.exports = { sections, build, rot };
