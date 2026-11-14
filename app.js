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
  let plate = null;   // gevonden plaat: {cx, cy, len, thick, angle} in foto-pixels
  let box = null;     // kader dat de gebruiker sleept: {x, y, w, h}
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

  // ---------- preview met sleepbaar kader ----------

  function drawPreview() {
    const c = els.canvas;
    c.width = photo.width;
    c.height = photo.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(photo, 0, 0);
    ctx.lineWidth = Math.max(3, photo.width / 200);
    if (box) {
      ctx.strokeStyle = '#ffffff';
      ctx.setLineDash([12, 8]);
      ctx.strokeRect(box.x, box.y, box.w, box.h);
      ctx.setLineDash([]);
    }
    if (plate) {
      ctx.save();
      ctx.translate(plate.cx, plate.cy);
      ctx.rotate(plate.angle);
      ctx.strokeStyle = '#00e676';
      ctx.strokeRect(-plate.len / 2, -plate.thick / 2, plate.len, plate.thick);
      ctx.restore();
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
    plate = null;
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
    if (box && box.w > 20 && box.h > 8) {
      plate = Vision.findPlate(photo, box);
      drawPreview();
      scan();
    } else {
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
    els.input.value = '';
    setStatus('Foto laden…');
    try {
      photo = toCanvas(await loadImage(file));
    } catch (err) {
      setStatus(err.message, true);
      return;
    }
    box = null;
    plate = Vision.findPlate(photo);
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

      // Elke variant van de plaat lezen; kandidaten van de zekerste lezing eerst.
      const variants = plate ? Vision.plateVariants(photo, plate) : box ? [Vision.regionVariant(photo, box)] : [];
      const reads = [];
      await worker.setParameters({ tessedit_pageseg_mode: '7' }); // één regel
      for (const v of variants) {
        const { data } = await worker.recognize(v);
        if (id !== scanId) return;
        reads.push({ found: Plate.candidates(data.text), conf: data.confidence });
      }
      reads.sort((x, y) => y.conf - x.conf);
      let found = [...new Set(reads.flatMap((r) => r.found))];
      if (!found.length && !box) {
        // Geen plaat gevonden of niets leesbaars: hele foto doorzoeken op losse tekst.
        await worker.setParameters({ tessedit_pageseg_mode: '11' });
        found = Plate.candidates((await worker.recognize(photo)).data.text);
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
