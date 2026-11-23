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
assert.equal(custom.st3.cut[2], 1.2);
assert.equal(prices.st3.cut[2], 1.15, 'нормализация не меняет исходные тарифы');

const result = P.calculate([
  { mass: 100, length: 10, metalRate: 3, cutRate: 1.15 },
  { mass: 200, length: 20, metalRate: 2.5, cutRate: 1.75 }
], [{ name: 'Доставка', amount: '25,50' }, { name: '', amount: '' }]);
assert.equal(result.items[0].metal, 300);
assert.equal(result.items[0].cut, 11.5);
assert.equal(result.items[1].metal, 500);
assert.equal(result.items[1].cut, 35);
assert.equal(result.extra, 25.5);
assert.equal(result.total, 872);

console.log('Все проверки стоимости пройдены');
