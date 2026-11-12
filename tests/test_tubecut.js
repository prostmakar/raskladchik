// Раскрой труб в 3D: выкладываем детали на хлыст, читаем результат обратно и сверяем положение и длины
// node tests/test_tubecut.js деталь.igs деталь.step ...
const fs = require('fs');
const X = require('../src/xtcut.js');
const I = require('../src/iges.js'); global.IGES = I;
const ST = require('../src/step.js');
const C = require('../src/calc.js'); global.Calc = C;
const TC = require('../src/tubecut.js');
const files = process.argv.slice(2);
let bad = 0;
const isStep = f => /\.ste?p$/i.test(f);
const model = (f, b) => isStep(f) ? ST.toModel(b) : I.toModel(b);
for (const f of files) {
  try {
    const b = new Uint8Array(fs.readFileSync(f));
    const r = X.analyzeModel(model(f, b)); const g = r.shape;
    const ors = C.orientations(g);
    // все развороты подряд с зазором 10 мм — каждая копия должна лечь в свой отрезок [s, s+L] вдоль X
    const parts = []; let s = 20; const spans = [];
    for (const o of ors) { parts.push({ bytes: b, M: TC.barMatrix(r.fr, g, o, s) }); spans.push([s + Math.min(...o.lo), s + Math.max(...o.ro), o]); s += g.L + 10; }
    for (let i = 0; i < parts.length; i++) {
      const one = isStep(f) ? TC.buildSTEP([parts[i]], {}) : TC.buildIGES([parts[i]], {});
      const r2 = X.analyzeModel(model(f, one));
      const ax = r2.view.axis; const okAx = Math.abs(Math.abs(ax[0]) - 1) < 1e-6;
      const okL = Math.abs(r2.length - r.length) < 0.01;
      // торцы на углах сечения: совпадают с раскладкой
      const xs = []; for (const e of r2.view.edges) for (const p of e.p) xs.push(p[0]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs);
      const okX = x0 > spans[i][0] - 0.5 - g.L && Math.abs(x1 - x0 - r.length) < 0.01 && x0 >= spans[i][0] - Math.max(...g.lo) - 0.01 - g.L * 0 - 50 ;
      const ys = []; const zs = []; for (const e of r2.view.edges) for (const p of e.p) { ys.push(p[1]); zs.push(p[2]); }
      const cy = (Math.min(...ys) + Math.max(...ys)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
      const okC = Math.abs(cy) < 0.05 && Math.abs(cz) < 0.05;
      const lo2 = r2.shape.lo, ro2 = r2.shape.ro;
      const okE = r2.shape.sym === g.sym;
      // торцы по четвертям сечения: как в раскладке (lo/ro у углов)
      let okQ = true; const o = spans[i][2];
      if (g.sym !== 'path') { // ни одна точка не вылезает за торцы раскладки (линейно между углами), и у углов торец рядом
        const sx = spans[i][0] - Math.min(...o.lo), A2 = g.A / 2, B2 = g.B / 2;
        const bil = (v, y, z) => { const u = (y + A2) / (2 * A2), w = (z + B2) / (2 * B2); return v[0] * (1 - u) * (1 - w) + v[1] * (1 - u) * w + v[2] * u * (1 - w) + v[3] * u * w; };
        let worst = 0;
        for (const e of r2.view.edges) for (const p of e.p) { worst = Math.max(worst, sx + bil(o.lo, p[1], p[2]) - p[0], p[0] - (sx + bil(o.ro, p[1], p[2]))); }
        if (worst > 0.15) { okQ = false; console.log('   вылезает на ' + worst.toFixed(2) + ' мм'); }
      }
      const ok = okQ && okAx && okL && okC && okE && x1 <= spans[i][1] + 0.05 && x0 >= spans[i][0] - 0.05;
      if (!ok) bad++;
      console.log(`${ok ? 'ok ' : 'НЕ '} ${f.split('/').pop()} разворот ${i}: ось ${ax.map(v => v.toFixed(3))}, L ${r2.length.toFixed(2)}/${r.length.toFixed(2)}, X ${x0.toFixed(2)}..${x1.toFixed(2)} ждали ${spans[i][0].toFixed(2)}..${spans[i][1].toFixed(2)}, центр ${cy.toFixed(3)},${cz.toFixed(3)}`);
    }
  } catch (e) { bad++; console.log('НЕ ' + f.split('/').pop() + ': ' + e.message + '\n' + e.stack.split('\n').slice(1, 3).join('\n')); }
}
console.log(bad ? `Ошибок: ${bad}` : 'Все проверки пройдены');
