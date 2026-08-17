'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'sklad.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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

CREATE TABLE IF NOT EXISTS parts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  barcode    TEXT NOT NULL UNIQUE,
  code       TEXT DEFAULT '',
  oem        TEXT DEFAULT '',
  name       TEXT NOT NULL,
  brand      TEXT DEFAULT '',
  car_make   TEXT DEFAULT '',
  car_model  TEXT DEFAULT '',
  unit       TEXT DEFAULT 'шт',
  min_qty    INTEGER DEFAULT 0,
  price      REAL DEFAULT 0,
  note       TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_parts_code ON parts(code);
CREATE INDEX IF NOT EXISTS idx_parts_oem  ON parts(oem);

CREATE TABLE IF NOT EXISTS stock (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  part_id     INTEGER NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  qty         INTEGER NOT NULL DEFAULT 0,
  UNIQUE(part_id, location_id)
);
CREATE INDEX IF NOT EXISTS idx_stock_loc ON stock(location_id);

-- type: 'in' | 'out' | 'move' | 'adjust'
CREATE TABLE IF NOT EXISTS movements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  type        TEXT NOT NULL,
  part_id     INTEGER REFERENCES parts(id) ON DELETE SET NULL,
  from_loc_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  to_loc_id   INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  qty         INTEGER NOT NULL,
  note        TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_mov_part ON movements(part_id);
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

-- Зв'язок нашої деталі з товаром у зовнішній системі.
CREATE TABLE IF NOT EXISTS part_links (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  part_id        INTEGER NOT NULL REFERENCES parts(id) ON DELETE CASCADE,
  integration_id INTEGER NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  external_id    TEXT NOT NULL,
  external_sku   TEXT DEFAULT '',
  external_url   TEXT DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(integration_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_links_part ON part_links(part_id);

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

// Лічильники штрих-кодів живуть у meta, щоб код не «переїжджав» після видалення рядків.
function nextSeq(key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  const next = (row ? parseInt(row.value, 10) : 0) + 1;
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(next));
  return next;
}

function newPartBarcode() {
  return 'P' + String(nextSeq('seq_part')).padStart(6, '0');
}

function newLocationBarcode() {
  return 'L' + String(nextSeq('seq_loc')).padStart(6, '0');
}

module.exports = { db, newPartBarcode, newLocationBarcode };
