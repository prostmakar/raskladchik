// Проверки тарифов и стоимости листового реза: node tests/test_price.js
const P = require('../src/price.js');
const assert = require('node:assert/strict');

const expected = { 1: 1, 2: 1.15, 3: 1.4, 4: 1.75, 5: 1.8, 6: 2, 8: 2.55, 10: 4.35, 12: 5.15, 14: 6.15, 16: 7.05, 20: 8.5, 25: 15.6, 35: 35.1, 36: 35.1, 40: 60 };
const prices = P.defaults();
for (const [t, price] of Object.entries(expected)) assert.equal(P.cutRate(prices, 'st3', t), price, `Ст3, ${t} мм`);
for (const m of P.MATS) {
  assert.equal(prices[m].metalLow, 3);
  assert.equal(prices[m].metalHigh, 2.5);
  assert.equal(P.cutRate(prices, m, 2), 1.15);
}
assert.equal(P.metalRate(prices, 'st3', 3), 3);
assert.equal(P.metalRate(prices, 'st3', 4), 2.5);

const custom = P.normalize({ st3: { metalLow: '3,2', metalHigh: '2,7', cut: { 2: '1,2' } }, aisi: { cut: { 2: 2.4 } } });
assert.equal(custom.st3.metalLow, 3.2);
assert.equal(custom.st3.metalHigh, 2.7);
assert.equal(custom.st3.cut[2], 1.2);
assert.equal(custom.aisi.cut[2], 2.4);
assert.equal(custom.aisi.cut[3], 1.4);
assert.equal(prices.st3.cut[2], 1.15, 'нормализация не меняет исходные тарифы');

// доп. работы хранятся в каждой строке-группе
const result = P.calculate([
  { mass: 100, length: 10, metalRate: 3, cutRate: 1.15, extras: [{ name: 'Гибка', amount: '25,50' }, { name: '', amount: '' }] },
  { mass: 200, length: 20, metalRate: 2.5, cutRate: 1.75, extras: [{ name: 'Сварка', amount: 10 }] }
]);
assert.equal(result.items[0].metal, 300);
assert.equal(result.items[0].cut, 11.5);
assert.equal(result.items[0].extra, 25.5);
assert.equal(result.items[0].total, 337);
assert.equal(result.items[1].metal, 500);
assert.equal(result.items[1].cut, 35);
assert.equal(result.items[1].extra, 10);
assert.equal(result.metal, 800);
assert.equal(result.cut, 46.5);
assert.equal(result.extra, 35.5);
assert.equal(result.total, 882);

// распределение суммы по весам: пропорционально, не поровну
const sh = P.share([100, 200, 300], 150);
assert.deepEqual(sh, [25, 50, 75]);
assert.equal(sh.reduce((s, x) => s + x, 0), 150, 'доли в сумме дают исходную сумму');
const eq = P.share([0, 0, 0], 90);
assert.deepEqual(eq, [30, 30, 30], 'нулевые веса — делим поровну');
assert.deepEqual(P.share([], 90), []);
const zero = P.share([5, 5], 0);
assert.deepEqual(zero, [0, 0]);

console.log('Все проверки стоимости пройдены');
