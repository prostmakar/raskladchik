// Проверки расчётов без браузера:  node tests/test_calc.js
// Опорные значения сверены с 3D-моделями (x_t) и чертежами.
const C = require('../src/calc.js');
let fails = 0;
const near = (name, got, exp, tol = 0.05) => {
  const ok = Math.abs(got - exp) <= tol;
  if (!ok) fails++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: ${got.toFixed(2)} (ожидается ${exp})`);
};
const total = p => C.summarize(C.manualAnalyze(p), p.mode || 'both').total;
const end2 = { ang: '90', side: 'a' };

// 1. Ручной ввод = расчёт по x_t (4167.04.01.001 и 4167.04.02.001, R углов из модели)
near('45×45×3 R4, 18×Ø17', total({ prof: { type: 'rect', a: 45, b: 45, t: 3, r: 4 }, L: 1000, ends: [end2, end2], holes: [{ n: 18, d: 17 }] }), 1307.59);
near('100×50×4 R5, 12×Ø17', total({ prof: { type: 'rect', a: 100, b: 50, t: 4, r: 5 }, L: 1000, ends: [end2, end2], holes: [{ n: 12, d: 17 }] }), 1223.72);

// 2. Косые торцы: опора 7100.003-00.00.006, 80×80×4, 60° и 30° к оси
const op = { prof: { type: 'rect', a: 80, b: 80, t: 4, r: '' }, L: 1345, ends: [{ ang: '60', side: 'a' }, { ang: '30', side: 'a' }] };
near('опора 80×80×4, R авто (2t)', total(op), 791.5, 0.1);
near('опора 80×80×4, острые углы', total({ ...op, prof: { ...op.prof, r: 0 } }), 2 * 80 + 2 * 80 / Math.sin(Math.PI / 3) + 2 * 80 + 2 * 80 / Math.sin(Math.PI / 6), 0.1);

// 3. Уголок и круглая труба
near('уголок 45×45 под 45°', C.endCutLen({ type: 'angle', a: 45, b: 45, t: 4 }, 45, 'a'), 45 / Math.sin(Math.PI / 4) + 45, 0.01);
near('труба Ø57 прямой рез', C.endCutLen({ type: 'round', a: 57, t: 3 }, 90, 'a'), Math.PI * 57, 0.05);

// 4. Углы
near("56°30'", C.parseAngle("56°30'"), 56.5, 1e-9);
near('63 30', C.parseAngle('63 30'), 63.5, 1e-9);

// 5. Форма скосов: вылет скоса у раскоса 04.05.104 (на чертеже 120,3) и 04.05.105 (90,7)
const raskos = (L, a1) => C.manualShape({ prof: { type: 'rect', a: 60, b: 40, t: 3 }, L, ends: [{ ang: a1, ref: 'face', side: 'a' }, { ang: '60', side: 'a' }], shape: 'para' });
near('вылет 04.05.104', raskos(1039.4, "63°30'").lo[2], 120.3, 0.1);
near('вылет 04.05.105', raskos(1049.3, "56°30'").lo[2], 90.7, 0.1);

// 6. Раскладка со стыковкой скосов: 4 раскоса 04.05.104 без ширины реза
const g = raskos(1039.4, "63°30'");
const four = C.nestShapes([0, 1, 2, 3].map(() => ({ key: 'a', name: 'a', g })), 6000, 0, 0, 0);
near('4×04.05.104 валетом, длина', four.patterns[0].end, 4 * 1039.4 - 120.3 - 34.6 - 120.3, 0.2);

// 7. Масса 1 м
near('60×40×3, кг/м', C.kgPerM({ type: 'rect', a: 60, b: 40, t: 3 }), 4.25, 0.02);

console.log(fails ? `\nОшибок: ${fails}` : '\nВсе проверки пройдены');
process.exit(fails ? 1 : 0);
