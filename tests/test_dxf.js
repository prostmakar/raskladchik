// Проверки чтения и исправления DXF и раскладки: node tests/test_dxf.js
global.DXF = require('../src/dxf.js');
const DC = require('../src/dxfclean.js');
const N = require('../src/nest2d.js');
let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log('  ✗ ' + m); } else console.log('  ✓ ' + m); };
const near = (a, b, t = 0.01) => Math.abs(a - b) <= t;
const dxf = (ents, extra = '') => `0\nSECTION\n2\nHEADER\n${extra}0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${ents}0\nENDSEC\n0\nEOF\n`;
const line = (x1, y1, x2, y2, lt) => `0\nLINE\n8\n0\n${lt ? '6\n' + lt + '\n' : ''}10\n${x1}\n20\n${y1}\n11\n${x2}\n21\n${y2}\n`;
const circle = (x, y, r) => `0\nCIRCLE\n8\n0\n10\n${x}\n20\n${y}\n40\n${r}\n`;
const arc = (x, y, r, a, b) => `0\nARC\n8\n0\n10\n${x}\n20\n${y}\n40\n${r}\n50\n${a}\n51\n${b}\n`;
const lw = (pts, closed) => `0\nLWPOLYLINE\n8\n0\n90\n${pts.length}\n70\n${closed ? 1 : 0}\n` + pts.map(p => `10\n${p[0]}\n20\n${p[1]}\n` + (p[2] ? `42\n${p[2]}\n` : '')).join('');
const an = t => DC.analyze(t);

console.log('Прямоугольник из 4 линий + отверстие');
let r = an(dxf(line(0, 0, 100, 0) + line(100, 0, 100, 50) + line(100, 50, 0, 50) + line(0, 50, 0, 0) + circle(50, 25, 10)));
ok(r.sev === 'ok', 'без замечаний'); ok(near(r.cut, 300 + 2 * Math.PI * 10), 'длина реза ' + r.cut.toFixed(3)); ok(r.pierces === 2, 'врезок 2');

console.log('Двойная линия, круг в круге, текст, разрыв 0,05, разрыв 0,6');
r = an(dxf(line(0, 0, 100, 0) + line(0, 0, 100, 0) + line(100, 0, 100, 50.05) + line(100, 50, 0, 50) + line(0, 50, 0, 0.6) + circle(50, 25, 10) + circle(50, 25, 10) + circle(50, 25, 10.03) + '0\nTEXT\n8\n0\n10\n0\n20\n0\n40\n5\n1\nтекст\n'));
ok(r.issues.some(i => i.code === 'dup'), 'двойные найдены'); ok(r.issues.some(i => i.code === 'junk'), 'текст удалён');
ok(r.issues.some(i => i.code === 'join'), 'разрыв 0,05 стянут'); ok(r.issues.some(i => i.code === 'bridge'), 'разрыв 0,6 закрыт');
ok(r.pierces === 2 && r.sev === 'fix', 'итог: 2 контура, всё исправлено');
ok(near(r.cut, 300 + 2 * Math.PI * 10.03, 0.2), 'длина ' + r.cut.toFixed(2));

console.log('Разрыв больше допуска — ошибка');
r = an(dxf(line(0, 0, 100, 0) + line(100, 0, 100, 50) + line(100, 50, 0, 50) + line(0, 50, 0, 5)));
ok(r.sev === 'err' && r.issues.some(i => i.code === 'open'), 'незамкнутый контур');

console.log('Осевая линия удаляется');
r = an(dxf(circle(0, 0, 50) + line(-60, 0, 60, 0, 'CENTER')));
ok(r.pierces === 1 && r.issues.some(i => i.code === 'axis'), 'осевая убрана');

console.log('LWPOLYLINE со скруглениями (выпуклость)');
const b = Math.tan(Math.PI / 8); // четверть окружности
r = an(dxf(lw([[10, 0], [90, 0, b], [100, 10], [100, 40, b], [90, 50], [10, 50, b], [0, 40], [0, 10, b]], true)));
ok(r.sev === 'ok' && near(r.cut, 2 * 80 + 2 * 30 + 2 * Math.PI * 10), 'длина ' + r.cut.toFixed(3));

console.log('Блок со вставкой: поворот, масштаб, зеркало');
const blk = `0\nSECTION\n2\nBLOCKS\n0\nBLOCK\n8\n0\n2\nB1\n70\n0\n10\n0\n20\n0\n${line(0, 0, 10, 0)}${line(10, 0, 10, 5)}${line(10, 5, 0, 5)}${line(0, 5, 0, 0)}${circle(5, 2.5, 1)}0\nENDBLK\n0\nENDSEC\n`;
const ins = (x, y, sx, sy, rot) => `0\nINSERT\n8\n0\n2\nB1\n10\n${x}\n20\n${y}\n41\n${sx}\n42\n${sy}\n50\n${rot}\n`;
r = an(`0\nSECTION\n2\nHEADER\n0\nENDSEC\n${blk}0\nSECTION\n2\nENTITIES\n${ins(0, 0, 2, 2, 30)}${ins(100, 0, -2, 2, 0)}0\nENDSEC\n0\nEOF\n`);
const one = 2 * (20 + 10) + 2 * Math.PI * 2;
ok(r.pierces === 4 && near(r.cut, 2 * one, 0.01), 'две вставки, длина ' + r.cut.toFixed(3) + ' (ожид. ' + (2 * one).toFixed(3) + ')');
ok(near(r.bbox[0], 100 - 20 - 0.5, 1) || r.bbox[0] < 0, 'зеркальная вставка уходит влево от точки вставки');

console.log('Дюймы');
r = an(dxf(circle(0, 0, 1), '9\n$INSUNITS\n70\n1\n'));
ok(near(r.w, 50.8), 'диаметр 1" -> 50,8 мм');

console.log('Эллипс (полный)');
r = an(dxf(`0\nELLIPSE\n8\n0\n10\n0\n20\n0\n11\n50\n21\n0\n40\n0.5\n41\n0\n42\n${2 * Math.PI}\n`));
ok(r.sev === 'ok' && near(r.cut, 242.211, 0.02), 'периметр ' + r.cut.toFixed(3));

console.log('Сплайн (окружность NURBS) и запись в DXF дугами');
const w = Math.SQRT1_2; const cp = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0]].map(p => [p[0] * 20, p[1] * 20]);
const kn = [0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4];
const spl = `0\nSPLINE\n8\n0\n70\n${1 | 4}\n71\n2\n72\n${kn.length}\n73\n${cp.length}\n74\n0\n` + kn.map(k => `40\n${k}\n`).join('') + cp.map((p, i) => `41\n${i % 2 ? w : 1}\n`).join('') + cp.map(p => `10\n${p[0]}\n20\n${p[1]}\n30\n0\n`).join('');
r = an(dxf(spl));
ok(r.sev === 'ok' && near(r.cut, 2 * Math.PI * 20, 0.02), 'длина ' + r.cut.toFixed(3));
const re = an(DC.writeDXF(r.contours));
ok(re.sev === 'ok' && near(re.cut, r.cut, 0.05), 'после записи длина ' + re.cut.toFixed(3));

console.log('Раскладка: квадраты 100×100, зазор 5');
const sq = [[0, 0], [100, 0], [100, 100], [0, 100]];
const nr = N.nest([{ id: 'a', qty: 100, polys: [sq], area: 1e4, cut: 400, pierces: 1 }], { W: 1000, H: 1000, margin: 0, gap: 5, mode: 'shape', rotStep: 0 });
ok(nr.sheets[0].items.length === 81 && nr.sheets.length === 2, 'на лист 1000×1000 — 81 шт, всего 2 листа');
let minGap = Infinity; const it = nr.sheets[0].items; for (const a of it) for (const c of it) if (a !== c) { const dx = Math.max(0, Math.max(a.x, c.x) - Math.min(a.x + 100, c.x + 100)), dy = Math.max(0, Math.max(a.y, c.y) - Math.min(a.y + 100, c.y + 100)); const d = Math.hypot(dx, dy); if (d < minGap) minGap = d; }
ok(minGap >= 5 - 1e-9, 'зазор не меньше 5 мм (' + minGap.toFixed(2) + ')');

console.log('Раскладка: общий рез');
const pr = N.nest([{ id: 'p', qty: 6, polys: [[[0, 0], [200, 0], [200, 100], [0, 100]]], area: 2e4, cut: 600, pierces: 1, rect: true }], { W: 1000, H: 500, margin: 10, gap: 5, mode: 'shape', rotStep: 0, common: true });
ok(pr.sheets[0].shared > 0, 'общие кромки: ' + pr.sheets[0].shared + ' мм');


console.log('Трубы: деловые отходы');
const Calc = require('../src/calc.js');
const gR = L => ({ L, A: 40, B: 20, sym: 'rect', lo: [0, 0, 0, 0], ro: [L, L, L, L], angL: 90, angR: 90 });
const pcs = []; for (let i = 0; i < 10; i++) pcs.push({ key: 'a', name: 'A', g: gR(1100) }); for (let i = 0; i < 4; i++) pcs.push({ key: 'b', name: 'B', g: gR(2300) });
const T0 = Calc.nestWithStock(pcs, 6000, 5, 0, 0, []);
const T1 = Calc.nestWithStock(pcs, 6000, 5, 0, 0, [{ L: 2350, n: 2 }, { L: 1200, n: 3 }, { L: 500, n: 1 }]);
ok(T0.bars === 4 && T1.bars === 3, 'без отходов 4 хлыста, с отходами 3 (' + T0.bars + ' / ' + T1.bars + ')');
ok(T1.stockBars === 5 && T1.unused.length === 1 && T1.unused[0] === 500, 'использовано 5 отрезков, 500 мм не пригодился');
const placed = T1.patterns.reduce((s, p) => s + p.items.length * p.n, 0);
ok(placed === 14, 'все 14 деталей разложены');
const R5 = Calc.nestShapes(Array.from({ length: 15 }, () => ({ key: 'c', name: 'C', g: gR(400) })), 6000, 5, 0, 0);
ok(R5.bars === 2, '15 деталей по 400 мм с зазором 5 мм — 2 хлыста');

console.log('Excel');
const XL = require('../src/xlsx.js');
const xb = XL.build([{ name: 'Тест/1', rows: [['a', 1, { v: 2.5, s: 'n2' }]] }]);
ok(xb[0] === 0x50 && xb[1] === 0x4B && xb.length > 1000, 'xlsx собран (' + xb.length + ' байт)');

console.log(fail ? `\nОшибок: ${fail}` : '\nВсе проверки пройдены');
process.exit(fail ? 1 : 0);
