// ===== TIFF -> PDF wrapper (so pdf.js can render scans) + PDF text helpers =====
(function (root) {
  'use strict';

  function readTiff(buf) {
    const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const bo = String.fromCharCode(u8[0], u8[1]);
    if (bo !== 'II' && bo !== 'MM') throw new Error('Это не TIFF-файл');
    const le = bo === 'II';
    const u16 = o => dv.getUint16(o, le), u32 = o => dv.getUint32(o, le);
    if (u16(2) !== 42) throw new Error('Неподдерживаемый TIFF (BigTIFF)');
    const pages = [];
    let ifd = u32(4), guard = 0;
    while (ifd && guard++ < 50) {
      const n = u16(ifd), tags = {};
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12, tag = u16(e), type = u16(e + 2), cnt = u32(e + 4);
        const sz = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 }[type] || 1;
        const off = cnt * sz <= 4 ? e + 8 : u32(e + 8);
        const vals = [];
        for (let k = 0; k < Math.min(cnt, 4000000); k++) {
          const o = off + k * sz;
          if (type === 3 || type === 8) vals.push(u16(o));
          else if (type === 4 || type === 9) vals.push(u32(o));
          else if (type === 5) vals.push(u32(o) / (u32(o + 4) || 1));
          else vals.push(u8[o]);
        }
        tags[tag] = vals;
      }
      pages.push(tags);
      ifd = u32(ifd + 2 + n * 12);
    }
    return { u8, pages };
  }

  // Build a PDF (one page per TIFF page) using native PDF filters.
  function tiffToPdf(buf) {
    const { u8, pages } = readTiff(buf);
    const enc = new TextEncoder();
    const parts = []; let size = 0; const offsets = [];
    const push = b => { if (typeof b === 'string') b = enc.encode(b); parts.push(b); size += b.length; };
    const objs = []; // {id, dict, stream}
    let nextId = 3;
    const pageIds = [];
    const unsupported = [];
    for (const t of pages) {
      const W = t[256][0], H = t[257][0];
      const comp = (t[259] || [1])[0], photo = (t[262] || [0])[0];
      const bps = (t[258] || [1])[0], spp = (t[277] || [1])[0];
      const fill = (t[266] || [1])[0], pred = (t[317] || [1])[0];
      const rps = Math.min((t[278] || [H])[0], H);
      const isJpeg = comp === 7 || comp === 6;
      if (![1, 3, 4, 5, 6, 7, 8, 32946, 32773].includes(comp)) { unsupported.push('сжатие ' + comp); continue; }
      if (photo === 3 || photo === 4 || photo === 5 || (photo > 6) || (photo === 6 && !isJpeg)) { unsupported.push('цветовая модель ' + photo); continue; }
      // куски изображения: полосы или плитки
      const chunks = [];
      if (t[322] && t[323] && (t[324] || t[513])) {
        const tw = t[322][0], th = t[323][0];
        const to = t[324] || [], tc = t[325] || [];
        const across = Math.ceil(W / tw);
        for (let k = 0; k < to.length; k++) chunks.push({ off: to[k], len: tc[k], x: (k % across) * tw, y: Math.floor(k / across) * th, w: tw, h: th });
      } else if (t[273] && t[279]) {
        const so = t[273], sc = t[279];
        for (let k = 0; k < so.length; k++) { const rows = Math.min(rps, H - k * rps); if (rows <= 0) break; chunks.push({ off: so[k], len: sc[k], x: 0, y: k * rps, w: W, h: rows }); }
      }
      // старый JPEG (сжатие 6): обычно целый JPEG по ссылке 513
      if (comp === 6 && t[513] && t[514]) chunks.splice(0, chunks.length, { off: t[513][0], len: t[514][0], x: 0, y: 0, w: W, h: H, whole: true });
      if (!chunks.length) { unsupported.push('нет данных изображения'); continue; }
      const tables = t[347] ? new Uint8Array(t[347]) : null; // JPEGTables: SOI ... EOI
      const xobjs = [];
      let content = '';
      chunks.forEach((ch, s) => {
        let data = u8.subarray(ch.off, ch.off + ch.len);
        let filter = '', parms = '';
        const cs = spp >= 3 ? '/DeviceRGB' : '/DeviceGray';
        const ncomp = spp >= 3 ? 3 : 1;
        let bits = bps;
        if (isJpeg) {
          if (tables && tables.length > 4 && !ch.whole) { // таблицы без EOI + кусок без SOI
            const head = tables.subarray(0, tables.length - 2);
            const body = data[0] === 0xFF && data[1] === 0xD8 ? data.subarray(2) : data;
            const m = new Uint8Array(head.length + body.length); m.set(head, 0); m.set(body, head.length); data = m;
          }
          filter = '/Filter /DCTDecode';
          if (spp >= 3) parms = `/DecodeParms << /ColorTransform ${photo === 2 ? 0 : 1} >>`;
          bits = 8;
        } else {
          if (fill === 2) { data = data.slice(); for (let i = 0; i < data.length; i++) { let b = data[i], r = 0; for (let k = 0; k < 8; k++) { r = (r << 1) | (b & 1); b >>= 1; } data[i] = r; } }
          if (comp === 32773) { // PackBits -> raw
            const out = []; let i = 0;
            while (i < data.length) { const n = data[i] > 127 ? data[i] - 256 : data[i]; i++; if (n >= 0) { for (let k = 0; k <= n; k++) out.push(data[i++]); } else if (n !== -128) { const v = data[i++]; for (let k = 0; k < 1 - n; k++) out.push(v); } }
            data = new Uint8Array(out);
          }
          if (comp === 4 || comp === 3) {
            const t4 = (t[292] || [0])[0];
            const K = comp === 4 ? -1 : (t4 & 1 ? 1 : 0);
            filter = '/Filter /CCITTFaxDecode';
            parms = `/DecodeParms << /K ${K} /Columns ${ch.w} /Rows ${ch.h} /BlackIs1 true >>`;
            bits = 1;
          } else if (comp === 5 || comp === 8 || comp === 32946) {
            filter = comp === 5 ? '/Filter /LZWDecode' : '/Filter /FlateDecode';
            parms = `/DecodeParms << ${comp === 5 ? '/EarlyChange 1 ' : ''}/Predictor ${pred === 2 ? 2 : 1} /Colors ${ncomp} /BitsPerComponent ${bps} /Columns ${ch.w} >>`;
          }
        }
        const decode = photo === 0 ? '/Decode [1 0]' : '';
        const id = nextId++;
        objs.push({ id, dict: `<< /Type /XObject /Subtype /Image /Width ${ch.w} /Height ${ch.h} /ColorSpace ${cs} /BitsPerComponent ${bits} ${filter} ${parms} ${decode} /Length ${data.length} >>`, stream: data });
        xobjs.push(`/Im${s} ${id} 0 R`);
        content += `q ${ch.w} 0 0 ${ch.h} ${ch.x} ${H - ch.y - ch.h} cm /Im${s} Do Q\n`;
      });
      const cid = nextId++; const cbytes = enc.encode(content);
      objs.push({ id: cid, dict: `<< /Length ${cbytes.length} >>`, stream: cbytes });
      const pid = nextId++; pageIds.push(pid);
      objs.push({ id: pid, dict: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << ${xobjs.join(' ')} >> >> /Contents ${cid} 0 R >>` });
    }
    if (!pageIds.length) throw new Error('Этот TIFF не поддерживается (' + (unsupported[0] || 'неизвестный формат') + ')');
    objs.push({ id: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' });
    objs.push({ id: 2, dict: `<< /Type /Pages /Kids [${pageIds.map(i => i + ' 0 R').join(' ')}] /Count ${pageIds.length} >>` });
    objs.sort((a, b) => a.id - b.id);
    push('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n');
    for (const o of objs) {
      offsets[o.id] = size;
      push(`${o.id} 0 obj\n${o.dict}\n`);
      if (o.stream) { push('stream\n'); push(o.stream); push('\nendstream\n'); }
      push('endobj\n');
    }
    const xref = size; const n = objs.length + 1;
    let x = `xref\n0 ${n}\n0000000000 65535 f \n`;
    for (let i = 1; i < n; i++) x += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    push(x + `trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const out = new Uint8Array(size); let p = 0; for (const b of parts) { out.set(b, p); p += b.length; }
    return out;
  }

  root.Media = { readTiff, tiffToPdf };
  if (typeof module !== 'undefined') module.exports = root.Media;
})(typeof window !== 'undefined' ? window : globalThis);
