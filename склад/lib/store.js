'use strict';

const { db, newProductBarcode, newLocationBarcode } = require('../db');

/* ---------------------------------------------------------------- helpers */

const colName = (i) => {
  // 0 -> A, 25 -> Z, 26 -> AA
  let s = '';
  i += 1;
  while (i > 0) {
    const rem = (i - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
};

function pushOutbox(event, payload) {
  db.prepare('INSERT INTO outbox(event, payload) VALUES(?, ?)').run(event, JSON.stringify(payload));
}

/* ------------------------------------------------------------ warehouses */

const listWarehouses = () =>
  db.prepare(`
    SELECT w.*,
           (SELECT COUNT(*) FROM racks r WHERE r.warehouse_id = w.id) AS racks_count,
           (SELECT COALESCE(SUM(s.qty), 0) FROM stock s
              JOIN locations l ON l.id = s.location_id
             WHERE l.warehouse_id = w.id) AS total_qty
      FROM warehouses w ORDER BY w.name
  `).all();

const createWarehouse = ({ name, address = '', note = '' }) => {
  const info = db.prepare('INSERT INTO warehouses(name, address, note) VALUES(?, ?, ?)').run(name, address, note);
  return getWarehouse(info.lastInsertRowid);
};

const getWarehouse = (id) => db.prepare('SELECT * FROM warehouses WHERE id = ?').get(id);

const updateWarehouse = (id, { name, address = '', note = '' }) => {
  db.prepare('UPDATE warehouses SET name = ?, address = ?, note = ? WHERE id = ?').run(name, address, note, id);
  return getWarehouse(id);
};

const deleteWarehouse = (id) => db.prepare('DELETE FROM warehouses WHERE id = ?').run(id);

/* ----------------------------------------------------------------- racks */

const listRacks = (warehouseId) =>
  db.prepare('SELECT * FROM racks WHERE warehouse_id = ? ORDER BY name').all(warehouseId);

const getRack = (id) => db.prepare('SELECT * FROM racks WHERE id = ?').get(id);

/**
 * Створює стелаж. Три способи задати комірки:
 *   mode 'strip' — один довгий ряд із `count` комірок (типовий стелаж із ящиками);
 *   mode 'grid'  — прямокутник rows × cols;
 *   mode 'empty' — жодної комірки, малюєте самі в редакторі.
 * Після створення комірки можна додавати, прибирати й перетягувати поштучно.
 */
const createRack = db.transaction((opts) => {
  const {
    warehouse_id, name, note = '', color = '',
    mode = 'grid', count = 0, rows = 1, cols = 1,
    pos_x = 0, pos_y = 0, orientation = 'h',
  } = opts;

  // Новий стелаж ставимо під уже наявні, щоб блоки не лягли один на одного.
  const autoY = pos_y || db.prepare(`
    SELECT COALESCE(MAX(pos_y + CASE WHEN orientation = 'v' THEN cols ELSE rows END), 0) AS y
      FROM racks WHERE warehouse_id = ?
  `).get(warehouse_id).y;

  const info = db.prepare(`
    INSERT INTO racks(warehouse_id, name, rows, cols, note, color, pos_x, pos_y, orientation)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(warehouse_id, name, 1, 1, note, color, pos_x, autoY, orientation === 'v' ? 'v' : 'h');
  const rackId = info.lastInsertRowid;

  const ins = db.prepare(`
    INSERT INTO locations(warehouse_id, rack_id, kind, row_idx, col_idx, label, barcode)
    VALUES(?, ?, 'cell', ?, ?, ?, ?)
  `);
  const put = (r, c) => ins.run(warehouse_id, rackId, r, c, autoLabel(name, r, c), newLocationBarcode());

  if (mode === 'strip') {
    for (let c = 0; c < Math.max(1, count); c++) put(0, c);
  } else if (mode === 'grid') {
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) put(r, c);
  }
  syncRackSize(rackId);
  return getRack(rackId);
});

// Комірки стелажа — довільний набір координат, а не обов'язково повний прямокутник.
// Тому «розмір» стелажа рахуємо з самих комірок, а rows/cols у таблиці лишаються
// лише підказкою для полотна редактора.
function rackBounds(rackId) {
  const b = db.prepare(`
    SELECT COALESCE(MAX(row_idx), -1) AS maxr, COALESCE(MAX(col_idx), -1) AS maxc, COUNT(*) AS n
      FROM locations WHERE rack_id = ? AND kind = 'cell'
  `).get(rackId);
  return { rows: b.maxr + 1, cols: b.maxc + 1, count: b.n };
}

const cellTaken = (rackId, row, col) =>
  !!db.prepare("SELECT 1 FROM locations WHERE rack_id = ? AND kind = 'cell' AND row_idx = ? AND col_idx = ?")
    .get(rackId, row, col);

// Автоназва комірки: «С1-B2» = стелаж С1, друга секція, другий ряд.
const autoLabel = (rackName, row, col) => `${rackName}-${colName(col)}${row + 1}`;

const addCell = db.transaction((rackId, row, col, label) => {
  const rack = getRack(rackId);
  if (!rack) throw new Error('Стелаж не знайдено');
  if (cellTaken(rackId, row, col)) throw new Error('Тут уже є комірка');
  const info = db.prepare(`
    INSERT INTO locations(warehouse_id, rack_id, kind, row_idx, col_idx, label, barcode)
    VALUES(?, ?, 'cell', ?, ?, ?, ?)
  `).run(rack.warehouse_id, rackId, row, col, label || autoLabel(rack.name, row, col), newLocationBarcode());
  syncRackSize(rackId);
  return locationFull(info.lastInsertRowid);
});

// Комірку з товаром або з коробками не видаляємо мовчки — краще явна помилка.
const removeCell = db.transaction((locId) => {
  const qty = db.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock WHERE location_id = ?').get(locId).q;
  if (qty > 0) throw new Error('У комірці є товар. Спершу заберіть або перемістіть його.');
  const boxes = db.prepare('SELECT COUNT(*) AS n FROM locations WHERE parent_id = ?').get(locId).n;
  if (boxes > 0) throw new Error('У комірці є коробки. Спершу приберіть їх.');
  const loc = db.prepare('SELECT rack_id FROM locations WHERE id = ?').get(locId);
  db.prepare('DELETE FROM locations WHERE id = ?').run(locId);
  if (loc?.rack_id) syncRackSize(loc.rack_id);
  return { ok: true };
});

// Перетягування комірки в межах стелажа (редактор схеми).
const moveCell = db.transaction((locId, row, col) => {
  const loc = db.prepare("SELECT * FROM locations WHERE id = ? AND kind = 'cell'").get(locId);
  if (!loc) throw new Error('Комірку не знайдено');
  if (cellTaken(loc.rack_id, row, col)) throw new Error('Місце вже зайняте іншою коміркою');
  db.prepare('UPDATE locations SET row_idx = ?, col_idx = ? WHERE id = ?').run(row, col, locId);
  syncRackSize(loc.rack_id);
  return locationFull(locId);
});

function syncRackSize(rackId) {
  const b = rackBounds(rackId);
  db.prepare('UPDATE racks SET rows = ?, cols = ? WHERE id = ?').run(Math.max(b.rows, 1), Math.max(b.cols, 1), rackId);
}

// Додати одразу ряд із n комірок — щоб не клікати кожну.
const addCellRow = db.transaction((rackId, count, row = null) => {
  const rack = getRack(rackId);
  if (!rack) throw new Error('Стелаж не знайдено');
  const b = rackBounds(rackId);
  const r = row === null ? b.rows : row;
  let added = 0;
  for (let c = 0; c < count; c++) {
    if (!cellTaken(rackId, r, c)) {
      db.prepare(`
        INSERT INTO locations(warehouse_id, rack_id, kind, row_idx, col_idx, label, barcode)
        VALUES(?, ?, 'cell', ?, ?, ?, ?)
      `).run(rack.warehouse_id, rackId, r, c, autoLabel(rack.name, r, c), newLocationBarcode());
      added++;
    }
  }
  syncRackSize(rackId);
  return { added, rack: getRack(rackId) };
});

const updateRack = (id, { name, note = '', color = '' }) => {
  db.prepare('UPDATE racks SET name = ?, note = ?, color = ? WHERE id = ?').run(name, note, color, id);
  return getRack(id);
};

// Куди стелаж поставлено на плані складу і як розвернуто.
const setRackPosition = (id, { pos_x, pos_y, orientation }) => {
  db.prepare('UPDATE racks SET pos_x = ?, pos_y = ?, orientation = ? WHERE id = ?')
    .run(Math.max(0, pos_x | 0), Math.max(0, pos_y | 0), orientation === 'v' ? 'v' : 'h', id);
  return getRack(id);
};

const deleteRack = (id) => db.prepare('DELETE FROM racks WHERE id = ?').run(id);

// Повна схема стелажа з підсумками по кожній комірці — для екрана й редактора.
function rackGrid(rackId) {
  const rack = getRack(rackId);
  if (!rack) return null;
  const cells = db.prepare(`
    SELECT l.*,
           (SELECT COALESCE(SUM(s.qty), 0) FROM stock s WHERE s.location_id = l.id) AS qty,
           (SELECT COUNT(*) FROM stock s WHERE s.location_id = l.id AND s.qty > 0) AS products_count,
           (SELECT COUNT(*) FROM locations b WHERE b.parent_id = l.id) AS boxes_count
      FROM locations l
     WHERE l.rack_id = ? AND l.kind = 'cell'
     ORDER BY l.row_idx, l.col_idx
  `).all(rackId);
  const b = rackBounds(rackId);
  return { rack: { ...rack, rows: Math.max(b.rows, 1), cols: Math.max(b.cols, 1) }, cells };
}

// План складу: усі стелажі з їхніми координатами й габаритами в клітинках.
function warehousePlan(warehouseId) {
  const warehouse = getWarehouse(warehouseId);
  if (!warehouse) return null;
  const racks = listRacks(warehouseId).map((r) => {
    const b = rackBounds(r.id);
    const qty = db.prepare(`
      SELECT COALESCE(SUM(s.qty), 0) AS q FROM stock s
        JOIN locations l ON l.id = s.location_id
       WHERE l.rack_id = ?
    `).get(r.id).q;
    return { ...r, cells_count: b.count, cell_rows: Math.max(b.rows, 1), cell_cols: Math.max(b.cols, 1), qty };
  });
  const zones = db.prepare(`
    SELECT l.*, (SELECT COALESCE(SUM(s.qty), 0) FROM stock s WHERE s.location_id = l.id) AS qty
      FROM locations l WHERE l.warehouse_id = ? AND l.kind = 'zone' ORDER BY l.label
  `).all(warehouseId);
  return { warehouse, racks, zones };
}

const updateWarehousePlan = (id, { plan_w, plan_h }) => {
  db.prepare('UPDATE warehouses SET plan_w = ?, plan_h = ? WHERE id = ?')
    .run(Math.min(Math.max(plan_w | 0, 4), 60), Math.min(Math.max(plan_h | 0, 4), 60), id);
  return getWarehouse(id);
};

/* ------------------------------------------------------------- locations */

const locationFull = (id) => db.prepare(`
  SELECT l.*, w.name AS warehouse_name, r.name AS rack_name, r.rows, r.cols,
         p.label AS parent_label, p.row_idx AS parent_row, p.col_idx AS parent_col
    FROM locations l
    JOIN warehouses w ON w.id = l.warehouse_id
    LEFT JOIN racks r ON r.id = l.rack_id
    LEFT JOIN locations p ON p.id = l.parent_id
   WHERE l.id = ?
`).get(id);

// Коробка всередині комірки або вільна зона на складі без стелажа.
const createLocation = ({ warehouse_id, rack_id = null, parent_id = null, kind = 'box', label, note = '' }) => {
  const info = db.prepare(`
    INSERT INTO locations(warehouse_id, rack_id, parent_id, kind, label, barcode, note)
    VALUES(?, ?, ?, ?, ?, ?, ?)
  `).run(warehouse_id, rack_id, parent_id, kind, label, newLocationBarcode(), note);
  return locationFull(info.lastInsertRowid);
};

const updateLocation = (id, { label, note = '' }) => {
  db.prepare('UPDATE locations SET label = ?, note = ? WHERE id = ?').run(label, note, id);
  return locationFull(id);
};

const deleteLocation = (id) => db.prepare('DELETE FROM locations WHERE id = ?').run(id);

const listLocations = (warehouseId) => db.prepare(`
  SELECT l.*, r.name AS rack_name, p.label AS parent_label,
         (SELECT COALESCE(SUM(s.qty), 0) FROM stock s WHERE s.location_id = l.id) AS qty
    FROM locations l
    LEFT JOIN racks r ON r.id = l.rack_id
    LEFT JOIN locations p ON p.id = l.parent_id
   WHERE (? IS NULL OR l.warehouse_id = ?)
   ORDER BY r.name, l.row_idx, l.col_idx, l.label
`).all(warehouseId ?? null, warehouseId ?? null);

// Вміст місця + усіх вкладених коробок.
function locationContents(id) {
  const loc = locationFull(id);
  if (!loc) return null;
  const items = db.prepare(`
    SELECT s.qty, p.*, l.label AS location_label, l.id AS location_id
      FROM stock s
      JOIN products p ON p.id = s.product_id
      JOIN locations l ON l.id = s.location_id
     WHERE (s.location_id = ? OR l.parent_id = ?) AND s.qty > 0
     ORDER BY p.name
  `).all(id, id);
  const boxes = db.prepare(`
    SELECT l.*, (SELECT COALESCE(SUM(s.qty),0) FROM stock s WHERE s.location_id = l.id) AS qty
      FROM locations l WHERE l.parent_id = ? ORDER BY l.label
  `).all(id);
  return { location: loc, items, boxes };
}

/* ------------------------------------------------------------ categories */

// Дерево категорій на два рівні: батьківська + підкатегорії.
const listCategories = () => db.prepare(`
  SELECT c.*, p.name AS parent_name,
         (SELECT COUNT(*) FROM products pr WHERE pr.category_id = c.id) AS products_count,
         (SELECT COUNT(*) FROM categories ch WHERE ch.parent_id = c.id) AS children_count
    FROM categories c
    LEFT JOIN categories p ON p.id = c.parent_id
   ORDER BY COALESCE(p.name, c.name), c.sort, c.name
`).all();

const getCategory = (id) => db.prepare('SELECT * FROM categories WHERE id = ?').get(id);

const createCategory = ({ name, parent_id = null, color = '', sort = 0 }) => {
  const info = db.prepare('INSERT INTO categories(name, parent_id, color, sort) VALUES(?, ?, ?, ?)')
    .run(name, parent_id || null, color, sort | 0);
  return getCategory(info.lastInsertRowid);
};

const updateCategory = (id, { name, parent_id = null, color = '', sort = 0 }) => {
  // Категорія не може бути власним батьком — інакше дерево зациклиться.
  const pid = Number(parent_id) === Number(id) ? null : (parent_id || null);
  db.prepare('UPDATE categories SET name = ?, parent_id = ?, color = ?, sort = ? WHERE id = ?')
    .run(name, pid, color, sort | 0, id);
  return getCategory(id);
};

// Видалення категорії не чіпає товари: вони просто лишаються без категорії.
const deleteCategory = (id) => db.prepare('DELETE FROM categories WHERE id = ?').run(id);

// Категорія + усі її підкатегорії — щоб фільтр по батьківській показував і дочірні товари.
const categoryWithChildren = (id) => {
  const kids = db.prepare('SELECT id FROM categories WHERE parent_id = ?').all(id).map((c) => c.id);
  return [Number(id), ...kids];
};

/* ------------------------------------------------- поля категорій */

// Ланцюжок «батьківська → дочірня»: поля успадковуються згори вниз.
function categoryChain(categoryId) {
  const chain = [];
  let cur = categoryId ? getCategory(categoryId) : null;
  let guard = 0;
  while (cur && guard++ < 10) {
    chain.unshift(cur);
    cur = cur.parent_id ? getCategory(cur.parent_id) : null;
  }
  return chain;
}

const parseField = (f) => ({ ...f, options: JSON.parse(f.options || '[]'), required: !!f.required });

// Власні поля однієї категорії.
const listCategoryFields = (categoryId) =>
  db.prepare('SELECT * FROM category_fields WHERE category_id = ? ORDER BY sort, id').all(categoryId).map(parseField);

// Усі поля, що діють на товар цієї категорії: свої + успадковані від батьківської.
function effectiveFields(categoryId) {
  if (!categoryId) return [];
  return categoryChain(categoryId).flatMap((c) =>
    listCategoryFields(c.id).map((f) => ({ ...f, from_category: c.name, inherited: c.id !== Number(categoryId) })));
}

const createField = (categoryId, { label, type = 'text', options = [], required = 0, sort = null, hint = '' }) => {
  const nextSort = sort === null
    ? (db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM category_fields WHERE category_id = ?').get(categoryId).s)
    : sort;
  const info = db.prepare(`
    INSERT INTO category_fields(category_id, label, type, options, required, sort, hint)
    VALUES(?, ?, ?, ?, ?, ?, ?)
  `).run(categoryId, label, type, JSON.stringify(options || []), required ? 1 : 0, nextSort, hint);
  return parseField(db.prepare('SELECT * FROM category_fields WHERE id = ?').get(info.lastInsertRowid));
};

const updateField = (id, { label, type = 'text', options = [], required = 0, sort = 0, hint = '' }) => {
  db.prepare(`
    UPDATE category_fields SET label = ?, type = ?, options = ?, required = ?, sort = ?, hint = ? WHERE id = ?
  `).run(label, type, JSON.stringify(options || []), required ? 1 : 0, sort | 0, hint, id);
  return parseField(db.prepare('SELECT * FROM category_fields WHERE id = ?').get(id));
};

// Разом з полем зникають і всі його значення — це каскад у схемі.
const deleteField = (id) => db.prepare('DELETE FROM category_fields WHERE id = ?').run(id);

/**
 * Готові набори полів під типові бізнеси — щоб не описувати все руками.
 * Це лише стартові заготовки: після застосування поля звичайні, їх можна міняти.
 */
const FIELD_PRESETS = {
  auto: {
    name: 'Автозапчастини',
    fields: [
      { label: 'OEM-номер', type: 'text' },
      { label: 'Марка авто', type: 'text' },
      { label: 'Модель авто', type: 'text' },
      { label: 'Рік від', type: 'number' },
      { label: 'Рік до', type: 'number' },
      { label: 'Стан', type: 'select', options: ['Нова', 'Б/в', 'Відновлена'] },
    ],
  },
  food: {
    name: 'Продукти харчування',
    fields: [
      { label: 'Термін придатності до', type: 'date' },
      { label: 'Номер партії', type: 'text' },
      { label: 'Вага / об’єм', type: 'text', hint: 'напр. 500 г, 1 л' },
      { label: 'Умови зберігання', type: 'select', options: ['Кімнатна', 'Холодильник', 'Морозильник'] },
      { label: 'Виробник', type: 'text' },
    ],
  },
  clothes: {
    name: 'Одяг і взуття',
    fields: [
      { label: 'Розмір', type: 'text' },
      { label: 'Колір', type: 'text' },
      { label: 'Матеріал', type: 'text' },
      { label: 'Стать', type: 'select', options: ['Чоловіче', 'Жіноче', 'Унісекс', 'Дитяче'] },
      { label: 'Сезон', type: 'select', options: ['Літо', 'Зима', 'Демісезон'] },
    ],
  },
  electronics: {
    name: 'Електроніка',
    fields: [
      { label: 'Серійний номер', type: 'text' },
      { label: 'Гарантія, міс', type: 'number' },
      { label: 'Модель', type: 'text' },
      { label: 'Комплектність', type: 'textarea' },
    ],
  },
  building: {
    name: 'Будматеріали',
    fields: [
      { label: 'Розмір / габарит', type: 'text' },
      { label: 'Вага, кг', type: 'number' },
      { label: 'Матеріал', type: 'text' },
      { label: 'Клас / марка', type: 'text' },
    ],
  },
};

const listPresets = () => Object.entries(FIELD_PRESETS).map(([key, v]) => ({
  key, name: v.name, fields: v.fields.map((f) => f.label),
}));

// Додає поля набору, пропускаючи ті, що вже є з такою назвою.
const applyPreset = db.transaction((categoryId, presetKey) => {
  const preset = FIELD_PRESETS[presetKey];
  if (!preset) throw new Error('Невідомий набір полів');
  const existing = new Set(listCategoryFields(categoryId).map((f) => f.label.toLowerCase()));
  let added = 0;
  preset.fields.forEach((f) => {
    if (existing.has(f.label.toLowerCase())) return;
    createField(categoryId, f);
    added++;
  });
  return { added, fields: listCategoryFields(categoryId) };
});

const productValues = (productId) => {
  const rows = db.prepare('SELECT field_id, value FROM product_values WHERE product_id = ?').all(productId);
  return Object.fromEntries(rows.map((r) => [r.field_id, r.value]));
};

// Пишемо тільки ті поля, що справді діють на цю категорію — щоб у базі
// не осідали значення від категорії, з якої товар уже переїхав.
const saveProductValues = db.transaction((productId, categoryId, values = {}) => {
  const allowed = new Set(effectiveFields(categoryId).map((f) => f.id));
  db.prepare(allowed.size
    ? `DELETE FROM product_values WHERE product_id = ? AND field_id NOT IN (${[...allowed].join(',')})`
    : 'DELETE FROM product_values WHERE product_id = ?').run(productId);
  const ins = db.prepare('INSERT OR REPLACE INTO product_values(product_id, field_id, value) VALUES(?, ?, ?)');
  const del = db.prepare('DELETE FROM product_values WHERE product_id = ? AND field_id = ?');
  Object.entries(values || {}).forEach(([fid, val]) => {
    const id = Number(fid);
    if (!allowed.has(id)) return;
    if (val === '' || val === null || val === undefined) del.run(productId, id);
    else ins.run(productId, id, String(val));
  });
});

/* -------------------------------------------------------------- products */

const productRow = (id) => db.prepare(`
  SELECT p.*, c.name AS category_name, c.color AS category_color, pc.name AS category_parent_name
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN categories pc ON pc.id = c.parent_id
   WHERE p.id = ?
`).get(id);

// Де саме лежить товар: повний шлях склад → стелаж → комірка → коробка + координати для схеми.
const productPlacements = (productId) => db.prepare(`
  SELECT s.qty, l.id AS location_id, l.label, l.kind, l.row_idx, l.col_idx, l.barcode AS location_barcode,
         r.id AS rack_id, r.name AS rack_name, r.rows, r.cols,
         w.id AS warehouse_id, w.name AS warehouse_name,
         pl.label AS parent_label, pl.row_idx AS parent_row, pl.col_idx AS parent_col, pl.id AS parent_id
    FROM stock s
    JOIN locations l ON l.id = s.location_id
    LEFT JOIN locations pl ON pl.id = l.parent_id
    LEFT JOIN racks r ON r.id = COALESCE(l.rack_id, pl.rack_id)
    JOIN warehouses w ON w.id = l.warehouse_id
   WHERE s.product_id = ? AND s.qty > 0
   ORDER BY w.name, r.name, l.label
`).all(productId);

function productFull(id) {
  const product = productRow(id);
  if (!product) return null;
  const placements = productPlacements(id);
  const links = db.prepare(`
    SELECT pl.*, i.name AS integration_name, i.slug AS integration_slug
      FROM product_links pl JOIN integrations i ON i.id = pl.integration_id
     WHERE pl.product_id = ?
  `).all(id);
  const fields = effectiveFields(product.category_id);
  const values = productValues(id);
  return {
    ...product,
    total_qty: placements.reduce((s, p) => s + p.qty, 0),
    placements,
    links,
    fields,
    values,
    // Готовий до показу список «підпис → значення», без порожніх.
    attributes: fields
      .map((f) => ({ label: f.label, type: f.type, value: values[f.id] ?? '' }))
      .filter((a) => a.value !== ''),
  };
}

const createProduct = db.transaction((p) => {
  const info = db.prepare(`
    INSERT INTO products(barcode, code, name, category_id, unit, min_qty, price, note)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    p.barcode || newProductBarcode(), p.code || '', p.name, p.category_id || null,
    p.unit || 'шт', p.min_qty || 0, p.price || 0, p.note || ''
  );
  saveProductValues(info.lastInsertRowid, p.category_id || null, p.values);
  return productFull(info.lastInsertRowid);
});

const updateProduct = db.transaction((id, p) => {
  db.prepare(`
    UPDATE products SET code = ?, name = ?, category_id = ?, unit = ?, min_qty = ?, price = ?, note = ?
     WHERE id = ?
  `).run(
    p.code || '', p.name, p.category_id || null, p.unit || 'шт',
    p.min_qty || 0, p.price || 0, p.note || '', id
  );
  saveProductValues(id, p.category_id || null, p.values);
  return productFull(id);
});

const deleteProduct = (id) => db.prepare('DELETE FROM products WHERE id = ?').run(id);

function searchProducts({ q = '', limit = 100, offset = 0, lowStock = false, categoryId = null, uncategorized = false } = {}) {
  const like = `%${q.trim()}%`;
  const where = [];
  const args = [];
  if (q.trim()) {
    // Пошук іде і по власних полях категорії — інакше не знайти за OEM чи серійним номером.
    where.push(`(p.name LIKE ? OR p.code LIKE ? OR p.barcode LIKE ?
                 OR EXISTS (SELECT 1 FROM product_values v WHERE v.product_id = p.id AND v.value LIKE ?))`);
    args.push(like, like, like, like);
  }
  if (uncategorized) {
    where.push('p.category_id IS NULL');
  } else if (categoryId) {
    // Фільтр по батьківській категорії має показувати й товари з її підкатегорій.
    const ids = categoryWithChildren(categoryId);
    where.push(`p.category_id IN (${ids.map(() => '?').join(',')})`);
    args.push(...ids);
  }
  let sql = `
    SELECT * FROM (
      SELECT p.*, c.name AS category_name, c.color AS category_color,
             COALESCE((SELECT SUM(s.qty) FROM stock s WHERE s.product_id = p.id), 0) AS total_qty
        FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    )
  `;
  if (lowStock) sql += ' WHERE min_qty > 0 AND total_qty <= min_qty ';
  sql += ' ORDER BY name LIMIT ? OFFSET ?';
  args.push(limit, offset);
  return db.prepare(sql).all(...args);
}

/* ----------------------------------------------------------------- stock */

const getQty = (productId, locId) => {
  const row = db.prepare('SELECT qty FROM stock WHERE product_id = ? AND location_id = ?').get(productId, locId);
  return row ? row.qty : 0;
};

const setQty = (productId, locId, qty) => {
  if (qty <= 0) {
    db.prepare('DELETE FROM stock WHERE product_id = ? AND location_id = ?').run(productId, locId);
  } else {
    db.prepare(`
      INSERT INTO stock(product_id, location_id, qty) VALUES(?, ?, ?)
      ON CONFLICT(product_id, location_id) DO UPDATE SET qty = excluded.qty
    `).run(productId, locId, qty);
  }
};

const logMove = (type, productId, fromLoc, toLoc, qty, note) =>
  db.prepare('INSERT INTO movements(type, product_id, from_loc_id, to_loc_id, qty, note) VALUES(?, ?, ?, ?, ?, ?)')
    .run(type, productId, fromLoc, toLoc, qty, note || '');

// Прихід: поклали qty штук деталі у місце.
const stockIn = db.transaction((productId, locId, qty, note) => {
  setQty(productId, locId, getQty(productId, locId) + qty);
  logMove('in', productId, null, locId, qty, note);
  pushOutbox('stock.changed', { product_id: productId, total_qty: totalQty(productId) });
  return productFull(productId);
});

// Видача: зняли qty штук з місця. Кидає помилку, якщо стільки немає.
const stockOut = db.transaction((productId, locId, qty, note) => {
  const have = getQty(productId, locId);
  if (have < qty) throw new Error(`У цьому місці лише ${have} шт, а списати треба ${qty}`);
  setQty(productId, locId, have - qty);
  logMove('out', productId, locId, null, qty, note);
  pushOutbox('stock.changed', { product_id: productId, total_qty: totalQty(productId) });
  return productFull(productId);
});

// Переміщення між місцями.
const stockMove = db.transaction((productId, fromLoc, toLoc, qty, note) => {
  const have = getQty(productId, fromLoc);
  if (have < qty) throw new Error(`У місці-джерелі лише ${have} шт`);
  setQty(productId, fromLoc, have - qty);
  setQty(productId, toLoc, getQty(productId, toLoc) + qty);
  logMove('move', productId, fromLoc, toLoc, qty, note);
  return productFull(productId);
});

// Інвентаризація: виставили точну кількість у місці.
const stockAdjust = db.transaction((productId, locId, qty, note) => {
  const before = getQty(productId, locId);
  setQty(productId, locId, qty);
  logMove('adjust', productId, locId, locId, qty - before, note || `Інвентаризація: було ${before}, стало ${qty}`);
  pushOutbox('stock.changed', { product_id: productId, total_qty: totalQty(productId) });
  return productFull(productId);
});

const totalQty = (productId) => {
  const r = db.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock WHERE product_id = ?').get(productId);
  return r.q;
};

const listMovements = ({ productId = null, limit = 200 } = {}) => db.prepare(`
  SELECT m.*, p.name AS product_name, p.barcode AS product_barcode,
         fl.label AS from_label, tl.label AS to_label
    FROM movements m
    LEFT JOIN products p ON p.id = m.product_id
    LEFT JOIN locations fl ON fl.id = m.from_loc_id
    LEFT JOIN locations tl ON tl.id = m.to_loc_id
   WHERE (? IS NULL OR m.product_id = ?)
   ORDER BY m.id DESC LIMIT ?
`).all(productId, productId, limit);

/* ------------------------------------------------------------- сканування */

// Одна точка входу для сканера й ручного пошуку.
// Повертає { type: 'product'|'location'|'many'|'none', ... }
function resolveCode(raw) {
  const code = String(raw || '').trim();
  if (!code) return { type: 'none', query: code };

  const loc = db.prepare('SELECT id FROM locations WHERE barcode = ?').get(code);
  if (loc) return { type: 'location', ...locationContents(loc.id) };

  const byBarcode = db.prepare('SELECT id FROM products WHERE barcode = ?').get(code);
  if (byBarcode) return { type: 'product', product: productFull(byBarcode.id) };

  const exact = db.prepare('SELECT id FROM products WHERE code = ? OR oem = ? LIMIT 2').all(code, code);
  if (exact.length === 1) return { type: 'product', product: productFull(exact[0].id) };

  const found = searchProducts({ q: code, limit: 50 });
  if (found.length === 1) return { type: 'product', product: productFull(found[0].id) };
  if (found.length > 1) return { type: 'many', query: code, results: found };
  return { type: 'none', query: code };
}

/* ------------------------------------------------------------ інтеграції */

const crypto = require('crypto');

const listIntegrations = () => db.prepare(`
  SELECT i.*, (SELECT COUNT(*) FROM product_links pl WHERE pl.integration_id = i.id) AS links_count
    FROM integrations i ORDER BY i.name
`).all();

const createIntegration = ({ name, slug, webhook_url = '', config = '{}' }) => {
  const key = 'sk_' + crypto.randomBytes(24).toString('hex');
  const info = db.prepare('INSERT INTO integrations(name, slug, api_key, webhook_url, config) VALUES(?, ?, ?, ?, ?)')
    .run(name, slug, key, webhook_url, config);
  return db.prepare('SELECT * FROM integrations WHERE id = ?').get(info.lastInsertRowid);
};

const updateIntegration = (id, { name, webhook_url = '', enabled = 1, config = '{}' }) => {
  db.prepare('UPDATE integrations SET name = ?, webhook_url = ?, enabled = ?, config = ? WHERE id = ?')
    .run(name, webhook_url, enabled ? 1 : 0, config, id);
  return db.prepare('SELECT * FROM integrations WHERE id = ?').get(id);
};

const rotateIntegrationKey = (id) => {
  const key = 'sk_' + crypto.randomBytes(24).toString('hex');
  db.prepare('UPDATE integrations SET api_key = ? WHERE id = ?').run(key, id);
  return db.prepare('SELECT * FROM integrations WHERE id = ?').get(id);
};

const deleteIntegration = (id) => db.prepare('DELETE FROM integrations WHERE id = ?').run(id);

const integrationByKey = (key) =>
  db.prepare('SELECT * FROM integrations WHERE api_key = ? AND enabled = 1').get(key);

const linkProduct = ({ product_id, integration_id, external_id, external_sku = '', external_url = '' }) => {
  db.prepare(`
    INSERT INTO product_links(product_id, integration_id, external_id, external_sku, external_url)
    VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(integration_id, external_id)
    DO UPDATE SET product_id = excluded.product_id, external_sku = excluded.external_sku, external_url = excluded.external_url
  `).run(product_id, integration_id, String(external_id), external_sku, external_url);
  return productFull(product_id);
};

const unlinkProduct = (linkId) => db.prepare('DELETE FROM product_links WHERE id = ?').run(linkId);

// Пошук деталі за ідентифікатором із зовнішньої системи: спершу явний зв'язок, далі артикул/OEM.
function findByExternal(integrationId, { external_id, sku }) {
  if (external_id) {
    const link = db.prepare('SELECT product_id FROM product_links WHERE integration_id = ? AND external_id = ?')
      .get(integrationId, String(external_id));
    if (link) return productFull(link.product_id);
  }
  if (sku) {
    const p = db.prepare('SELECT id FROM products WHERE code = ? OR oem = ? OR barcode = ? LIMIT 1').get(sku, sku, sku);
    if (p) return productFull(p.id);
  }
  return null;
}

/* ------------------------------------------------------------------ дашборд */

function dashboard() {
  const one = (sql) => db.prepare(sql).get().v;
  return {
    warehouses: one('SELECT COUNT(*) AS v FROM warehouses'),
    racks: one('SELECT COUNT(*) AS v FROM racks'),
    locations: one('SELECT COUNT(*) AS v FROM locations'),
    products: one('SELECT COUNT(*) AS v FROM products'),
    total_qty: one('SELECT COALESCE(SUM(qty), 0) AS v FROM stock'),
    unplaced: one('SELECT COUNT(*) AS v FROM products p WHERE NOT EXISTS (SELECT 1 FROM stock s WHERE s.product_id = p.id AND s.qty > 0)'),
    low_stock: searchProducts({ lowStock: true, limit: 20 }),
    recent: listMovements({ limit: 15 }),
  };
}

module.exports = {
  colName,
  listWarehouses, createWarehouse, getWarehouse, updateWarehouse, deleteWarehouse,
  listRacks, getRack, createRack, updateRack, deleteRack, rackGrid, rackBounds,
  addCell, addCellRow, removeCell, moveCell, setRackPosition,
  warehousePlan, updateWarehousePlan,
  listLocations, createLocation, updateLocation, deleteLocation, locationFull, locationContents,
  searchProducts, productFull, createProduct, updateProduct, deleteProduct, productPlacements,
  listCategories, getCategory, createCategory, updateCategory, deleteCategory,
  listCategoryFields, effectiveFields, createField, updateField, deleteField,
  listPresets, applyPreset, productValues,
  stockIn, stockOut, stockMove, stockAdjust, getQty, totalQty, listMovements,
  resolveCode,
  listIntegrations, createIntegration, updateIntegration, rotateIntegrationKey, deleteIntegration,
  integrationByKey, linkProduct, unlinkProduct, findByExternal,
  dashboard,
};
