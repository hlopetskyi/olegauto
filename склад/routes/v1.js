'use strict';

/**
 * Публічний API складу для зовнішніх систем (магазин, CRM, маркетплейс).
 * Авторизація: заголовок  X-Api-Key: sk_...
 *
 * Цей контракт навмисно не знає нічого про olegavto — будь-який сервіс,
 * що вміє слати HTTP, інтегрується без змін у ядрі.
 */

const express = require('express');
const S = require('../lib/store');

const router = express.Router();

router.use((req, res, next) => {
  const key = req.get('X-Api-Key') || (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const integration = S.integrationByKey(key);
  if (!integration) return res.status(401).json({ error: 'invalid_api_key' });
  req.integration = integration;
  next();
});

const wrap = (fn) => (req, res) => {
  try {
    const out = fn(req, res);
    if (out !== undefined) res.json(out);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};

// Стисле подання товару для зовнішньої системи: залишок + де лежить.
function publicProduct(product) {
  if (!product) return null;
  return {
    id: product.id,
    barcode: product.barcode,
    sku: product.code,
    oem: product.oem,
    name: product.name,
    brand: product.brand,
    category: product.category_name || null,
    category_path: [product.category_parent_name, product.category_name].filter(Boolean).join(' / ') || null,
    car: [product.car_make, product.car_model].filter(Boolean).join(' '),
    unit: product.unit,
    price: product.price,
    total_qty: product.total_qty,
    in_stock: product.total_qty > 0,
    placements: product.placements.map((p) => ({
      warehouse: p.warehouse_name,
      rack: p.rack_name,
      location: p.label,
      box: p.parent_label || null,
      location_barcode: p.location_barcode,
      qty: p.qty,
    })),
  };
}

router.get('/ping', (req, res) => res.json({ ok: true, integration: req.integration.slug }));

// Пошук товару: за нашим id/штрих-кодом/артикулом або за external_id самої інтеграції.
router.get('/products/lookup', wrap((req) => {
  const { external_id, sku, barcode, q } = req.query;
  let product = null;
  if (external_id || sku) product = S.findByExternal(req.integration.id, { external_id, sku });
  if (!product && (barcode || q)) {
    const r = S.resolveCode(barcode || q);
    if (r.type === 'product') product = r.product;
    else if (r.type === 'many') return { matches: r.results.map((p) => ({ id: p.id, sku: p.code, name: p.name, total_qty: p.total_qty })) };
  }
  if (!product) return { product: null };
  return { product: publicProduct(product) };
}));

router.get('/products', wrap((req) => ({
  products: S.searchProducts({ q: req.query.q || '', limit: Number(req.query.limit) || 50 })
    .map((p) => ({ id: p.id, sku: p.code, oem: p.oem, name: p.name, total_qty: p.total_qty, price: p.price })),
})));

router.get('/products/:id', wrap((req) => ({ product: publicProduct(S.productFull(Number(req.params.id))) })));

// Наявність одразу для списку артикулів — для сторінки товару в магазині.
router.post('/stock/check', wrap((req) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  return {
    items: items.map((it) => {
      const product = S.findByExternal(req.integration.id, { external_id: it.external_id, sku: it.sku });
      return {
        external_id: it.external_id ?? null,
        sku: it.sku ?? null,
        found: !!product,
        total_qty: product ? product.total_qty : 0,
        in_stock: product ? product.total_qty > 0 : false,
      };
    }),
  };
}));

// Продаж у магазині: списати з конкретного місця (або з найбільшого, якщо місце не вказали).
router.post('/stock/out', wrap((req) => {
  const { external_id, sku, qty = 1, location_barcode, note } = req.body || {};
  const product = S.findByExternal(req.integration.id, { external_id, sku });
  if (!product) throw new Error('product_not_found');

  let locId = null;
  if (location_barcode) {
    const r = S.resolveCode(location_barcode);
    if (r.type !== 'location') throw new Error('location_not_found');
    locId = r.location.id;
  } else {
    const best = [...product.placements].sort((a, b) => b.qty - a.qty)[0];
    if (!best) throw new Error('no_stock');
    locId = best.location_id;
  }
  const updated = S.stockOut(product.id, locId, Number(qty), note || `Продаж через ${req.integration.name}`);
  return { product: publicProduct(updated) };
}));

// Прихід ззовні (повернення, поставка).
router.post('/stock/in', wrap((req) => {
  const { external_id, sku, qty = 1, location_barcode, note } = req.body || {};
  const product = S.findByExternal(req.integration.id, { external_id, sku });
  if (!product) throw new Error('product_not_found');
  if (!location_barcode) throw new Error('location_barcode_required');
  const r = S.resolveCode(location_barcode);
  if (r.type !== 'location') throw new Error('location_not_found');
  const updated = S.stockIn(product.id, r.location.id, Number(qty), note || `Прихід через ${req.integration.name}`);
  return { product: publicProduct(updated) };
}));

// Прив'язка товару магазину до нашого товару.
router.post('/products/link', wrap((req) => {
  const { product_id, sku, external_id, external_sku, external_url } = req.body || {};
  let pid = product_id;
  if (!pid && sku) {
    const r = S.resolveCode(sku);
    if (r.type !== 'product') throw new Error('product_not_found');
    pid = r.product.id;
  }
  if (!pid) throw new Error('product_id_or_sku_required');
  const product = S.linkProduct({
    product_id: pid,
    integration_id: req.integration.id,
    external_id,
    external_sku: external_sku || '',
    external_url: external_url || '',
  });
  return { product: publicProduct(product) };
}));

// Де лежить: те, заради чого все й затівалось — код товару → склад, стелаж, комірка + координати для схеми.
router.get('/locate', wrap((req) => {
  const r = S.resolveCode(req.query.code || req.query.sku || '');
  if (r.type === 'product') {
    return {
      type: 'product',
      product: publicProduct(r.product),
      map: r.product.placements.map((p) => ({
        warehouse_id: p.warehouse_id,
        warehouse: p.warehouse_name,
        rack_id: p.rack_id,
        rack: p.rack_name,
        rows: p.rows,
        cols: p.cols,
        row: p.parent_row ?? p.row_idx,
        col: p.parent_col ?? p.col_idx,
        cell: p.parent_label || p.label,
        box: p.parent_label ? p.label : null,
        qty: p.qty,
      })),
    };
  }
  if (r.type === 'location') {
    return {
      type: 'location',
      location: { id: r.location.id, label: r.location.label, warehouse: r.location.warehouse_name, rack: r.location.rack_name },
      items: r.items.map((i) => ({ id: i.id, sku: i.code, name: i.name, qty: i.qty })),
    };
  }
  return { type: r.type, query: r.query || '' };
}));

module.exports = router;
