'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');

const S = require('./lib/store');
const v1 = require('./routes/v1');

const PORT = process.env.PORT || 3200;
// Старий префікс SKLAD_ лишаємо робочим, щоб уже налаштовані запуски не зламались.
const PASSWORD = process.env.INVENTA_PASSWORD || process.env.SKLAD_PASSWORD || 'inventa';
const SESSION_SECRET = process.env.INVENTA_SECRET || process.env.SKLAD_SECRET || 'change-me-in-production';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

/* ------------------------------------------------------------------ auth */

const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('hex');
const makeToken = () => {
  const payload = String(Date.now());
  return `${payload}.${sign(payload)}`;
};
const validToken = (t) => {
  if (!t || !t.includes('.')) return false;
  const [payload, sig] = t.split('.');
  if (sign(payload) !== sig) return false;
  return Date.now() - Number(payload) < 30 * 24 * 3600 * 1000; // 30 днів
};

app.post('/api/login', (req, res) => {
  if (req.body?.password !== PASSWORD) return res.status(401).json({ error: 'Невірний пароль' });
  res.cookie('inventa_session', makeToken(), {
    httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000,
  });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('inventa_session');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => res.json({ authed: validToken(req.cookies?.inventa_session) }));

function requireAuth(req, res, next) {
  if (!validToken(req.cookies?.inventa_session)) return res.status(401).json({ error: 'Не авторизовано' });
  next();
}

/* ---------------------------------------------------- публічний API (v1) */
// Окремий контракт для зовнішніх систем: авторизація по API-ключу, не по сесії.
app.use('/api/v1', v1);

/* ------------------------------------------------------------- admin API */

const api = express.Router();
api.use(requireAuth);

const wrap = (fn) => (req, res) => {
  try {
    const out = fn(req, res);
    if (out !== undefined) res.json(out);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};

const id = (req, key = 'id') => Number(req.params[key]);

api.get('/dashboard', wrap(() => S.dashboard()));

// склади
api.get('/warehouses', wrap(() => S.listWarehouses()));
api.post('/warehouses', wrap((req) => S.createWarehouse(req.body)));
api.put('/warehouses/:id', wrap((req) => S.updateWarehouse(id(req), req.body)));
api.delete('/warehouses/:id', wrap((req) => (S.deleteWarehouse(id(req)), { ok: true })));

// стелажі
api.get('/warehouses/:id/racks', wrap((req) => S.listRacks(id(req))));
api.get('/warehouses/:id/plan', wrap((req) => S.warehousePlan(id(req))));
api.put('/warehouses/:id/plan', wrap((req) => S.updateWarehousePlan(id(req), req.body)));
api.post('/racks', wrap((req) => S.createRack(req.body)));
api.get('/racks/:id/grid', wrap((req) => S.rackGrid(id(req))));
api.put('/racks/:id', wrap((req) => S.updateRack(id(req), req.body)));
api.put('/racks/:id/position', wrap((req) => S.setRackPosition(id(req), req.body)));
api.delete('/racks/:id', wrap((req) => (S.deleteRack(id(req)), { ok: true })));

// комірки стелажа — довільна схема, редагується поштучно
api.post('/racks/:id/cells', wrap((req) => S.addCell(id(req), Number(req.body.row), Number(req.body.col), req.body.label)));
api.post('/racks/:id/cell-row', wrap((req) => S.addCellRow(id(req), Number(req.body.count), req.body.row ?? null)));
api.delete('/cells/:id', wrap((req) => S.removeCell(id(req))));
api.put('/cells/:id/move', wrap((req) => S.moveCell(id(req), Number(req.body.row), Number(req.body.col))));

// місця
api.get('/locations', wrap((req) => S.listLocations(req.query.warehouse_id ? Number(req.query.warehouse_id) : null)));
api.post('/locations', wrap((req) => S.createLocation(req.body)));
api.get('/locations/:id', wrap((req) => S.locationContents(id(req))));
api.put('/locations/:id', wrap((req) => S.updateLocation(id(req), req.body)));
api.delete('/locations/:id', wrap((req) => (S.deleteLocation(id(req)), { ok: true })));

// товари
api.get('/products', wrap((req) => S.searchProducts({
  q: req.query.q || '',
  limit: Number(req.query.limit) || 100,
  offset: Number(req.query.offset) || 0,
  lowStock: req.query.low === '1',
  categoryId: req.query.category ? Number(req.query.category) : null,
  uncategorized: req.query.category === 'none',
})));
api.post('/products', wrap((req) => S.createProduct(req.body)));
api.get('/products/:id', wrap((req) => S.productFull(id(req))));
api.put('/products/:id', wrap((req) => S.updateProduct(id(req), req.body)));
api.delete('/products/:id', wrap((req) => (S.deleteProduct(id(req)), { ok: true })));

// категорії товарів
api.get('/categories', wrap(() => S.listCategories()));
api.post('/categories', wrap((req) => S.createCategory(req.body)));
api.put('/categories/:id', wrap((req) => S.updateCategory(id(req), req.body)));
api.delete('/categories/:id', wrap((req) => (S.deleteCategory(id(req)), { ok: true })));

// поля, які категорія додає у форму товару
api.get('/categories/:id/fields', wrap((req) => ({
  own: S.listCategoryFields(id(req)),
  effective: S.effectiveFields(id(req)),
})));
api.post('/categories/:id/fields', wrap((req) => S.createField(id(req), req.body)));
api.post('/categories/:id/apply-preset', wrap((req) => S.applyPreset(id(req), req.body.preset)));
api.put('/fields/:id', wrap((req) => S.updateField(id(req), req.body)));
api.delete('/fields/:id', wrap((req) => (S.deleteField(id(req)), { ok: true })));
api.get('/field-presets', wrap(() => S.listPresets()));

// рух товару
api.post('/stock/in', wrap((req) => S.stockIn(+req.body.product_id, +req.body.location_id, +req.body.qty, req.body.note)));
api.post('/stock/out', wrap((req) => S.stockOut(+req.body.product_id, +req.body.location_id, +req.body.qty, req.body.note)));
api.post('/stock/move', wrap((req) => S.stockMove(+req.body.product_id, +req.body.from_location_id, +req.body.to_location_id, +req.body.qty, req.body.note)));
api.post('/stock/adjust', wrap((req) => S.stockAdjust(+req.body.product_id, +req.body.location_id, +req.body.qty, req.body.note)));
api.get('/movements', wrap((req) => S.listMovements({
  productId: req.query.product_id ? Number(req.query.product_id) : null,
  limit: Number(req.query.limit) || 200,
})));

// сканування / пошук за кодом
api.get('/resolve', wrap((req) => S.resolveCode(req.query.code)));

// інтеграції
api.get('/integrations', wrap(() => S.listIntegrations()));
api.post('/integrations', wrap((req) => S.createIntegration(req.body)));
api.put('/integrations/:id', wrap((req) => S.updateIntegration(id(req), req.body)));
api.post('/integrations/:id/rotate', wrap((req) => S.rotateIntegrationKey(id(req))));
api.delete('/integrations/:id', wrap((req) => (S.deleteIntegration(id(req)), { ok: true })));
api.post('/product-links', wrap((req) => S.linkProduct(req.body)));
api.delete('/product-links/:id', wrap((req) => (S.unlinkProduct(id(req)), { ok: true })));

app.use('/api', api);

/* ---------------------------------------------------------------- статика */

// Бібліотеки віддаємо зі свого сервера — жодних CDN, склад має працювати без інтернету.
const vendor = {
  '/vendor/jsbarcode.js': 'node_modules/jsbarcode/dist/JsBarcode.all.min.js',
  '/vendor/zxing.js': 'node_modules/@zxing/library/umd/index.min.js',
};
Object.entries(vendor).forEach(([url, file]) => {
  app.get(url, (req, res) => res.sendFile(path.join(__dirname, file)));
});
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Inventa запущена: http://localhost:${PORT}`);
  if (PASSWORD === 'inventa') console.log('УВАГА: стоїть пароль за замовчуванням. Задайте INVENTA_PASSWORD.');
});
