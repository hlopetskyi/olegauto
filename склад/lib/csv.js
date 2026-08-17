'use strict';

/**
 * Розбір і збірка CSV. Свій парсер, а не бібліотека: файли від клієнтів
 * бувають із крапкою з комою (Excel українською), з лапками й переносами
 * рядків усередині поля — усе це треба пережити.
 */

// Визначаємо роздільник за першим рядком: що частіше, те й роздільник.
function detectDelimiter(text) {
  const head = text.split(/\r?\n/)[0] || '';
  const counts = [[';', 0], [',', 0], ['\t', 0]].map(([d]) => {
    let n = 0, inQ = false;
    for (let i = 0; i < head.length; i++) {
      const ch = head[i];
      if (ch === '"') inQ = !inQ;
      else if (ch === d && !inQ) n++;
    }
    return [d, n];
  });
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

function parseCsv(text, delimiter) {
  const src = String(text).replace(/^﻿/, ''); // BOM від Excel
  const d = delimiter || detectDelimiter(src);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === d) { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  row.push(field);
  rows.push(row);

  return rows
    .map((r) => r.map((c) => c.trim()))
    .filter((r) => r.some((c) => c !== ''));
}

const escapeCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Excel українською читає крапку з комою; BOM потрібен, щоб не поламалась кирилиця.
const buildCsv = (rows) => '﻿' + rows.map((r) => r.map(escapeCell).join(';')).join('\r\n');

module.exports = { parseCsv, buildCsv, detectDelimiter };
