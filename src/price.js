// ===== Стоимость листового реза: личные тарифы и расчёт =====
(function (root) {
  'use strict';
  const KEY = 'sheet.prices.v1';
  const MATS = ['st3', 'aisi', '09g2s', 'st20', 'zn'];
  const THICK = [0.5, 0.8, 1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 14, 16, 20, 25, 30, 32, 35, 36, 40];
  const ST3 = { 1: 1, 2: 1.15, 3: 1.4, 4: 1.75, 5: 1.8, 6: 2, 8: 2.55, 10: 4.35, 12: 5.15, 14: 6.15, 16: 7.05, 20: 8.5, 25: 15.6, 30: 25.35, 32: 29.25, 35: 35.1, 36: 35.1, 40: 60 };
  const num = v => { const n = +String(v === undefined || v === null ? '' : v).trim().replace(',', '.'); return isFinite(n) && n >= 0 ? n : 0; };
  const nonNeg = (v, d) => { if (v === undefined || v === null || String(v).trim() === '') return d; const n = +String(v).trim().replace(',', '.'); return isFinite(n) && n >= 0 ? n : d; };
  function defaults() {
    const out = {};
    for (const m of MATS) out[m] = { metalLow: 3, metalHigh: 2.5, cut: Object.assign({}, ST3) };
    return out;
  }
  function normalize(raw) {
    const out = defaults();
    for (const m of MATS) {
      const src = raw && raw[m]; if (!src) continue;
      out[m].metalLow = nonNeg(src.metalLow, out[m].metalLow);
      out[m].metalHigh = nonNeg(src.metalHigh, out[m].metalHigh);
      for (const t of THICK) out[m].cut[t] = nonNeg(src.cut && src.cut[t], out[m].cut[t]);
    }
    return out;
  }
  function load() {
    let raw = null;
    try { raw = JSON.parse(root.localStorage.getItem(KEY) || 'null'); } catch (e) {}
    return normalize(raw);
  }
  function save(prices) {
    try { root.localStorage.setItem(KEY, JSON.stringify(normalize(prices))); return true; } catch (e) { return false; }
  }
  const metalRate = (prices, mat, t) => num(t) <= 3 ? prices[mat].metalLow : prices[mat].metalHigh;
  const cutRate = (prices, mat, t) => nonNeg(prices[mat] && prices[mat].cut && prices[mat].cut[t], 0);
  function calculate(rows) {
    const items = (rows || []).map(r => {
      const metal = num(r.mass) * num(r.metalRate), cut = num(r.length) * num(r.cutRate);
      const works = (r.extras || []).map(x => ({ name: String(x.name || ''), amount: num(x.amount) }));
      const extra = works.reduce((s, x) => s + x.amount, 0);
      return Object.assign({}, r, { works, metal, cut, extra, total: metal + cut + extra });
    });
    const metal = items.reduce((s, x) => s + x.metal, 0), cut = items.reduce((s, x) => s + x.cut, 0), extra = items.reduce((s, x) => s + x.extra, 0);
    return { items, metal, cut, extra, total: metal + cut + extra };
  }
  // доля суммы sum по весам: вес 0 у всех — поровну
  function share(weights, sum) {
    const w = (weights || []).map(x => num(x));
    const tot = w.reduce((s, x) => s + x, 0), s = num(sum);
    if (!w.length) return [];
    if (!(tot > 0)) return w.map(() => s / w.length);
    return w.map(x => s * x / tot);
  }
  const api = { KEY, MATS, THICK, defaults, normalize, load, save, metalRate, cutRate, calculate, share };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SheetPrice = api;
})(typeof window !== 'undefined' ? window : globalThis);
