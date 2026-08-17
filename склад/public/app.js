'use strict';

/* ============================================================ утиліти */

const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && !path.startsWith('/login')) {
    renderLogin();
    throw new Error('Не авторизовано');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Помилка запиту');
  return data;
}

const qs = (obj) => {
  const p = new URLSearchParams();
  Object.entries(obj).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p.set(k, v); });
  const s = p.toString();
  return s ? '?' + s : '';
};

function modal(html) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal">${html}</div>`;
  bg.addEventListener('click', (e) => { if (e.target === bg) bg.remove(); });
  document.body.appendChild(bg);
  const first = bg.querySelector('input, select, textarea');
  if (first) setTimeout(() => first.focus(), 40);
  return bg;
}

const closeModal = () => document.querySelectorAll('.modal-bg').forEach((m) => m.remove());

// Малює Code128 у вказаний <svg>. Висота підбирається під контекст.
function drawBarcode(svgEl, code, { height = 40, fontSize = 12, displayValue = true } = {}) {
  try {
    JsBarcode(svgEl, code, {
      format: 'CODE128',
      height,
      fontSize,
      displayValue,
      margin: 2,
      width: 1.6,
    });
  } catch (e) {
    svgEl.outerHTML = `<div class="small err">Код не намалювався: ${esc(code)}</div>`;
  }
}

const renderAllBarcodes = (root = document) =>
  root.querySelectorAll('svg[data-code]').forEach((el) => drawBarcode(el, el.dataset.code, {
    height: Number(el.dataset.h) || 40,
    fontSize: Number(el.dataset.fs) || 12,
  }));

/* ============================================================ вхід */

function renderLogin() {
  $('#topbar').hidden = true;
  app.innerHTML = `
    <div class="card" style="max-width:380px;margin:12vh auto">
      <h1>Склад запчастин</h1>
      <p class="muted small">Введіть пароль доступу.</p>
      <form id="loginForm">
        <label class="field"><span>Пароль</span><input type="password" id="pw" autofocus></label>
        <button class="primary" style="width:100%">Увійти</button>
      </form>
    </div>`;
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/login', { method: 'POST', body: { password: $('#pw').value } });
      $('#topbar').hidden = false;
      location.hash = '#/scan';
      route();
    } catch (err) { toast(err.message, 'err'); }
  });
}

/* ============================================================ сканування */

let scanner = null;

async function stopCamera() {
  if (scanner) { try { scanner.reset(); } catch (e) {} scanner = null; }
}

function viewScan() {
  app.innerHTML = `
    <div class="card scan-box">
      <h1>Сканувати</h1>
      <p class="muted small">Наведіть сканер і стрельніть у код, або введіть артикул/назву вручну.</p>
      <form id="scanForm">
        <input id="scanInput" autocomplete="off" placeholder="Код деталі, місця або артикул" autofocus>
      </form>
      <div class="row" style="justify-content:center;margin-top:12px">
        <button class="ghost sm" id="camBtn">📷 Камерою телефона</button>
      </div>
      <div id="reader" hidden></div>
    </div>
    <div id="scanResult"></div>`;

  const input = $('#scanInput');
  // Сканер-пістолет друкує код і тисне Enter — тому просто ловимо submit.
  $('#scanForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = input.value.trim();
    if (!code) return;
    await doResolve(code);
    input.value = '';
    input.focus();
  });

  // Фокус не має губитись, поки комірник ходить по складу.
  document.addEventListener('click', refocus);
  $('#camBtn').addEventListener('click', toggleCamera);
}

function refocus(e) {
  const inp = $('#scanInput');
  if (!inp) { document.removeEventListener('click', refocus); return; }
  if (e.target.closest('button, a, input, select, textarea, .modal-bg')) return;
  inp.focus();
}

async function toggleCamera() {
  const box = $('#reader');
  if (scanner) { await stopCamera(); box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = '<video id="cam" playsinline muted></video>';
  try {
    const hints = new Map();
    const { BrowserMultiFormatReader } = ZXing;
    scanner = new BrowserMultiFormatReader(hints);
    const devices = await scanner.listVideoInputDevices();
    // Задня камера читає наклейки, фронтальна — ні.
    const back = devices.find((d) => /back|rear|задн/i.test(d.label)) || devices[devices.length - 1];
    scanner.decodeFromVideoDevice(back ? back.deviceId : undefined, 'cam', (result, err) => {
      if (result) {
        const code = result.getText();
        stopCamera();
        box.hidden = true;
        doResolve(code);
      }
    });
  } catch (e) {
    toast('Камера недоступна: ' + e.message, 'err');
    box.hidden = true;
  }
}

async function doResolve(code) {
  const out = $('#scanResult');
  try {
    const r = await api('/resolve' + qs({ code }));
    if (r.type === 'part') out.innerHTML = partCardHtml(r.part);
    else if (r.type === 'location') out.innerHTML = locationCardHtml(r);
    else if (r.type === 'many') out.innerHTML = manyHtml(r);
    else out.innerHTML = `<div class="card"><h2>Нічого не знайдено</h2>
        <p class="muted">За запитом «${esc(r.query)}» нічого немає.
        <a href="#/parts?new=${encodeURIComponent(r.query)}">Створити запчастину?</a></p></div>`;
    renderAllBarcodes(out);
    bindCardActions(out);
    out.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) { toast(e.message, 'err'); }
}

function manyHtml(r) {
  return `<div class="card"><h2>Знайдено кілька: «${esc(r.query)}»</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>Назва</th><th>Артикул</th><th>Залишок</th></tr></thead>
      <tbody>${r.results.map((p) => `<tr>
        <td><a href="#/part/${p.id}">${esc(p.name)}</a></td>
        <td class="mono small">${esc(p.code)}</td>
        <td>${p.total_qty}</td></tr>`).join('')}</tbody>
    </table></div></div>`;
}

/* ------------------------------------------ картка деталі зі схемою */

function partCardHtml(p) {
  const qtyBadge = p.total_qty > 0
    ? `<span class="badge ok">${p.total_qty} ${esc(p.unit)}</span>`
    : '<span class="badge err">немає на складі</span>';

  const places = p.placements.length ? p.placements.map((pl) => `
    <div class="card" style="background:var(--panel-2);margin-bottom:10px">
      <div class="path">
        <span>${esc(pl.warehouse_name)}</span><span class="sep">→</span>
        ${pl.rack_name ? `<span>${esc(pl.rack_name)}</span><span class="sep">→</span>` : ''}
        ${pl.parent_label ? `<span>${esc(pl.parent_label)}</span><span class="sep">→</span>` : ''}
        <span class="final">${esc(pl.label)}</span>
        <span class="badge ok">${pl.qty} ${esc(p.unit)}</span>
      </div>
      ${pl.rack_id ? `<div class="rack" data-rack="${pl.rack_id}"
            data-hit-row="${pl.parent_row ?? pl.row_idx}" data-hit-col="${pl.parent_col ?? pl.col_idx}"></div>` : ''}
      <div class="row" style="margin-top:10px">
        <button class="sm" data-act="out" data-part="${p.id}" data-loc="${pl.location_id}">Видати</button>
        <button class="sm" data-act="move" data-part="${p.id}" data-loc="${pl.location_id}">Перемістити</button>
        <button class="sm ghost" data-act="adjust" data-part="${p.id}" data-loc="${pl.location_id}">Перерахувати</button>
      </div>
    </div>`).join('')
    : '<p class="muted">Ще не розміщено на складі. Натисніть «Прийняти на склад».</p>';

  return `
  <div class="card">
    <div class="row">
      <div class="grow">
        <h1>${esc(p.name)} ${qtyBadge}</h1>
        <div class="muted small">
          ${p.code ? `Артикул: <b class="mono">${esc(p.code)}</b> · ` : ''}
          ${p.oem ? `OEM: <b class="mono">${esc(p.oem)}</b> · ` : ''}
          ${[p.brand, p.car_make, p.car_model].filter(Boolean).map(esc).join(' · ')}
        </div>
        ${p.note ? `<p class="small">${esc(p.note)}</p>` : ''}
      </div>
      <div style="text-align:center">
        <svg data-code="${esc(p.barcode)}" data-h="46"></svg>
      </div>
    </div>
    <div class="row" style="margin-top:10px">
      <button class="primary sm" data-act="in" data-part="${p.id}">＋ Прийняти на склад</button>
      <button class="sm" data-act="edit-part" data-part="${p.id}">Редагувати</button>
      <a class="sm" href="#/labels?part=${p.id}"><button class="sm">🖨 Наклейка</button></a>
      <a class="sm" href="#/history?part=${p.id}"><button class="sm ghost">Історія</button></a>
    </div>
  </div>
  <h2>Де лежить</h2>
  ${places}`;
}

// Домальовує міні-схеми стелажів у щойно вставлену картку.
async function paintRacks(root) {
  const nodes = [...root.querySelectorAll('.rack[data-rack]')];
  for (const node of nodes) {
    try {
      const { rack, cells } = await api(`/racks/${node.dataset.rack}/grid`);
      const hitR = Number(node.dataset.hitRow), hitC = Number(node.dataset.hitCol);
      node.style.gridTemplateColumns = `repeat(${rack.cols}, minmax(64px, 1fr))`;
      node.innerHTML = cells.map((c) => {
        const hit = c.row_idx === hitR && c.col_idx === hitC;
        const cls = hit ? 'hit' : (c.qty > 0 ? 'filled' : 'empty');
        return `<button class="cell ${cls}" data-loc="${c.id}">
          <span class="lbl">${esc(c.label)}</span>
          <span class="qty">${c.qty || '·'}</span>
          ${c.boxes_count ? `<span class="boxes">${c.boxes_count} кор.</span>` : ''}
        </button>`;
      }).join('');
      node.querySelectorAll('.cell').forEach((b) =>
        b.addEventListener('click', () => openLocation(b.dataset.loc)));
    } catch (e) { node.innerHTML = `<span class="muted small">${esc(e.message)}</span>`; }
  }
}

/* ------------------------------------------------- картка місця */

function locationCardHtml(r) {
  const l = r.location;
  return `
  <div class="card">
    <div class="row">
      <div class="grow">
        <h1>${esc(l.label)}</h1>
        <div class="path">
          <span>${esc(l.warehouse_name)}</span>
          ${l.rack_name ? `<span class="sep">→</span><span>${esc(l.rack_name)}</span>` : ''}
          ${l.parent_label ? `<span class="sep">→</span><span>${esc(l.parent_label)}</span>` : ''}
        </div>
        ${l.note ? `<p class="small muted">${esc(l.note)}</p>` : ''}
      </div>
      <div style="text-align:center"><svg data-code="${esc(l.barcode)}" data-h="46"></svg></div>
    </div>
    <div class="row" style="margin-top:8px">
      <button class="primary sm" data-act="in-here" data-loc="${l.id}">＋ Покласти сюди деталь</button>
      <button class="sm" data-act="add-box" data-loc="${l.id}" data-wh="${l.warehouse_id}">＋ Коробка всередині</button>
      <a href="#/labels?loc=${l.id}"><button class="sm">🖨 Наклейка</button></a>
    </div>
  </div>
  ${r.boxes.length ? `<div class="card"><h2>Коробки тут</h2>
    <div class="table-wrap"><table><tbody>
      ${r.boxes.map((b) => `<tr>
        <td><a href="#" data-open-loc="${b.id}">${esc(b.label)}</a></td>
        <td class="mono small">${esc(b.barcode)}</td>
        <td>${b.qty} шт</td></tr>`).join('')}
    </tbody></table></div></div>` : ''}
  <div class="card">
    <h2>Що тут лежить (${r.items.length})</h2>
    ${r.items.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Назва</th><th>Артикул</th><th>Місце</th><th>К-сть</th><th></th></tr></thead>
      <tbody>${r.items.map((i) => `<tr>
        <td><a href="#/part/${i.id}">${esc(i.name)}</a></td>
        <td class="mono small">${esc(i.code)}</td>
        <td class="small muted">${esc(i.location_label)}</td>
        <td><b>${i.qty}</b></td>
        <td class="nowrap">
          <button class="sm" data-act="out" data-part="${i.id}" data-loc="${i.location_id}">Видати</button>
        </td></tr>`).join('')}</tbody>
    </table></div>` : '<p class="muted">Порожньо.</p>'}
  </div>`;
}

async function openLocation(locId) {
  const r = await api(`/locations/${locId}`);
  const bg = modal(`<div id="locModalBody"></div><div class="row" style="margin-top:10px">
    <button class="ghost right" onclick="this.closest('.modal-bg').remove()">Закрити</button></div>`);
  const body = bg.querySelector('#locModalBody');
  body.innerHTML = locationCardHtml(r);
  renderAllBarcodes(body);
  bindCardActions(body);
}

/* ============================================ дії над залишками */

function bindCardActions(root) {
  paintRacks(root);

  root.querySelectorAll('[data-open-loc]').forEach((a) =>
    a.addEventListener('click', (e) => { e.preventDefault(); openLocation(a.dataset.openLoc); }));

  root.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const act = btn.dataset.act;
      const partId = Number(btn.dataset.part);
      const locId = Number(btn.dataset.loc);
      if (act === 'in') return dlgPutStock(partId);
      if (act === 'in-here') return dlgPutIntoLocation(locId);
      if (act === 'out') return dlgQty('Видати зі складу', 'out', partId, locId);
      if (act === 'adjust') return dlgQty('Перерахунок (точна кількість у місці)', 'adjust', partId, locId);
      if (act === 'move') return dlgMove(partId, locId);
      if (act === 'edit-part') return dlgPart(await api(`/parts/${partId}`));
      if (act === 'add-box') return dlgAddBox(locId, Number(btn.dataset.wh));
    });
  });
}

const refreshAfter = async (partId) => {
  if (location.hash.startsWith('#/part/')) return route();
  if ($('#scanResult') && partId) {
    const p = await api(`/parts/${partId}`);
    $('#scanResult').innerHTML = partCardHtml(p);
    renderAllBarcodes($('#scanResult'));
    bindCardActions($('#scanResult'));
  } else route();
};

async function locationOptions(selected) {
  const locs = await api('/locations');
  return locs.map((l) => `<option value="${l.id}" ${l.id === selected ? 'selected' : ''}>
    ${esc([l.rack_name, l.parent_label, l.label].filter(Boolean).join(' → '))} (${l.qty} шт)
  </option>`).join('');
}

async function dlgQty(title, kind, partId, locId) {
  const bg = modal(`
    <h2>${esc(title)}</h2>
    <form id="f">
      <label class="field"><span>Кількість</span><input type="number" id="qty" value="1" min="0" step="1" required></label>
      <label class="field"><span>Коментар</span><input id="note" placeholder="напр. продано, замовлення №123"></label>
      <div class="row"><button class="primary grow">Підтвердити</button>
        <button type="button" class="ghost" onclick="this.closest('.modal-bg').remove()">Скасувати</button></div>
    </form>`);
  bg.querySelector('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/stock/' + kind, {
        method: 'POST',
        body: { part_id: partId, location_id: locId, qty: Number(bg.querySelector('#qty').value), note: bg.querySelector('#note').value },
      });
      closeModal(); toast('Готово', 'ok'); refreshAfter(partId);
    } catch (err) { toast(err.message, 'err'); }
  });
}

async function dlgPutStock(partId) {
  const opts = await locationOptions();
  const bg = modal(`
    <h2>Прийняти на склад</h2>
    <form id="f">
      <label class="field"><span>Місце</span><select id="loc" required>${opts}</select></label>
      <label class="field"><span>Кількість</span><input type="number" id="qty" value="1" min="1" required></label>
      <label class="field"><span>Коментар</span><input id="note" placeholder="напр. поставка від 17.08"></label>
      <div class="row"><button class="primary grow">Покласти</button>
        <button type="button" class="ghost" onclick="this.closest('.modal-bg').remove()">Скасувати</button></div>
    </form>
    <p class="small muted">Порада: щоб не шукати місце у списку — відскануйте наклейку місця, і кладіть деталь звідти.</p>`);
  bg.querySelector('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/stock/in', { method: 'POST', body: {
        part_id: partId,
        location_id: Number(bg.querySelector('#loc').value),
        qty: Number(bg.querySelector('#qty').value),
        note: bg.querySelector('#note').value,
      } });
      closeModal(); toast('Покладено', 'ok'); refreshAfter(partId);
    } catch (err) { toast(err.message, 'err'); }
  });
}

async function dlgPutIntoLocation(locId) {
  const parts = await api('/parts' + qs({ limit: 500 }));
  const bg = modal(`
    <h2>Покласти деталь у це місце</h2>
    <form id="f">
      <label class="field"><span>Деталь</span>
        <select id="part" required>${parts.map((p) => `<option value="${p.id}">${esc(p.name)} ${p.code ? '· ' + esc(p.code) : ''}</option>`).join('')}</select></label>
      <label class="field"><span>Кількість</span><input type="number" id="qty" value="1" min="1" required></label>
      <div class="row"><button class="primary grow">Покласти</button>
        <button type="button" class="ghost" onclick="this.closest('.modal-bg').remove()">Скасувати</button></div>
    </form>`);
  bg.querySelector('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/stock/in', { method: 'POST', body: {
        part_id: Number(bg.querySelector('#part').value), location_id: locId,
        qty: Number(bg.querySelector('#qty').value),
      } });
      closeModal(); toast('Покладено', 'ok'); route();
    } catch (err) { toast(err.message, 'err'); }
  });
}

async function dlgMove(partId, fromLoc) {
  const opts = await locationOptions();
  const bg = modal(`
    <h2>Перемістити в інше місце</h2>
    <form id="f">
      <label class="field"><span>Куди</span><select id="to" required>${opts}</select></label>
      <label class="field"><span>Кількість</span><input type="number" id="qty" value="1" min="1" required></label>
      <div class="row"><button class="primary grow">Перемістити</button>
        <button type="button" class="ghost" onclick="this.closest('.modal-bg').remove()">Скасувати</button></div>
    </form>`);
  bg.querySelector('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/stock/move', { method: 'POST', body: {
        part_id: partId, from_location_id: fromLoc,
        to_location_id: Number(bg.querySelector('#to').value),
        qty: Number(bg.querySelector('#qty').value),
      } });
      closeModal(); toast('Переміщено', 'ok'); refreshAfter(partId);
    } catch (err) { toast(err.message, 'err'); }
  });
}

async function dlgAddBox(parentId, warehouseId) {
  const bg = modal(`
    <h2>Нова коробка в цьому місці</h2>
    <form id="f">
      <label class="field"><span>Назва коробки</span><input id="label" placeholder="напр. Коробка 12 — датчики" required></label>
      <label class="field"><span>Примітка</span><input id="note"></label>
      <div class="row"><button class="primary grow">Створити</button>
        <button type="button" class="ghost" onclick="this.closest('.modal-bg').remove()">Скасувати</button></div>
    </form>`);
  bg.querySelector('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const parent = await api(`/locations/${parentId}`);
      await api('/locations', { method: 'POST', body: {
        warehouse_id: warehouseId || parent.location.warehouse_id,
        rack_id: parent.location.rack_id,
        parent_id: parentId, kind: 'box',
        label: bg.querySelector('#label').value, note: bg.querySelector('#note').value,
      } });
      closeModal(); toast('Коробку створено', 'ok'); route();
    } catch (err) { toast(err.message, 'err'); }
  });
}

/* ============================================================ запчастини */

async function viewParts(params) {
  const q = params.get('q') || '';
  app.innerHTML = `
    <div class="card">
      <div class="row">
        <h1 class="grow">Запчастини</h1>
        <button class="primary" id="addPart">＋ Нова запчастина</button>
      </div>
      <input id="q" placeholder="Пошук: назва, артикул, OEM, модель авто" value="${esc(q)}" autofocus>
      <label class="small muted" style="display:block;margin-top:8px">
        <input type="checkbox" id="low" style="width:auto"> лише те, що закінчується
      </label>
    </div>
    <div class="card"><div id="list" class="table-wrap">Завантаження…</div></div>`;

  const load = async () => {
    const low = $('#low').checked ? '1' : '';
    const items = await api('/parts' + qs({ q: $('#q').value, low, limit: 300 }));
    $('#list').innerHTML = items.length ? `<table>
      <thead><tr><th>Назва</th><th>Артикул</th><th>Авто</th><th>Залишок</th><th>Код</th></tr></thead>
      <tbody>${items.map((p) => `<tr>
        <td><a href="#/part/${p.id}">${esc(p.name)}</a></td>
        <td class="mono small">${esc(p.code)}</td>
        <td class="small muted">${esc([p.car_make, p.car_model].filter(Boolean).join(' '))}</td>
        <td>${p.total_qty > 0
            ? `<span class="badge ${p.min_qty > 0 && p.total_qty <= p.min_qty ? 'warn' : 'ok'}">${p.total_qty}</span>`
            : '<span class="badge err">0</span>'}</td>
        <td class="mono small muted">${esc(p.barcode)}</td>
      </tr>`).join('')}</tbody></table>` : '<p class="muted">Нічого не знайдено.</p>';
  };

  let timer;
  $('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 220); });
  $('#low').addEventListener('change', load);
  $('#addPart').addEventListener('click', () => dlgPart(null));
  await load();
  if (params.get('new')) dlgPart({ name: params.get('new') });
}

function dlgPart(p) {
  const v = (k) => esc(p?.[k] ?? '');
  const bg = modal(`
    <h2>${p?.id ? 'Редагувати запчастину' : 'Нова запчастина'}</h2>
    <form id="f">
      <label class="field"><span>Назва *</span><input id="name" value="${v('name')}" required></label>
      <div class="row">
        <label class="field grow"><span>Артикул (ваш код)</span><input id="code" value="${v('code')}"></label>
        <label class="field grow"><span>OEM-номер</span><input id="oem" value="${v('oem')}"></label>
      </div>
      <div class="row">
        <label class="field grow"><span>Виробник</span><input id="brand" value="${v('brand')}"></label>
        <label class="field grow"><span>Марка авто</span><input id="car_make" value="${v('car_make')}"></label>
        <label class="field grow"><span>Модель</span><input id="car_model" value="${v('car_model')}"></label>
      </div>
      <div class="row">
        <label class="field grow"><span>Одиниця</span><input id="unit" value="${p?.unit ? esc(p.unit) : 'шт'}"></label>
        <label class="field grow"><span>Мінімальний залишок</span><input type="number" id="min_qty" value="${p?.min_qty ?? 0}"></label>
        <label class="field grow"><span>Ціна</span><input type="number" step="0.01" id="price" value="${p?.price ?? 0}"></label>
      </div>
      <label class="field"><span>Примітка</span><textarea id="note">${v('note')}</textarea></label>
      <div class="row">
        <button class="primary grow">Зберегти</button>
        ${p?.id ? '<button type="button" class="danger" id="del">Видалити</button>' : ''}
        <button type="button" class="ghost" onclick="this.closest('.modal-bg').remove()">Скасувати</button>
      </div>
    </form>`);

  bg.querySelector('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {};
    ['name', 'code', 'oem', 'brand', 'car_make', 'car_model', 'unit', 'note'].forEach((k) => body[k] = bg.querySelector('#' + k).value);
    body.min_qty = Number(bg.querySelector('#min_qty').value) || 0;
    body.price = Number(bg.querySelector('#price').value) || 0;
    try {
      const saved = p?.id
        ? await api(`/parts/${p.id}`, { method: 'PUT', body })
        : await api('/parts', { method: 'POST', body });
      closeModal();
      toast('Збережено', 'ok');
      if (!p?.id) location.hash = `#/part/${saved.id}`; else route();
    } catch (err) { toast(err.message, 'err'); }
  });

  bg.querySelector('#del')?.addEventListener('click', async () => {
    if (!confirm('Видалити запчастину разом з усіма її залишками?')) return;
    await api(`/parts/${p.id}`, { method: 'DELETE' });
    closeModal(); toast('Видалено', 'ok'); location.hash = '#/parts';
  });
}

async function viewPart(id) {
  const p = await api(`/parts/${id}`);
  app.innerHTML = partCardHtml(p);
  renderAllBarcodes(app);
  bindCardActions(app);
}

/* ============================================================ склади */

async function viewWarehouses() {
  const [d, whs] = await Promise.all([api('/dashboard'), api('/warehouses')]);
  app.innerHTML = `
    <div class="card">
      <h1>Огляд</h1>
      <div class="stats">
        <div class="stat"><b>${d.warehouses}</b><span>складів</span></div>
        <div class="stat"><b>${d.racks}</b><span>стелажів</span></div>
        <div class="stat"><b>${d.locations}</b><span>місць</span></div>
        <div class="stat"><b>${d.parts}</b><span>найменувань</span></div>
        <div class="stat"><b>${d.total_qty}</b><span>штук усього</span></div>
        <div class="stat"><b>${d.unplaced}</b><span>без місця</span></div>
      </div>
    </div>
    <div class="card">
      <div class="row"><h2 class="grow">Склади</h2><button class="primary sm" id="addWh">＋ Склад</button></div>
      ${whs.length ? whs.map((w) => `
        <div class="card" style="background:var(--panel-2)">
          <div class="row">
            <div class="grow">
              <h3><a href="#/warehouse/${w.id}">${esc(w.name)}</a></h3>
              <div class="muted small">${esc(w.address)} · ${w.racks_count} стелажів · ${w.total_qty} шт</div>
            </div>
            <button class="sm ghost" data-edit-wh="${w.id}">Змінити</button>
          </div>
        </div>`).join('') : '<p class="muted">Складів ще немає. Створіть перший.</p>'}
    </div>
    ${d.low_stock.length ? `<div class="card"><h2>Закінчується</h2>
      <div class="table-wrap"><table><tbody>${d.low_stock.map((p) => `<tr>
        <td><a href="#/part/${p.id}">${esc(p.name)}</a></td>
        <td><span class="badge warn">${p.total_qty} / мін ${p.min_qty}</span></td>
      </tr>`).join('')}</tbody></table></div></div>` : ''}`;

  $('#addWh').addEventListener('click', () => dlgWarehouse(null));
  app.querySelectorAll('[data-edit-wh]').forEach((b) =>
    b.addEventListener('click', () => dlgWarehouse(whs.find((w) => w.id === Number(b.dataset.editWh)))));
}

function dlgWarehouse(w) {
  const bg = modal(`
    <h2>${w ? 'Змінити склад' : 'Новий склад'}</h2>
    <form id="f">
      <label class="field"><span>Назва *</span><input id="name" value="${esc(w?.name ?? '')}" required></label>
      <label class="field"><span>Адреса</span><input id="address" value="${esc(w?.address ?? '')}"></label>
      <label class="field"><span>Примітка</span><input id="note" value="${esc(w?.note ?? '')}"></label>
      <div class="row"><button class="primary grow">Зберегти</button>
        ${w ? '<button type="button" class="danger" id="del">Видалити</button>' : ''}
        <button type="button" class="ghost" onclick="this.closest('.modal-bg').remove()">Скасувати</button></div>
    </form>`);
  bg.querySelector('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { name: bg.querySelector('#name').value, address: bg.querySelector('#address').value, note: bg.querySelector('#note').value };
    try {
      if (w) await api(`/warehouses/${w.id}`, { method: 'PUT', body });
      else await api('/warehouses', { method: 'POST', body });
      closeModal(); toast('Збережено', 'ok'); route();
    } catch (err) { toast(err.message, 'err'); }
  });
  bg.querySelector('#del')?.addEventListener('click', async () => {
    if (!confirm('Видалити склад разом зі стелажами, місцями і залишками?')) return;
    await api(`/warehouses/${w.id}`, { method: 'DELETE' });
    closeModal(); route();
  });
}

async function viewWarehouse(id) {
  const [wh, racks, locs] = await Promise.all([
    api('/warehouses').then((all) => all.find((w) => w.id === Number(id))),
    api(`/warehouses/${id}/racks`),
    api('/locations' + qs({ warehouse_id: id })),
  ]);
  const zones = locs.filter((l) => l.kind === 'zone');

  app.innerHTML = `
    <div class="card">
      <div class="row">
        <div class="grow"><h1>${esc(wh?.name ?? 'Склад')}</h1>
          <div class="muted small">${esc(wh?.address ?? '')}</div></div>
        <button class="primary sm" id="addRack">＋ Стелаж</button>
        <button class="sm" id="addZone">＋ Вільне місце</button>
      </div>
    </div>
    ${racks.map((r) => `
      <div class="card">
        <div class="row">
          <h2 class="grow">${esc(r.name)} <span class="muted small">${r.rows}×${r.cols}</span></h2>
          <button class="sm ghost" data-edit-rack="${r.id}">Змінити</button>
          <a href="#/labels?rack=${r.id}"><button class="sm">🖨 Наклейки стелажа</button></a>
        </div>
        <div class="rack" data-rack="${r.id}"></div>
      </div>`).join('')}
    ${zones.length ? `<div class="card"><h2>Вільні місця (без стелажа)</h2>
      <div class="table-wrap"><table><tbody>${zones.map((z) => `<tr>
        <td><a href="#" data-open-loc="${z.id}">${esc(z.label)}</a></td>
        <td class="mono small">${esc(z.barcode)}</td><td>${z.qty} шт</td></tr>`).join('')}</tbody></table></div></div>` : ''}
    ${!racks.length && !zones.length ? '<div class="card muted">Ще нічого немає. Створіть стелаж — комірки й штрих-коди зроблю автоматично.</div>' : ''}`;

  await paintRacks(app);
  app.querySelectorAll('[data-open-loc]').forEach((a) =>
    a.addEventListener('click', (e) => { e.preventDefault(); openLocation(a.dataset.openLoc); }));
  $('#addRack').addEventListener('click', () => dlgRack(null, id));
  $('#addZone').addEventListener('click', () => dlgZone(id));
  app.querySelectorAll('[data-edit-rack]').forEach((b) =>
    b.addEventListener('click', () => dlgRack(racks.find((r) => r.id === Number(b.dataset.editRack)), id)));
}

function dlgRack(r, warehouseId) {
  const bg = modal(`
    <h2>${r ? 'Змінити стелаж' : 'Новий стелаж'}</h2>
    <form id="f">
      <label class="field"><span>Назва (коротка, піде в код комірок)</span>
        <input id="name" value="${esc(r?.name ?? '')}" placeholder="напр. С1" required></label>
      <div class="row">
        <label class="field grow"><span>Полиць (рядів)</span><input type="number" id="rows" min="1" max="30" value="${r?.rows ?? 4}" required></label>
        <label class="field grow"><span>Секцій (колонок)</span><input type="number" id="cols" min="1" max="30" value="${r?.cols ?? 5}" required></label>
      </div>
      <label class="field"><span>Примітка</span><input id="note" value="${esc(r?.note ?? '')}"></label>
      <p class="small muted">Комірки й штрих-коди для них створяться самі: С1-A1, С1-B1 і так далі.</p>
      <div class="row"><button class="primary grow">Зберегти</button>
        ${r ? '<button type="button" class="danger" id="del">Видалити</button>' : ''}
        <button type="button" class="ghost" onclick="this.closest('.modal-bg').remove()">Скасувати</button></div>
    </form>`);
  bg.querySelector('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = bg.querySelector('#name').value;
    const rows = Number(bg.querySelector('#rows').value);
    const cols = Number(bg.querySelector('#cols').value);
    const note = bg.querySelector('#note').value;
    try {
      if (r) {
        await api(`/racks/${r.id}`, { method: 'PUT', body: { name, note } });
        if (rows !== r.rows || cols !== r.cols) {
          const res = await api(`/racks/${r.id}/resize`, { method: 'POST', body: { rows, cols } });
          toast(`Сітку змінено. Прибрано порожніх комірок: ${res.removed}`, 'ok');
        }
      } else {
        await api('/racks', { method: 'POST', body: { warehouse_id: Number(warehouseId), name, rows, cols, note } });
      }
      closeModal(); route();
    } catch (err) { toast(err.message, 'err'); }
  });
  bg.querySelector('#del')?.addEventListener('click', async () => {
    if (!confirm('Видалити стелаж з усіма комірками і залишками в них?')) return;
    await api(`/racks/${r.id}`, { method: 'DELETE' });
    closeModal(); route();
  });
}

function dlgZone(warehouseId) {
  const bg = modal(`
    <h2>Вільне місце на складі</h2>
    <p class="small muted">Для того, що не влазить у стелаж: піддон, кут, підлога, вітрина.</p>
    <form id="f">
      <label class="field"><span>Назва *</span><input id="label" placeholder="напр. Піддон біля воріт" required></label>
      <div class="row"><button class="primary grow">Створити</button>
        <button type="button" class="ghost" onclick="this.closest('.modal-bg').remove()">Скасувати</button></div>
    </form>`);
  bg.querySelector('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/locations', { method: 'POST', body: {
        warehouse_id: Number(warehouseId), kind: 'zone', label: bg.querySelector('#label').value,
      } });
      closeModal(); route();
    } catch (err) { toast(err.message, 'err'); }
  });
}

/* ============================================================ наклейки */

async function viewLabels(params) {
  const rackId = params.get('rack');
  const partId = params.get('part');
  const locId = params.get('loc');

  let items = [];
  if (rackId) {
    const { rack, cells } = await api(`/racks/${rackId}/grid`);
    items = cells.map((c) => ({ code: c.barcode, title: c.label, meta: rack.name }));
  } else if (partId) {
    const p = await api(`/parts/${partId}`);
    items = [{ code: p.barcode, title: p.name, meta: [p.code, p.brand].filter(Boolean).join(' · ') }];
  } else if (locId) {
    const { location } = await api(`/locations/${locId}`);
    items = [{ code: location.barcode, title: location.label, meta: location.warehouse_name }];
  }

  const [whs, parts] = await Promise.all([api('/warehouses'), api('/parts' + qs({ limit: 500 }))]);

  app.innerHTML = `
    <div class="card no-print">
      <h1>Друк наклейок</h1>
      <div class="row">
        <label class="field grow"><span>Що друкуємо</span>
          <select id="what">
            <option value="sel">Вибрані нижче</option>
            <option value="parts">Усі запчастини (${parts.length})</option>
            ${whs.map((w) => `<option value="wh:${w.id}">Усі місця складу «${esc(w.name)}»</option>`).join('')}
          </select></label>
        <label class="field grow"><span>Формат</span>
          <select id="fmt">
            <option value="a4">Аркуш A4 — 3 колонки</option>
            <option value="thermal">Термопринтер 58×40 мм</option>
          </select></label>
        <button class="primary" id="printBtn">🖨 Друк</button>
      </div>
      <label class="field"><span>Додати вручну (пошук по запчастинах)</span>
        <select id="pick"><option value="">— вибрати —</option>
          ${parts.map((p) => `<option value="${p.id}">${esc(p.name)} ${p.code ? '· ' + esc(p.code) : ''}</option>`).join('')}
        </select></label>
      <p class="small muted">Порада: наклейку місця клейте на полицю/коробку, наклейку деталі — на саму деталь або пакет.
        Кількість на наклейці навмисно не друкується — вона змінюється, а наклейка ні.</p>
    </div>
    <div class="card"><div id="sheet" class="labels-preview"></div></div>`;

  const render = () => {
    const fmt = $('#fmt').value;
    $('#sheet').className = 'labels-preview ' + (fmt === 'a4' ? 'sheet-a4' : 'sheet-thermal');
    $('#sheet').innerHTML = items.length ? items.map((i) => `
      <div class="label">
        <div class="l-name">${esc(i.title)}</div>
        <svg data-code="${esc(i.code)}" data-h="${fmt === 'a4' ? 26 : 40}" data-fs="${fmt === 'a4' ? 10 : 14}"></svg>
        <div class="l-meta">${esc(i.meta || '')}</div>
      </div>`).join('') : '<p class="muted" style="color:#666">Нічого не вибрано.</p>';
    renderAllBarcodes($('#sheet'));
  };

  $('#what').addEventListener('change', async () => {
    const v = $('#what').value;
    if (v === 'parts') {
      items = parts.map((p) => ({ code: p.barcode, title: p.name, meta: p.code || '' }));
    } else if (v.startsWith('wh:')) {
      const locs = await api('/locations' + qs({ warehouse_id: v.slice(3) }));
      items = locs.map((l) => ({ code: l.barcode, title: l.label, meta: l.rack_name || '' }));
    }
    render();
  });

  $('#pick').addEventListener('change', () => {
    const p = parts.find((x) => x.id === Number($('#pick').value));
    if (p) { items.push({ code: p.barcode, title: p.name, meta: p.code || '' }); render(); }
  });

  $('#fmt').addEventListener('change', render);
  $('#printBtn').addEventListener('click', () => window.print());
  render();
}

/* ============================================================ історія */

async function viewHistory(params) {
  const partId = params.get('part');
  const rows = await api('/movements' + qs({ part_id: partId, limit: 300 }));
  const T = { in: '＋ прихід', out: '− видача', move: '→ переміщення', adjust: '= перерахунок' };
  app.innerHTML = `
    <div class="card">
      <h1>Історія рухів${partId ? ' (одна деталь)' : ''}</h1>
      ${rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Коли</th><th>Що</th><th>Деталь</th><th>Звідки</th><th>Куди</th><th>К-сть</th><th>Коментар</th></tr></thead>
        <tbody>${rows.map((m) => `<tr>
          <td class="small nowrap">${esc(m.ts)}</td>
          <td class="small nowrap">${T[m.type] || m.type}</td>
          <td>${m.part_id ? `<a href="#/part/${m.part_id}">${esc(m.part_name)}</a>` : '<span class="muted">видалено</span>'}</td>
          <td class="small muted">${esc(m.from_label || '')}</td>
          <td class="small muted">${esc(m.to_label || '')}</td>
          <td><b>${m.qty}</b></td>
          <td class="small muted">${esc(m.note || '')}</td>
        </tr>`).join('')}</tbody></table></div>` : '<p class="muted">Рухів ще не було.</p>'}
    </div>`;
}

/* ============================================================ інтеграції */

async function viewIntegrations() {
  const list = await api('/integrations');
  const origin = location.origin;
  app.innerHTML = `
    <div class="card">
      <div class="row"><h1 class="grow">Інтеграції</h1>
        <button class="primary sm" id="add">＋ Підключити сервіс</button></div>
      <p class="muted small">Склад — самостійний додаток. Будь-який магазин чи CRM під'єднується сюди
        через API-ключ і не має доступу ні до чого іншого. Ключ можна відкликати в один клік.</p>
      ${list.length ? list.map((i) => `
        <div class="card" style="background:var(--panel-2)">
          <div class="row">
            <div class="grow">
              <h3>${esc(i.name)} <span class="badge ${i.enabled ? 'ok' : 'err'}">${i.enabled ? 'увімкнено' : 'вимкнено'}</span></h3>
              <div class="small muted">slug: <code class="mono">${esc(i.slug)}</code> · зв'язків з товарами: ${i.links_count}</div>
              <div class="small mono" style="margin-top:6px;word-break:break-all">${esc(i.api_key)}</div>
            </div>
            <button class="sm" data-copy="${esc(i.api_key)}">Копіювати ключ</button>
            <button class="sm ghost" data-rotate="${i.id}">Новий ключ</button>
            <button class="sm danger" data-del="${i.id}">Видалити</button>
          </div>
        </div>`).join('') : '<p class="muted">Поки жодного підключеного сервісу.</p>'}
    </div>

    <div class="card">
      <h2>Як під'єднати магазин</h2>
      <p class="small muted">Усі запити йдуть на <code class="mono">${esc(origin)}/api/v1</code>
        із заголовком <code class="mono">X-Api-Key</code>. Приклади:</p>
      <pre class="mono small" style="white-space:pre-wrap;background:var(--panel-2);padding:12px;border-radius:10px">
# Чи є на складі і де лежить (за артикулом магазину)
curl -H "X-Api-Key: sk_..." \\
  "${origin}/api/v1/parts/lookup?sku=7700123456"

# Наявність одразу для списку товарів
curl -X POST -H "X-Api-Key: sk_..." -H "Content-Type: application/json" \\
  -d '{"items":[{"sku":"7700123456"},{"external_id":"42"}]}' \\
  ${origin}/api/v1/stock/check

# Продаж: списати 1 шт
curl -X POST -H "X-Api-Key: sk_..." -H "Content-Type: application/json" \\
  -d '{"sku":"7700123456","qty":1,"note":"замовлення №123"}' \\
  ${origin}/api/v1/stock/out

# Прив'язати товар магазину до нашої деталі
curl -X POST -H "X-Api-Key: sk_..." -H "Content-Type: application/json" \\
  -d '{"sku":"7700123456","external_id":"42","external_url":"https://shop/p/42"}' \\
  ${origin}/api/v1/parts/link

# Де лежить (для схеми)
curl -H "X-Api-Key: sk_..." "${origin}/api/v1/locate?code=7700123456"</pre>
    </div>`;

  $('#add').addEventListener('click', () => {
    const bg = modal(`
      <h2>Новий сервіс</h2>
      <form id="f">
        <label class="field"><span>Назва *</span><input id="name" placeholder="напр. Магазин olegavto" required></label>
        <label class="field"><span>Код (латиницею) *</span><input id="slug" placeholder="olegavto" required pattern="[a-z0-9_-]+"></label>
        <label class="field"><span>Webhook URL (не обов'язково)</span><input id="webhook_url" placeholder="https://…/hooks/sklad"></label>
        <div class="row"><button class="primary grow">Створити і видати ключ</button>
          <button type="button" class="ghost" onclick="this.closest('.modal-bg').remove()">Скасувати</button></div>
      </form>`);
    bg.querySelector('#f').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/integrations', { method: 'POST', body: {
          name: bg.querySelector('#name').value,
          slug: bg.querySelector('#slug').value,
          webhook_url: bg.querySelector('#webhook_url').value,
        } });
        closeModal(); toast('Ключ видано', 'ok'); route();
      } catch (err) { toast(err.message, 'err'); }
    });
  });

  app.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => {
    navigator.clipboard.writeText(b.dataset.copy).then(() => toast('Скопійовано', 'ok'));
  }));
  app.querySelectorAll('[data-rotate]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Старий ключ перестане працювати. Продовжити?')) return;
    await api(`/integrations/${b.dataset.rotate}/rotate`, { method: 'POST' });
    toast('Новий ключ видано', 'ok'); route();
  }));
  app.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Видалити інтеграцію і всі її зв\'язки з товарами?')) return;
    await api(`/integrations/${b.dataset.del}`, { method: 'DELETE' });
    route();
  }));
}

/* ============================================================ роутер */

async function route() {
  await stopCamera();
  closeModal();
  const raw = location.hash.slice(1) || '/scan';
  const [path, query] = raw.split('?');
  const params = new URLSearchParams(query || '');
  const parts = path.split('/').filter(Boolean);

  document.querySelectorAll('header.top nav a').forEach((a) =>
    a.classList.toggle('active', a.getAttribute('href') === '#/' + parts[0]));

  try {
    switch (parts[0]) {
      case 'scan': return viewScan();
      case 'parts': return viewParts(params);
      case 'part': return viewPart(parts[1]);
      case 'warehouses': return viewWarehouses();
      case 'warehouse': return viewWarehouse(parts[1]);
      case 'labels': return viewLabels(params);
      case 'history': return viewHistory(params);
      case 'integrations': return viewIntegrations();
      default: location.hash = '#/scan';
    }
  } catch (e) {
    app.innerHTML = `<div class="card"><h2>Помилка</h2><p class="muted">${esc(e.message)}</p></div>`;
  }
}

window.addEventListener('hashchange', route);

$('#logoutBtn').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' });
  renderLogin();
});

(async function boot() {
  const { authed } = await api('/me');
  if (!authed) return renderLogin();
  $('#topbar').hidden = false;
  if (!location.hash) location.hash = '#/scan';
  route();
})();
