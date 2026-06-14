require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const basicAuth = require('express-basic-auth');

const ADMINS_PATH = path.join(__dirname, 'data', 'admins.json');

function loadAdmins() {
  if (fs.existsSync(ADMINS_PATH)) {
    try { return JSON.parse(fs.readFileSync(ADMINS_PATH, 'utf8')); } catch {}
  }
  // Migrate from .env on first run
  const defaultUser = process.env.ADMIN_USER || 'admin';
  const defaultPass = process.env.ADMIN_PASS || 'admin';
  const admins = { [defaultUser]: defaultPass };
  fs.mkdirSync(path.dirname(ADMINS_PATH), { recursive: true });
  fs.writeFileSync(ADMINS_PATH, JSON.stringify(admins, null, 2));
  return admins;
}

function saveAdmins(admins) {
  fs.writeFileSync(ADMINS_PATH, JSON.stringify(admins, null, 2));
}

let admins = loadAdmins();

function dynamicAdminAuth(req, res, next) {
  const handler = basicAuth({
    users: admins,
    challenge: true,
    realm: 'OlegAuto Admin',
  });
  handler(req, res, next);
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
  const { brand, category, condition, inStock, search, sort, carBrand, carModel } = req.query;

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

app.post('/api/products', upload.single('image'), (req, res) => {
  const products = readData('products.json');
  const compatibility = JSON.parse(req.body.compatibility || '[]');
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
    image: req.file ? '/uploads/' + req.file.filename : null,
    createdAt: new Date().toISOString()
  };
  products.unshift(product);
  writeData('products.json', products);
  res.json(product);
});

app.put('/api/products/:id', upload.single('image'), (req, res) => {
  const products = readData('products.json');
  const idx = products.findIndex(p => p.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const updCompatibility = JSON.parse(req.body.compatibility || '[]');
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
  };
  if (req.file) updated.image = '/uploads/' + req.file.filename;
  products[idx] = updated;
  writeData('products.json', products);
  res.json(updated);
});

app.delete('/api/products/:id', (req, res) => {
  let products = readData('products.json');
  products = products.filter(p => p.id !== parseInt(req.params.id));
  writeData('products.json', products);
  res.json({ ok: true });
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
  orders[idx].status = req.body.status;
  writeData('orders.json', orders);
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
  res.json(Object.keys(admins));
});

app.post('/api/admins', dynamicAdminAuth, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Логін і пароль обовʼязкові' });
  if (password.length < 4) return res.status(400).json({ error: 'Пароль мінімум 4 символи' });
  if (admins[username]) return res.status(400).json({ error: 'Такий логін вже існує' });
  admins[username] = password;
  saveAdmins(admins);
  res.json({ ok: true });
});

app.put('/api/admins/:username', dynamicAdminAuth, (req, res) => {
  const { username } = req.params;
  const { password } = req.body;
  if (!admins[username]) return res.status(404).json({ error: 'Адміна не знайдено' });
  if (!password || password.length < 4) return res.status(400).json({ error: 'Пароль мінімум 4 символи' });
  admins[username] = password;
  saveAdmins(admins);
  res.json({ ok: true });
});

app.delete('/api/admins/:username', dynamicAdminAuth, (req, res) => {
  const { username } = req.params;
  if (!admins[username]) return res.status(404).json({ error: 'Адміна не знайдено' });
  if (Object.keys(admins).length <= 1) return res.status(400).json({ error: 'Не можна видалити останнього адміна' });
  delete admins[username];
  saveAdmins(admins);
  res.json({ ok: true });
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
