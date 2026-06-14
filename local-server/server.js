require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const bcrypt = require('bcryptjs');

const ADMINS_PATH = path.join(__dirname, 'data', 'admins.json');
const LOG_PATH    = path.join(__dirname, 'data', 'access.log');
const BCRYPT_ROUNDS = 10;

function loadAdmins() {
  if (fs.existsSync(ADMINS_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(ADMINS_PATH, 'utf8'));
      let migrated = false;
      for (const [k, v] of Object.entries(raw)) {
        // old format: {login: "pass"}
        if (typeof v === 'string') {
          raw[k] = { name: k, password: bcrypt.hashSync(v, BCRYPT_ROUNDS) };
          migrated = true;
        // new format but password not yet hashed
        } else if (v.password && !v.password.startsWith('$2')) {
          raw[k].password = bcrypt.hashSync(v.password, BCRYPT_ROUNDS);
          migrated = true;
        }
      }
      if (migrated) fs.writeFileSync(ADMINS_PATH, JSON.stringify(raw, null, 2));
      return raw;
    } catch {}
  }
  const defaultUser = process.env.ADMIN_USER || 'admin';
  const defaultPass = process.env.ADMIN_PASS || 'admin';
  const admins = { [defaultUser]: { name: defaultUser, password: bcrypt.hashSync(defaultPass, BCRYPT_ROUNDS) } };
  fs.mkdirSync(path.dirname(ADMINS_PATH), { recursive: true });
  fs.writeFileSync(ADMINS_PATH, JSON.stringify(admins, null, 2));
  return admins;
}

function saveAdmins(admins) {
  fs.writeFileSync(ADMINS_PATH, JSON.stringify(admins, null, 2));
}

let admins = loadAdmins();

// ── Brute-force protection ──────────────────────────────────────────────────
const loginAttempts = new Map(); // ip -> {count, resetAt}
const MAX_ATTEMPTS  = 10;
const WINDOW_MS     = 15 * 60 * 1000;

function checkRateLimit(ip) {
  const now = Date.now();
  const e = loginAttempts.get(ip);
  if (!e || now > e.resetAt) return true;
  return e.count < MAX_ATTEMPTS;
}

function recordFail(ip, username) {
  const now = Date.now();
  const e = loginAttempts.get(ip) || { count: 0, resetAt: now + WINDOW_MS };
  if (now > e.resetAt) { e.count = 0; e.resetAt = now + WINDOW_MS; }
  e.count++;
  loginAttempts.set(ip, e);
  appendLog(ip, username, false);
}

function recordOk(ip, username) {
  loginAttempts.delete(ip);
  appendLog(ip, username, true);
}

function appendLog(ip, username, success) {
  const line = `${new Date().toISOString()} | ${success ? 'OK  ' : 'FAIL'} | ${ip} | ${username}\n`;
  try { fs.appendFileSync(LOG_PATH, line); } catch {}
}

// ── Auth middleware ─────────────────────────────────────────────────────────
function dynamicAdminAuth(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || '?';

  if (!checkRateLimit(ip)) {
    return res.status(429).send('Забагато спроб входу. Спробуйте через 15 хвилин.');
  }

  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="OlegAuto Admin", charset="UTF-8"');
    return res.status(401).end();
  }

  const decoded  = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const colon    = decoded.indexOf(':');
  if (colon < 0) {
    res.set('WWW-Authenticate', 'Basic realm="OlegAuto Admin"');
    return res.status(401).end();
  }
  const username = decoded.slice(0, colon);
  const password = decoded.slice(colon + 1);

  const admin = admins[username];
  if (!admin) {
    recordFail(ip, username);
    res.set('WWW-Authenticate', 'Basic realm="OlegAuto Admin"');
    return res.status(401).end();
  }

  bcrypt.compare(password, admin.password, (err, match) => {
    if (err || !match) {
      recordFail(ip, username);
      res.set('WWW-Authenticate', 'Basic realm="OlegAuto Admin"');
      return res.status(401).end();
    }
    recordOk(ip, username);
    next();
  });
}

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

// Ensure uploads dir exists
if (!fs.existsSync(path.join(__dirname, 'uploads'))) {
  fs.mkdirSync(path.join(__dirname, 'uploads'));
}
// Ensure data dir exists
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'));
}

// Multer for image uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// Data helpers
function readData(file) {
  const fp = path.join(__dirname, 'data', file);
  if (!fs.existsSync(fp)) return [];
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (e) {
    return [];
  }
}
function writeData(file, data) {
  const fp = path.join(__dirname, 'data', file);
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
}
function nextId(arr) {
  return arr.length === 0 ? 1 : Math.max(...arr.map(x => x.id)) + 1;
}

// ============ PRODUCTS API ============
app.get('/api/products', (req, res) => {
  let products = readData('products.json');
  const { brand, category, condition, inStock, search, sort, carBrand, carModel, yearFrom, yearTo, priceMin, priceMax } = req.query;

  if (brand) products = products.filter(p => p.brand === brand);
  if (carBrand) products = products.filter(p => {
    const compat = p.compatibility && p.compatibility.length ? p.compatibility : [{brand: p.brand, model: p.model}];
    return compat.some(c => (c.brand || '').toLowerCase() === carBrand.toLowerCase());
  });
  if (carModel) products = products.filter(p => {
    const compat = p.compatibility && p.compatibility.length ? p.compatibility : [{brand: p.brand, model: p.model}];
    return compat.some(c => (c.model || '').toLowerCase() === carModel.toLowerCase());
  });
  if (category) products = products.filter(p => p.category === category);
  if (condition && condition !== 'all') products = products.filter(p => p.condition === condition);
  if (inStock === 'true') products = products.filter(p => p.stock > 0);
  if (yearFrom) products = products.filter(p => !p.yearTo || parseInt(p.yearTo) >= parseInt(yearFrom));
  if (yearTo) products = products.filter(p => !p.yearFrom || parseInt(p.yearFrom) <= parseInt(yearTo));
  if (priceMin) products = products.filter(p => p.price >= parseFloat(priceMin));
  if (priceMax) products = products.filter(p => p.price <= parseFloat(priceMax));
  if (search) {
    const q = search.toLowerCase();
    products = products.filter(p =>
      (p.name || '').toLowerCase().includes(q) ||
      (p.oem || '').toLowerCase().includes(q) ||
      (p.article || '').toLowerCase().includes(q) ||
      (p.brand || '').toLowerCase().includes(q) ||
      (p.model || '').toLowerCase().includes(q)
    );
  }
  if (sort === 'price_asc') products.sort((a, b) => a.price - b.price);
  else if (sort === 'price_desc') products.sort((a, b) => b.price - a.price);
  else if (sort === 'newest') products.sort((a, b) => b.id - a.id);

  res.json(products);
});

app.get('/api/products/:id', (req, res) => {
  const products = readData('products.json');
  const p = products.find(p => p.id === parseInt(req.params.id));
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(p);
});

app.post('/api/products', upload.array('images', 5), (req, res) => {
  const products = readData('products.json');
  const compatibility = JSON.parse(req.body.compatibility || '[]');
  const images = (req.files || []).map(f => '/uploads/' + f.filename);
  const product = {
    id: nextId(products),
    name: req.body.name,
    brand: compatibility[0]?.brand || req.body.brand || '',
    model: compatibility[0]?.model || req.body.model || '',
    compatibility,
    yearFrom: req.body.yearFrom || '',
    yearTo: req.body.yearTo || '',
    category: req.body.category,
    condition: req.body.condition,
    price: parseInt(req.body.price) || 0,
    stock: parseInt(req.body.stock) || 0,
    oem: req.body.oem || '',
    article: req.body.article || '',
    description: req.body.description || '',
    images,
    image: images[0] || null,
    createdAt: new Date().toISOString()
  };
  products.unshift(product);
  writeData('products.json', products);
  res.json(product);
});

app.put('/api/products/bulk', (req, res) => {
  const { ids, changes } = req.body;
  if (!Array.isArray(ids) || !ids.length || !changes) return res.status(400).json({ error: 'ids and changes required' });
  const allowed = ['category', 'condition'];
  const patch = {};
  for (const k of allowed) if (changes[k] !== undefined) patch[k] = changes[k];
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'No valid fields' });
  let products = readData('products.json');
  let updated = 0;
  products = products.map(p => { if (!ids.includes(p.id)) return p; updated++; return { ...p, ...patch }; });
  writeData('products.json', products);
  res.json({ ok: true, updated });
});

app.put('/api/products/:id', upload.array('images', 5), (req, res) => {
  const products = readData('products.json');
  const idx = products.findIndex(p => p.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const updCompatibility = JSON.parse(req.body.compatibility || '[]');
  const newImages = (req.files || []).map(f => '/uploads/' + f.filename);
  // keep existing images unless new ones uploaded or user removed some
  const keepImages = JSON.parse(req.body.keepImages || 'null');
  const existingImages = keepImages !== null ? keepImages : (products[idx].images || (products[idx].image ? [products[idx].image] : []));
  const allImages = [...existingImages, ...newImages];
  const updated = {
    ...products[idx],
    name: req.body.name,
    brand: updCompatibility[0]?.brand || req.body.brand || '',
    model: updCompatibility[0]?.model || req.body.model || '',
    compatibility: updCompatibility,
    yearFrom: req.body.yearFrom || '',
    yearTo: req.body.yearTo || '',
    category: req.body.category,
    condition: req.body.condition,
    price: parseInt(req.body.price) || 0,
    stock: parseInt(req.body.stock) || 0,
    oem: req.body.oem || '',
    article: req.body.article || '',
    description: req.body.description || '',
    images: allImages,
    image: allImages[0] || null,
  };
  products[idx] = updated;
  writeData('products.json', products);
  res.json(updated);
});

app.delete('/api/products/bulk', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids required' });
  let products = readData('products.json');
  const before = products.length;
  products = products.filter(p => !ids.includes(p.id));
  writeData('products.json', products);
  res.json({ ok: true, deleted: before - products.length });
});

app.delete('/api/products/:id', (req, res) => {
  let products = readData('products.json');
  products = products.filter(p => p.id !== parseInt(req.params.id));
  writeData('products.json', products);
  res.json({ ok: true });
});

app.patch('/api/products/:id', (req, res) => {
  const products = readData('products.json');
  const idx = products.findIndex(p => p.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  if (req.body.price !== undefined) products[idx].price = parseInt(req.body.price) || 0;
  if (req.body.stock !== undefined) products[idx].stock = parseInt(req.body.stock) || 0;
  writeData('products.json', products);
  res.json(products[idx]);
});

app.post('/api/products/:id/duplicate', (req, res) => {
  const products = readData('products.json');
  const p = products.find(p => p.id === parseInt(req.params.id));
  if (!p) return res.status(404).json({ error: 'Not found' });
  const dup = { ...p, id: nextId(products), name: p.name + ' (копія)', createdAt: new Date().toISOString() };
  products.unshift(dup);
  writeData('products.json', products);
  res.json(dup);
});

// ============ IMPORT API ============
const IMPORT_BRAND_PATTERNS = [
  { brand: 'Renault',  re: /renault|рено/i },
  { brand: 'Peugeot',  re: /peugeot|пежо/i },
  { brand: 'Citroën',  re: /citro[eë]n|ситро[єе]/i },
  { brand: 'Fiat',     re: /\bfiat\b|фіат/i },
];
const IMPORT_MODEL_PATTERNS = {
  'Renault': [
    {model:'Clio I',re:/clio\s*(i\b|1\b)/i},{model:'Clio II',re:/clio\s*(ii\b|2\b)/i},{model:'Clio III',re:/clio\s*(iii\b|3\b)/i},{model:'Clio IV',re:/clio\s*(iv\b|4\b)/i},{model:'Clio',re:/\bclio\b/i},
    {model:'Megane I',re:/megane\s*(i\b|1\b)/i},{model:'Megane II',re:/megane\s*(ii\b|2\b)/i},{model:'Megane III',re:/megane\s*(iii\b|3\b)/i},{model:'Megane IV',re:/megane\s*(iv\b|4\b)/i},{model:'Megane',re:/\bmegane\b/i},
    {model:'Laguna I',re:/laguna\s*(i\b|1\b)/i},{model:'Laguna II',re:/laguna\s*(ii\b|2\b)/i},{model:'Laguna III',re:/laguna\s*(iii\b|3\b)/i},{model:'Laguna',re:/\blaguna\b/i},
    {model:'Scenic I',re:/scenic\s*(i\b|1\b)/i},{model:'Scenic II',re:/scenic\s*(ii\b|2\b)/i},{model:'Scenic III',re:/scenic\s*(iii\b|3\b)/i},{model:'Scenic',re:/\bscenic\b/i},
    {model:'Kangoo I',re:/kangoo\s*(i\b|1\b)/i},{model:'Kangoo II',re:/kangoo\s*(ii\b|2\b)/i},{model:'Kangoo',re:/\bkangoo\b/i},
    {model:'Trafic II',re:/trafic\s*(ii\b|2\b)/i},{model:'Trafic III',re:/trafic\s*(iii\b|3\b)/i},{model:'Trafic',re:/\btrafic\b/i},
    {model:'Master II',re:/master\s*(ii\b|2\b)/i},{model:'Master III',re:/master\s*(iii\b|3\b)/i},{model:'Master',re:/\bmaster\b/i},
    {model:'Duster',re:/\bduster\b/i},{model:'Captur',re:/\bcaptur\b/i},{model:'Kadjar',re:/\bkadjar\b/i},{model:'Logan',re:/\blogan\b/i},
    {model:'Sandero',re:/\bsandero\b/i},{model:'Fluence',re:/\bfluence\b/i},{model:'Twingo',re:/\btwingo\b/i},{model:'Symbol',re:/\bsymbol\b/i},{model:'Koleos',re:/\bkoleos\b/i},
  ],
  'Peugeot': [
    {model:'106',re:/\b106\b/},{model:'107',re:/\b107\b/},{model:'108',re:/\b108\b/},{model:'205',re:/\b205\b/},{model:'206',re:/\b206\b/},{model:'207',re:/\b207\b/},{model:'208',re:/\b208\b/},
    {model:'306',re:/\b306\b/},{model:'307',re:/\b307\b/},{model:'308',re:/\b308\b/},{model:'406',re:/\b406\b/},{model:'407',re:/\b407\b/},{model:'508',re:/\b508\b/},
    {model:'2008',re:/\b2008\b/},{model:'3008',re:/\b3008\b/},{model:'5008',re:/\b5008\b/},{model:'Partner',re:/\bpartner\b/i},{model:'Expert',re:/\bexpert\b/i},{model:'Boxer',re:/\bboxer\b/i},
  ],
  'Citroën': [
    {model:'C1',re:/\bc1\b/i},{model:'C2',re:/\bc2\b/i},{model:'C3 Aircross',re:/c3\s*aircross/i},{model:'C3 Picasso',re:/c3\s*picasso/i},{model:'C3',re:/\bc3\b/i},
    {model:'C4 Grand Picasso',re:/c4\s*(grand\s*picasso|grand)/i},{model:'C4 Picasso',re:/c4\s*picasso/i},{model:'C4 Cactus',re:/c4\s*cactus/i},{model:'C4',re:/\bc4\b/i},
    {model:'C5',re:/\bc5\b/i},{model:'C6',re:/\bc6\b/i},{model:'Berlingo',re:/\bberlingo\b/i},{model:'Jumpy',re:/\bjumpy\b/i},{model:'Jumper',re:/\bjumper\b/i},
    {model:'Saxo',re:/\bsaxo\b/i},{model:'Xantia',re:/\bxantia\b/i},{model:'Xsara Picasso',re:/xsara\s*picasso/i},{model:'Xsara',re:/\bxsara\b/i},
  ],
  'Fiat': [
    {model:'500',re:/\b500\b/},{model:'Doblo',re:/\bdoblo\b/i},{model:'Ducato',re:/\bducato\b/i},{model:'Punto',re:/\bpunto\b/i},{model:'Panda',re:/\bpanda\b/i},
    {model:'Bravo',re:/\bbravo\b/i},{model:'Stilo',re:/\bstilo\b/i},{model:'Tipo',re:/\btipo\b/i},{model:'Fiorino',re:/\bfiorino\b/i},{model:'Scudo',re:/\bscudo\b/i},
  ],
};
const IMPORT_CATEGORY_PATTERNS = [
  {cat:'Освітлення',re:/фар[аиу]|ліхтар|lamp|light|фонар|headlight|taillight/i},
  {cat:'Кузов',re:/бампер|крило|капот|двер|hood|bumper|fender|door|wing|порог|панел|решітк/i},
  {cat:'Двигун та КПП',re:/двигун|мотор|кпп|коробк|engine|gearbox|поршень|клапан|голівк|блок цил/i},
  {cat:'Підвіска',re:/підвіск|важіл|стійк|амортиз|пружин|bearing|suspension|arm|strut|рульов/i},
  {cat:'Гальма',re:/гальм|колодк|диск|супорт|brake|caliper/i},
  {cat:'Електрика',re:/електр|генерат|стартер|датчик|sensor|реле|проводк|signal|сигнал/i},
  {cat:"Інтер'єр",re:/салон|сидін|килим|ручк|interior|panel|торпед/i},
  {cat:'Охолодження',re:/радіат|охолод|термостат|помпа|cooling|radiator/i},
  {cat:'Паливна система',re:/паливн|форсунк|насос|injector|fuel|pump|карбюр/i},
  {cat:'Трансмісія',re:/трансміс|привод|шрус|піввісь|driveshaft|transmission/i},
];
function importDetectCategory(name) {
  for (const {cat,re} of IMPORT_CATEGORY_PATTERNS) if (re.test(name)) return cat;
  return 'Кузов';
}
function importDetectCompatibility(name) {
  const compat = [];
  for (const {brand,re} of IMPORT_BRAND_PATTERNS) {
    if (re.test(name)) {
      const matched = (IMPORT_MODEL_PATTERNS[brand]||[]).filter(m=>m.re.test(name)).map(m=>m.model);
      if (matched.length) matched.forEach(model=>compat.push({brand,model}));
      else compat.push({brand,model:''});
    }
  }
  return compat;
}
function importDetectCondition(name) {
  if (/нов[ий|а|е]|new\b/i.test(name)) return 'new';
  return 'used';
}

const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

app.post('/api/import', dynamicAdminAuth, importUpload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не завантажено' });
    const raw = zlib.gunzipSync(req.file.buffer).toString('utf8').replace(/^﻿/, '');
    const lines = raw.split('\n').filter(l => l.trim());
    const products = [];
    const seen = new Set();
    let id = 1;
    for (const line of lines) {
      const cols = line.split(';');
      if (cols.length < 4) continue;
      const supplierBrand = (cols[0]||'').trim();
      const article       = (cols[1]||'').trim();
      const name          = (cols[2]||'').trim();
      const price         = parseFloat((cols[3]||'0').replace(',','.')) || 0;
      const stock         = parseInt(cols[4]) || 0;
      const imagesRaw     = (cols[6]||'').trim();
      const oem           = (cols[8]||'').trim();
      if (!name || !price) continue;
      const dedupKey = oem || name;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      const imageList = imagesRaw ? imagesRaw.split(',').map(u=>u.trim()).filter(Boolean) : [];
      const compat = importDetectCompatibility(name);
      products.push({
        id: id++, name,
        brand: compat[0]?.brand||'', model: compat[0]?.model||'',
        compatibility: compat,
        category: importDetectCategory(name),
        condition: importDetectCondition(name),
        price, stock, oem, article, supplierBrand,
        images: imageList, image: imageList[0]||null,
        description: '', yearFrom: '', yearTo: '',
        createdAt: new Date().toISOString()
      });
    }
    writeData('products.json', products);
    res.json({ ok: true, imported: products.length, total: lines.length });
  } catch(e) {
    res.status(500).json({ error: 'Помилка парсингу: ' + e.message });
  }
});

// ============ ORDERS API ============
app.get('/api/orders', (req, res) => {
  res.json(readData('orders.json'));
});

app.post('/api/orders', (req, res) => {
  const orders = readData('orders.json');
  const order = {
    id: nextId(orders),
    ...req.body,
    status: 'new',
    createdAt: new Date().toISOString()
  };
  orders.unshift(order);
  writeData('orders.json', orders);
  res.json(order);
});

app.put('/api/orders/:id/status', (req, res) => {
  const orders = readData('orders.json');
  const idx = orders.findIndex(o => o.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  const prevStatus = orders[idx].status;
  const newStatus = req.body.status;
  orders[idx].status = newStatus;
  writeData('orders.json', orders);

  // Decrease stock only when transitioning TO "done" (not already done)
  if (newStatus === 'done' && prevStatus !== 'done') {
    const items = orders[idx].items || [];
    if (items.length) {
      const products = readData('products.json');
      let changed = false;
      items.forEach(item => {
        const pidx = products.findIndex(p => p.id === item.id);
        if (pidx !== -1) {
          products[pidx].stock = Math.max(0, products[pidx].stock - (item.qty || 1));
          changed = true;
        }
      });
      if (changed) writeData('products.json', products);
    }
  }

  // Restore stock if cancelled from done
  if (newStatus === 'cancelled' && prevStatus === 'done') {
    const items = orders[idx].items || [];
    if (items.length) {
      const products = readData('products.json');
      let changed = false;
      items.forEach(item => {
        const pidx = products.findIndex(p => p.id === item.id);
        if (pidx !== -1) {
          products[pidx].stock += (item.qty || 1);
          changed = true;
        }
      });
      if (changed) writeData('products.json', products);
    }
  }

  res.json(orders[idx]);
});

// ============ STATS API ============
app.get('/api/stats', (req, res) => {
  const products = readData('products.json');
  const orders = readData('orders.json');
  res.json({
    totalProducts: products.length,
    newProducts: products.filter(p => p.condition === 'new').length,
    usedProducts: products.filter(p => p.condition === 'used').length,
    totalOrders: orders.length,
    newOrders: orders.filter(o => o.status === 'new').length,
    revenue: orders.filter(o => o.status !== 'cancelled').reduce((s, o) => s + (o.total || 0), 0)
  });
});

// ============ ADMINS API ============
app.get('/api/admins', dynamicAdminAuth, (req, res) => {
  res.json(Object.entries(admins).map(([username, v]) => ({ username, name: v.name })));
});

app.post('/api/admins', dynamicAdminAuth, (req, res) => {
  const { username, password, name } = req.body;
  if (!username || !password || !name) return res.status(400).json({ error: 'Імʼя, логін і пароль обовʼязкові' });
  if (password.length < 4) return res.status(400).json({ error: 'Пароль мінімум 4 символи' });
  if (admins[username]) return res.status(400).json({ error: 'Такий логін вже існує' });
  admins[username] = { name, password: bcrypt.hashSync(password, BCRYPT_ROUNDS) };
  saveAdmins(admins);
  res.json({ ok: true });
});

app.put('/api/admins/:username', dynamicAdminAuth, (req, res) => {
  const { username } = req.params;
  const { password, name } = req.body;
  if (!admins[username]) return res.status(404).json({ error: 'Адміна не знайдено' });
  if (password && password.length < 4) return res.status(400).json({ error: 'Пароль мінімум 4 символи' });
  if (name) admins[username].name = name;
  if (password) admins[username].password = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  saveAdmins(admins);
  res.json({ ok: true });
});

app.get('/api/admins/log', dynamicAdminAuth, (req, res) => {
  try {
    const raw = fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, 'utf8') : '';
    const lines = raw.trim().split('\n').filter(Boolean).reverse().slice(0, 200);
    res.json(lines);
  } catch { res.json([]); }
});

app.delete('/api/admins/:username', dynamicAdminAuth, (req, res) => {
  const { username } = req.params;
  if (!admins[username]) return res.status(404).json({ error: 'Адміна не знайдено' });
  if (Object.keys(admins).length <= 1) return res.status(400).json({ error: 'Не можна видалити останнього адміна' });
  delete admins[username];
  saveAdmins(admins);
  res.json({ ok: true });
});

// ============ SEO ============
const SITE_URL = 'https://olegavto.com';

app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send(`User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);
});

app.get('/sitemap.xml', (req, res) => {
  const products = readData('products.json');
  const staticPages = [['', '1.0'], ['#catalog', '0.7'], ['#contacts', '0.7']];
  const productUrls = products.map(p =>
    `  <url><loc>${SITE_URL}/#product-${p.id}</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>`
  );
  const staticUrls = staticPages.map(([p, pri]) =>
    `  <url><loc>${SITE_URL}/${p}</loc><changefreq>daily</changefreq><priority>${pri}</priority></url>`
  );
  res.type('application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${staticUrls.join('\n')}
${productUrls.join('\n')}
</urlset>`);
});

// ============ PAGES ============
app.get('/admin', dynamicAdminAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin/*', dynamicAdminAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use('/api', dynamicAdminAuth);
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log('\n OlegAuto сервер запущено!\n');
  console.log('  Магазин:       http://localhost:' + PORT);
  console.log('  Адмін-панель:  http://localhost:' + PORT + '/admin');
  console.log('\nНатисніть Ctrl+C щоб зупинити\n');
});
