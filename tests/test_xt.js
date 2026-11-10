// Расчёт по x_t-файлам из командной строки:
//   node tests/test_xt.js путь/к/детали.x_t [ещё.x_t ...]
const fs = require('fs');
const X = require('../src/xtcut.js');
const C = require('../src/calc.js');
const files = process.argv.slice(2);
if (!files.length) { console.log('Укажите x_t-файлы: node tests/test_xt.js деталь.x_t'); process.exit(0); }
for (const f of files) {
  try {
    const r = X.analyze(fs.readFileSync(f, 'latin1'));
    const s = C.summarize(r, 'both');
    console.log(`${f}\n  профиль ${r.profile}, длина ${r.length.toFixed(1)} мм`);
    console.log(`  рез на 1 шт ${s.total.toFixed(2)} мм, врезок ${s.pierces}; торцы ${s.endLens.map(x => x.toFixed(1)).join(' + ')}`);
    for (const g of s.groups) console.log(`  ${g.label} ×${g.n} = ${g.len.toFixed(1)}`);
    if (r.warnings.length) console.log('  ! ' + r.warnings.join('; '));
  } catch (e) { console.log(`${f}\n  ошибка: ${e.message}`); }
}
