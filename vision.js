// Beeldbewerking: kentekenplaat vinden, rechtzetten en de letters schoon zwart-op-wit maken.
(function (root) {
  'use strict';

  const DETECT_W = 360;   // breedte waarop gezocht wordt naar de gele plaat
  const PLATE_H = 110;    // hoogte van de rechtgezette plaat in pixels voor OCR

  function rgbToHsv(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d) {
      if (max === r) h = 60 * (((g - b) / d) % 6);
      else if (max === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
      if (h < 0) h += 360;
    }
    return [h, max ? d / max : 0, max / 255];
  }

  // Strenge definitie om de plaat te vinden; geen grijze of witte vlakken.
  function isPlateYellow(r, g, b) {
    const [h, s, v] = rgbToHsv(r, g, b);
    return h >= 28 && h <= 70 && s >= 0.35 && v >= 0.35;
  }

  // Ruimere definitie binnen de plaat, zodat schaduw en glans nog als geel tellen.
  function isYellowish(r, g, b) {
    const [h, s, v] = rgbToHsv(r, g, b);
    return h >= 20 && h <= 75 && s >= 0.35 && v >= 0.4;
  }

  function context(c) {
    return c.getContext('2d', { willReadFrequently: true });
  }

  // Zoekt het grootste gele, langwerpige vlak. Geeft een gedraaide rechthoek terug
  // (midden, lengte, dikte, hoek) in coördinaten van de bronafbeelding.
  // Met `region` wordt alleen binnen dat kader gezocht (kader dat de gebruiker sleept).
  function findPlate(src, region) {
    const area = region || { x: 0, y: 0, w: src.width, h: src.height };
    const scale = Math.min(1, DETECT_W / area.w);
    const W = Math.max(1, Math.round(area.w * scale));
    const H = Math.max(1, Math.round(area.h * scale));
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = context(c);
    ctx.drawImage(src, area.x, area.y, area.w, area.h, 0, 0, W, H);
    const px = ctx.getImageData(0, 0, W, H).data;

    const yellow = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      if (isPlateYellow(px[i * 4], px[i * 4 + 1], px[i * 4 + 2])) yellow[i] = 1;
    }

    const seen = new Uint8Array(W * H);
    const stack = [];
    let best = null;
    for (let start = 0; start < W * H; start++) {
      if (!yellow[start] || seen[start]) continue;
      const pts = [];
      stack.push(start);
      seen[start] = 1;
      while (stack.length) {
        const p = stack.pop();
        pts.push(p);
        const x = p % W;
        if (x > 0 && yellow[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
        if (x < W - 1 && yellow[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
        if (p >= W && yellow[p - W] && !seen[p - W]) { seen[p - W] = 1; stack.push(p - W); }
        if (p < W * (H - 1) && yellow[p + W] && !seen[p + W]) { seen[p + W] = 1; stack.push(p + W); }
      }
      if (pts.length < 60) continue;
      const rect = orientedRect(pts, W);
      const ratio = rect.len / rect.thick;
      const fill = pts.length / (rect.len * rect.thick);
      if (ratio < 2 || ratio > 7 || fill < 0.4) continue;
      if (!best || pts.length > best.count) best = { ...rect, count: pts.length };
    }
    if (!best) return null;

    const k = 1 / scale;
    return {
      cx: area.x + best.cx * k,
      cy: area.y + best.cy * k,
      len: best.len * k,
      thick: best.thick * k,
      angle: best.angle,
    };
  }

  // Hoofdas via momenten, daarna de afmetingen langs die assen.
  function orientedRect(pts, W) {
    let sx = 0, sy = 0;
    for (const p of pts) { sx += p % W; sy += (p - (p % W)) / W; }
    const cx = sx / pts.length, cy = sy / pts.length;
    let xx = 0, yy = 0, xy = 0;
    for (const p of pts) {
      const dx = (p % W) - cx, dy = (p - (p % W)) / W - cy;
      xx += dx * dx; yy += dy * dy; xy += dx * dy;
    }
    const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
    const ca = Math.cos(angle), sa = Math.sin(angle);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of pts) {
      const dx = (p % W) - cx, dy = (p - (p % W)) / W - cy;
      const u = dx * ca + dy * sa, v = -dx * sa + dy * ca;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const mu = (minU + maxU) / 2, mv = (minV + maxV) / 2;
    return {
      cx: cx + mu * ca - mv * sa,
      cy: cy + mu * sa + mv * ca,
      len: maxU - minU + 1,
      thick: maxV - minV + 1,
      angle,
    };
  }

  // Snijdt de plaat recht uit: horizontaal, vaste hoogte, met wat marge rondom.
  function straighten(src, plate) {
    const s = PLATE_H / plate.thick;
    const pad = Math.round(PLATE_H * 0.15);
    const c = document.createElement('canvas');
    c.width = Math.round(plate.len * s) + 2 * pad;
    c.height = PLATE_H + 2 * pad;
    const ctx = context(c);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(-plate.angle);
    ctx.scale(s, s);
    ctx.translate(-plate.cx, -plate.cy);
    ctx.drawImage(src, 0, 0);
    return c;
  }

  // Zwart-wit masker: 1 = mogelijk letter. Twee methodes, zodat er een tweede kans is.
  function maskYellow(img) {
    const d = img.data, n = img.width * img.height, m = new Uint8Array(n);
    for (let i = 0; i < n; i++) m[i] = isYellowish(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) ? 0 : 1;
    return m;
  }

  function maskOtsu(img) {
    const d = img.data, n = img.width * img.height;
    const gray = new Uint8Array(n), hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) {
      const v = Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]);
      gray[i] = v;
      hist[v]++;
    }
    const t = otsu(hist, n);
    const m = new Uint8Array(n);
    for (let i = 0; i < n; i++) m[i] = gray[i] <= t ? 1 : 0;
    return m;
  }

  function otsu(hist, total) {
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, threshold = 127;
    for (let i = 0; i < 256; i++) {
      wB += hist[i];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; threshold = i; }
    }
    return threshold;
  }

  // Houdt alleen vlekken over die op letters, cijfers of streepjes lijken:
  // niet aan de rand (blauwe strook, plaatrand, bumper) en niet te klein of te groot.
  function keepGlyphs(mask, W, H) {
    const label = new Int32Array(W * H).fill(-1);
    const out = new Uint8Array(W * H);
    const stack = [];
    const glyphs = [];
    for (let start = 0; start < W * H; start++) {
      if (!mask[start] || label[start] !== -1) continue;
      const pts = [];
      let minX = W, maxX = 0, minY = H, maxY = 0, edge = false;
      stack.push(start);
      label[start] = start;
      while (stack.length) {
        const p = stack.pop();
        pts.push(p);
        const x = p % W, y = (p - x) / W;
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) edge = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x > 0 && mask[p - 1] && label[p - 1] === -1) { label[p - 1] = start; stack.push(p - 1); }
        if (x < W - 1 && mask[p + 1] && label[p + 1] === -1) { label[p + 1] = start; stack.push(p + 1); }
        if (y > 0 && mask[p - W] && label[p - W] === -1) { label[p - W] = start; stack.push(p - W); }
        if (y < H - 1 && mask[p + W] && label[p + W] === -1) { label[p + W] = start; stack.push(p + W); }
      }
      if (edge) continue;
      const w = maxX - minX + 1, h = maxY - minY + 1;
      const isChar = h >= PLATE_H * 0.4 && h <= PLATE_H * 0.98 && w <= PLATE_H * 0.9 && pts.length >= 40;
      const isDash = h < PLATE_H * 0.3 && w > h && w >= PLATE_H * 0.1 && w <= PLATE_H * 0.5 && pts.length >= 15;
      if (!isChar && !isDash) continue;
      glyphs.push({ pts, isChar, cy: (minY + maxY) / 2 });
    }
    // Streepjes horen ongeveer in het midden van de letters te liggen.
    const chars = glyphs.filter((g) => g.isChar);
    if (!chars.length) return { mask: out, count: 0 };
    const mid = chars.reduce((a, g) => a + g.cy, 0) / chars.length;
    for (const g of glyphs) {
      if (!g.isChar && Math.abs(g.cy - mid) > PLATE_H * 0.2) continue;
      for (const p of g.pts) out[p] = 1;
    }
    return { mask: out, count: chars.length };
  }

  // Zoekt de helling waarbij de letters het meest rechtop staan (scherpste kolomprofiel).
  function bestShear(mask, W, H) {
    const pts = [];
    for (let i = 0; i < W * H; i++) if (mask[i]) pts.push(i);
    let best = 0, bestScore = -1;
    for (let k = -0.6; k <= 0.601; k += 0.05) {
      const cols = new Float64Array(W + 2 * H);
      for (const p of pts) {
        const x = p % W, y = (p - x) / W;
        cols[Math.round(x + k * (y - H / 2)) + H]++;
      }
      let score = 0;
      for (const v of cols) score += v * v;
      if (score > bestScore) { bestScore = score; best = k; }
    }
    return best;
  }

  // Maakt van een masker een OCR-klaar plaatje: zwart op wit, rechtgetrokken, met witte rand.
  function render(mask, W, H, shear) {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = context(c);
    const img = ctx.createImageData(W, H);
    for (let i = 0; i < W * H; i++) {
      const v = mask[i] ? 0 : 255;
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const extra = Math.ceil(Math.abs(shear) * H / 2);
    const out = document.createElement('canvas');
    out.width = W + 2 * extra + 40;
    out.height = H + 40;
    const octx = out.getContext('2d');
    octx.fillStyle = '#fff';
    octx.fillRect(0, 0, out.width, out.height);
    octx.setTransform(1, 0, shear, 1, 20 + extra - shear * H / 2, 20);
    octx.drawImage(c, 0, 0);
    return out;
  }

  // Geeft OCR-varianten van de plaat, beste eerst. Leeg als er geen plaat is.
  function plateVariants(src, plate) {
    const c = straighten(src, plate);
    const W = c.width, H = c.height;
    const img = context(c).getImageData(0, 0, W, H);
    const variants = [];
    for (const mask of [maskOtsu(img), maskYellow(img)]) {
      const g = keepGlyphs(mask, W, H);
      if (g.count < 3) continue;
      variants.push(render(g.mask, W, H, bestShear(g.mask, W, H)));
    }
    return variants;
  }

  // Voor een zelf gesleept kader zonder herkenbare gele plaat: alleen rechte uitsnede en Otsu.
  function regionVariant(src, region) {
    const s = Math.min(4, (PLATE_H * 1.4) / region.h);
    const W = Math.max(1, Math.round(region.w * s)), H = Math.max(1, Math.round(region.h * s));
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = context(c);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, region.x, region.y, region.w, region.h, 0, 0, W, H);
    const mask = maskOtsu(ctx.getImageData(0, 0, W, H));
    return render(mask, W, H, bestShear(mask, W, H));
  }

  root.Vision = { findPlate, plateVariants, regionVariant, straighten };
})(self);
