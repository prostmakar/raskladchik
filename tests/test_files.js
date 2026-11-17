// Расчёт по настоящим файлам из заказов (tests/models): то, что уже однажды ломалось.
// node tests/test_files.js
const fs = require('fs'), path = require('path');
const X = require('../src/xtcut.js'); const I = require('../src/iges.js'); global.IGES = I;
const C = require('../src/calc.js');
// файл → профиль, размеры, длина, рез на 1 шт, врезок
const exp = {
  // труба 40×40×2 с острыми углами и сквозными отверстиями: в 1.4.18 считалась уголком (шум координат выбивал угол из оболочки сечения)
  'Truba40x40x2_L520_90-90_poz5.igs': ['rect', 40, 40, 2, 520, 160 * 2 + 4 * 18 * Math.PI, 6],
  'Truba40x40x2_L600_45-45_poz3.igs': ['rect', 40, 40, 2, 600, (80 + 80 * Math.SQRT2) * 2 + 4 * 18 * Math.PI + 4 * 13 * Math.PI, 10],
  'Truba40x40x2_L600_45-45_poz4.igs': ['rect', 40, 40, 2, 600, (80 + 80 * Math.SQRT2) * 2 + 4 * 18 * Math.PI + 4 * 13 * Math.PI, 10],
  'Truba40x40x2_L2000_45-45_poz1.igs': ['rect', 40, 40, 2, 2000, (80 + 80 * Math.SQRT2) * 2 + 8 * 13 * Math.PI, 10],
  'Truba40x40x2_L2000_45-45_poz2.igs': ['rect', 40, 40, 2, 2000, (80 + 80 * Math.SQRT2) * 2 + 8 * 13 * Math.PI, 10],
};
let bad = 0;
for (const [f, [type, a, b, t, L, cut, pc]] of Object.entries(exp)) {
  const r = X.analyzeModel(I.toModel(new Uint8Array(fs.readFileSync(path.join(__dirname, 'models', f)))));
  const s = C.summarize(r, 'both'), p = r.prof || {}, err = [];
  if (p.type !== type) err.push(`профиль ${p.type}, ждали ${type}`);
  if (Math.abs(p.a - a) > 0.05 || Math.abs(p.b - b) > 0.05 || Math.abs(p.t - t) > 0.05) err.push(`${p.a}×${p.b}×${p.t}, ждали ${a}×${b}×${t}`);
  if (Math.abs(r.length - L) > 0.05) err.push(`длина ${r.length.toFixed(2)}, ждали ${L}`);
  if (Math.abs(s.total - cut) > 0.3) err.push(`рез ${s.total.toFixed(2)}, ждали ${cut.toFixed(2)}`);
  if (s.pierces !== pc) err.push(`врезок ${s.pierces}, ждали ${pc}`);
  console.log((err.length ? 'НЕ  ' : 'ok  ') + f + (err.length ? ': ' + err.join('; ') : `  рез ${s.total.toFixed(1)} мм, врезок ${s.pierces}`));
  bad += err.length ? 1 : 0;
}
console.log(bad ? `Ошибок: ${bad}` : 'Все проверки пройдены');
process.exit(bad ? 1 : 0);
