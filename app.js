(function () {
  'use strict';

  const RDW_BASE = 'https://opendata.rdw.nl/resource/m9d7-ebf2.json';
  const RDW_FUEL = 'https://opendata.rdw.nl/resource/8ys7-d773.json';
  const MAX_SIDE = 1600; // grote telefoonfoto's verkleinen, scheelt geheugen en tijd

  const $ = (id) => document.getElementById(id);
  const els = {
    camera: $('camera-input'),
    file: $('file-input'),
    preview: $('preview'),
    canvas: $('preview-canvas'),
    form: $('plate-form'),
    input: $('plate-input'),
    candidates: $('candidates'),
    candidateList: $('candidate-list'),
    status: $('status'),
    progress: $('progress'),
    result: $('result'),
  };

  let photo = null;   // canvas met de (verkleinde) foto
  let box = null;     // {x, y, w, h} in foto-pixels: waar het kenteken staat
  let workerPromise = null;
  let scanId = 0;     // om verouderde scans te negeren als er snel opnieuw gescand wordt

  // ---------- status ----------

  function setStatus(text, isError) {
    els.status.textContent = text || '';
    els.status.classList.toggle('error', !!isError);
  }

  function setProgress(value) {
    if (value == null) {
      els.progress.hidden = true;
      return;
    }
    els.progress.hidden = false;
    els.progress.value = value;
  }

  // ---------- OCR ----------

  function getWorker() {
    if (!workerPromise) {
      const base = new URL('vendor/', location.href).href;
      workerPromise = Tesseract.createWorker('eng', 1, {
        workerPath: base + 'worker.min.js',
        corePath: base + 'core/',
        langPath: base + 'lang/',
        logger: (m) => {
          if (m.status === 'recognizing text') setProgress(0.5 + m.progress / 2);
          else if (typeof m.progress === 'number') setProgress(m.progress / 2);
        },
      }).then(async (worker) => {
        await worker.setParameters({
          tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789- ',
        });
        return worker;
      }).catch((err) => {
        workerPromise = null;
        throw err;
      });
    }
    return workerPromise;
  }

  // ---------- foto laden ----------

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Deze foto kan ik niet openen.'));
      };
      img.src = url;
    });
  }

  function toCanvas(img) {
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  // ---------- kenteken vinden: het grootste gele, langwerpige vlak ----------

  function findPlate(src) {
    const W = 320;
    const scale = W / src.width;
    const H = Math.max(1, Math.round(src.height * scale));
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, W, H);
    const px = ctx.getImageData(0, 0, W, H).data;

    const yellow = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      if (max < 90 || max - min < 0.35 * max) continue;
      let h;
      if (max === r) h = 60 * (((g - b) / (max - min)) % 6);
      else if (max === g) h = 60 * ((b - r) / (max - min) + 2);
      else continue;
      if (h >= 30 && h <= 70) yellow[i] = 1;
    }

    const seen = new Uint8Array(W * H);
    const stack = [];
    let best = null;
    for (let start = 0; start < W * H; start++) {
      if (!yellow[start] || seen[start]) continue;
      let minX = W, minY = H, maxX = 0, maxY = 0, count = 0;
      stack.push(start);
      seen[start] = 1;
      while (stack.length) {
        const p = stack.pop();
        const x = p % W, y = (p - x) / W;
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x > 0 && yellow[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
        if (x < W - 1 && yellow[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
        if (y > 0 && yellow[p - W] && !seen[p - W]) { seen[p - W] = 1; stack.push(p - W); }
        if (y < H - 1 && yellow[p + W] && !seen[p + W]) { seen[p + W] = 1; stack.push(p + W); }
      }
      const w = maxX - minX + 1, h = maxY - minY + 1;
      const ratio = w / h;
      const fill = count / (w * h);
      if (count < 40 || ratio < 1.8 || ratio > 7 || fill < 0.35) continue;
      if (!best || count > best.count) best = { x: minX, y: minY, w, h, count };
    }
    if (!best) return null;

    // Iets ruimer nemen zodat randletters niet worden afgesneden.
    const padX = best.w * 0.04, padY = best.h * 0.12;
    const x = Math.max(0, (best.x - padX) / scale);
    const y = Math.max(0, (best.y - padY) / scale);
    return {
      x, y,
      w: Math.min(src.width - x, (best.w + 2 * padX) / scale),
      h: Math.min(src.height - y, (best.h + 2 * padY) / scale),
    };
  }

  // ---------- voorbewerking voor OCR ----------

  function prepareCrop(src, area) {
    const targetH = 140;
    const scale = targetH / area.h;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(area.w * scale));
    c.height = targetH;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, area.x, area.y, area.w, area.h, 0, 0, c.width, c.height);

    const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    const gray = new Uint8Array(c.width * c.height);
    const hist = new Uint32Array(256);
    for (let i = 0; i < gray.length; i++) {
      const v = Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]);
      gray[i] = v;
      hist[v]++;
    }
    const t = otsu(hist, gray.length);
    for (let i = 0; i < gray.length; i++) {
      const v = gray[i] > t ? 255 : 0;
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
      d[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);

    // Witte rand helpt Tesseract bij tekst die tot de rand loopt.
    const out = document.createElement('canvas');
    out.width = c.width + 40;
    out.height = c.height + 40;
    const octx = out.getContext('2d');
    octx.fillStyle = '#fff';
    octx.fillRect(0, 0, out.width, out.height);
    octx.drawImage(c, 20, 20);
    return out;
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

  // ---------- preview met sleepbaar kader ----------

  function drawPreview() {
    const c = els.canvas;
    c.width = photo.width;
    c.height = photo.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(photo, 0, 0);
    if (box) {
      const lw = Math.max(3, photo.width / 200);
      ctx.lineWidth = lw;
      ctx.strokeStyle = '#00e676';
      ctx.strokeRect(box.x, box.y, box.w, box.h);
    }
  }

  function canvasPoint(e) {
    const r = els.canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * els.canvas.width,
      y: ((e.clientY - r.top) / r.height) * els.canvas.height,
    };
  }

  let drag = null;
  els.canvas.addEventListener('pointerdown', (e) => {
    if (!photo) return;
    els.canvas.setPointerCapture(e.pointerId);
    drag = canvasPoint(e);
  });
  els.canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = canvasPoint(e);
    box = {
      x: Math.min(drag.x, p.x),
      y: Math.min(drag.y, p.y),
      w: Math.abs(p.x - drag.x),
      h: Math.abs(p.y - drag.y),
    };
    drawPreview();
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    if (box && box.w > 20 && box.h > 8) scan();
    else {
      box = null;
      drawPreview();
    }
  };
  els.canvas.addEventListener('pointerup', endDrag);
  els.canvas.addEventListener('pointercancel', endDrag);

  // ---------- scannen ----------

  async function onFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // zelfde foto nogmaals kiezen moet ook werken
    if (!file) return;
    els.result.hidden = true;
    els.candidates.hidden = true;
    setStatus('Foto laden…');
    try {
      photo = toCanvas(await loadImage(file));
    } catch (err) {
      setStatus(err.message, true);
      return;
    }
    box = findPlate(photo);
    els.preview.hidden = false;
    drawPreview();
    scan();
  }

  async function scan() {
    const id = ++scanId;
    setStatus(workerPromise ? 'Kenteken lezen…' : 'Tekstherkenning laden, eerste keer duurt dit even…');
    setProgress(0);
    try {
      const worker = await getWorker();
      if (id !== scanId) return;
      setStatus('Kenteken lezen…');

      let text = '';
      if (box) {
        await worker.setParameters({ tessedit_pageseg_mode: '7' }); // één regel
        text = (await worker.recognize(prepareCrop(photo, box))).data.text;
      }
      let found = Plate.candidates(text);
      if (!found.length) {
        // Geen plaat gevonden of niets leesbaars: hele foto doorzoeken op losse tekst.
        await worker.setParameters({ tessedit_pageseg_mode: '11' });
        text = (await worker.recognize(photo)).data.text;
        found = Plate.candidates(text);
      }
      if (id !== scanId) return;
      setProgress(null);

      if (!found.length) {
        setStatus('Ik kon geen kenteken lezen. Sleep een kader om het kenteken, of typ het zelf in.', true);
        return;
      }
      await lookup(found.slice(0, 6));
    } catch (err) {
      if (id !== scanId) return;
      setProgress(null);
      console.error(err);
      setStatus('Tekstherkenning werkt niet in deze browser. Typ het kenteken zelf in.', true);
    }
  }

  // ---------- RDW ----------

  async function rdw(url, plates) {
    const list = plates.map((p) => "'" + p + "'").join(',');
    const q = plates.length === 1 ? '?kenteken=' + plates[0] : '?$where=' + encodeURIComponent('kenteken in(' + list + ')');
    const res = await fetch(url + q, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('RDW gaf foutcode ' + res.status);
    return res.json();
  }

  // Zoekt de kandidaten in volgorde van waarschijnlijkheid op en toont de eerste die bestaat.
  async function lookup(plates) {
    plates = plates.map(Plate.clean).filter((p) => p.length >= 1);
    if (!plates.length) return;
    els.input.value = Plate.format(plates[0]);
    setStatus('Gegevens ophalen bij de RDW…');
    let rows;
    try {
      rows = await rdw(RDW_BASE, plates);
    } catch (err) {
      console.error(err);
      setStatus('De RDW is nu niet bereikbaar. Controleer je internetverbinding en probeer het opnieuw.', true);
      return;
    }

    const byPlate = new Map(rows.map((r) => [r.kenteken, r]));
    const hit = plates.find((p) => byPlate.has(p));
    showCandidates(plates.length > 1 ? plates.filter((p) => p !== hit && Plate.isValid(p)).slice(0, 4) : []);

    if (!hit) {
      els.result.hidden = true;
      setStatus(
        plates.length > 1
          ? 'Geen van de gelezen kentekens staat bij de RDW. Controleer het kenteken en pas het aan.'
          : 'Kenteken ' + Plate.format(plates[0]) + ' staat niet in de RDW-gegevens.',
        true,
      );
      return;
    }

    els.input.value = Plate.format(hit);
    history.replaceState(null, '', '?kenteken=' + hit);
    let fuel = [];
    try {
      fuel = await rdw(RDW_FUEL, [hit]);
    } catch (err) {
      console.warn('Brandstofgegevens niet beschikbaar', err);
    }
    setStatus('');
    render(byPlate.get(hit), fuel);
  }

  function showCandidates(list) {
    els.candidateList.textContent = '';
    els.candidates.hidden = !list.length;
    for (const p of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = Plate.format(p);
      b.addEventListener('click', () => lookup([p]));
      els.candidateList.appendChild(b);
    }
  }

  // ---------- weergave ----------

  function parseDate(s) {
    if (!s || !/^\d{8}$/.test(s)) return null;
    return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  }
  const dateText = (s) => {
    const d = parseDate(s);
    return d ? d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' }) : null;
  };
  const num = (s, unit) => (s && !isNaN(+s) ? (+s).toLocaleString('nl-NL') + (unit ? ' ' + unit : '') : null);
  const euro = (s) => (s && !isNaN(+s) ? (+s).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }) : null);
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : null);

  function render(v, fuel) {
    const r = els.result;
    r.textContent = '';

    const h = document.createElement('h2');
    h.textContent = [v.merk, v.handelsbenaming].filter(Boolean).join(' ');
    const sub = document.createElement('p');
    sub.className = 'sub';
    sub.textContent = [Plate.format(v.kenteken), v.voertuigsoort, cap(v.inrichting)].filter(Boolean).join(' · ');
    r.append(h, sub);

    const badges = document.createElement('div');
    badges.className = 'badges';
    const badge = (text, kind) => {
      const b = document.createElement('span');
      b.className = 'badge ' + kind;
      b.textContent = text;
      badges.appendChild(b);
    };
    const apk = parseDate(v.vervaldatum_apk);
    if (apk) {
      const days = (apk - new Date()) / 86400000;
      if (days < 0) badge('APK verlopen', 'bad');
      else if (days < 60) badge('APK verloopt binnenkort', 'warn');
      else badge('APK geldig', 'ok');
    }
    if (v.wam_verzekerd === 'Ja') badge('Verzekerd', 'ok');
    else if (v.wam_verzekerd === 'Nee') badge('Niet verzekerd', 'bad');
    if (v.openstaande_terugroepactie_indicator === 'Ja') badge('Open terugroepactie', 'bad');
    if (v.export_indicator === 'Ja') badge('Geëxporteerd', 'warn');
    if (v.taxi_indicator === 'Ja') badge('Taxi', 'warn');
    if (badges.children.length) r.appendChild(badges);

    const fuels = fuel.map((f) => f.brandstof_omschrijving).filter(Boolean);
    const f0 = fuel[0] || {};
    const kw = f0.nettomaximumvermogen && +f0.nettomaximumvermogen;

    const facts = [
      ['Kleur', cap(v.eerste_kleur)],
      ['Brandstof', fuels.length ? fuels.join(' + ') : null],
      ['Eerste toelating', dateText(v.datum_eerste_toelating)],
      ['In Nederland sinds', dateText(v.datum_eerste_tenaamstelling_in_nederland)],
      ['APK geldig tot', dateText(v.vervaldatum_apk)],
      ['Laatste tenaamstelling', dateText(v.datum_tenaamstelling)],
      ['Vermogen', kw ? kw.toLocaleString('nl-NL') + ' kW (' + Math.round(kw * 1.36) + ' pk)' : null],
      ['Cilinderinhoud', num(v.cilinderinhoud, 'cc')],
      ['Catalogusprijs', euro(v.catalogusprijs)],
      ['Zitplaatsen', num(v.aantal_zitplaatsen)],
      ['Deuren', num(v.aantal_deuren)],
      ['Massa rijklaar', num(v.massa_rijklaar, 'kg')],
      ['Trekgewicht geremd', num(v.maximum_trekken_massa_geremd, 'kg')],
      ['Trekgewicht ongeremd', num(v.maximum_massa_trekken_ongeremd, 'kg')],
      ['Verbruik', f0.brandstofverbruik_gecombineerd ? num(f0.brandstofverbruik_gecombineerd, 'l/100 km') : null],
      ['CO₂-uitstoot', num(f0.co2_uitstoot_gecombineerd, 'g/km')],
      ['Emissieklasse', f0.uitlaatemissieniveau || null],
      ['Tellerstand', v.tellerstandoordeel || null],
    ].filter(([, val]) => val);

    const dl = document.createElement('dl');
    dl.className = 'facts';
    for (const [k, val] of facts) {
      const row = document.createElement('div');
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = k;
      dd.textContent = val;
      row.append(dt, dd);
      dl.appendChild(row);
    }
    r.appendChild(dl);
    r.hidden = false;
    r.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------- invoer ----------

  els.camera.addEventListener('change', onFile);
  els.file.addEventListener('change', onFile);

  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const p = Plate.clean(els.input.value);
    if (p.length !== 6) {
      setStatus('Een Nederlands kenteken heeft 6 letters en cijfers.', true);
      els.input.focus();
      return;
    }
    scanId++; // een lopende scan mag dit niet meer overschrijven
    setProgress(null);
    lookup([p]);
  });

  els.input.addEventListener('blur', () => {
    if (els.input.value) els.input.value = Plate.format(els.input.value);
  });

  // Deelbare link: ?kenteken=GX434R
  const initial = new URLSearchParams(location.search).get('kenteken');
  if (initial && Plate.clean(initial).length === 6) lookup([Plate.clean(initial)]);
})();
