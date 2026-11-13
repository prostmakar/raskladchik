// STEP → IGES: переводим, читаем IGES обратно и сверяем расчёт с расчётом по STEP
// node tests/test_step2iges.js файл.step ...
const fs = require('fs');
const X = require('../src/xtcut.js');
const I = require('../src/iges.js'); global.IGES = I;
const ST = require('../src/step.js'); global.STEP = ST;
const C = require('../src/calc.js'); global.Calc = C;
const TC = require('../src/tubecut.js'); global.TubeCut = TC;
const S2 = require('../src/step2iges.js');
let bad = 0;
for (const f of process.argv.slice(2)) {
  try {
    const b = new Uint8Array(fs.readFileSync(f));
    const a = X.analyzeModel(ST.toModel(b));
    const ig = S2.convert(b);
    if (process.env.OUT) fs.writeFileSync(process.env.OUT + '/' + f.split('/').pop().replace(/\.[^.]+$/, '') + '.igs', ig);
    const m = I.toModel(ig); const r = X.analyzeModel(m);
    const ca = a.contours.reduce((s, c) => s + c.len, 0), cr = r.contours.reduce((s, c) => s + c.len, 0);
    const ok = Math.abs(a.length - r.length) < 0.01 && a.profile === r.profile && Math.abs(ca - cr) < Math.max(0.5, ca * 0.002) && a.contours.length === r.contours.length;
    if (!ok) bad++;
    console.log(`${ok ? 'ok ' : 'НЕ '} ${f.split('/').pop()}: ${a.profile} / ${r.profile}, L ${a.length.toFixed(2)} / ${r.length.toFixed(2)}, рез ${ca.toFixed(1)} / ${cr.toFixed(1)}, контуров ${a.contours.length} / ${r.contours.length}, граней ${m.faces.size}, ${(ig.length / 1024).toFixed(0)} КБ`);
  } catch (e) { bad++; console.log('НЕ ' + f.split('/').pop() + ': ' + e.message + '\n' + e.stack.split('\n').slice(1, 3).join('\n')); }
}
console.log(bad ? `Ошибок: ${bad}` : 'Все проверки пройдены');
