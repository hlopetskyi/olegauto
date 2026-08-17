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
      <h1>Inventa</h1>
      <p class="muted small">Складський облік зі штрих-кодами.</p>
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
        <input id="scanInput" autocomplete="off" placeholder="Код товару, місця або артикул" autofocus>
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
    if (r.type === 'product') out.innerHTML = productCardHtml(r.product);
    else if (r.type === 'location') out.innerHTML = locationCardHtml(r);
    else if (r.type === 'many') out.innerHTML = manyHtml(r);
    else out.innerHTML = `<div class="card"><h2>Нічого не знайдено</h2>
        <p class="muted">За запитом «${esc(r.query)}» нічого немає.
        <a href="#/products?new=${encodeURIComponent(r.query)}">Створити товар?</a></p></div>`;
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
        <td><a href="#/product/${p.id}">${esc(p.name)}</a></td>
        <td class="mono small">${esc(p.code)}</td>
        <td>${p.total_qty}</td></tr>`).join('')}</tbody>
    </table></div></div>`;
}

/* -------------------------------------------- картка товару зі схемою */

function productCardHtml(p) {
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
        <button class="sm" data-act="out" data-product="${p.id}" data-loc="${pl.location_id}">Видати</button>
        <button class="sm" data-act="move" data-product="${p.id}" data-loc="${pl.location_id}">Перемістити</button>
        <button class="sm ghost" data-act="adjust" data-product="${p.id}" data-loc="${pl.location_id}">Перерахувати</button>
        <a href="#/warehouse/${pl.warehouse_id}?hit=${pl.location_id}"><button class="sm ghost">🗺 Показати на плані складу</button></a>
      </div>
    </div>`).join('')
    : '<p class="muted">Ще не розміщено на складі. Натисніть «Прийняти на склад».</p>';

  return `
  <div class="card">
    <div class="row">
      <div class="grow">
        <h1>${esc(p.name)} ${qtyBadge}</h1>
        <div class="muted small">
          ${[
            p.category_name
              ? `<span class="badge">${esc(p.category_parent_name ? p.category_parent_name + ' → ' : '')}${esc(p.category_name)}</span>`
              : '',
            p.code ? `Артикул: <b class="mono">${esc(p.code)}</b>` : '',
            p.price ? `Ціна: <b>${esc(p.price)}</b>` : '',
          ].filter(Boolean).join(' · ')}
        </div>
        ${p.attributes && p.attributes.length ? `<div class="attrs">${p.attributes.map((a) => `
          <span class="attr"><em>${esc(a.label)}</em>${esc(a.type === 'checkbox' ? (a.value === '1' ? 'так' : 'ні') : a.value)}</span>`).join('')}</div>` : ''}
        ${p.note ? `<p class="small">${esc(p.note)}</p>` : ''}
      </div>
      <div style="text-align:center">
        <svg data-code="${esc(p.barcode)}" data-h="46"></svg>
      </div>
    </div>
    <div class="row" style="margin-top:10px">
      <button class="primary sm" data-act="in" data-product="${p.id}">＋ Прийняти на склад</button>
      <button class="sm" data-act="edit-product" data-product="${p.id}">Редагувати</button>
      <a class="sm" href="#/labels?product=${p.id}"><button class="sm">🖨 Наклейка</button></a>
      <a class="sm" href="#/history?product=${p.id}"><button class="sm ghost">Історія</button></a>
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
      // Схема стелажа розріджена — кожну комірку ставимо в її власні координати,
      // інакше пропуски з'їхали б і підсвітка вказала б не туди.
      node.innerHTML = cells.map((c) => {
        const hit = c.row_idx === hitR && c.col_idx === hitC;
        const cls = hit ? 'hit' : (c.qty > 0 ? 'filled' : 'empty');
        return `<button class="cell ${cls}" data-loc="${c.id}"
            style="grid-column:${c.col_idx + 1};grid-row:${c.row_idx + 1}">
          <span class="lbl">${esc(c.label)}</span>
          <span class="qty">${c.qty || '·'}</span>
          ${c.boxes_count ? `<span class="boxes">${c.boxes_count} кор.</span>` : ''}
        </button>`;
      }).join('');
      node.querySelectorAll('.cell').forEach((b) => {
        const cell = cells.find((c) => c.id === Number(b.dataset.loc));
        if (cell) bindCellTip(b, cell);
        b.addEventListener('click', () => { cellTipEl().hidden = true; openLocation(b.dataset.loc); });
      });
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
      <button class="primary sm" data-act="in-here" data-loc="${l.id}">＋ Покласти сюди товар</button>
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
        <td><a href="#/product/${i.id}">${esc(i.name)}</a></td>
        <td class="mono small">${esc(i.code)}</td>
        <td class="small muted">${esc(i.location_label)}</td>
        <td><b>${i.qty}</b></td>
        <td class="nowrap">
          <button class="sm" data-act="out" data-product="${i.id}" data-loc="${i.location_id}">Видати</button>
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
      const productId = Number(btn.dataset.product);
      const locId = Number(btn.dataset.loc);
      if (act === 'in') return dlgPutStock(productId);
      if (act === 'in-here') return dlgPutIntoLocation(locId);
      if (act === 'out') return dlgQty('Видати зі складу', 'out', productId, locId);
      if (act === 'adjust') return dlgQty('Перерахунок (точна кількість у місці)', 'adjust', productId, locId);
      if (act === 'move') return dlgMove(productId, locId);
      if (act === 'edit-product') return dlgProduct(await api(`/products/${productId}`));
      if (act === 'add-box') return dlgAddBox(locId, Number(btn.dataset.wh));
    });
  });
}

const refreshAfter = async (productId) => {
  if (location.hash.startsWith('#/product/')) return route();
  if ($('#scanResult') && productId) {
    const p = await api(`/products/${productId}`);
    $('#scanResult').innerHTML = productCardHtml(p);
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

async function dlgQty(title, kind, productId, locId) {
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
        body: { product_id: productId, location_id: locId, qty: Number(bg.querySelector('#qty').value), note: bg.querySelector('#note').value },
      });
      closeModal(); toast('Готово', 'ok'); refreshAfter(productId);
    } catch (err) { toast(err.message, 'err'); }
  });
}

async function dlgPutStock(productId) {
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
    <p class="small muted">Порада: щоб не шукати місце у списку — відскануйте наклейку місця, і кладіть товар звідти.</p>`);
  bg.querySelector('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/stock/in', { method: 'POST', body: {
        product_id: productId,
        location_id: Number(bg.querySelector('#loc').value),
        qty: Number(bg.querySelector('#qty').value),
        note: bg.querySelector('#note').value,
      } });
      closeModal(); toast('Покладено', 'ok'); refreshAfter(productId);
    } catch (err) { toast(err.message, 'err'); }
  });
}

async function dlgPutIntoLocation(locId) {
  const products = await api('/products' + qs({ limit: 500 }));
  const bg = modal(`
    <h2>Покласти товар у це місце</h2>
    <form id="f">
      <label class="field"><span>Товар</span>
        <select id="product" required>${products.map((p) => `<option value="${p.id}">${esc(p.name)} ${p.code ? '· ' + esc(p.code) : ''}</option>`).join('')}</select></label>
      <label class="field"><span>Кількість</span><input type="number" id="qty" value="1" min="1" required></label>
      <div class="row"><button class="primary grow">Покласти</button>
        <button type="button" class="ghost" onclick="this.closest('.modal-bg').remove()">Скасувати</button></div>
    </form>`);
  bg.querySelector('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/stock/in', { method: 'POST', body: {
        product_id: Number(bg.querySelector('#product').value), location_id: locId,
        qty: Number(bg.querySelector('#qty').value),
      } });
      closeModal(); toast('Покладено', 'ok'); route();
    } catch (err) { toast(err.message, 'err'); }
  });
}

async function dlgMove(productId, fromLoc) {
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
        product_id: productId, from_location_id: fromLoc,
        to_location_id: Number(bg.querySelector('#to').value),
        qty: Number(bg.querySelector('#qty').value),
      } });
      closeModal(); toast('Переміщено', 'ok'); refreshAfter(productId);
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

/* =============================================================== товари */

// Категорії подаються плоским списком з позначкою вкладеності — так їх зручно
// класти і в <select>, і в чіпи фільтра.
function categoryOptions(cats, selected, emptyLabel = '— без категорії —') {
  const roots = cats.filter((c) => !c.parent_id);
  const orphans = cats.filter((c) => c.parent_id && !cats.some((x) => x.id === c.parent_id));
  let html = emptyLabel === null ? '' : `<option value="">${emptyLabel}</option>`;
  [...roots, ...orphans].forEach((r) => {
    html += `<option value="${r.id}" ${Number(selected) === r.id ? 'selected' : ''}>${esc(r.name)}</option>`;
    cats.filter((c) => c.parent_id === r.id).forEach((ch) => {
      html += `<option value="${ch.id}" ${Number(selected) === ch.id ? 'selected' : ''}>&nbsp;&nbsp;└ ${esc(ch.name)}</option>`;
    });
  });
  return html;
}

async function viewProducts(params) {
  const q = params.get('q') || '';
  const cats = await api('/categories');
  app.innerHTML = `
    <div class="card">
      <div class="row">
        <h1 class="grow">Товари</h1>
        <button class="primary" id="addProduct">＋ Новий товар</button>
      </div>
      <input id="q" placeholder="Пошук: назва, артикул, OEM, модель" value="${esc(q)}" autofocus>
      <div class="row" style="margin-top:8px">
        <label class="field grow" style="margin:0"><span>Категорія</span>
          <select id="cat">
            <option value="">Усі категорії</option>
            <option value="none">Без категорії</option>
            ${categoryOptions(cats, params.get('category'), null)}
          </select></label>
        <label class="small muted" style="padding-bottom:9px">
          <input type="checkbox" id="low" style="width:auto"> лише те, що закінчується
        </label>
        <a href="#/categories" class="small" style="padding-bottom:11px">керувати категоріями</a>
      </div>
    </div>
    <div class="card"><div id="list" class="table-wrap">Завантаження…</div></div>`;

  const load = async () => {
    const low = $('#low').checked ? '1' : '';
    const items = await api('/products' + qs({ q: $('#q').value, low, category: $('#cat').value, limit: 300 }));
    $('#list').innerHTML = items.length ? `<table>
      <thead><tr><th>Назва</th><th>Категорія</th><th>Артикул</th><th>Залишок</th><th>Код</th></tr></thead>
      <tbody>${items.map((p) => `<tr>
        <td><a href="#/product/${p.id}">${esc(p.name)}</a></td>
        <td class="small">${p.category_name ? `<span class="badge">${esc(p.category_name)}</span>` : ''}</td>
        <td class="mono small">${esc(p.code)}</td>
        <td>${p.total_qty > 0
            ? `<span class="badge ${p.min_qty > 0 && p.total_qty <= p.min_qty ? 'warn' : 'ok'}">${p.total_qty}</span>`
            : '<span class="badge err">0</span>'}</td>
        <td class="mono small muted">${esc(p.barcode)}</td>
      </tr>`).join('')}</tbody></table>` : '<p class="muted">Нічого не знайдено.</p>';
  };

  let timer;
  $('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 220); });
  $('#low').addEventListener('change', load);
  $('#cat').addEventListener('change', load);
  $('#addProduct').addEventListener('click', () => dlgProduct(null));
  await load();
  if (params.get('new')) dlgProduct({ name: params.get('new') });
}

/* ---------------------------------------------------------- категорії */

async function viewCategories() {
  const cats = await api('/categories');
  const roots = cats.filter((c) => !c.parent_id);

  app.innerHTML = `
    <div class="card">
      <div class="row">
        <h1 class="grow">Категорії товарів</h1>
        <button class="primary" id="add">＋ Категорія</button>
      </div>
      <p class="muted small">Категорія визначає не лише «що це за товар», а й <b>які поля буде заповнено
        при створенні товару</b>. Для автозапчастин це OEM-номер і модель авто, для продуктів —
        термін придатності й партія. Натисніть <b>⚙ Поля товару</b> в потрібній категорії.
        Підкатегорії успадковують поля батьківської.</p>
    </div>
    <div class="card">
      ${roots.length ? roots.map((r) => {
        const kids = cats.filter((c) => c.parent_id === r.id);
        return `<div class="card" style="background:var(--panel-2)">
          <div class="row">
            <div class="grow"><h3><a href="#/products?category=${r.id}">${esc(r.name)}</a>
              <span class="badge">${r.products_count} товарів</span></h3></div>
            <button class="sm" data-fields="${r.id}">⚙ Поля товару</button>
            <button class="sm ghost" data-add-child="${r.id}">＋ підкатегорія</button>
            <button class="sm ghost" data-edit="${r.id}">Змінити</button>
          </div>
          ${kids.length ? `<div class="table-wrap"><table><tbody>${kids.map((k) => `<tr>
            <td>└ <a href="#/products?category=${k.id}">${esc(k.name)}</a></td>
            <td><span class="badge">${k.products_count}</span></td>
            <td class="nowrap">
              <button class="sm" data-fields="${k.id}">⚙ Поля</button>
              <button class="sm ghost" data-edit="${k.id}">Змінити</button>
            </td>
          </tr>`).join('')}</tbody></table></div>` : ''}
        </div>`;
      }).join('') : '<p class="muted">Категорій ще немає. Створіть першу.</p>'}
    </div>`;

  $('#add').addEventListener('click', () => dlgCategory(null, cats));
  app.querySelectorAll('[data-fields]').forEach((b) =>
    b.addEventListener('click', () => dlgFields(Number(b.dataset.fields), cats)));
  app.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', () => dlgCategory(cats.find((c) => c.id === Number(b.dataset.edit)), cats)));
  app.querySelectorAll('[data-add-child]').forEach((b) =>
    b.addEventListener('click', () => dlgCategory({ parent_id: Number(b.dataset.addChild) }, cats)));
}

const FIELD_TYPES = {
  text: 'Текст',
  textarea: 'Довгий текст',
  number: 'Число',
  date: 'Дата',
  select: 'Вибір зі списку',
  checkbox: 'Так / ні',
};

// Редактор полів категорії: саме тут бізнес описує, що потрібно знати про його товар.
async function dlgFields(categoryId, cats) {
  const cat = cats.find((c) => c.id === categoryId);
  const [{ own, effective }, presets] = await Promise.all([
    api(`/categories/${categoryId}/fields`),
    api('/field-presets'),
  ]);
  const inherited = effective.filter((f) => f.inherited);

  const bg = modal(`
    <h2>Поля товару — «${esc(cat?.name ?? '')}»</h2>
    <p class="small muted">Ці поля з'являться у формі створення товару цієї категорії.
      Основні поля (назва, артикул, кількість, ціна, місце) є завжди й тут не налаштовуються.</p>

    ${inherited.length ? `<div class="hint">Успадковано від «${esc(inherited[0].from_category)}»:
      ${inherited.map((f) => esc(f.label)).join(', ')}. Змінюються в тій категорії.</div>` : ''}

    <div id="fieldList"></div>

    <div class="row" style="margin-top:12px">
      <button class="primary sm" id="addField">＋ Додати поле</button>
      <select id="preset" class="grow">
        <option value="">Готовий набір полів…</option>
        ${presets.map((p) => `<option value="${p.key}">${esc(p.name)}: ${esc(p.fields.join(', '))}</option>`).join('')}
      </select>
      <button class="sm" id="applyPreset">Застосувати</button>
    </div>
    <div class="row" style="margin-top:12px">
      <button class="ghost right" onclick="this.closest('.modal-bg').remove()">Закрити</button>
    </div>`);

  const listBox = bg.querySelector('#fieldList');

  const renderList = (fields) => {
    listBox.innerHTML = fields.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Поле</th><th>Тип</th><th>Обов'язкове</th><th></th></tr></thead>
      <tbody>${fields.map((f) => `<tr>
        <td><b>${esc(f.label)}</b>${f.options.length ? `<div class="small muted">${esc(f.options.join(' · '))}</div>` : ''}</td>
        <td class="small">${esc(FIELD_TYPES[f.type] || f.type)}</td>
        <td>${f.required ? '<span class="badge warn">так</span>' : '<span class="muted small">ні</span>'}</td>
        <td class="nowrap">
          <button class="sm ghost" data-ef="${f.id}">✎</button>
          <button class="sm danger" data-df="${f.id}">✕</button>
        </td>
      </tr>`).join('')}</tbody></table></div>` : '<p class="muted small">Власних полів ще немає.</p>';

    listBox.querySelectorAll('[data-df]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Видалити поле? Значення цього поля в усіх товарах теж зникнуть.')) return;
      await api(`/fields/${b.dataset.df}`, { method: 'DELETE' });
      reload();
    }));
    listBox.querySelectorAll('[data-ef]').forEach((b) => b.addEventListener('click', () =>
      dlgOneField(categoryId, fields.find((f) => f.id === Number(b.dataset.ef)), reload)));
  };

  const reload = async () => {
    const fresh = await api(`/categories/${categoryId}/fields`);
    renderList(fresh.own);
  };

  renderList(own);

  bg.querySelector('#addField').addEventListener('click', () => dlgOneField(categoryId, null, reload));
  bg.querySelector('#applyPreset').addEventListener('click', async () => {
    const key = bg.querySelector('#preset').value;
    if (!key) return;
    const res = await api(`/categories/${categoryId}/apply-preset`, { method: 'POST', body: { preset: key } });
    toast(`Додано полів: ${res.added}`, 'ok');
    reload();
  });
}

function dlgOneField(categoryId, f, onSaved) {
  const bg = modal(`
    <h2>${f ? 'Змінити поле' : 'Нове поле'}</h2>
    <form id="ff">
      <label class="field"><span>Назва поля *</span>
        <input id="label" value="${esc(f?.label ?? '')}" placeholder="напр. Термін придатності" required></label>
      <div class="row">
        <label class="field grow"><span>Тип</span>
          <select id="type">${Object.entries(FIELD_TYPES).map(([k, n]) =>
            `<option value="${k}" ${f?.type === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label class="field grow"><span>Обов'язкове</span>
          <select id="required">
            <option value="0" ${!f?.required ? 'selected' : ''}>Ні</option>
            <option value="1" ${f?.required ? 'selected' : ''}>Так</option>
          </select></label>
      </div>
      <label class="field" id="optWrap" ${f?.type === 'select' ? '' : 'hidden'}>
        <span>Варіанти вибору — кожен з нового рядка</span>
        <textarea id="options">${esc((f?.options || []).join('\n'))}</textarea></label>
      <label class="field"><span>Підказка під полем</span>
        <input id="hint" value="${esc(f?.hint ?? '')}" placeholder="напр. у форматі 500 г"></label>
      <div class="row"><button class="primary grow">Зберегти</button>
        <button type="button" class="ghost" onclick="this.closest('.modal-bg').remove()">Скасувати</button></div>
    </form>`);

  const typeSel = bg.querySelector('#type');
  typeSel.addEventListener('change', () => { bg.querySelector('#optWrap').hidden = typeSel.value !== 'select'; });

  bg.querySelector('#ff').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      label: bg.querySelector('#label').value,
      type: typeSel.value,
      required: Number(bg.querySelector('#required').value),
      hint: bg.querySelector('#hint').value,
      options: bg.querySelector('#options').value.split('\n').map((x) => x.trim()).filter(Boolean),
      sort: f?.sort ?? 0,
    };
    try {
      if (f) await api(`/fields/${f.id}`, { method: 'PUT', body });
      else await api(`/categories/${categoryId}/fields`, { method: 'POST', body });
      bg.remove();
      onSaved();
    } catch (err) { toast(err.message, 'err'); }
  });
}

function dlgCategory(c, cats) {
  // Себе саму в батьки не пропонуємо — це створило б цикл.
  const parents = cats.filter((x) => !x.parent_id && x.id !== c?.id);
  const bg = modal(`
    <h2>${c?.id ? 'Змінити категорію' : 'Нова категорія'}</h2>
    <form id="f">
      <label class="field"><span>Назва *</span><input id="name" value="${esc(c?.name ?? '')}" required></label>
      <label class="field"><span>Всередині категорії</span>
        <select id="parent">
          <option value="">— верхній рівень —</option>
          ${parents.map((p) => `<option value="${p.id}" ${Number(c?.parent_id) === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select></label>
      <div class="row"><button class="primary grow">Зберегти</button>
        ${c?.id ? '<button type="button" class="danger" id="del">Видалити</button>' : ''}
        <button type="button" class="ghost" onclick="this.closest('.modal-bg').remove()">Скасувати</button></div>
    </form>`);

  bg.querySelector('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      name: bg.querySelector('#name').value,
      parent_id: bg.querySelector('#parent').value || null,
    };
    try {
      if (c?.id) await api(`/categories/${c.id}`, { method: 'PUT', body });
      else await api('/categories', { method: 'POST', body });
      closeModal(); route();
    } catch (err) { toast(err.message, 'err'); }
  });

  bg.querySelector('#del')?.addEventListener('click', async () => {
    if (!confirm('Видалити категорію? Товари залишаться, просто без категорії.')) return;
    await api(`/categories/${c.id}`, { method: 'DELETE' });
    closeModal(); route();
  });
}

// Один рядок форми під одне поле категорії. Значення завжди зберігаємо текстом —
// тип потрібен лише для того, щоб дати правильний елемент вводу.
function fieldInputHtml(f, value) {
  const id = `fv_${f.id}`;
  const req = f.required ? 'required' : '';
  const val = esc(value ?? '');
  let input;
  if (f.type === 'textarea') input = `<textarea id="${id}" ${req}>${val}</textarea>`;
  else if (f.type === 'select') {
    input = `<select id="${id}" ${req}><option value="">—</option>${
      f.options.map((o) => `<option ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  } else if (f.type === 'checkbox') {
    input = `<input type="checkbox" id="${id}" style="width:auto" ${value === '1' ? 'checked' : ''}>`;
  } else {
    const t = f.type === 'number' ? 'number' : (f.type === 'date' ? 'date' : 'text');
    input = `<input type="${t}" id="${id}" value="${val}" ${req}>`;
  }
  return `<label class="field" data-field="${f.id}" data-type="${f.type}">
    <span>${esc(f.label)}${f.required ? ' *' : ''}${f.inherited ? ` <em class="muted">(з «${esc(f.from_category)}»)</em>` : ''}</span>
    ${input}
    ${f.hint ? `<em class="muted small">${esc(f.hint)}</em>` : ''}
  </label>`;
}

async function dlgProduct(p) {
  const v = (k) => esc(p?.[k] ?? '');
  const cats = await api('/categories');
  const bg = modal(`
    <h2>${p?.id ? 'Редагувати товар' : 'Новий товар'}</h2>
    <form id="f">
      <label class="field"><span>Назва *</span><input id="name" value="${v('name')}" required></label>
      <div class="row">
        <label class="field grow"><span>Категорія</span>
          <select id="category_id">${categoryOptions(cats, p?.category_id)}</select></label>
        <a href="#/categories" class="small" style="padding-bottom:20px">налаштувати поля</a>
      </div>
      <div class="row">
        <label class="field grow"><span>Артикул / код</span><input id="code" value="${v('code')}"></label>
        <label class="field grow"><span>Одиниця</span><input id="unit" value="${p?.unit ? esc(p.unit) : 'шт'}"></label>
      </div>
      <div class="row">
        <label class="field grow"><span>Мінімальний залишок</span><input type="number" id="min_qty" value="${p?.min_qty ?? 0}"></label>
        <label class="field grow"><span>Ціна</span><input type="number" step="0.01" id="price" value="${p?.price ?? 0}"></label>
      </div>

      <div id="customFields"></div>

      <label class="field"><span>Примітка</span><textarea id="note">${v('note')}</textarea></label>
      <div class="row">
        <button class="primary grow">Зберегти</button>
        ${p?.id ? '<button type="button" class="danger" id="del">Видалити</button>' : ''}
        <button type="button" class="ghost" onclick="this.closest('.modal-bg').remove()">Скасувати</button>
      </div>
    </form>`);

  const catSel = bg.querySelector('#category_id');
  const box = bg.querySelector('#customFields');

  // Поля залежать від обраної категорії, тому перемальовуємо їх при кожній зміні.
  const loadFields = async () => {
    const catId = catSel.value;
    if (!catId) {
      box.innerHTML = `<p class="small muted">Виберіть категорію — і тут з'являться її поля
        (наприклад OEM-номер для запчастин або термін придатності для продуктів).</p>`;
      return;
    }
    const { effective } = await api(`/categories/${catId}/fields`);
    if (!effective.length) {
      box.innerHTML = `<p class="small muted">У цієї категорії ще немає власних полів.
        <a href="#/categories">Додати їх</a> — і вони з'являться у формі.</p>`;
      return;
    }
    box.innerHTML = `<h3 class="muted small">Поля категорії</h3>` +
      effective.map((f) => fieldInputHtml(f, p?.values?.[f.id])).join('');
  };
  catSel.addEventListener('change', loadFields);
  await loadFields();

  bg.querySelector('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {};
    ['name', 'code', 'unit', 'note'].forEach((k) => body[k] = bg.querySelector('#' + k).value);
    body.category_id = catSel.value || null;
    body.min_qty = Number(bg.querySelector('#min_qty').value) || 0;
    body.price = Number(bg.querySelector('#price').value) || 0;
    body.values = {};
    box.querySelectorAll('[data-field]').forEach((lab) => {
      const el = lab.querySelector('input, select, textarea');
      body.values[lab.dataset.field] = lab.dataset.type === 'checkbox'
        ? (el.checked ? '1' : '')
        : el.value;
    });
    try {
      const saved = p?.id
        ? await api(`/products/${p.id}`, { method: 'PUT', body })
        : await api('/products', { method: 'POST', body });
      closeModal();
      toast('Збережено', 'ok');
      if (!p?.id) location.hash = `#/product/${saved.id}`; else route();
    } catch (err) { toast(err.message, 'err'); }
  });

  bg.querySelector('#del')?.addEventListener('click', async () => {
    if (!confirm('Видалити товар разом з усіма його залишками?')) return;
    await api(`/products/${p.id}`, { method: 'DELETE' });
    closeModal(); toast('Видалено', 'ok'); location.hash = '#/products';
  });
}

async function viewProduct(id) {
  const p = await api(`/products/${id}`);
  app.innerHTML = productCardHtml(p);
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
        <div class="stat"><b>${d.products}</b><span>найменувань</span></div>
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
        <td><a href="#/product/${p.id}">${esc(p.name)}</a></td>
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

/* ------------------------------------------------ план складу */

// Скільки клітинок плану займає стелаж. Комірки мають бути видні поштучно,
// тому під кожен ряд комірок відводимо цілу клітинку плану, плюс один рядок під назву.
// Мінімум 2 клітинки завширшки — інакше назва стелажа не влазить і читається як «С…».
function rackSpan(r) {
  const cols = r.orientation === 'v' ? r.cell_rows : r.cell_cols;
  const rows = r.orientation === 'v' ? r.cell_cols : r.cell_rows;
  return { w: Math.max(2, cols), h: Math.max(1, rows) + 1, cols: Math.max(1, cols), rows: Math.max(1, rows) };
}

let planPlacing = null; // id стелажа, який зараз переставляють

async function viewWarehouse(id, params = new URLSearchParams()) {
  const plan = await api(`/warehouses/${id}/plan`);
  const { warehouse: wh, racks, zones } = plan;
  planPlacing = null;

  // Прийшли за посиланням «показати на плані» з картки товару — підсвітимо потрібну комірку.
  let hit = null;
  const hitLoc = params.get('hit');
  if (hitLoc) {
    try {
      const { location } = await api(`/locations/${hitLoc}`);
      const cellId = location.parent_id || location.id;
      const target = location.parent_id ? (await api(`/locations/${location.parent_id}`)).location : location;
      hit = { rack_id: target.rack_id, row: target.row_idx, col: target.col_idx, label: target.label, cell_id: cellId };
    } catch (e) { /* місце могли видалити — просто покажемо план */ }
  }

  app.innerHTML = `
    <div class="card">
      <div class="row">
        <div class="grow"><h1>${esc(wh.name)}</h1>
          <div class="muted small">${esc(wh.address || '')}</div></div>
        <button class="primary sm" id="addRack">＋ Стелаж</button>
        <button class="sm" id="addZone">＋ Вільне місце</button>
        <button class="sm ghost" id="planSize">Розмір плану</button>
      </div>
    </div>

    ${hit ? `<div class="hint">Шуканий товар лежить тут: <b>${esc(hit.label)}</b> — підсвічено на плані.</div>` : ''}

    <div class="card">
      <div class="row">
        <h2 class="grow">План складу</h2>
        <span class="muted small" id="planHint">Тягніть стелаж за смужку з назвою — рамка показує, куди він стане.
          На телефоні: довге натискання на стелаж, потім тик у потрібне місце.</span>
      </div>
      <div class="plan-wrap"><div class="plan" id="plan"></div></div>
    </div>

    ${!racks.length && !zones.length
      ? '<div class="card muted">Порожньо. Створіть стелаж — і одразу намалюєте його схему під свої ящики.</div>'
      : ''}`;

  drawPlan(plan, hit);
  $('#addRack').addEventListener('click', () => dlgRack(null, id));
  $('#addZone').addEventListener('click', () => dlgZone(id));
  $('#planSize').addEventListener('click', () => dlgPlanSize(wh));
}

function drawPlan(plan, hit = null) {
  const { warehouse: wh, racks, zones } = plan;
  const W = wh.plan_w || 24, H = wh.plan_h || 14;
  const el = $('#plan');
  if (!el) return;
  const cellPx = PLAN_CELL;
  el.style.setProperty('--cell', cellPx + 'px');
  el.style.gridTemplateColumns = `repeat(${W}, ${cellPx}px)`;
  el.style.gridTemplateRows = `repeat(${H}, ${cellPx}px)`;

  // Порожні клітинки підлоги — вони ж мішені, коли переставляємо стелаж.
  let html = '';
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) html += `<div class="slot" data-x="${x}" data-y="${y}"></div>`;
  }

  html += racks.map((r) => {
    const sp = rackSpan(r);
    const x = Math.min(r.pos_x || 0, Math.max(0, W - sp.w));
    const y = Math.min(r.pos_y || 0, Math.max(0, H - sp.h));
    return `<div class="rack-block" data-rack-id="${r.id}"
      style="grid-column:${x + 1}/span ${sp.w};grid-row:${y + 1}/span ${sp.h}">
      <div class="rb-name" draggable="true" title="Потягніть за назву, щоб пересунути стелаж">
        ${esc(r.name)} · ${r.cells_count} ком.
      </div>
      <div class="rb-cells" style="grid-template-columns:repeat(${sp.cols},1fr);grid-template-rows:repeat(${sp.rows},1fr)"
           data-mini="${r.id}"></div>
    </div>`;
  }).join('');

  // Вільні місця вишиковуємо знизу плану, з переносом на рядок вище, якщо не влазять.
  const perRow = Math.max(1, Math.floor(W / 3));
  html += zones.map((z, i) => {
    const zx = (i % perRow) * 3;
    const zy = Math.max(0, H - 1 - Math.floor(i / perRow));
    return `<div class="zone-block" data-zone="${z.id}"
      style="grid-column:${zx + 1}/span 3;grid-row:${zy + 1}/span 1">
      📦 ${esc(z.label)} · ${z.qty} шт
    </div>`;
  }).join('');

  el.innerHTML = html;
  paintMiniCells(racks, hit);

  el.querySelectorAll('.rack-block').forEach((block) => {
    const rid = Number(block.dataset.rackId);
    const nameEl = block.querySelector('.rb-name');
    // По назві — перехід до схеми стелажа; по комірці — її вміст (нижче, у paintMiniCells).
    nameEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (planPlacing === rid) { planPlacing = null; el.classList.remove('placing'); block.classList.remove('selected'); return; }
      location.hash = `#/rack/${rid}`;
    });
    // Довгий тиск / друге торкання = режим перестановки (працює й на телефоні).
    block.addEventListener('contextmenu', (e) => { e.preventDefault(); startPlacing(rid); });
    nameEl.addEventListener('dragstart', (e) => {
      planPlacing = rid;
      e.dataTransfer.setData('text/plain', String(rid));
      e.dataTransfer.effectAllowed = 'move';
      // Запам'ятовуємо, за яку саме клітинку стелажа взялись, щоб він не стрибав
      // лівим верхнім кутом під курсор.
      const at = planCellAt(e.clientX, e.clientY);
      const rr = window.__plan.racks.find((x) => x.id === rid);
      grabOffset = at ? { x: at.x - (rr.pos_x || 0), y: at.y - (rr.pos_y || 0) } : { x: 0, y: 0 };
      el.classList.add('placing');
    });
    nameEl.addEventListener('dragend', () => {
      planPlacing = null; grabOffset = { x: 0, y: 0 };
      el.classList.remove('placing'); clearGhost();
    });
  });

  // Перетягування слухаємо на всій сітці, а не на окремих клітинках підкладки:
  // клітинки перекриті блоками стелажів і подій не отримують.
  el.addEventListener('dragover', (e) => {
    if (!planPlacing) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const at = planCellAt(e.clientX, e.clientY);
    if (!at) return;
    const rack = window.__plan.racks.find((r) => r.id === planPlacing);
    const pos = clampToPlan(window.__plan, rack, at.x - grabOffset.x, at.y - grabOffset.y);
    showGhost(window.__plan, rack, pos.x, pos.y);
  });

  el.addEventListener('dragleave', (e) => { if (e.target === el) clearGhost(); });

  el.addEventListener('drop', (e) => {
    e.preventDefault();
    const at = planCellAt(e.clientX, e.clientY);
    clearGhost();
    if (at) placeRack(at.x - grabOffset.x, at.y - grabOffset.y);
  });

  // Режим «тицьнув і поставив» для телефона: тут курсор вказує лівий верхній кут.
  el.addEventListener('click', (e) => {
    if (!planPlacing) return;
    const at = planCellAt(e.clientX, e.clientY);
    if (at) placeRack(at.x, at.y);
  });

  el.querySelectorAll('[data-zone]').forEach((z) =>
    z.addEventListener('click', () => openLocation(z.dataset.zone)));

  window.__plan = plan;
}

function startPlacing(rackId) {
  planPlacing = rackId;
  $('#plan').classList.add('placing');
  $('#plan').querySelector(`[data-rack-id="${rackId}"]`)?.classList.add('selected');
  $('#planHint').textContent = 'Тепер натисніть на плані місце, куди поставити стелаж.';
}

const PLAN_CELL = 34;

// Куди саме на сітці вказує курсор. Рахуємо математикою, а не пошуком елемента
// під курсором: підкладку сітки перекривають самі блоки стелажів.
function planCellAt(clientX, clientY) {
  const el = $('#plan');
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  const st = getComputedStyle(el);
  const gap = parseFloat(st.gap) || 0;
  const step = PLAN_CELL + gap;
  return {
    x: Math.floor((clientX - rect.left - parseFloat(st.paddingLeft)) / step),
    y: Math.floor((clientY - rect.top - parseFloat(st.paddingTop)) / step),
  };
}

// Тримаємо стелаж у межах плану: у край сітки він має ставати впритул.
function clampToPlan(plan, rack, x, y) {
  const sp = rackSpan(rack);
  const W = plan.warehouse.plan_w || 24;
  const H = plan.warehouse.plan_h || 14;
  return {
    x: Math.max(0, Math.min(x, W - sp.w)),
    y: Math.max(0, Math.min(y, H - sp.h)),
  };
}

// Два стелажі не можуть стояти на одному місці — інакше блоки на плані
// перекривають один одного і схема перестає відповідати дійсності.
function rackCollision(plan, rack, x, y) {
  const a = rackSpan(rack);
  return plan.racks.find((other) => {
    if (other.id === rack.id) return false;
    const b = rackSpan(other);
    const ox = other.pos_x || 0, oy = other.pos_y || 0;
    return x < ox + b.w && x + a.w > ox && y < oy + b.h && y + a.h > oy;
  });
}

async function placeRack(rawX, rawY) {
  const rid = planPlacing;
  if (!rid) return;
  planPlacing = null;
  const plan = window.__plan;
  const r = plan.racks.find((rr) => rr.id === rid);
  const { x, y } = clampToPlan(plan, r, rawX, rawY);
  const clash = rackCollision(plan, r, x, y);
  if (clash) {
    $('#plan').classList.remove('placing');
    clearGhost();
    return toast(`Тут уже стоїть «${clash.name}». Виберіть вільне місце.`, 'err');
  }
  try {
    await api(`/racks/${rid}/position`, { method: 'PUT', body: { pos_x: x, pos_y: y, orientation: r.orientation } });
    r.pos_x = x; r.pos_y = y;
    drawPlan(plan);
  } catch (e) { toast(e.message, 'err'); }
}

/* --------------------------------- прев'ю місця під час перетягування */

let grabOffset = { x: 0, y: 0 };

function clearGhost() {
  document.querySelectorAll('.plan-ghost').forEach((g) => g.remove());
}

// Показує рамку рівно там, куди стелаж стане, якщо відпустити зараз.
function showGhost(plan, rack, x, y) {
  const el = $('#plan');
  if (!el) return;
  const sp = rackSpan(rack);
  let ghost = el.querySelector('.plan-ghost');
  if (!ghost) {
    ghost = document.createElement('div');
    ghost.className = 'plan-ghost';
    el.appendChild(ghost);
  }
  const free = !rackCollision(plan, rack, x, y);
  ghost.classList.toggle('busy', !free);
  ghost.style.gridColumn = `${x + 1}/span ${sp.w}`;
  ghost.style.gridRow = `${y + 1}/span ${sp.h}`;
  ghost.textContent = free ? '' : 'зайнято';
}

/* ------------------------------------------ підказка над коміркою */

// Одна спільна плашка на всю сторінку — дешевше, ніж тримати її в кожній комірці.
function cellTipEl() {
  let t = $('#cellTip');
  if (!t) {
    t = document.createElement('div');
    t.id = 'cellTip';
    t.className = 'cell-tip';
    t.hidden = true;
    document.body.appendChild(t);
  }
  return t;
}

function cellTipHtml(c) {
  const total = c.total_qty ?? c.qty;
  const rows = [];
  if (c.box_labels?.length) {
    rows.push(`<div class="ct-group"><em>Коробки</em>${c.box_labels.map((b) => `<span>📦 ${esc(b)}</span>`).join('')}</div>`);
  }
  if (c.item_labels?.length) {
    rows.push(`<div class="ct-group"><em>Товари</em>${c.item_labels.map((i) => `<span>${esc(i)}</span>`).join('')}</div>`);
  }
  if (!rows.length) rows.push('<div class="ct-group muted">Порожня комірка</div>');
  return `<b>${esc(c.label)}</b>${total ? ` <span class="badge ok">${total} шт</span>` : ''}
    ${rows.join('')}<div class="ct-hint">Натисніть, щоб відкрити вміст</div>`;
}

function bindCellTip(el, cell) {
  const show = (e) => {
    const t = cellTipEl();
    t.innerHTML = cellTipHtml(cell);
    t.hidden = false;
    // Тримаємо плашку в межах вікна, щоб вона не тікала за правий край.
    const r = el.getBoundingClientRect();
    const w = t.offsetWidth;
    let left = r.left + window.scrollX;
    if (left + w > window.scrollX + document.documentElement.clientWidth - 8) {
      left = window.scrollX + document.documentElement.clientWidth - w - 8;
    }
    const above = r.top > t.offsetHeight + 12;
    t.style.left = Math.max(8, left) + 'px';
    t.style.top = (above ? r.top + window.scrollY - t.offsetHeight - 8 : r.bottom + window.scrollY + 8) + 'px';
  };
  el.addEventListener('mouseenter', show);
  el.addEventListener('focus', show);
  el.addEventListener('mouseleave', () => { cellTipEl().hidden = true; });
  el.addEventListener('blur', () => { cellTipEl().hidden = true; });
}

// Мініатюрні комірки всередині блока стелажа на плані.
async function paintMiniCells(racks, hit) {
  for (const r of racks) {
    const box = document.querySelector(`[data-mini="${r.id}"]`);
    if (!box) continue;
    try {
      const { cells } = await api(`/racks/${r.id}/grid`);
      const vertical = r.orientation === 'v';
      box.innerHTML = cells.map((c) => {
        const isHit = hit && hit.rack_id === r.id && hit.row === c.row_idx && hit.col === c.col_idx;
        const total = c.total_qty ?? c.qty;
        const cls = isHit ? 'hit' : (total > 0 ? 'full' : '');
        // При вертикальній орієнтації ряди й секції міняються місцями.
        const gc = vertical ? c.row_idx + 1 : c.col_idx + 1;
        const gr = vertical ? c.col_idx + 1 : c.row_idx + 1;
        return `<button class="rb-cell ${cls}" data-loc="${c.id}" style="grid-column:${gc};grid-row:${gr}">
          <span class="rb-lbl">${esc(c.label.replace(r.name + '-', ''))}</span>
          <span class="rb-qty">${total || ''}</span>
          ${c.boxes_count ? `<span class="rb-box">${c.boxes_count}📦</span>` : ''}
        </button>`;
      }).join('');

      box.querySelectorAll('.rb-cell').forEach((el) => {
        const cell = cells.find((c) => c.id === Number(el.dataset.loc));
        bindCellTip(el, cell);
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          cellTipEl().hidden = true;
          openLocation(cell.id);
        });
      });
    } catch (e) { /* блок лишиться порожнім */ }
  }
}

function dlgPlanSize(wh) {
  const bg = modal(`
    <h2>Розмір плану складу</h2>
    <p class="small muted">Скільки клітинок займає підлога складу. Одна клітинка ≈ одна секція стелажа.</p>
    <form id="f">
      <div class="row">
        <label class="field grow"><span>Ширина</span><input type="number" id="w" min="4" max="60" value="${wh.plan_w || 24}"></label>
        <label class="field grow"><span>Висота</span><input type="number" id="h" min="4" max="60" value="${wh.plan_h || 14}"></label>
      </div>
      <div class="row"><button class="primary grow">Зберегти</button>
        <button type="button" class="ghost" onclick="this.closest('.modal-bg').remove()">Скасувати</button></div>
    </form>`);
  bg.querySelector('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    await api(`/warehouses/${wh.id}/plan`, { method: 'PUT', body: {
      plan_w: Number(bg.querySelector('#w').value), plan_h: Number(bg.querySelector('#h').value),
    } });
    closeModal(); route();
  });
}

/* ------------------------------------------- створення / зміна стелажа */

function dlgRack(r, warehouseId) {
  const isNew = !r;
  const bg = modal(`
    <h2>${isNew ? 'Новий стелаж' : 'Змінити стелаж'}</h2>
    <form id="f">
      <label class="field"><span>Назва (коротка, піде в код комірок)</span>
        <input id="name" value="${esc(r?.name ?? '')}" placeholder="напр. С1" required></label>
      ${isNew ? `
      <label class="field"><span>Як задати комірки</span>
        <select id="mode">
          <option value="strip">Один довгий ряд — вкажу скільки ящиків</option>
          <option value="grid">Прямокутник: полиць × секцій</option>
          <option value="empty">Порожній — намалюю схему сам</option>
        </select></label>
      <label class="field" id="wrapCount"><span>Скільки ящиків (комірок) у ряд</span>
        <input type="number" id="count" min="1" max="60" value="8"></label>
      <div class="row" id="wrapGrid" hidden>
        <label class="field grow"><span>Полиць (рядів)</span><input type="number" id="rows" min="1" max="30" value="3"></label>
        <label class="field grow"><span>Секцій (колонок)</span><input type="number" id="cols" min="1" max="30" value="5"></label>
      </div>` : ''}
      <label class="field"><span>Примітка</span><input id="note" value="${esc(r?.note ?? '')}"></label>
      <p class="small muted">Це лише стартова заготовка. Далі в схемі стелажа комірки можна додавати,
        прибирати й перетягувати поштучно — рівно під ваші ящики.</p>
      <div class="row"><button class="primary grow">Зберегти</button>
        ${r ? '<button type="button" class="danger" id="del">Видалити</button>' : ''}
        <button type="button" class="ghost" onclick="this.closest('.modal-bg').remove()">Скасувати</button></div>
    </form>`);

  const mode = bg.querySelector('#mode');
  mode?.addEventListener('change', () => {
    bg.querySelector('#wrapCount').hidden = mode.value !== 'strip';
    bg.querySelector('#wrapGrid').hidden = mode.value !== 'grid';
  });

  bg.querySelector('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = bg.querySelector('#name').value;
    const note = bg.querySelector('#note').value;
    try {
      if (r) {
        await api(`/racks/${r.id}`, { method: 'PUT', body: { name, note, color: r.color || '' } });
        closeModal(); route();
      } else {
        const created = await api('/racks', { method: 'POST', body: {
          warehouse_id: Number(warehouseId), name, note,
          mode: mode.value,
          count: Number(bg.querySelector('#count').value) || 1,
          rows: Number(bg.querySelector('#rows').value) || 1,
          cols: Number(bg.querySelector('#cols').value) || 1,
        } });
        closeModal();
        location.hash = `#/rack/${created.id}`;
      }
    } catch (err) { toast(err.message, 'err'); }
  });

  bg.querySelector('#del')?.addEventListener('click', async () => {
    if (!confirm('Видалити стелаж з усіма комірками і залишками в них?')) return;
    await api(`/racks/${r.id}`, { method: 'DELETE' });
    closeModal(); location.hash = `#/warehouse/${warehouseId}`;
  });
}

/* ------------------------------------- редактор схеми одного стелажа */

let editingRack = false;
let movingCell = null;

async function viewRack(rackId) {
  const { rack, cells } = await api(`/racks/${rackId}/grid`);
  const maxR = Math.max(rack.rows, 1), maxC = Math.max(rack.cols, 1);
  // Полотно трохи більше за наявні комірки — щоб було куди дорощувати.
  const padR = editingRack ? Math.min(maxR + 2, 20) : maxR;
  const padC = editingRack ? Math.min(maxC + 3, 30) : maxC;
  const byPos = new Map(cells.map((c) => [`${c.row_idx}:${c.col_idx}`, c]));

  let grid = '';
  for (let r = 0; r < padR; r++) {
    for (let c = 0; c < padC; c++) {
      const cell = byPos.get(`${r}:${c}`);
      if (cell) {
        grid += `<div class="cell ${(cell.total_qty ?? cell.qty) > 0 ? 'filled' : 'empty'}" data-cell="${cell.id}"
            data-r="${r}" data-c="${c}" style="grid-column:${c + 1};grid-row:${r + 1}">
          <span class="lbl">${esc(cell.label)}</span>
          <span class="qty">${(cell.total_qty ?? cell.qty) || '·'}</span>
          ${cell.boxes_count ? `<span class="boxes">${cell.boxes_count} кор.</span>` : ''}
          ${editingRack ? `<span class="cell-tools">
            <button class="sm" data-ren="${cell.id}" title="Перейменувати">✎</button>
            <button class="sm" data-mv="${cell.id}" title="Перемістити">✥</button>
            <button class="sm danger" data-rm="${cell.id}" title="Прибрати">✕</button>
          </span>` : ''}
        </div>`;
      } else if (editingRack) {
        grid += `<button class="slot-empty" data-add-r="${r}" data-add-c="${c}"
            style="grid-column:${c + 1};grid-row:${r + 1}">＋</button>`;
      }
    }
  }

  app.innerHTML = `
    <div class="card">
      <div class="row">
        <div class="grow">
          <h1>${esc(rack.name)}</h1>
          <div class="muted small">
            <a href="#/warehouse/${rack.warehouse_id}">← до плану складу</a> ·
            комірок: ${cells.length} · ${esc(rack.note || '')}
          </div>
        </div>
        <button class="${editingRack ? 'primary' : ''} sm" id="editToggle">
          ${editingRack ? '✓ Готово' : '✎ Редагувати схему'}</button>
        <button class="sm ghost" id="rotate">↻ ${rack.orientation === 'v' ? 'Покласти горизонтально' : 'Поставити вертикально'}</button>
        <a href="#/labels?rack=${rack.id}"><button class="sm">🖨 Наклейки</button></a>
        <button class="sm ghost" id="rackSettings">Налаштування</button>
      </div>
    </div>

    ${editingRack ? `<div class="hint">
      Натисніть <b>＋</b>, щоб додати комірку саме там, де в реальності стоїть ящик.
      На комірці: <b>✎</b> перейменувати, <b>✥</b> перемістити, <b>✕</b> прибрати.
      Комірку з товаром прибрати не вийде — спершу заберіть звідти товар.
    </div>
    <div class="card">
      <div class="row">
        <button class="sm" id="addRow">＋ Додати ряд знизу</button>
        <input type="number" id="rowCount" value="${Math.max(maxC, 1)}" min="1" max="60" style="width:90px">
        <span class="muted small">комірок у ряду</span>
      </div>
    </div>` : ''}

    <div class="card">
      <div class="editor-grid" id="eg"
           style="grid-template-columns:repeat(${padC}, minmax(76px, 1fr))">${grid}</div>
      ${!cells.length ? '<p class="muted">Комірок ще немає. Увімкніть «Редагувати схему» і натискайте ＋ там, де стоять ящики.</p>' : ''}
    </div>`;

  $('#editToggle').addEventListener('click', () => { editingRack = !editingRack; movingCell = null; viewRack(rackId); });

  $('#rotate').addEventListener('click', async () => {
    await api(`/racks/${rackId}/position`, { method: 'PUT', body: {
      pos_x: rack.pos_x, pos_y: rack.pos_y, orientation: rack.orientation === 'v' ? 'h' : 'v',
    } });
    viewRack(rackId);
  });

  $('#rackSettings').addEventListener('click', () => dlgRack(rack, rack.warehouse_id));

  $('#addRow')?.addEventListener('click', async () => {
    try {
      const res = await api(`/racks/${rackId}/cell-row`, { method: 'POST', body: { count: Number($('#rowCount').value) } });
      toast(`Додано комірок: ${res.added}`, 'ok');
      viewRack(rackId);
    } catch (e) { toast(e.message, 'err'); }
  });

  // Клік по порожньому слоту: або створюємо комірку, або кладемо ту, що переміщуємо.
  app.querySelectorAll('.slot-empty').forEach((b) => b.addEventListener('click', async () => {
    const r = Number(b.dataset.addR), c = Number(b.dataset.addC);
    try {
      if (movingCell) {
        await api(`/cells/${movingCell}/move`, { method: 'PUT', body: { row: r, col: c } });
        movingCell = null;
      } else {
        await api(`/racks/${rackId}/cells`, { method: 'POST', body: { row: r, col: c } });
      }
      viewRack(rackId);
    } catch (e) { toast(e.message, 'err'); }
  }));

  app.querySelectorAll('[data-cell]').forEach((el) => {
    const cell = cells.find((c) => c.id === Number(el.dataset.cell));
    if (cell) bindCellTip(el, cell);
    el.addEventListener('click', (e) => {
      if (e.target.closest('.cell-tools')) return;
      cellTipEl().hidden = true;
      openLocation(el.dataset.cell);
    });
  });

  app.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    try { await api(`/cells/${b.dataset.rm}`, { method: 'DELETE' }); viewRack(rackId); }
    catch (err) { toast(err.message, 'err'); }
  }));

  app.querySelectorAll('[data-ren]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const cell = cells.find((c) => c.id === Number(b.dataset.ren));
    const name = prompt('Назва комірки (те, що буде на наклейці):', cell.label);
    if (!name) return;
    await api(`/locations/${cell.id}`, { method: 'PUT', body: { label: name, note: cell.note || '' } });
    viewRack(rackId);
  }));

  app.querySelectorAll('[data-mv]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    movingCell = Number(b.dataset.mv);
    toast('Тепер натисніть ＋ там, куди перенести комірку');
  }));
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
  const productId = params.get('product');
  const locId = params.get('loc');

  let items = [];
  if (rackId) {
    const { rack, cells } = await api(`/racks/${rackId}/grid`);
    items = cells.map((c) => ({ code: c.barcode, title: c.label, meta: rack.name }));
  } else if (productId) {
    const p = await api(`/products/${productId}`);
    items = [{ code: p.barcode, title: p.name, meta: [p.code, p.brand].filter(Boolean).join(' · ') }];
  } else if (locId) {
    const { location } = await api(`/locations/${locId}`);
    items = [{ code: location.barcode, title: location.label, meta: location.warehouse_name }];
  }

  const [whs, products] = await Promise.all([api('/warehouses'), api('/products' + qs({ limit: 500 }))]);

  app.innerHTML = `
    <div class="card no-print">
      <h1>Друк наклейок</h1>
      <div class="row">
        <label class="field grow"><span>Що друкуємо</span>
          <select id="what">
            <option value="sel">Вибрані нижче</option>
            <option value="products">Усі товари (${products.length})</option>
            ${whs.map((w) => `<option value="wh:${w.id}">Усі місця складу «${esc(w.name)}»</option>`).join('')}
          </select></label>
        <label class="field grow"><span>Формат</span>
          <select id="fmt">
            <option value="a4">Аркуш A4 — 3 колонки</option>
            <option value="thermal">Термопринтер 58×40 мм</option>
          </select></label>
        <button class="primary" id="printBtn">🖨 Друк</button>
      </div>
      <label class="field"><span>Додати вручну (пошук по товарах)</span>
        <select id="pick"><option value="">— вибрати —</option>
          ${products.map((p) => `<option value="${p.id}">${esc(p.name)} ${p.code ? '· ' + esc(p.code) : ''}</option>`).join('')}
        </select></label>
      <p class="small muted">Порада: наклейку місця клейте на полицю/коробку, наклейку товару — на сам товар або пакет.
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
    if (v === 'products') {
      items = products.map((p) => ({ code: p.barcode, title: p.name, meta: p.code || '' }));
    } else if (v.startsWith('wh:')) {
      const locs = await api('/locations' + qs({ warehouse_id: v.slice(3) }));
      items = locs.map((l) => ({ code: l.barcode, title: l.label, meta: l.rack_name || '' }));
    }
    render();
  });

  $('#pick').addEventListener('change', () => {
    const p = products.find((x) => x.id === Number($('#pick').value));
    if (p) { items.push({ code: p.barcode, title: p.name, meta: p.code || '' }); render(); }
  });

  $('#fmt').addEventListener('change', render);
  $('#printBtn').addEventListener('click', () => window.print());
  render();
}

/* ============================================================ історія */

async function viewHistory(params) {
  const productId = params.get('product');
  const rows = await api('/movements' + qs({ product_id: productId, limit: 300 }));
  const T = { in: '＋ прихід', out: '− видача', move: '→ переміщення', adjust: '= перерахунок' };
  app.innerHTML = `
    <div class="card">
      <h1>Історія рухів${productId ? ' (один товар)' : ''}</h1>
      ${rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Коли</th><th>Що</th><th>Товар</th><th>Звідки</th><th>Куди</th><th>К-сть</th><th>Коментар</th></tr></thead>
        <tbody>${rows.map((m) => `<tr>
          <td class="small nowrap">${esc(m.ts)}</td>
          <td class="small nowrap">${T[m.type] || m.type}</td>
          <td>${m.product_id ? `<a href="#/product/${m.product_id}">${esc(m.product_name)}</a>` : '<span class="muted">видалено</span>'}</td>
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
      <p class="muted small">Inventa — самостійний додаток. Будь-який магазин чи CRM під'єднується сюди
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
  "${origin}/api/v1/products/lookup?sku=7700123456"

# Наявність одразу для списку товарів
curl -X POST -H "X-Api-Key: sk_..." -H "Content-Type: application/json" \\
  -d '{"items":[{"sku":"7700123456"},{"external_id":"42"}]}' \\
  ${origin}/api/v1/stock/check

# Продаж: списати 1 шт
curl -X POST -H "X-Api-Key: sk_..." -H "Content-Type: application/json" \\
  -d '{"sku":"7700123456","qty":1,"note":"замовлення №123"}' \\
  ${origin}/api/v1/stock/out

# Прив'язати товар магазину до нашого товару
curl -X POST -H "X-Api-Key: sk_..." -H "Content-Type: application/json" \\
  -d '{"sku":"7700123456","external_id":"42","external_url":"https://shop/p/42"}' \\
  ${origin}/api/v1/products/link

# Де лежить (для схеми)
curl -H "X-Api-Key: sk_..." "${origin}/api/v1/locate?code=7700123456"</pre>
    </div>`;

  $('#add').addEventListener('click', () => {
    const bg = modal(`
      <h2>Новий сервіс</h2>
      <form id="f">
        <label class="field"><span>Назва *</span><input id="name" placeholder="напр. Магазин olegavto" required></label>
        <label class="field"><span>Код (латиницею) *</span><input id="slug" placeholder="olegavto" required pattern="[a-z0-9_-]+"></label>
        <label class="field"><span>Webhook URL (не обов'язково)</span><input id="webhook_url" placeholder="https://…/hooks/inventa"></label>
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
  const seg = path.split('/').filter(Boolean);

  document.querySelectorAll('header.top nav a').forEach((a) =>
    a.classList.toggle('active', a.getAttribute('href') === '#/' + seg[0]));

  try {
    switch (seg[0]) {
      case 'scan': return viewScan();
      case 'products': return viewProducts(params);
      case 'categories': return viewCategories();
      case 'product': return viewProduct(seg[1]);
      case 'warehouses': return viewWarehouses();
      case 'warehouse': return viewWarehouse(seg[1], params);
      case 'rack': return viewRack(seg[1]);
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
