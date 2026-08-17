'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');

const fs = require('fs');
const S = require('./lib/store');
const P = require('./lib/porting');
const v1 = require('./routes/v1');

const PORT = process.env.PORT || 3200;
// Старий префікс SKLAD_ лишаємо робочим, щоб уже налаштовані запуски не зламались.
const PASSWORD = process.env.INVENTA_PASSWORD || process.env.SKLAD_PASSWORD || 'inventa';
const SESSION_SECRET = process.env.INVENTA_SECRET || process.env.SKLAD_SECRET || 'change-me-in-production';

const UPLOADS = path.join(require('./db').DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '25mb' })); // у тілі приходять фото й CSV
app.use(cookieParser());

/* ------------------------------------------------------------------ auth */

// У підпис входить сіль із бази: змінили її — і всі сесії стали недійсні.
const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET + S.sessionSalt()).update(v).digest('hex');
// У токені лежить час видачі та id користувача (0 = вхід спільним паролем).
const makeToken = (userId = 0) => {
  const payload = `${Date.now()}.${userId}`;
  return `${payload}.${sign(payload)}`;
};
const sessionMs = () => (S.getSettings().session_days || 30) * 24 * 3600 * 1000;
// Повертає дані сесії або null. Одна функція і для перевірки, і для того,
// щоб дізнатись, хто саме працює.
function readToken(t) {
  if (!t) return null;
  const parts = String(t).split('.');
  if (parts.length !== 3) return null;
  const [ts, uid, sig] = parts;
  if (sign(`${ts}.${uid}`) !== sig) return null;
  if (Date.now() - Number(ts) >= sessionMs()) return null;
  const userId = Number(uid);
  if (!userId) return { userId: 0, name: 'Власник', login: '' };
  const u = S.userById(userId);
  if (!u || !u.active) return null;
  return { userId: u.id, name: u.name || u.login, login: u.login };
}

const validToken = (t) => !!readToken(t);

// Пароль зі змінної оточення — лише поки його не змінили в самому додатку.
// Після зміни джерелом правди стає хеш у базі.
function passwordOk(plain) {
  const stored = S.getPasswordHash();
  if (stored) return S.verifyPassword(plain, stored);
  return typeof plain === 'string' && plain === PASSWORD;
}

const usingDefaultPassword = () => !S.getPasswordHash() && PASSWORD === 'inventa';

/**
 * Вхід. Поки в базі немає жодного користувача — працює старий спосіб
 * зі спільним паролем, щоб оновлення нічого не зламало. Щойно заведено
 * першого користувача, потрібні логін і пароль.
 */
app.post('/api/login', (req, res) => {
  const { login, password } = req.body || {};

  if (login) {
    const u = S.userByLogin(login);
    if (!u || !S.verifyPassword(password, u.password_hash)) {
      return res.status(401).json({ error: 'Невірний логін або пароль' });
    }
    S.touchLogin(u.id);
    res.cookie('inventa_session', makeToken(u.id), { httpOnly: true, sameSite: 'lax', maxAge: sessionMs() });
    return res.json({ ok: true, user: { name: u.name || u.login } });
  }

  if (S.usersCount() > 0) return res.status(401).json({ error: 'Вкажіть логін' });
  if (!passwordOk(password)) return res.status(401).json({ error: 'Невірний пароль' });
  res.cookie('inventa_session', makeToken(0), { httpOnly: true, sameSite: 'lax', maxAge: sessionMs() });
  res.json({ ok: true });
});

// Те, що потрібно ще до входу: як називати додаток і в якій темі малювати екран.
app.get('/api/public-settings', (req, res) => {
  const { brand, theme, accent } = S.getSettings();
  // Форма входу має знати, питати логін чи лише пароль.
  res.json({ brand, theme, accent, needs_login: S.usersCount() > 0 });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('inventa_session');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const ses = readToken(req.cookies?.inventa_session);
  res.json({ authed: !!ses, user: ses ? { name: ses.name, login: ses.login } : null });
});

function requireAuth(req, res, next) {
  const ses = readToken(req.cookies?.inventa_session);
  if (!ses) return res.status(401).json({ error: 'Не авторизовано' });
  req.session = ses;
  // Ім'я автора підхоплюють записи в історії рухів.
  S.setActor({ id: ses.userId || null, name: ses.name, login: ses.login });
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

// налаштування вигляду
api.get('/settings', wrap(() => S.getSettings()));
api.put('/settings', wrap((req) => S.saveSettings(req.body)));

// безпека
api.get('/security', wrap(() => ({
  password_source: S.getPasswordHash() ? 'app' : 'env',
  default_password: usingDefaultPassword(),
  session_days: S.getSettings().session_days,
})));

api.post('/security/password', wrap((req, res) => {
  const { current, next } = req.body || {};
  if (!passwordOk(current)) {
    res.status(400).json({ error: 'Поточний пароль невірний' });
    return undefined;
  }
  if (!next || String(next).length < 6) {
    res.status(400).json({ error: 'Новий пароль має бути щонайменше 6 символів' });
    return undefined;
  }
  S.setPassword(next);
  // Міняємо сіль: старі сесії на інших пристроях мають перестати діяти.
  S.rotateSessionSalt();
  res.cookie('inventa_session', makeToken(), { httpOnly: true, sameSite: 'lax', maxAge: sessionMs() });
  return { ok: true };
}));

api.post('/security/logout-all', wrap((req, res) => {
  S.rotateSessionSalt();
  res.cookie('inventa_session', makeToken(), { httpOnly: true, sameSite: 'lax', maxAge: sessionMs() });
  return { ok: true };
}));

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

// масові дії над обраними товарами
api.post('/products/bulk/duplicate', wrap((req) => {
  const made = S.bulkDuplicate((req.body.ids || []).map(Number));
  // Фото копіюємо файлами: копія без знімка на складі майже даремна.
  made.forEach((m) => m.source_photos.forEach((file) => {
    try {
      const ext = path.extname(file) || '.jpg';
      const name = `${m.id}-${crypto.randomBytes(8).toString('hex')}${ext}`;
      fs.copyFileSync(path.join(UPLOADS, file), path.join(UPLOADS, name));
      S.addPhoto(m.id, name);
    } catch (e) { /* вихідного файлу вже немає — копія лишиться без фото */ }
  }));
  return { created: made.length, ids: made.map((m) => m.id) };
}));

api.post('/products/bulk/category', wrap((req) =>
  S.bulkSetCategory((req.body.ids || []).map(Number), req.body.category_id ? Number(req.body.category_id) : null)));

api.post('/products/bulk/move-stock', wrap((req) =>
  S.bulkMoveStock((req.body.ids || []).map(Number), Number(req.body.location_id), req.body.note)));

api.post('/products/bulk/delete', wrap((req) => S.bulkDelete((req.body.ids || []).map(Number))));

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

// заводські штрих-коди товару
api.get('/products/:id/barcodes', wrap((req) => S.productBarcodes(id(req))));
api.put('/products/:id/barcodes', wrap((req) => S.setProductBarcodes(id(req), req.body.codes)));

// фото товару
api.get('/products/:id/photos', wrap((req) => S.productPhotos(id(req))));
api.post('/products/:id/photos', wrap((req) => savePhoto(id(req), req.body.data)));
api.post('/photos/:id/main', wrap((req) => S.makeMainPhoto(id(req))));
api.delete('/photos/:id', wrap((req) => removePhoto(id(req))));

// користувачі
api.get('/users', wrap(() => ({ users: S.listUsers() })));
api.post('/users', wrap((req) => S.createUser(req.body)));
api.put('/users/:id', wrap((req) => S.updateUser(id(req), req.body)));
api.delete('/users/:id', wrap((req) => S.deleteUser(id(req))));

// імпорт: спершу розбір і показ плану, застосування — окремим запитом
api.post('/import/analyze', wrap((req) =>
  P.analyzeImport(req.body.text, { categoryId: req.body.category_id ? Number(req.body.category_id) : null })));
api.post('/import/run', wrap((req) => {
  const plan = P.analyzeImport(req.body.text, { categoryId: req.body.category_id ? Number(req.body.category_id) : null });
  return { ...P.runImport(plan, {
    categoryId: req.body.category_id ? Number(req.body.category_id) : null,
    updateExisting: req.body.update_existing !== false,
    addStock: req.body.add_stock !== false,
  }), problems: plan.problems };
}));

// експорт
const sendCsv = (res, name, body) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(body);
};
api.get('/export/products.csv', (req, res) => sendCsv(res, 'inventa-products.csv', P.exportProducts()));
api.get('/export/movements.csv', (req, res) => sendCsv(res, 'inventa-movements.csv', P.exportMovements()));
api.get('/export/locations.csv', (req, res) => sendCsv(res, 'inventa-locations.csv', P.exportLocations()));
api.get('/export/template.csv', (req, res) => sendCsv(res, 'inventa-import-template.csv', P.importTemplate()));

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

/* ------------------------------------------------------------------ фото */

// Приймаємо картинку як data-URL: браузер сам стискає її перед відправкою,
// тому окрема бібліотека для multipart не потрібна.
function savePhoto(productId, dataUrl) {
  const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) throw new Error('Очікується зображення PNG, JPEG або WEBP');
  const ext = m[1].toLowerCase() === 'png' ? 'png' : (m[1].toLowerCase() === 'webp' ? 'webp' : 'jpg');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 4 * 1024 * 1024) throw new Error('Файл завеликий — до 4 МБ після стиснення');
  const file = `${productId}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS, file), buf);
  return S.addPhoto(productId, file);
}

function removePhoto(photoId) {
  const ph = S.getPhoto(photoId);
  if (!ph) return { ok: true };
  S.deletePhoto(photoId);
  try { fs.unlinkSync(path.join(UPLOADS, ph.file)); } catch (e) { /* файлу вже немає */ }
  return { ok: true };
}

app.use('/uploads', requireAuth, express.static(UPLOADS, { maxAge: '7d' }));

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
  if (usingDefaultPassword()) {
    console.log('УВАГА: стоїть пароль за замовчуванням. Змініть його в «Налаштування → Безпека» або задайте INVENTA_PASSWORD.');
  }
});
