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

// Стисле подання деталі для зовнішньої системи: залишок + де лежить.
function publicPart(part) {
  if (!part) return null;
  return {
    id: part.id,
    barcode: part.barcode,
    sku: part.code,
    oem: part.oem,
    name: part.name,
    brand: part.brand,
    car: [part.car_make, part.car_model].filter(Boolean).join(' '),
    unit: part.unit,
    price: part.price,
    total_qty: part.total_qty,
    in_stock: part.total_qty > 0,
    placements: part.placements.map((p) => ({
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

// Пошук деталі: за нашим id/штрих-кодом/артикулом або за external_id самої інтеграції.
router.get('/parts/lookup', wrap((req) => {
  const { external_id, sku, barcode, q } = req.query;
  let part = null;
  if (external_id || sku) part = S.findByExternal(req.integration.id, { external_id, sku });
  if (!part && (barcode || q)) {
    const r = S.resolveCode(barcode || q);
    if (r.type === 'part') part = r.part;
    else if (r.type === 'many') return { matches: r.results.map((p) => ({ id: p.id, sku: p.code, name: p.name, total_qty: p.total_qty })) };
  }
  if (!part) return { part: null };
  return { part: publicPart(part) };
}));

router.get('/parts', wrap((req) => ({
  parts: S.searchParts({ q: req.query.q || '', limit: Number(req.query.limit) || 50 })
    .map((p) => ({ id: p.id, sku: p.code, oem: p.oem, name: p.name, total_qty: p.total_qty, price: p.price })),
})));

router.get('/parts/:id', wrap((req) => ({ part: publicPart(S.partFull(Number(req.params.id))) })));

// Наявність одразу для списку артикулів — для сторінки товару в магазині.
router.post('/stock/check', wrap((req) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  return {
    items: items.map((it) => {
      const part = S.findByExternal(req.integration.id, { external_id: it.external_id, sku: it.sku });
      return {
        external_id: it.external_id ?? null,
        sku: it.sku ?? null,
        found: !!part,
        total_qty: part ? part.total_qty : 0,
        in_stock: part ? part.total_qty > 0 : false,
      };
    }),
  };
}));

// Продаж у магазині: списати з конкретного місця (або з найбільшого, якщо місце не вказали).
router.post('/stock/out', wrap((req) => {
  const { external_id, sku, qty = 1, location_barcode, note } = req.body || {};
  const part = S.findByExternal(req.integration.id, { external_id, sku });
  if (!part) throw new Error('part_not_found');

  let locId = null;
  if (location_barcode) {
    const r = S.resolveCode(location_barcode);
    if (r.type !== 'location') throw new Error('location_not_found');
    locId = r.location.id;
  } else {
    const best = [...part.placements].sort((a, b) => b.qty - a.qty)[0];
    if (!best) throw new Error('no_stock');
    locId = best.location_id;
  }
  const updated = S.stockOut(part.id, locId, Number(qty), note || `Продаж через ${req.integration.name}`);
  return { part: publicPart(updated) };
}));

// Прихід ззовні (повернення, поставка).
router.post('/stock/in', wrap((req) => {
  const { external_id, sku, qty = 1, location_barcode, note } = req.body || {};
  const part = S.findByExternal(req.integration.id, { external_id, sku });
  if (!part) throw new Error('part_not_found');
  if (!location_barcode) throw new Error('location_barcode_required');
  const r = S.resolveCode(location_barcode);
  if (r.type !== 'location') throw new Error('location_not_found');
  const updated = S.stockIn(part.id, r.location.id, Number(qty), note || `Прихід через ${req.integration.name}`);
  return { part: publicPart(updated) };
}));

// Прив'язка товару магазину до нашої деталі.
router.post('/parts/link', wrap((req) => {
  const { part_id, sku, external_id, external_sku, external_url } = req.body || {};
  let pid = part_id;
  if (!pid && sku) {
    const r = S.resolveCode(sku);
    if (r.type !== 'part') throw new Error('part_not_found');
    pid = r.part.id;
  }
  if (!pid) throw new Error('part_id_or_sku_required');
  const part = S.linkPart({
    part_id: pid,
    integration_id: req.integration.id,
    external_id,
    external_sku: external_sku || '',
    external_url: external_url || '',
  });
  return { part: publicPart(part) };
}));

// Де лежить: те, заради чого все й затівалось — код деталі → склад, стелаж, комірка + координати для схеми.
router.get('/locate', wrap((req) => {
  const r = S.resolveCode(req.query.code || req.query.sku || '');
  if (r.type === 'part') {
    return {
      type: 'part',
      part: publicPart(r.part),
      map: r.part.placements.map((p) => ({
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
