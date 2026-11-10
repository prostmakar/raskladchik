// ===== Простой 3D-просмотр детали (рёбра модели), Canvas 2D, вращение мышью =====
(function (root) {
  'use strict';
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

  // view: {edges:[{p:[[x,y,z]...], c: номер контура или -1}], axis:[x,y,z]}
  // opt: {colorOf(c) -> css, hl: номер выделенного контура}
  function Viewer(canvas, view, opt) {
    this.cv = canvas; this.view = view; this.opt = opt || {};
    // базис: ось трубы -> X экрана
    const ax = norm(view.axis || [1, 0, 0]);
    const u = norm(cross(ax, Math.abs(ax[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0])), v = cross(ax, u);
    this.B = [ax, v, u];
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    this.P = view.edges.map(e => e.p.map(q => { const r = [dot(q, this.B[0]), dot(q, this.B[1]), dot(q, this.B[2])]; for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], r[k]); hi[k] = Math.max(hi[k], r[k]); } return r; }));
    this.c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    this.size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1);
    this.home(); this.bind();
  }
  Viewer.prototype.home = function (which) {
    const p = { iso: this.opt.iso || [-0.6, 0.45], top: [0, Math.PI / 2 - 0.001], front: [0, 0], end: [-Math.PI / 2, 0.0001] }[which || 'iso'];
    this.yaw = p[0]; this.pitch = p[1]; this.zoom = 1; this.pan = [0, 0]; this.draw();
  };
  Viewer.prototype.project = function (q) {
    const x0 = q[0] - this.c[0], y0 = q[1] - this.c[1], z0 = q[2] - this.c[2];
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const x1 = x0 * cy + z0 * sy, z1 = -x0 * sy + z0 * cy;      // вокруг вертикали
    const y2 = y0 * cp - z1 * sp, z2 = y0 * sp + z1 * cp;       // наклон
    return [x1, y2, z2];
  };
  Viewer.prototype.draw = function () {
    const cv = this.cv, dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = cv.clientHeight; if (!W || !H) return;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    // масштаб по проекции
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const pr = this.P.map(L => L.map(q => { const r = this.project(q); x0 = Math.min(x0, r[0]); x1 = Math.max(x1, r[0]); y0 = Math.min(y0, r[1]); y1 = Math.max(y1, r[1]); return r; }));
    const k = Math.min((W - 40) / Math.max(x1 - x0, 1e-6), (H - 40) / Math.max(y1 - y0, 1e-6)) * this.zoom;
    const ox = W / 2 + this.pan[0] - (x0 + x1) / 2 * k, oy = H / 2 + this.pan[1] + (y0 + y1) / 2 * k;
    const css = getComputedStyle(cv);
    const base = css.getPropertyValue('--muted').trim() || '#888';
    const hl = this.opt.hl;
    // сначала обычные рёбра, затем линии реза
    for (const pass of [0, 1]) {
      this.view.edges.forEach((e, i) => {
        const cut = e.c >= 0; if ((pass === 1) !== cut) return;
        const L = pr[i]; if (L.length < 2) return;
        g.beginPath(); g.moveTo(ox + L[0][0] * k, oy - L[0][1] * k);
        for (let j = 1; j < L.length; j++) g.lineTo(ox + L[j][0] * k, oy - L[j][1] * k);
        if (!cut) { g.strokeStyle = base; g.globalAlpha = 0.45; g.lineWidth = 1; }
        else { g.strokeStyle = this.opt.colorOf ? this.opt.colorOf(e.c) : '#d9480f'; g.globalAlpha = hl === undefined || hl === null || hl === e.c ? 1 : 0.25; g.lineWidth = hl === e.c ? 4 : 2.2; }
        g.stroke();
      });
    }
    g.globalAlpha = 1;
  };
  Viewer.prototype.bind = function () {
    const cv = this.cv; let drag = null;
    this._down = e => { drag = { x: e.clientX, y: e.clientY, yaw: this.yaw, pitch: this.pitch, pan: this.pan.slice(), pan_: e.button === 2 || e.shiftKey }; e.preventDefault(); };
    this._move = e => { if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (drag.pan_) this.pan = [drag.pan[0] + dx, drag.pan[1] + dy];
      else { this.yaw = drag.yaw + dx * 0.01; this.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, drag.pitch + dy * 0.01)); }
      this.draw(); };
    this._up = () => { drag = null; };
    this._wheel = e => { e.preventDefault(); const r = cv.getBoundingClientRect(); const k = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      const mx = e.clientX - r.left - r.width / 2 - this.pan[0], my = e.clientY - r.top - r.height / 2 - this.pan[1];
      this.pan = [this.pan[0] - mx * (k - 1), this.pan[1] - my * (k - 1)]; this.zoom *= k; this.draw(); };
    this._ctx = e => e.preventDefault();
    this._resize = () => this.draw();
    cv.addEventListener('mousedown', this._down); window.addEventListener('mousemove', this._move); window.addEventListener('mouseup', this._up);
    cv.addEventListener('wheel', this._wheel, { passive: false }); cv.addEventListener('contextmenu', this._ctx); window.addEventListener('resize', this._resize);
  };
  Viewer.prototype.destroy = function () {
    const cv = this.cv;
    cv.removeEventListener('mousedown', this._down); window.removeEventListener('mousemove', this._move); window.removeEventListener('mouseup', this._up);
    cv.removeEventListener('wheel', this._wheel); cv.removeEventListener('contextmenu', this._ctx); window.removeEventListener('resize', this._resize);
  };
  root.View3D = { Viewer };
})(typeof window !== 'undefined' ? window : globalThis);
