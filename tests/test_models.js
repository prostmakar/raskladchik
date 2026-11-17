// Расчёт по 3D на проверочных моделях (tests/gen_step.js): профиль, размеры, длина, рез, врезки, вес, зазор в раскладке.
// node tests/test_models.js
const X = require('../src/xtcut.js');
const I = require('../src/iges.js'); global.IGES = I;
const ST = require('../src/step.js'); global.STEP = ST;
const C = require('../src/calc.js'); global.Calc = C;
const TC = require('../src/tubecut.js'); global.TubeCut = TC;
const S2 = require('../src/step2iges.js');
const G = require('./gen_step.js');
const S = G.sections, t45 = 1, t30 = Math.tan(Math.PI / 3), t60 = Math.tan(Math.PI / 6);
const rots = [null, G.rot([1, 2, 3], 0.7), G.rot([0, 1, 0], Math.PI / 2), G.rot([-2, 1, 0.5], 2.1)];
const cases = [
  ['труба 50×50×4 R6, прямые торцы', S.rect(50, 50, 4, 6), 390, {}, { type: 'rect', a: 50, b: 50, t: 4 }],
  ['труба 50×50×4 R6, скосы 45° валетом', S.rect(50, 50, 4, 6), 390, { left: [0, t45], right: [0, t45] }, { type: 'rect', a: 50, b: 50, t: 4 }],
  ['труба 120×120×5 R10, трапеция 45°', S.rect(120, 120, 5, 10), 1038, { left: [0, t45], right: [0, -t45] }, { type: 'rect', a: 120, b: 120, t: 5 }],
  ['труба 100×50×4 R8, скос 30° по широкой', S.rect(100, 50, 4, 8), 800, { left: [t30, 0] }, { type: 'rect', a: 100, b: 50, t: 4 }],
  ['труба 80×40×3 R6, скос в двух плоскостях', S.rect(80, 40, 3, 6), 600, { left: [0.4, 0.7], right: [-0.3, 0.2] }, { type: 'rect', a: 80, b: 40, t: 3 }],
  ['труба 60×60×3 острые углы, 4 отв. Ø12', S.rect(60, 60, 3, 0), 500, { holes: [{ seg: 0, u: 0.5, z: 100, d: 12 }, { seg: 0, u: 0.5, z: 400, d: 12 }, { seg: 1, u: 0.3, z: 250, d: 12 }, { seg: 2, u: 0.5, z: 250, d: 12 }] }, { type: 'rect', a: 60, b: 60, t: 3 }],
  ['труба Ø57×3, прямые торцы', S.round(57, 3), 700, {}, { type: 'round', a: 57, t: 3 }],
  ['труба Ø89×4,5, скос 60°', S.round(89, 4.5), 900, { right: [t60, 0] }, { type: 'round', a: 89, t: 4.5 }],
  ['уголок 25×25×3', S.angle(25, 25, 3), 300, {}, { type: 'angle', a: 25, b: 25, t: 3 }],
  ['уголок 63×40×5, скос 45°', S.angle(63, 40, 5), 450, { left: [t45, 0] }, { type: 'angle', a: 63, b: 40, t: 5 }],
  ['уголок 50×50×5, 2 отв. Ø9', S.angle(50, 50, 5), 400, { holes: [{ seg: 0, u: 0.6, z: 50, d: 9 }, { seg: 5, u: 0.4, z: 350, d: 9 }] }, { type: 'angle', a: 50, b: 50, t: 5 }],
  ['швеллер гнутый 100×50×4', S.channel(100, 50, 4), 1000, {}, { type: 'channel', a: 100, b: 50, t: 4 }],
  ['швеллер 18П без скруглений (полка 8,7)', S.channel(180, 70, 5.1, 8.7), 1200, {}, { type: 'channel', a: 180, b: 70, t: 5.1 }],
  ['швеллер 14П, скос 45° по стенке', S.channel(140, 58, 4.9, 8.1), 1100, { left: [0, t45], right: [0, t45] }, { type: 'channel', a: 140, b: 58, t: 4.9 }],
  ['уголок 50×50×5 R5,5 (горячекатаный)', S.angleR(50, 50, 5, 5.5), 600, {}, { type: 'angle', a: 50, b: 50, t: 5 }],
  ['уголок 75×50×6 R8, скос', S.angleR(75, 50, 6, 8), 500, { right: [0, 0.6] }, { type: 'angle', a: 75, b: 50, t: 6 }],
  ['швеллер 18П со скруглениями', S.channelR(180, 70, 5.1, 8.7, 9, 5), 1200, {}, { type: 'channel', a: 180, b: 70, t: 5.1 }],
  ['швеллер 10П со скруглениями, скос', S.channelR(100, 46, 4.5, 7.6, 7, 4), 700, { left: [0.5, 0] }, { type: 'channel', a: 100, b: 46, t: 4.5 }],
  ['короткая труба 100×100×4 R8, L=40', S.rect(100, 100, 4, 8), 40, {}, { type: 'rect', a: 100, b: 100, t: 4 }],
  ['короткая труба 120×120×5 R10, L=12', S.rect(120, 120, 5, 10), 12, {}, { type: 'rect', a: 120, b: 120, t: 5 }],
  ['короткий швеллер 18П, L=60', S.channelR(180, 70, 5.1, 8.7, 9, 5), 60, {}, { type: 'channel', a: 180, b: 70, t: 5.1 }],
  ['короткий уголок 50×50×5, L=30', S.angle(50, 50, 5), 30, {}, { type: 'angle', a: 50, b: 50, t: 5 }],
  ['короткая труба Ø108×4, L=25', S.round(108, 4), 25, {}, { type: 'round', a: 108, t: 4 }],
  ['швеллер 80×40×4, отв. Ø14 в стенке', S.channel(80, 40, 4), 500, { holes: [{ seg: 7, u: 0.5, z: 250, d: 14 }] }, { type: 'channel', a: 80, b: 40, t: 4 }],
];
let bad = 0, n = 0;
const chk = (ok, msg) => { n++; if (!ok) { bad++; console.log('   НЕ: ' + msg); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
function check(name, r, m, exp, src) {
  const s = C.summarize(r, 'both'), nh = Math.round(m.holeCut / 1) && m.nHoles;
  const p = r.prof || {};
  chk(p.type === exp.type, `${src}: профиль ${p.type}, ждали ${exp.type}`);
  if (exp.type === 'round') chk(near(p.a, exp.a, 0.11), `${src}: Ø${p.a}, ждали ${exp.a}`);
  else if (exp.type === 'channel') chk(near(p.a, exp.a, 0.11) && near(p.b, exp.b, 0.11), `${src}: ${p.a}×${p.b}, ждали ${exp.a}×${exp.b}`);
  else chk(near(Math.max(p.a, p.b), Math.max(exp.a, exp.b), 0.11) && near(Math.min(p.a, p.b), Math.min(exp.a, exp.b), 0.11), `${src}: ${p.a}×${p.b}, ждали ${exp.a}×${exp.b}`);
  chk(near(p.t, exp.t, 0.11), `${src}: стенка ${p.t}, ждали ${exp.t}`);
  chk(near(r.length, m.length, 0.02), `${src}: длина ${r.length.toFixed(2)}, ждали ${m.length.toFixed(2)}`);
  chk(near(s.endsLen, m.cut, Math.max(0.05, m.cut * 0.0005)), `${src}: торцы ${s.endsLen.toFixed(2)}, ждали ${m.cut.toFixed(2)}`);
  chk(near(s.otherLen, m.holeCut, Math.max(0.05, m.holeCut * 0.0005)), `${src}: отверстия ${s.otherLen.toFixed(2)}, ждали ${m.holeCut.toFixed(2)}`);
  chk(s.pierces === 2 + m.nHoles, `${src}: врезок ${s.pierces}, ждали ${2 + m.nHoles}`);
  if (!m.nHoles || exp.type !== 'x') chk(near(C.kgPerM(p), m.area * 7850 / 1e6, m.area * 7850 / 1e6 * 0.012), `${src}: кг/м ${C.kgPerM(p).toFixed(3)}, ждали ${(m.area * 7850 / 1e6).toFixed(3)}`);
}
// зазор в раскладке: выкладываем копии на хлыст, читаем хлыст обратно и меряем расстояние вдоль оси между соседями
function gapCheck(name, bytes, r, K, iges) {
  const g = r.shape, pieces = []; for (let i = 0; i < 4; i++) pieces.push({ key: 'p', name: 'p', g });
  const N = C.nestShapes(pieces, 12000, K, 10, 300);
  const dense = P => { const out = []; for (let i = 0; i < P.length; i++) { out.push(P[i]); if (i + 1 < P.length) for (let k = 1; k < 30; k++) out.push([0, 1, 2].map(j => P[i][j] + (P[i + 1][j] - P[i][j]) * k / 30)); } return out; };
  for (const pt of N.patterns) {
    const cl = pt.items.map(it => { const part = [{ bytes, M: TC.barMatrix(r.fr, it.p.g, it.o, it.s) }]; const m = iges ? I.toModel(TC.buildIGES(part, {})) : ST.toModel(TC.buildSTEP(part, {})); const P = []; for (const e of m.edges) { const q = e.g.pts, a = q[0], b = q[q.length - 1]; if (e.kind === 'line' && Math.hypot(a[1] - b[1], a[2] - b[2]) < 1e-6) P.push([a[0], a[1], a[2], b[0]]); } return P; });
    for (let i = 1; i < cl.length; i++) {
      if (pt.items[i].shared) continue;
      // по каждой образующей (прямое ребро вдоль хлыста): правый край предыдущей детали и левый край следующей
      const mx = new Map(), mn = new Map();
      for (const [L, M, right] of [[cl[i - 1], mx, true], [cl[i], mn, false]]) for (const q of L) { const k2 = q[1].toFixed(2) + ':' + q[2].toFixed(2), x = right ? Math.max(q[0], q[3]) : Math.min(q[0], q[3]); if (right ? !(M.get(k2) >= x) : !(M.get(k2) <= x)) M.set(k2, x); }
      let gmin = Infinity; for (const [k2, a] of mx) if (mn.has(k2)) gmin = Math.min(gmin, mn.get(k2) - a);
      chk(Math.abs(gmin - K) < 0.02, `${iges ? 'IGES' : 'STEP'}: зазор ${gmin.toFixed(2)} мм, задано ${K}`);
    }
  }
}
for (const [name, sec, len, opt, exp] of cases) {
  const before = bad;
  rots.forEach((R, ri) => {
    const m = G.build(sec, len, Object.assign({}, opt, { rot: R || undefined, shift: R ? [130, -70, 40] : undefined, seed: ri + 1, unit: ri === 2 ? 1000 : ri === 3 ? 25.4 : 1 }));
    m.nHoles = (opt.holes || []).length;
    let r;
    try { r = X.analyzeModel(ST.toModel(m.bytes)); check(name, r, m, exp, 'STEP' + ri); } catch (e) { chk(false, 'STEP' + ri + ': ' + e.message); return; }
    if (ri === 0) {
      try { const ig = S2.convert(m.bytes), r2 = X.analyzeModel(I.toModel(ig)); check(name, r2, m, exp, 'IGES'); gapCheck(name, ig, r2, 10, true); } catch (e) { chk(false, 'IGES: ' + e.message); }
      try { gapCheck(name, m.bytes, r, 10); gapCheck(name, m.bytes, r, 3); } catch (e) { chk(false, 'раскладка: ' + e.message); }
    }
  });
  console.log((bad === before ? 'ok  ' : 'НЕ  ') + name);
}
console.log(bad ? `Ошибок: ${bad} из ${n} проверок` : `Все проверки пройдены (${n})`);
process.exit(bad ? 1 : 0);
