'use strict';

const { db, newPartBarcode, newLocationBarcode } = require('../db');

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
           (SELECT COUNT(*) FROM stock s WHERE s.location_id = l.id AND s.qty > 0) AS parts_count,
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
      JOIN parts p ON p.id = s.part_id
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

/* ----------------------------------------------------------------- parts */

const partRow = (id) => db.prepare('SELECT * FROM parts WHERE id = ?').get(id);

// Де саме лежить деталь: повний шлях склад → стелаж → комірка → коробка + координати для схеми.
const partPlacements = (partId) => db.prepare(`
  SELECT s.qty, l.id AS location_id, l.label, l.kind, l.row_idx, l.col_idx, l.barcode AS location_barcode,
         r.id AS rack_id, r.name AS rack_name, r.rows, r.cols,
         w.id AS warehouse_id, w.name AS warehouse_name,
         pl.label AS parent_label, pl.row_idx AS parent_row, pl.col_idx AS parent_col, pl.id AS parent_id
    FROM stock s
    JOIN locations l ON l.id = s.location_id
    LEFT JOIN locations pl ON pl.id = l.parent_id
    LEFT JOIN racks r ON r.id = COALESCE(l.rack_id, pl.rack_id)
    JOIN warehouses w ON w.id = l.warehouse_id
   WHERE s.part_id = ? AND s.qty > 0
   ORDER BY w.name, r.name, l.label
`).all(partId);

function partFull(id) {
  const part = partRow(id);
  if (!part) return null;
  const placements = partPlacements(id);
  const links = db.prepare(`
    SELECT pl.*, i.name AS integration_name, i.slug AS integration_slug
      FROM part_links pl JOIN integrations i ON i.id = pl.integration_id
     WHERE pl.part_id = ?
  `).all(id);
  return {
    ...part,
    total_qty: placements.reduce((s, p) => s + p.qty, 0),
    placements,
    links,
  };
}

const createPart = (p) => {
  const info = db.prepare(`
    INSERT INTO parts(barcode, code, oem, name, brand, car_make, car_model, unit, min_qty, price, note)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    p.barcode || newPartBarcode(), p.code || '', p.oem || '', p.name, p.brand || '',
    p.car_make || '', p.car_model || '', p.unit || 'шт', p.min_qty || 0, p.price || 0, p.note || ''
  );
  return partFull(info.lastInsertRowid);
};

const updatePart = (id, p) => {
  db.prepare(`
    UPDATE parts SET code = ?, oem = ?, name = ?, brand = ?, car_make = ?, car_model = ?,
                     unit = ?, min_qty = ?, price = ?, note = ?
     WHERE id = ?
  `).run(
    p.code || '', p.oem || '', p.name, p.brand || '', p.car_make || '', p.car_model || '',
    p.unit || 'шт', p.min_qty || 0, p.price || 0, p.note || '', id
  );
  return partFull(id);
};

const deletePart = (id) => db.prepare('DELETE FROM parts WHERE id = ?').run(id);

function searchParts({ q = '', limit = 100, offset = 0, lowStock = false } = {}) {
  const like = `%${q.trim()}%`;
  const where = [];
  const args = [];
  if (q.trim()) {
    where.push('(p.name LIKE ? OR p.code LIKE ? OR p.oem LIKE ? OR p.barcode LIKE ? OR p.brand LIKE ? OR p.car_model LIKE ?)');
    args.push(like, like, like, like, like, like);
  }
  let sql = `
    SELECT * FROM (
      SELECT p.*, COALESCE((SELECT SUM(s.qty) FROM stock s WHERE s.part_id = p.id), 0) AS total_qty
        FROM parts p
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    )
  `;
  if (lowStock) sql += ' WHERE min_qty > 0 AND total_qty <= min_qty ';
  sql += ' ORDER BY name LIMIT ? OFFSET ?';
  args.push(limit, offset);
  return db.prepare(sql).all(...args);
}

/* ----------------------------------------------------------------- stock */

const getQty = (partId, locId) => {
  const row = db.prepare('SELECT qty FROM stock WHERE part_id = ? AND location_id = ?').get(partId, locId);
  return row ? row.qty : 0;
};

const setQty = (partId, locId, qty) => {
  if (qty <= 0) {
    db.prepare('DELETE FROM stock WHERE part_id = ? AND location_id = ?').run(partId, locId);
  } else {
    db.prepare(`
      INSERT INTO stock(part_id, location_id, qty) VALUES(?, ?, ?)
      ON CONFLICT(part_id, location_id) DO UPDATE SET qty = excluded.qty
    `).run(partId, locId, qty);
  }
};

const logMove = (type, partId, fromLoc, toLoc, qty, note) =>
  db.prepare('INSERT INTO movements(type, part_id, from_loc_id, to_loc_id, qty, note) VALUES(?, ?, ?, ?, ?, ?)')
    .run(type, partId, fromLoc, toLoc, qty, note || '');

// Прихід: поклали qty штук деталі у місце.
const stockIn = db.transaction((partId, locId, qty, note) => {
  setQty(partId, locId, getQty(partId, locId) + qty);
  logMove('in', partId, null, locId, qty, note);
  pushOutbox('stock.changed', { part_id: partId, total_qty: totalQty(partId) });
  return partFull(partId);
});

// Видача: зняли qty штук з місця. Кидає помилку, якщо стільки немає.
const stockOut = db.transaction((partId, locId, qty, note) => {
  const have = getQty(partId, locId);
  if (have < qty) throw new Error(`У цьому місці лише ${have} шт, а списати треба ${qty}`);
  setQty(partId, locId, have - qty);
  logMove('out', partId, locId, null, qty, note);
  pushOutbox('stock.changed', { part_id: partId, total_qty: totalQty(partId) });
  return partFull(partId);
});

// Переміщення між місцями.
const stockMove = db.transaction((partId, fromLoc, toLoc, qty, note) => {
  const have = getQty(partId, fromLoc);
  if (have < qty) throw new Error(`У місці-джерелі лише ${have} шт`);
  setQty(partId, fromLoc, have - qty);
  setQty(partId, toLoc, getQty(partId, toLoc) + qty);
  logMove('move', partId, fromLoc, toLoc, qty, note);
  return partFull(partId);
});

// Інвентаризація: виставили точну кількість у місці.
const stockAdjust = db.transaction((partId, locId, qty, note) => {
  const before = getQty(partId, locId);
  setQty(partId, locId, qty);
  logMove('adjust', partId, locId, locId, qty - before, note || `Інвентаризація: було ${before}, стало ${qty}`);
  pushOutbox('stock.changed', { part_id: partId, total_qty: totalQty(partId) });
  return partFull(partId);
});

const totalQty = (partId) => {
  const r = db.prepare('SELECT COALESCE(SUM(qty), 0) AS q FROM stock WHERE part_id = ?').get(partId);
  return r.q;
};

const listMovements = ({ partId = null, limit = 200 } = {}) => db.prepare(`
  SELECT m.*, p.name AS part_name, p.barcode AS part_barcode,
         fl.label AS from_label, tl.label AS to_label
    FROM movements m
    LEFT JOIN parts p ON p.id = m.part_id
    LEFT JOIN locations fl ON fl.id = m.from_loc_id
    LEFT JOIN locations tl ON tl.id = m.to_loc_id
   WHERE (? IS NULL OR m.part_id = ?)
   ORDER BY m.id DESC LIMIT ?
`).all(partId, partId, limit);

/* ------------------------------------------------------------- сканування */

// Одна точка входу для сканера й ручного пошуку.
// Повертає { type: 'part'|'location'|'many'|'none', ... }
function resolveCode(raw) {
  const code = String(raw || '').trim();
  if (!code) return { type: 'none', query: code };

  const loc = db.prepare('SELECT id FROM locations WHERE barcode = ?').get(code);
  if (loc) return { type: 'location', ...locationContents(loc.id) };

  const byBarcode = db.prepare('SELECT id FROM parts WHERE barcode = ?').get(code);
  if (byBarcode) return { type: 'part', part: partFull(byBarcode.id) };

  const exact = db.prepare('SELECT id FROM parts WHERE code = ? OR oem = ? LIMIT 2').all(code, code);
  if (exact.length === 1) return { type: 'part', part: partFull(exact[0].id) };

  const found = searchParts({ q: code, limit: 50 });
  if (found.length === 1) return { type: 'part', part: partFull(found[0].id) };
  if (found.length > 1) return { type: 'many', query: code, results: found };
  return { type: 'none', query: code };
}

/* ------------------------------------------------------------ інтеграції */

const crypto = require('crypto');

const listIntegrations = () => db.prepare(`
  SELECT i.*, (SELECT COUNT(*) FROM part_links pl WHERE pl.integration_id = i.id) AS links_count
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

const linkPart = ({ part_id, integration_id, external_id, external_sku = '', external_url = '' }) => {
  db.prepare(`
    INSERT INTO part_links(part_id, integration_id, external_id, external_sku, external_url)
    VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(integration_id, external_id)
    DO UPDATE SET part_id = excluded.part_id, external_sku = excluded.external_sku, external_url = excluded.external_url
  `).run(part_id, integration_id, String(external_id), external_sku, external_url);
  return partFull(part_id);
};

const unlinkPart = (linkId) => db.prepare('DELETE FROM part_links WHERE id = ?').run(linkId);

// Пошук деталі за ідентифікатором із зовнішньої системи: спершу явний зв'язок, далі артикул/OEM.
function findByExternal(integrationId, { external_id, sku }) {
  if (external_id) {
    const link = db.prepare('SELECT part_id FROM part_links WHERE integration_id = ? AND external_id = ?')
      .get(integrationId, String(external_id));
    if (link) return partFull(link.part_id);
  }
  if (sku) {
    const p = db.prepare('SELECT id FROM parts WHERE code = ? OR oem = ? OR barcode = ? LIMIT 1').get(sku, sku, sku);
    if (p) return partFull(p.id);
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
    parts: one('SELECT COUNT(*) AS v FROM parts'),
    total_qty: one('SELECT COALESCE(SUM(qty), 0) AS v FROM stock'),
    unplaced: one('SELECT COUNT(*) AS v FROM parts p WHERE NOT EXISTS (SELECT 1 FROM stock s WHERE s.part_id = p.id AND s.qty > 0)'),
    low_stock: searchParts({ lowStock: true, limit: 20 }),
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
  searchParts, partFull, createPart, updatePart, deletePart, partPlacements,
  stockIn, stockOut, stockMove, stockAdjust, getQty, totalQty, listMovements,
  resolveCode,
  listIntegrations, createIntegration, updateIntegration, rotateIntegrationKey, deleteIntegration,
  integrationByKey, linkPart, unlinkPart, findByExternal,
  dashboard,
};
