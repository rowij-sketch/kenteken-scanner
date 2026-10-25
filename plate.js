// Kentekenlogica: herkent Nederlandse sidecodes en corrigeert typische OCR-fouten.
// Werkt zowel in de browser (window.Plate) als in Node (module.exports) voor de tests.
(function (root) {
  'use strict';

  // L = letter, D = cijfer. Groepen bepalen waar de streepjes staan.
  const SIDECODES = [
    ['LL', 'DD', 'DD'], // 1  XX-99-99
    ['DD', 'DD', 'LL'], // 2  99-99-XX
    ['DD', 'LL', 'DD'], // 3  99-XX-99
    ['LL', 'DD', 'LL'], // 4  XX-99-XX
    ['LL', 'LL', 'DD'], // 5  XX-XX-99
    ['DD', 'LL', 'LL'], // 6  99-XX-XX
    ['DD', 'LLL', 'D'], // 7  99-XXX-9
    ['D', 'LLL', 'DD'], // 8  9-XXX-99
    ['LL', 'DDD', 'L'], // 9  XX-999-X
    ['L', 'DDD', 'LL'], // 10 X-999-XX
    ['LLL', 'DD', 'L'], // 11 XXX-99-X
    ['L', 'DD', 'LLL'], // 12 X-99-XXX
    ['D', 'LL', 'DDD'], // 13 9-XX-999
    ['DDD', 'LL', 'D'], // 14 999-XX-9
  ].map((groups) => ({ groups, pattern: groups.join('') }));

  // Tekens die OCR vaak verwisselt, per gewenst type.
  const TO_DIGIT = { O: '0', Q: '0', D: '0', U: '0', I: '1', L: '1', J: '1', T: '7', Z: '2', S: '5', B: '8', G: '6', A: '4' };
  const TO_LETTER = { 0: 'D', 1: 'J', 2: 'Z', 4: 'A', 5: 'S', 6: 'G', 7: 'T', 8: 'B' };

  const isDigit = (c) => c >= '0' && c <= '9';
  const isLetter = (c) => c >= 'A' && c <= 'Z';

  function clean(text) {
    return String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  // Past een ruwe reeks van 6 tekens op een sidecode. Geeft null als dat niet kan.
  function fit(raw, sidecode) {
    let out = '';
    let fixes = 0;
    for (let i = 0; i < 6; i++) {
      const want = sidecode.pattern[i];
      let c = raw[i];
      if (want === 'D' && !isDigit(c)) {
        if (!TO_DIGIT[c]) return null;
        c = TO_DIGIT[c];
        fixes++;
      } else if (want === 'L' && !isLetter(c)) {
        if (!TO_LETTER[c]) return null;
        c = TO_LETTER[c];
        fixes++;
      }
      out += c;
    }
    return { plate: out, fixes, sidecode };
  }

  // Beste interpretatie van precies 6 tekens, of null.
  function bestFit(raw, preferredGroups) {
    let best = null;
    for (const sc of SIDECODES) {
      const r = fit(raw, sc);
      if (!r) continue;
      // Als de OCR streepjes zag, telt een sidecode met dezelfde groepen zwaarder.
      const groupBonus = preferredGroups && preferredGroups.join() === sc.groups.map((g) => g.length).join() ? -1.5 : 0;
      const score = r.fixes + groupBonus;
      if (!best || score < best.score) best = { ...r, score };
    }
    return best;
  }

  function format(plate) {
    const p = clean(plate);
    if (p.length !== 6) return p;
    const pattern = [...p].map((c) => (isDigit(c) ? 'D' : 'L')).join('');
    const sc = SIDECODES.find((s) => s.pattern === pattern);
    if (!sc) return p;
    const parts = [];
    let i = 0;
    for (const g of sc.groups) {
      parts.push(p.slice(i, i + g.length));
      i += g.length;
    }
    return parts.join('-');
  }

  function isValid(plate) {
    const p = clean(plate);
    if (p.length !== 6) return false;
    const pattern = [...p].map((c) => (isDigit(c) ? 'D' : 'L')).join('');
    return SIDECODES.some((s) => s.pattern === pattern);
  }

  // Haalt kandidaat-kentekens uit ruwe OCR-tekst, beste eerst.
  function candidates(ocrText) {
    const seen = new Map();
    const add = (r, bonus) => {
      if (!r) return;
      const score = r.score + bonus;
      const prev = seen.get(r.plate);
      if (prev === undefined || score < prev) seen.set(r.plate, score);
    };

    const lines = String(ocrText || '').toUpperCase().split(/\n+/);
    for (const line of lines) {
      // Groepen gescheiden door streepjes of spaties, zoals ze op de plaat staan.
      const groups = line.split(/[^A-Z0-9]+/).filter(Boolean);
      for (let start = 0; start < groups.length; start++) {
        for (let end = start + 1; end <= Math.min(groups.length, start + 3); end++) {
          const chunk = groups.slice(start, end);
          const joined = chunk.join('');
          if (joined.length === 6) {
            add(bestFit(joined, chunk.length === 3 ? chunk.map((g) => g.length) : null), 0);
          }
        }
      }
      // Daarnaast elk venster van 6 tekens, voor als OCR streepjes mist of rommel toevoegt.
      let flat = clean(line);
      if (flat.startsWith('NL') && flat.length > 6) flat = flat.slice(2);
      for (let i = 0; i + 6 <= flat.length; i++) {
        add(bestFit(flat.slice(i, i + 6)), flat.length === 6 ? 0.25 : 1 + i * 0.01);
      }
    }
    return [...seen.entries()].sort((a, b) => a[1] - b[1]).map(([plate]) => plate);
  }

  const api = { clean, format, isValid, candidates, SIDECODES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Plate = api;
})(typeof self !== 'undefined' ? self : this);
