'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Каталог даних можна винести за межі коду — зручно для деплою й для тестів.
const DATA_DIR_ENV = process.env.INVENTA_DATA_DIR || process.env.SKLAD_DATA_DIR;
const DATA_DIR = DATA_DIR_ENV ? path.resolve(DATA_DIR_ENV) : path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'sklad.db');

/* Копія бази при кожному старті. Inventa — єдине джерело правди про залишки,
   і відкотитись має бути на що. Тримаємо останні 10 копій. */
function backupOnStart() {
  if (!fs.existsSync(DB_FILE) || (process.env.INVENTA_NO_BACKUP || process.env.SKLAD_NO_BACKUP) === '1') return;
  const dir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  try {
    // Проста копія головного файлу; перед нею скидаємо WAL, щоб копія була цілісною.
    const tmp = new Database(DB_FILE);
    tmp.pragma('wal_checkpoint(TRUNCATE)');
    tmp.close();
    fs.copyFileSync(DB_FILE, path.join(dir, `inventa-${stamp}.db`));
    // Прибираємо зайві копії за часом, а не за назвою: після перейменування
    // додатка в каталозі можуть лежати файли зі старим префіксом.
    fs.readdirSync(dir).filter((f) => f.endsWith('.db'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => a.t - b.t).slice(0, -10)
      .forEach(({ f }) => fs.unlinkSync(path.join(dir, f)));
  } catch (e) {
    console.error('Не вдалося зробити резервну копію бази:', e.message);
  }
}
backupOnStart();

const db = new Database(DB_FILE);
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

-- Поля, які категорія додає до форми товару. Саме тут живе специфіка бізнесу:
-- автозапчастини мають OEM і модель авто, продукти — термін придатності й партію.
-- type: text | textarea | number | date | select | checkbox
CREATE TABLE IF NOT EXISTS category_fields (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'text',
  options     TEXT DEFAULT '[]',
  required    INTEGER NOT NULL DEFAULT 0,
  sort        INTEGER NOT NULL DEFAULT 0,
  hint        TEXT DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fields_cat ON category_fields(category_id);

CREATE TABLE IF NOT EXISTS product_values (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  field_id   INTEGER NOT NULL REFERENCES category_fields(id) ON DELETE CASCADE,
  value      TEXT DEFAULT '',
  PRIMARY KEY (product_id, field_id)
);
CREATE INDEX IF NOT EXISTS idx_values_field ON product_values(field_id);

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

-- Заводські штрих-коди з упаковки. Свій код у товару один (у полі barcode),
-- а чужих може бути скільки завгодно: EAN виробника, код постачальника тощо.
CREATE TABLE IF NOT EXISTS product_barcodes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  code       TEXT NOT NULL UNIQUE,
  note       TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pbarcodes_product ON product_barcodes(product_id);

-- Фото товару лежать файлами в data/uploads, у базі — лише імена.
CREATE TABLE IF NOT EXISTS product_photos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  file       TEXT NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_photos_product ON product_photos(product_id);

-- role: admin (усе) | worker (рух товару й товари) | viewer (тільки перегляд)
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  login         TEXT NOT NULL UNIQUE,
  name          TEXT DEFAULT '',
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'worker',
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login    TEXT
);

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
// Хто зробив рух товару. Стара база рухів такої колонки не мала.
addColumn('movements', 'user_id', 'INTEGER REFERENCES users(id)');
addColumn('movements', 'user_name', "TEXT DEFAULT ''");
// Категорія товару — для баз, що існували до появи категорій.
// Індекс ставимо тут, а не в CREATE-блоці: на старій базі колонки ще не було.
addColumn('products', 'category_id', 'INTEGER REFERENCES categories(id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_products_cat ON products(category_id)');

/* Поля OEM / марка авто / модель раніше були вбудовані у форму товару. Тепер це
   звичайні поля категорії. Переносимо наявні значення один раз, щоб нічого не зникло.
   Самі колонки лишаємо в таблиці — як страховку. */
function migrateLegacyAutoFields() {
  const done = db.prepare("SELECT value FROM meta WHERE key = 'legacy_auto_fields_moved'").get();
  if (done) return;

  const legacy = [
    ['oem', 'OEM-номер'],
    ['car_make', 'Марка авто'],
    ['car_model', 'Модель авто'],
  ].filter(([col]) => db.prepare('PRAGMA table_info(products)').all().some((c) => c.name === col));

  const mark = () => db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('legacy_auto_fields_moved', '1')").run();
  if (!legacy.length) return mark();

  const cond = legacy.map(([c]) => `COALESCE(${c}, '') <> ''`).join(' OR ');
  const rows = db.prepare(`SELECT id, category_id, ${legacy.map(([c]) => c).join(', ')} FROM products WHERE ${cond}`).all();
  if (!rows.length) return mark();

  const run = db.transaction(() => {
    // Товарам без категорії заводимо «Автозапчастини»; решта отримує поля у свою категорію.
    let fallbackId = db.prepare("SELECT id FROM categories WHERE name = 'Автозапчастини'").get()?.id;
    if (!fallbackId && rows.some((r) => !r.category_id)) {
      fallbackId = db.prepare("INSERT INTO categories(name) VALUES('Автозапчастини')").run().lastInsertRowid;
    }

    const fieldId = (categoryId, label, sort) => {
      const found = db.prepare('SELECT id FROM category_fields WHERE category_id = ? AND label = ?').get(categoryId, label);
      if (found) return found.id;
      return db.prepare('INSERT INTO category_fields(category_id, label, type, sort) VALUES(?, ?, ?, ?)')
        .run(categoryId, label, 'text', sort).lastInsertRowid;
    };

    rows.forEach((r) => {
      const catId = r.category_id || fallbackId;
      if (!r.category_id) db.prepare('UPDATE products SET category_id = ? WHERE id = ?').run(catId, r.id);
      legacy.forEach(([col, label], i) => {
        const val = r[col];
        if (!val) return;
        db.prepare('INSERT OR REPLACE INTO product_values(product_id, field_id, value) VALUES(?, ?, ?)')
          .run(r.id, fieldId(catId, label, i), val);
      });
    });
    mark();
  });
  run();
}
migrateLegacyAutoFields();

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

module.exports = { db, DATA_DIR, newProductBarcode, newLocationBarcode };
