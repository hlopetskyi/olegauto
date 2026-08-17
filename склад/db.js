'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'sklad.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/* Перейменування «запчастина» → «товар»: додаток задумувався під автозапчастини,
   але має обслуговувати будь-який бізнес. Робимо до створення нових таблиць,
   інакше поруч виникли б і старі, і нові. */
const tableExists = (t) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
const columnExists = (t, c) =>
  tableExists(t) && db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);

if (tableExists('parts') && !tableExists('products')) db.exec('ALTER TABLE parts RENAME TO products');
if (tableExists('part_links') && !tableExists('product_links')) db.exec('ALTER TABLE part_links RENAME TO product_links');
[['product_links', 'part_id'], ['stock', 'part_id'], ['movements', 'part_id']].forEach(([t, c]) => {
  if (columnExists(t, c) && !columnExists(t, 'product_id')) {
    db.exec(`ALTER TABLE ${t} RENAME COLUMN ${c} TO product_id`);
  }
});

db.exec(`
CREATE TABLE IF NOT EXISTS warehouses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  address    TEXT DEFAULT '',
  note       TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS racks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  rows         INTEGER NOT NULL DEFAULT 4,
  cols         INTEGER NOT NULL DEFAULT 5,
  note         TEXT DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- kind: 'cell' = комірка стелажа, 'box' = коробка всередині комірки, 'zone' = вільне місце на складі
CREATE TABLE IF NOT EXISTS locations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  rack_id      INTEGER REFERENCES racks(id) ON DELETE CASCADE,
  parent_id    INTEGER REFERENCES locations(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'cell',
  row_idx      INTEGER,
  col_idx      INTEGER,
  label        TEXT NOT NULL,
  barcode      TEXT NOT NULL UNIQUE,
  note         TEXT DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_loc_rack ON locations(rack_id);
CREATE INDEX IF NOT EXISTS idx_loc_wh   ON locations(warehouse_id);

-- Категорії товарів. parent_id дає підкатегорії: «Гальма» → «Колодки».
CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  parent_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  color      TEXT DEFAULT '',
  sort       INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cat_parent ON categories(parent_id);

CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  barcode     TEXT NOT NULL UNIQUE,
  code        TEXT DEFAULT '',
  oem         TEXT DEFAULT '',
  name        TEXT NOT NULL,
  brand       TEXT DEFAULT '',
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  car_make    TEXT DEFAULT '',
  car_model   TEXT DEFAULT '',
  unit        TEXT DEFAULT 'шт',
  min_qty     INTEGER DEFAULT 0,
  price       REAL DEFAULT 0,
  note        TEXT DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_products_code ON products(code);
CREATE INDEX IF NOT EXISTS idx_products_oem  ON products(oem);

CREATE TABLE IF NOT EXISTS stock (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  qty         INTEGER NOT NULL DEFAULT 0,
  UNIQUE(product_id, location_id)
);
CREATE INDEX IF NOT EXISTS idx_stock_loc ON stock(location_id);

-- type: 'in' | 'out' | 'move' | 'adjust'
CREATE TABLE IF NOT EXISTS movements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  type        TEXT NOT NULL,
  product_id  INTEGER REFERENCES products(id) ON DELETE SET NULL,
  from_loc_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  to_loc_id   INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  qty         INTEGER NOT NULL,
  note        TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_mov_product ON movements(product_id);
CREATE INDEX IF NOT EXISTS idx_mov_ts   ON movements(ts);

-- Інтеграції: зовнішні сервіси (магазини, CRM, маркетплейси), що ходять у наш API.
CREATE TABLE IF NOT EXISTS integrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  api_key    TEXT NOT NULL UNIQUE,
  enabled    INTEGER NOT NULL DEFAULT 1,
  webhook_url TEXT DEFAULT '',
  config     TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Зв'язок нашого товару з товаром у зовнішній системі.
CREATE TABLE IF NOT EXISTS product_links (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id     INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  integration_id INTEGER NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  external_id    TEXT NOT NULL,
  external_sku   TEXT DEFAULT '',
  external_url   TEXT DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(integration_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_links_product ON product_links(product_id);

-- Черга подій для зовнішніх систем (зміна залишку тощо). Доставка — окремим воркером.
CREATE TABLE IF NOT EXISTS outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL DEFAULT (datetime('now')),
  event      TEXT NOT NULL,
  payload    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

/* Міграції: доліплюємо колонки до вже існуючих баз, не чіпаючи даних. */
function addColumn(table, column, decl) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

// Позиція стелажа на плані складу + як він розвернутий.
addColumn('racks', 'pos_x', 'INTEGER DEFAULT 0');
addColumn('racks', 'pos_y', 'INTEGER DEFAULT 0');
addColumn('racks', 'orientation', "TEXT DEFAULT 'h'");
addColumn('racks', 'color', "TEXT DEFAULT ''");
// Розмір «підлоги» складу в клітинках плану.
addColumn('warehouses', 'plan_w', 'INTEGER DEFAULT 24');
addColumn('warehouses', 'plan_h', 'INTEGER DEFAULT 14');
// Категорія товару — для баз, що існували до появи категорій.
// Індекс ставимо тут, а не в CREATE-блоці: на старій базі колонки ще не було.
addColumn('products', 'category_id', 'INTEGER REFERENCES categories(id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_products_cat ON products(category_id)');

// Лічильники штрих-кодів живуть у meta, щоб код не «переїжджав» після видалення рядків.
function nextSeq(key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  const next = (row ? parseInt(row.value, 10) : 0) + 1;
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(next));
  return next;
}

function newProductBarcode() {
  return 'P' + String(nextSeq('seq_part')).padStart(6, '0');
}

function newLocationBarcode() {
  return 'L' + String(nextSeq('seq_loc')).padStart(6, '0');
}

module.exports = { db, newProductBarcode, newLocationBarcode };
