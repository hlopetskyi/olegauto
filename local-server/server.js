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
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  maxAge: '1d', setHeaders(res) { res.setHeader('Cache-Control', 'public, max-age=86400'); }
}));
// index:false so "/" does NOT auto-serve the raw shell — the SEO head-injection
// middleware below must handle "/" (and other page routes) instead.
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  }
}));

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

// In-memory cache: avoids re-reading JSON from disk on every request
const _cache = {};
function readData(file) {
  if (_cache[file]) return _cache[file];
  const fp = path.join(__dirname, 'data', file);
  if (!fs.existsSync(fp)) return [];
  try {
    _cache[file] = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return _cache[file];
  } catch (e) {
    return [];
  }
}
function writeData(file, data) {
  const fp = path.join(__dirname, 'data', file);
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
  _cache[file] = data; // update cache in-place — no stale reads
}
function nextId(arr) {
  return arr.length === 0 ? 1 : Math.max(...arr.map(x => x.id)) + 1;
}

// ============ PRODUCTS API ============
app.get('/api/products', (req, res) => {
  let products = readData('products.json');
  const { brand, category, condition, inStock, search, sort, carBrand, carModel, carEngine, yearFrom, yearTo, priceMin, priceMax } = req.query;

  if (brand) products = products.filter(p => p.brand === brand);
  if (carBrand) products = products.filter(p => {
    const compat = p.compatibility && p.compatibility.length ? p.compatibility : [{brand: p.brand, model: p.model}];
    return compat.some(c => (c.brand || '').toLowerCase() === carBrand.toLowerCase());
  });
  if (carModel) products = products.filter(p => {
    const compat = p.compatibility && p.compatibility.length ? p.compatibility : [{brand: p.brand, model: p.model}];
    return compat.some(c => (c.model || '').toLowerCase() === carModel.toLowerCase());
  });
  if (carEngine) products = products.filter(p => {
    const compat = p.compatibility && p.compatibility.length ? p.compatibility : [];
    return compat.some(c => (c.engine || '').toLowerCase() === carEngine.toLowerCase());
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

  // Optional pagination (additive; absent = full list, unchanged behaviour).
  // Applied AFTER filtering+sorting so limit returns the top-N of the result set.
  const limit = parseInt(req.query.limit);
  if (!isNaN(limit) && limit > 0) {
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    products = products.slice(offset, offset + limit);
  }

  res.json(products);
});

app.get('/api/products/:id', (req, res) => {
  const products = readData('products.json');
  const numId = parseInt(req.params.id);
  const p = isNaN(numId)
    ? products.find(p => p.article && p.article.toLowerCase() === req.params.id.toLowerCase())
    : products.find(p => p.id === numId);
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

const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT  = process.env.TG_CHAT;

async function sendTelegram(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' })
    });
  } catch(e) { console.error('Telegram error:', e.message); }
}

app.post('/api/orders', async (req, res) => {
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

  const items = (order.items||[]).map(i=>`  • ${i.name} × ${i.qty} — €${i.price}`).join('\n');
  const deliveryLine = order.delivery === 'nova_poshta'
    ? `🚚 Нова Пошта: ${order.city||'—'}${order.warehouse ? ', ' + order.warehouse : ''}`
    : `🏠 Самовивіз: Комарно, вул. Річкова 1`;
  const msg = `🛒 <b>Нове замовлення #${order.id}</b>\n\n`
    + `👤 ${order.customerName}\n`
    + `📞 ${order.customerPhone}\n`
    + `${deliveryLine}\n`
    + (order.comment ? `💬 ${order.comment}\n` : '')
    + `\n<b>Товари:</b>\n${items}\n\n`
    + `💰 <b>Сума: €${order.total}</b>`;
  sendTelegram(msg);
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

app.delete('/api/orders/:id', (req, res) => {
  const orders = readData('orders.json');
  const idx = orders.findIndex(o => o.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  orders.splice(idx, 1);
  writeData('orders.json', orders);
  res.json({ ok: true });
});

// ============ STATS API ============
app.get('/api/stats', (req, res) => {
  const products = readData('products.json');
  const orders = readData('orders.json');
  const todayStr = new Date().toISOString().slice(0, 10);
  res.json({
    totalProducts: products.length,
    newProducts: products.filter(p => p.condition === 'new').length,
    usedProducts: products.filter(p => p.condition === 'used').length,
    totalOrders: orders.length,
    newOrders: orders.filter(o => o.status === 'new').length,
    todayOrders: orders.filter(o => (o.createdAt || '').startsWith(todayStr)).length,
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

function xmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
app.get('/sitemap.xml', (req, res) => {
  const products = readData('products.json');
  const staticPages = [['', '1.0'], ['catalog', '0.7'], ['contacts', '0.7']];
  // /cart and /wishlist are intentionally excluded (thin utility, noindex)
  const productUrls = products.map(p => {
    const lastmod = (p.updatedAt || p.createdAt || '').slice(0, 10);
    const img = (p.images && p.images.length) ? p.images[0] : (p.image || '');
    const imgAbs = img ? (/^https?:/i.test(img) ? img : SITE_URL + img) : '';
    return `  <url><loc>${SITE_URL}/product/${p.id}</loc>` +
      (lastmod ? `<lastmod>${lastmod}</lastmod>` : '') +
      `<changefreq>weekly</changefreq><priority>0.8</priority>` +
      (imgAbs ? `<image:image><image:loc>${xmlEsc(imgAbs)}</image:loc><image:title>${xmlEsc(p.name)}</image:title></image:image>` : '') +
      `</url>`;
  });
  const staticUrls = staticPages.map(([p, pri]) =>
    `  <url><loc>${SITE_URL}/${p}</loc><changefreq>daily</changefreq><priority>${pri}</priority></url>`
  );
  res.type('application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${staticUrls.join('\n')}
${productUrls.join('\n')}
</urlset>`);
});

// ============ RESTOCK SUBSCRIPTIONS ============
const NOTIFY_FILE = path.join(__dirname, 'data', 'notify.json');
function loadNotify() { try { return JSON.parse(fs.readFileSync(NOTIFY_FILE, 'utf8')); } catch { return []; } }

app.post('/api/notify-restock', (req, res) => {
  const { productId, phone } = req.body || {};
  if(!productId || !phone) return res.status(400).json({ error: 'Missing fields' });
  const digits = String(phone).replace(/\D/g, '');
  if(digits.length < 10 || digits.length > 13) return res.status(400).json({ error: 'Invalid phone' });
  const products = readData('products.json');
  const product = products.find(p => p.id === parseInt(productId));
  if(!product) return res.status(404).json({ error: 'Product not found' });
  const list = loadNotify();
  if(list.length >= 5000) return res.status(429).json({ error: 'Too many subscriptions' });
  const already = list.find(x => x.productId === parseInt(productId) && x.phone === phone);
  if(!already) {
    list.push({ productId: parseInt(productId), productName: product.name, phone, createdAt: new Date().toISOString() });
    fs.writeFileSync(NOTIFY_FILE, JSON.stringify(list, null, 2));
  }
  res.json({ ok: true });
});

app.get('/api/notify-restock', dynamicAdminAuth, (req, res) => {
  res.json(loadNotify());
});

// ============ SETTINGS ============
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}
app.get('/api/settings', (req, res) => res.json(loadSettings()));
app.patch('/api/settings', dynamicAdminAuth, (req, res) => {
  const current = loadSettings();
  const updated = Object.assign({}, current, req.body);
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(updated, null, 2));
  res.json(updated);
});

// ============ NOVA POSHTA PROXY ============
const NP_API_KEY = process.env.NP_API_KEY || '';
const NP_URL = 'https://api.novaposhta.ua/v2.0/json/';

async function npRequest(modelName, calledMethod, methodProperties) {
  const r = await fetch(NP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: NP_API_KEY, modelName, calledMethod, methodProperties })
  });
  return r.json();
}

app.get('/api/np/cities', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json([]);
  try {
    const data = await npRequest('Address', 'searchSettlements', {
      CityName: q, Limit: '10', Page: '1'
    });
    const addresses = (data.data?.[0]?.Addresses || []);
    res.json(addresses.map(a => ({
      ref: a.DeliveryCity,
      label: `${a.Present}`,
      city: a.MainDescription,
      area: a.Area,
      region: a.Region
    })));
  } catch(e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/np/warehouses', async (req, res) => {
  const cityRef = (req.query.cityRef || '').trim();
  if (!cityRef) return res.json([]);
  try {
    const data = await npRequest('AddressGeneral', 'getWarehouses', {
      CityRef: cityRef, Limit: 200, Page: 1
    });
    res.json((data.data || []).map(w => ({
      ref: w.Ref,
      label: w.ShortAddress || w.Description,
      number: w.Number
    })));
  } catch(e) { res.status(502).json({ error: e.message }); }
});

// ============ CONTACT ============
let _currencyCache = null;
let _currencyCacheTs = 0;
const GOVERLA_QUERY = `query Point($alias: Alias!) { point(alias: $alias) { updatedAt rates { currency { codeAlpha exponent } bid { absolute } ask { absolute } } } }`;
app.get('/api/currency', async (req, res) => {
  try {
    if (_currencyCache && Date.now() - _currencyCacheTs < 3600000) {
      return res.json(_currencyCache);
    }
    const r = await fetch('https://api.goverla.ua/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://goverla.ua', 'Referer': 'https://goverla.ua/' },
      body: JSON.stringify({ query: GOVERLA_QUERY, variables: { alias: 'goverla-ua' } })
    });
    const json = await r.json();
    const rates = json.data.point.rates
      .filter(x => ['USD','EUR'].includes(x.currency.codeAlpha))
      .map(x => {
        const exp = Math.pow(10, x.currency.exponent || 2);
        return { ccy: x.currency.codeAlpha, buy: (x.bid.absolute / exp).toFixed(2), sale: (x.ask.absolute / exp).toFixed(2) };
      });
    _currencyCache = rates;
    _currencyCacheTs = Date.now();
    res.json(rates);
  } catch(e) { res.status(502).json({error:'fetch failed'}); }
});

app.post('/api/contact', (req, res) => {
  const contacts = readData('contacts.json');
  const msg = {
    id: Date.now(),
    name: req.body.name || '',
    contact: req.body.contact || '',
    message: req.body.message || '',
    createdAt: new Date().toISOString(),
    read: false
  };
  contacts.unshift(msg);
  writeData('contacts.json', contacts);
  res.json({ ok: true });
});

// ============ ANALYTICS (first-party) ============
const ANALYTICS_FILE = path.join(__dirname, 'data', 'analytics.jsonl');
const TRACK_EVENTS = ['page_view', 'product_view', 'add_to_cart', 'begin_checkout', 'purchase', 'phone_click', 'viber_click'];
const BOT_RE = /bot|crawl|spider|slurp|bing|yandex|google|facebook|preview|headless|curl|wget|monitor|lighthouse/i;

// Public collector — records one event per call (fire-and-forget from client)
app.post('/api/track', (req, res) => {
  try {
    const ua = req.get('user-agent') || '';
    if (BOT_RE.test(ua)) return res.status(204).end(); // skip bots/crawlers
    const b = req.body || {};
    if (!TRACK_EVENTS.includes(b.ev)) return res.status(204).end();
    const rec = {
      t: new Date().toISOString(),
      ev: b.ev,
      sid: String(b.sid || '').slice(0, 40),
      vid: String(b.vid || '').slice(0, 40),
      device: b.device === 'mobile' ? 'mobile' : 'desktop',
      path: String(b.path || '').slice(0, 200),
      pid: b.pid != null ? parseInt(b.pid) || null : null,
      name: String(b.name || '').slice(0, 120),
      value: b.value != null ? Number(b.value) || 0 : 0
    };
    fs.appendFileSync(ANALYTICS_FILE, JSON.stringify(rec) + '\n');
    res.status(204).end();
  } catch (e) { res.status(204).end(); }
});

// Admin-only aggregation
app.get('/api/analytics', dynamicAdminAuth, (req, res) => {
  const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 30));
  const since = Date.now() - days * 86400000;
  let events = [];
  try {
    const raw = fs.readFileSync(ANALYTICS_FILE, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (new Date(e.t).getTime() >= since) events.push(e);
      } catch {}
    }
  } catch { events = []; }

  const uniq = (arr) => new Set(arr).size;
  const bySession = {}; // sid -> set of events
  for (const e of events) {
    if (!e.sid) continue;
    (bySession[e.sid] = bySession[e.sid] || new Set()).add(e.ev);
  }
  const sessionsWith = (ev) => Object.values(bySession).filter(s => s.has(ev)).length;

  // Device split by unique session
  const devOfSession = {};
  for (const e of events) if (e.sid) devOfSession[e.sid] = e.device;
  const deviceSessions = Object.values(devOfSession);
  const device = {
    mobile: deviceSessions.filter(d => d === 'mobile').length,
    desktop: deviceSessions.filter(d => d === 'desktop').length
  };

  // Top viewed products
  const prodCounts = {};
  for (const e of events) {
    if (e.ev === 'product_view' && e.pid) {
      const k = e.pid;
      prodCounts[k] = prodCounts[k] || { pid: e.pid, name: e.name || ('#' + e.pid), count: 0 };
      prodCounts[k].count++;
    }
  }
  const allViewedProducts = Object.values(prodCounts).sort((a, b) => b.count - a.count);
  const topProducts = allViewedProducts.slice(0, 10);

  // Daily series (visitors = unique vid/day, orders = purchase count/day)
  const daily = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const dayStr = d.toISOString().slice(0, 10);
    const dayEvents = events.filter(e => (e.t || '').startsWith(dayStr));
    daily.push({
      date: dayStr,
      visitors: uniq(dayEvents.map(e => e.vid).filter(Boolean)),
      pageViews: dayEvents.filter(e => e.ev === 'page_view').length,
      orders: dayEvents.filter(e => e.ev === 'purchase').length
    });
  }

  res.json({
    days,
    totals: {
      visitors: uniq(events.map(e => e.vid).filter(Boolean)),
      sessions: uniq(events.map(e => e.sid).filter(Boolean)),
      pageViews: events.filter(e => e.ev === 'page_view').length,
      productViews: events.filter(e => e.ev === 'product_view').length,
      phoneClicks: events.filter(e => e.ev === 'phone_click').length,
      viberClicks: events.filter(e => e.ev === 'viber_click').length,
      addToCart: events.filter(e => e.ev === 'add_to_cart').length,
      orders: events.filter(e => e.ev === 'purchase').length,
      events: events.length
    },
    device,
    funnel: [
      { stage: 'Зайшли на сайт', sessions: Object.keys(bySession).length },
      { stage: 'Переглянули товар', sessions: sessionsWith('product_view') },
      { stage: 'Додали в кошик', sessions: sessionsWith('add_to_cart') },
      { stage: 'Перейшли до оформлення', sessions: sessionsWith('begin_checkout') },
      { stage: 'Оформили замовлення', sessions: sessionsWith('purchase') }
    ],
    topProducts,
    allViewedProducts,
    daily
  });
});

// ============ PAGES ============
app.get('/admin', dynamicAdminAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin/*', dynamicAdminAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use('/api', dynamicAdminAuth);

// ---------- SEO: per-route <head> injection + JSON-LD (server-side) ----------
const SHELL_PATH = path.join(__dirname, 'public', 'index.html');
let _shellCache = null;
function shellHtml() {
  if (_shellCache) return _shellCache;
  _shellCache = fs.readFileSync(SHELL_PATH, 'utf8');
  return _shellCache;
}
const OG_DEFAULT = SITE_URL + '/og-image.png';

// Escape for HTML attribute context (title / meta / og / twitter)
function htmlAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// Serialize for <script type="application/ld+json"> — JSON only, then neutralize </script
function jsonLdSafe(obj) {
  return JSON.stringify(obj).replace(/<\//g, '<\\/');
}
function getProductById(id) {
  const numId = parseInt(id);
  const products = readData('products.json');
  const p = isNaN(numId)
    ? products.find(x => x.article && x.article.toLowerCase() === String(id).toLowerCase())
    : products.find(x => x.id === numId);
  return { p, dataAvailable: products.length > 0 };
}
function productCompatStr(p) {
  const arr = (p.compatibility && p.compatibility.length) ? p.compatibility : [{ brand: p.brand, model: p.model }];
  return arr.filter(c => c.brand).map(c => c.model ? `${c.brand} ${c.model}` : c.brand).join(', ');
}
function futureDate(days) {
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 10);
}
// Replace the shell's default head tags with per-route values (string-replace on unique tags)
function injectHead(html, o) {
  let out = html;
  if (o.title != null) {
    const T = htmlAttr(o.title);
    out = out.replace('<title>OlegAvto — Запчастини для французьких авто</title>', `<title>${T}</title>`)
             .replace('<meta property="og:title" content="OlegAvto — Запчастини для французьких авто">', `<meta property="og:title" content="${T}">`)
             .replace('<meta name="twitter:title" content="OlegAvto — Запчастини для французьких авто">', `<meta name="twitter:title" content="${T}">`);
  }
  if (o.desc != null) {
    const D = htmlAttr(o.desc);
    out = out.replace('<meta name="description" content="Автозапчастини для Renault, Peugeot, Citroën та Fiat в Україні. Нові та б/у деталі. Швидка відправка Новою Поштою по всій Україні.">', `<meta name="description" content="${D}">`)
             .replace('<meta property="og:description" content="Автозапчастини для Renault, Peugeot, Citroën та Fiat в Україні. Нові та б/у деталі. Швидка відправка Новою Поштою.">', `<meta property="og:description" content="${D}">`)
             .replace('<meta name="twitter:description" content="Автозапчастини для Renault, Peugeot, Citroën та Fiat в Україні. Нові та б/у деталі. Швидка відправка Новою Поштою.">', `<meta name="twitter:description" content="${D}">`);
  }
  if (o.canonical != null) {
    out = out.replace('<link rel="canonical" href="https://olegavto.com/">', `<link rel="canonical" href="${htmlAttr(o.canonical)}">`)
             .replace('<link rel="alternate" hreflang="uk-ua" href="https://olegavto.com/">', `<link rel="alternate" hreflang="uk-ua" href="${htmlAttr(o.canonical)}">`);
  }
  if (o.ogUrl != null) {
    out = out.replace('<meta property="og:url" content="https://olegavto.com/">', `<meta property="og:url" content="${htmlAttr(o.ogUrl)}">`);
  }
  if (o.ogImage != null) {
    out = out.replace('<meta property="og:image" content="https://olegavto.com/og-image.png">', `<meta property="og:image" content="${htmlAttr(o.ogImage)}">`)
             .replace('<meta name="twitter:image" content="https://olegavto.com/og-image.png">', `<meta name="twitter:image" content="${htmlAttr(o.ogImage)}">`);
  }
  if (o.robots != null) {
    out = out.replace('<meta name="robots" content="index, follow">', `<meta name="robots" content="${htmlAttr(o.robots)}">`);
  }
  if (o.jsonLdBlock != null) {
    out = out.replace(/<script type="application\/ld\+json" id="jsonLd">[\s\S]*?<\/script>/, o.jsonLdBlock);
  }
  if (o.noscript != null) {
    out = out.replace('</body>', o.noscript + '</body>');
  }
  return out;
}
function notFoundHtml() {
  return `<!DOCTYPE html><html lang="uk"><head><meta charset="UTF-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex, follow">` +
    `<title>Сторінку не знайдено — OlegAvto</title></head>` +
    `<body style="font-family:sans-serif;text-align:center;padding:60px 20px;color:#0f172a">` +
    `<h1>404 — Сторінку не знайдено</h1>` +
    `<p>Такої сторінки не існує або товар уже продано.</p>` +
    `<p><a href="/">На головну</a> &middot; <a href="/catalog">Каталог запчастин</a></p></body></html>`;
}

app.get('/favicon.ico', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.type('image/png');
  res.sendFile(path.join(__dirname, 'public', 'icon-192.png'));
});

// Home — shell default head already IS the homepage head
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.send(shellHtml());
});

// Catalog (page-1 canonical = /catalog; ?page=N self-canonicalizes)
app.get('/catalog', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const canonical = page > 1 ? `${SITE_URL}/catalog?page=${page}` : `${SITE_URL}/catalog`;
  const ns = `<noscript><div><h1>Каталог автозапчастин Renault, Peugeot, Citroën, Fiat</h1>` +
    `<p>Понад 15 000 нових та вживаних запчастин для французьких авто. Доставка Новою Поштою по всій Україні.</p>` +
    `<p><a href="/catalog">Усі товари</a> &middot; <a href="/contacts">Контакти</a> &middot; <a href="/">Головна</a></p></div></noscript>`;
  res.set('Cache-Control', 'no-cache');
  res.send(injectHead(shellHtml(), {
    title: 'Каталог запчастин Renault, Peugeot, Citroën, Fiat — OlegAvto',
    desc: 'Каталог нових та б/у автозапчастин для Renault, Peugeot, Citroën, Fiat. Понад 15 000 позицій. Доставка Новою Поштою по всій Україні.',
    canonical, ogUrl: canonical, noscript: ns
  }));
});

app.get('/contacts', (req, res) => {
  const canonical = `${SITE_URL}/contacts`;
  const ns = `<noscript><div><h1>Контакти OlegAvto</h1><p>Телефон: +380677448965, +380677533189.</p>` +
    `<p>Графік: Пн–Пт 09:00–18:00, Сб 09:00–14:00, Нд вихідний.</p>` +
    `<p><a href="/">Головна</a> &middot; <a href="/catalog">Каталог запчастин</a></p></div></noscript>`;
  res.set('Cache-Control', 'no-cache');
  res.send(injectHead(shellHtml(), {
    title: 'Контакти OlegAvto — телефон, адреса, графік роботи',
    desc: 'Контакти магазину OlegAvto: телефони, графік роботи, доставка Новою Поштою. Консультація по запчастинах для Renault, Peugeot, Citroën, Fiat.',
    canonical, ogUrl: canonical, noscript: ns
  }));
});

// Cart / Wishlist — thin utility pages: noindex, still boot the SPA
app.get(['/cart', '/wishlist'], (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.send(injectHead(shellHtml(), {
    canonical: SITE_URL + req.path, ogUrl: SITE_URL + req.path, robots: 'noindex, follow'
  }));
});

// Product detail
app.get('/product/:id', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  let lookup;
  try {
    lookup = getProductById(req.params.id);
  } catch (e) {
    return res.send(shellHtml()); // data error — never 500 a real route
  }
  if (!lookup.dataAvailable) return res.send(shellHtml()); // store unavailable — serve unmodified shell
  const p = lookup.p;
  if (!p) { res.status(404); return res.send(notFoundHtml()); } // genuinely missing product

  const cs = productCompatStr(p);
  const title = `${p.name} — купити | OlegAvto`;
  const desc = `${p.name}${cs ? ' для ' + cs : ''}. ${p.condition === 'new' ? 'Новий' : 'Б/У'}. Ціна: €${p.price}. ${p.stock > 0 ? 'В наявності.' : 'Під замовлення.'} Доставка Новою Поштою.`;
  const imgs = (p.images && p.images.length) ? p.images : (p.image ? [p.image] : []);
  const canonical = `${SITE_URL}/product/${p.id}`;

  const productLd = {
    '@context': 'https://schema.org', '@type': 'Product',
    name: p.name,
    image: imgs.length ? imgs : undefined,
    description: desc,
    sku: p.article || p.oem || undefined,
    mpn: p.oem || undefined,
    brand: { '@type': 'Brand', name: p.supplierBrand || p.brand || 'OlegAvto' },
    category: p.category || undefined,
    itemCondition: p.condition === 'used' ? 'https://schema.org/UsedCondition' : 'https://schema.org/NewCondition',
    offers: {
      '@type': 'Offer', price: p.price, priceCurrency: 'EUR',
      availability: p.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      url: canonical, priceValidUntil: futureDate(30),
      seller: { '@type': 'Organization', name: 'OlegAvto' }
    }
  };
  const breadcrumbLd = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Головна', item: SITE_URL + '/' },
      { '@type': 'ListItem', position: 2, name: 'Каталог', item: SITE_URL + '/catalog' },
      { '@type': 'ListItem', position: 3, name: p.name, item: canonical }
    ]
  };
  const jsonLdBlock =
    `<script type="application/ld+json" id="jsonLd">${jsonLdSafe(productLd)}</script>\n` +
    `<script type="application/ld+json">${jsonLdSafe(breadcrumbLd)}</script>`;

  const ns = `<noscript><div><h1>${htmlAttr(p.name)}</h1>` +
    `<p>${htmlAttr(desc)}</p>` +
    (cs ? `<p>Сумісність: ${htmlAttr(cs)}</p>` : '') +
    (p.oem ? `<p>OEM: ${htmlAttr(p.oem)}</p>` : '') +
    `<p>Ціна: €${htmlAttr(p.price)}</p>` +
    `<p><a href="/catalog">Каталог запчастин</a> &middot; <a href="/contacts">Контакти</a> &middot; <a href="/">Головна</a></p>` +
    `</div></noscript>`;

  res.send(injectHead(shellHtml(), {
    title, desc, canonical, ogUrl: canonical, ogImage: OG_DEFAULT,
    jsonLdBlock, noscript: ns
  }));
});

// Real 404 for everything else (no more shell-for-all soft-404)
app.get('*', (req, res) => {
  res.status(404).set('Cache-Control', 'no-cache').send(notFoundHtml());
});

app.listen(PORT, () => {
  console.log('\n OlegAuto сервер запущено!\n');
  console.log('  Магазин:       http://localhost:' + PORT);
  console.log('  Адмін-панель:  http://localhost:' + PORT + '/admin');
  console.log('\nНатисніть Ctrl+C щоб зупинити\n');
});
