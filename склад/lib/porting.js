'use strict';

/**
 * Імпорт та експорт товарів у CSV.
 *
 * Імпорт свідомо зроблений у два кроки: спершу «розбір» показує, що система
 * зрозуміла і що вона зробить, і лише окремим запитом усе застосовується.
 * Завантажити тисячу позицій наосліп — надто дорога помилка.
 */

const { db } = require('../db');
const S = require('./store');
const { parseCsv, buildCsv } = require('./csv');

// Синоніми заголовків: клієнти називають колонки як завгодно.
const HEADER_MAP = {
  name: ['назва', 'найменування', 'товар', 'name', 'title', 'product'],
  code: ['артикул', 'код', 'код товару', 'sku', 'code', 'article'],
  barcode: ['штрихкод', 'штрих-код', 'штрих код', 'barcode', 'ean', 'upc'],
  category: ['категорія', 'категория', 'category', 'група', 'group'],
  unit: ['одиниця', 'од', 'од.', 'unit', 'uom'],
  price: ['ціна', 'price', 'вартість'],
  min_qty: ['мінімум', 'мін залишок', 'мінімальний залишок', 'min', 'min_qty'],
  qty: ['кількість', 'к-сть', 'залишок', 'qty', 'quantity', 'stock'],
  location: ['місце', 'комірка', 'локація', 'location', 'bin', 'cell', 'полиця'],
  note: ['примітка', 'опис', 'note', 'comment', 'description'],
};

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

function matchHeader(header) {
  const h = norm(header);
  for (const [key, variants] of Object.entries(HEADER_MAP)) {
    if (variants.includes(h)) return { kind: 'core', key };
  }
  return null;
}

/**
 * Розбирає CSV і будує план: що створимо, що оновимо, де проблеми.
 * Нічого не змінює в базі.
 */
function analyzeImport(text, { categoryId = null } = {}) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('У файлі немає даних — потрібен рядок заголовків і хоча б один рядок товару');

  const headers = rows[0];
  const fields = categoryId ? S.effectiveFields(categoryId) : [];

  // Колонка або одна з відомих, або збігається з назвою поля категорії.
  const columns = headers.map((h) => {
    const core = matchHeader(h);
    if (core) return { header: h, ...core };
    const field = fields.find((f) => norm(f.label) === norm(h));
    if (field) return { header: h, kind: 'field', field_id: field.id, key: field.label };
    return { header: h, kind: 'skip', key: null };
  });

  const nameCol = columns.findIndex((c) => c.key === 'name');
  if (nameCol === -1) throw new Error('Не знайдено колонку з назвою товару. Назвіть її «Назва» або «Name».');

  const items = [];
  const problems = [];
  const seenCodes = new Set();

  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const get = (key) => {
      const idx = columns.findIndex((c) => c.key === key);
      return idx === -1 ? '' : (r[idx] || '').trim();
    };

    const name = get('name');
    if (!name) { problems.push({ line, text: 'порожня назва — рядок пропущено' }); return; }

    const code = get('code');
    const barcode = get('barcode');
    const qtyRaw = get('qty');
    const locationRaw = get('location');

    // Шукаємо наявний товар за артикулом, потім за штрих-кодом.
    let existing = null;
    if (code) existing = db.prepare('SELECT id, name FROM products WHERE code = ?').get(code);
    if (!existing && barcode) {
      const byOwn = db.prepare('SELECT id, name FROM products WHERE barcode = ?').get(barcode);
      const byExtra = db.prepare('SELECT product_id AS id FROM product_barcodes WHERE code = ?').get(barcode);
      existing = byOwn || (byExtra ? db.prepare('SELECT id, name FROM products WHERE id = ?').get(byExtra.id) : null);
    }

    if (code) {
      if (seenCodes.has(code)) problems.push({ line, text: `артикул ${code} повторюється у файлі` });
      seenCodes.add(code);
    }

    let location = null;
    if (locationRaw) {
      location = db.prepare('SELECT id, label FROM locations WHERE barcode = ? OR label = ?').get(locationRaw, locationRaw);
      if (!location) problems.push({ line, text: `місце «${locationRaw}» не знайдено — товар створиться без розміщення` });
    }

    const qty = qtyRaw ? Number(String(qtyRaw).replace(',', '.')) : 0;
    if (qtyRaw && !Number.isFinite(qty)) problems.push({ line, text: `кількість «${qtyRaw}» не число — буде 0` });

    const values = {};
    columns.forEach((c, idx) => {
      if (c.kind === 'field' && r[idx]) values[c.field_id] = r[idx].trim();
    });

    items.push({
      line,
      name,
      code,
      barcode,
      category: get('category'),
      unit: get('unit') || 'шт',
      price: Number(String(get('price') || '0').replace(',', '.')) || 0,
      min_qty: Number(get('min_qty') || '0') || 0,
      note: get('note'),
      qty: Number.isFinite(qty) ? Math.max(0, Math.round(qty)) : 0,
      location_id: location?.id || null,
      location_label: location?.label || locationRaw || '',
      values,
      existing_id: existing?.id || null,
      action: existing ? 'update' : 'create',
    });
  });

  return {
    columns,
    recognized: columns.filter((c) => c.kind !== 'skip').map((c) => c.header),
    ignored: columns.filter((c) => c.kind === 'skip').map((c) => c.header),
    items,
    problems,
    summary: {
      total: items.length,
      create: items.filter((i) => i.action === 'create').length,
      update: items.filter((i) => i.action === 'update').length,
      with_stock: items.filter((i) => i.qty > 0 && i.location_id).length,
    },
  };
}

/** Застосовує розібраний план. Усе в одній транзакції: або весь файл, або нічого. */
const runImport = db.transaction((plan, { categoryId = null, updateExisting = true, addStock = true }) => {
  let created = 0, updated = 0, placed = 0;

  plan.items.forEach((it) => {
    // Категорія з файлу має пріоритет над вибраною в формі.
    let catId = categoryId;
    if (it.category) {
      const found = db.prepare('SELECT id FROM categories WHERE name = ?').get(it.category);
      catId = found ? found.id : S.createCategory({ name: it.category }).id;
    }

    const payload = {
      name: it.name,
      code: it.code,
      unit: it.unit,
      price: it.price,
      min_qty: it.min_qty,
      note: it.note,
      category_id: catId,
      values: it.values,
    };

    let productId;
    if (it.existing_id && updateExisting) {
      S.updateProduct(it.existing_id, payload);
      productId = it.existing_id;
      updated++;
    } else if (it.existing_id) {
      productId = it.existing_id;
    } else {
      productId = S.createProduct(payload).id;
      created++;
    }

    if (it.barcode) {
      const codes = S.productBarcodes(productId).map((b) => b.code);
      if (!codes.includes(it.barcode)) {
        try { S.setProductBarcodes(productId, [...codes, it.barcode]); } catch (e) { /* код зайнятий — пропускаємо */ }
      }
    }

    if (addStock && it.qty > 0 && it.location_id) {
      S.stockIn(productId, it.location_id, it.qty, `Імпорт з файлу, рядок ${it.line}`);
      placed++;
    }
  });

  return { created, updated, placed };
});

/* ------------------------------------------------------------------ експорт */

function exportProducts() {
  const products = S.searchProducts({ limit: 100000 });
  // Поля категорій різні в різних товарів, тому зводимо їх в одну колонку «підпис: значення».
  const rows = [[
    'Назва', 'Артикул', 'Внутрішній код', 'Штрих-коди з упаковки', 'Категорія',
    'Одиниця', 'Ціна', 'Мінімальний залишок', 'Залишок', 'Де лежить', 'Поля категорії', 'Примітка',
  ]];

  products.forEach((p) => {
    const full = S.productFull(p.id);
    rows.push([
      full.name,
      full.code,
      full.barcode,
      full.extra_barcodes.join(' '),
      [full.category_parent_name, full.category_name].filter(Boolean).join(' / '),
      full.unit,
      full.price,
      full.min_qty,
      full.total_qty,
      full.placements.map((pl) => `${pl.warehouse_name}/${pl.label}=${pl.qty}`).join('; '),
      full.attributes.map((a) => `${a.label}: ${a.value}`).join('; '),
      full.note,
    ]);
  });
  return buildCsv(rows);
}

function exportMovements() {
  const rows = [['Коли', 'Дія', 'Товар', 'Артикул', 'Звідки', 'Куди', 'Кількість', 'Хто', 'Коментар']];
  const T = { in: 'прихід', out: 'видача', move: 'переміщення', adjust: 'перерахунок' };
  S.listMovements({ limit: 100000 }).forEach((m) => {
    rows.push([m.ts, T[m.type] || m.type, m.product_name || '', m.product_barcode || '',
      m.from_label || '', m.to_label || '', m.qty, m.user_name || '', m.note || '']);
  });
  return buildCsv(rows);
}

function exportLocations() {
  const rows = [['Склад', 'Стелаж', 'Місце', 'Тип', 'Штрих-код', 'Залишок']];
  const kinds = { cell: 'комірка', box: 'коробка', zone: 'вільне місце' };
  S.listLocations(null).forEach((l) => {
    const full = S.locationFull(l.id);
    rows.push([full.warehouse_name, full.rack_name || '', full.label, kinds[full.kind] || full.kind, full.barcode, l.qty]);
  });
  return buildCsv(rows);
}

// Зразок файлу, щоб клієнт бачив очікувані колонки.
const importTemplate = () => buildCsv([
  ['Назва', 'Артикул', 'Штрих-код', 'Категорія', 'Одиниця', 'Ціна', 'Мінімальний залишок', 'Кількість', 'Місце', 'Примітка'],
  ['Фільтр масляний', '7700274177', '4820012345678', 'Фільтри', 'шт', '250', '2', '10', 'С1-A1', 'Renault Megane'],
  ['Колодки гальмівні', 'BP-1122', '', 'Гальма', 'компл', '900', '1', '4', 'С1-B1', ''],
]);

module.exports = { analyzeImport, runImport, exportProducts, exportMovements, exportLocations, importTemplate };
