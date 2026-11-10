// Расчёт по IGES/STEP-файлам из командной строки: node tests/test_iges.js деталь.igs деталь.step [...]
const fs = require('fs');
const X = require('../src/xtcut.js');
const I = require('../src/iges.js');
global.IGES = I;
const ST = require('../src/step.js');
const C = require('../src/calc.js');
for (const f of process.argv.slice(2)) {
  try {
    const t0 = Date.now();
    const m = /\.ste?p$/i.test(f) ? ST.toModel(new Uint8Array(fs.readFileSync(f))) : I.toModel(new Uint8Array(fs.readFileSync(f)));
    const kinds = {}; for (const fc of m.faces.values()) kinds[fc.surf.kind] = (kinds[fc.surf.kind] || 0) + 1;
    const ek = {}; for (const e of m.edges) ek[e.kind] = (ek[e.kind] || 0) + 1;
    const r = X.analyzeModel(m);
    const s = C.summarize(r, 'both');
    console.log(`${f.split('/').pop()}  (${Date.now() - t0} мс)\n  грани ${JSON.stringify(kinds)} рёбра ${JSON.stringify(ek)}\n  профиль ${r.profile}, длина ${r.length.toFixed(2)} мм`);
    console.log(`  рез на 1 шт ${s.total.toFixed(2)} мм, врезок ${s.pierces}; торцы ${s.endLens.map(x => x.toFixed(1)).join(' + ')}; углы ${r.shape ? r.shape.angL.toFixed(1) + '/' + r.shape.angR.toFixed(1) : ''}`);
    for (const g of s.groups) console.log(`  ${g.label} ×${g.n} = ${g.len.toFixed(1)}`);
    if (r.warnings.length) console.log('  ! ' + r.warnings.join('; '));
  } catch (e) { console.log(`${f.split('/').pop()}\n  ошибка: ${e.message}\n${e.stack.split('\n').slice(1, 3).join('\n')}`); }
}
