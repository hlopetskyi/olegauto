const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const INPUT = path.join(__dirname, 'cкладcsv.gz');
const OUTPUT = path.join(__dirname, 'local-server/data/products.json');

// Car brand detection patterns (order matters — more specific first)
const BRAND_PATTERNS = [
  { brand: 'Renault', re: /renault|рено/i },
  { brand: 'Peugeot', re: /peugeot|пежо/i },
  { brand: 'Citroën', re: /citro[eë]n|ситро[єе]/i },
  { brand: 'Fiat', re: /\bfiat\b|фіат/i },
];

// Model detection per brand
const MODEL_PATTERNS = {
  'Renault': [
    { model: 'Clio I',    re: /clio\s*(i\b|1\b)/i },
    { model: 'Clio II',   re: /clio\s*(ii\b|2\b)/i },
    { model: 'Clio III',  re: /clio\s*(iii\b|3\b)/i },
    { model: 'Clio IV',   re: /clio\s*(iv\b|4\b)/i },
    { model: 'Clio',      re: /\bclio\b/i },
    { model: 'Megane I',   re: /megane\s*(i\b|1\b)/i },
    { model: 'Megane II',  re: /megane\s*(ii\b|2\b)/i },
    { model: 'Megane III', re: /megane\s*(iii\b|3\b)/i },
    { model: 'Megane IV',  re: /megane\s*(iv\b|4\b)/i },
    { model: 'Megane',     re: /\bmegane\b/i },
    { model: 'Laguna I',   re: /laguna\s*(i\b|1\b)/i },
    { model: 'Laguna II',  re: /laguna\s*(ii\b|2\b)/i },
    { model: 'Laguna III', re: /laguna\s*(iii\b|3\b)/i },
    { model: 'Laguna',     re: /\blaguna\b/i },
    { model: 'Scenic I',   re: /scenic\s*(i\b|1\b)/i },
    { model: 'Scenic II',  re: /scenic\s*(ii\b|2\b)/i },
    { model: 'Scenic III', re: /scenic\s*(iii\b|3\b)/i },
    { model: 'Scenic',     re: /\bscenic\b/i },
    { model: 'Kangoo I',   re: /kangoo\s*(i\b|1\b|98|99|00|01|02|03|04|05|06|07)/i },
    { model: 'Kangoo II',  re: /kangoo\s*(ii\b|2\b)/i },
    { model: 'Kangoo',     re: /\bkangoo\b/i },
    { model: 'Trafic II',  re: /trafic\s*(ii\b|2\b)/i },
    { model: 'Trafic III', re: /trafic\s*(iii\b|3\b)/i },
    { model: 'Trafic',     re: /\btrafic\b/i },
    { model: 'Master II',  re: /master\s*(ii\b|2\b)/i },
    { model: 'Master III', re: /master\s*(iii\b|3\b)/i },
    { model: 'Master',     re: /\bmaster\b/i },
    { model: 'Duster',     re: /\bduster\b/i },
    { model: 'Captur',     re: /\bcaptur\b/i },
    { model: 'Kadjar',     re: /\bkadjar\b/i },
    { model: 'Logan',      re: /\blogan\b/i },
    { model: 'Sandero',    re: /\bsandero\b/i },
    { model: 'Fluence',    re: /\bfluence\b/i },
    { model: 'Twingo',     re: /\btwingo\b/i },
    { model: 'Symbol',     re: /\bsymbol\b/i },
    { model: 'Espace',     re: /\bespace\b/i },
    { model: 'Koleos',     re: /\bkoleos\b/i },
    { model: 'Zoe',        re: /\bzoe\b/i },
  ],
  'Peugeot': [
    { model: '106',  re: /\b106\b/ },
    { model: '107',  re: /\b107\b/ },
    { model: '108',  re: /\b108\b/ },
    { model: '205',  re: /\b205\b/ },
    { model: '206',  re: /\b206\b/ },
    { model: '207',  re: /\b207\b/ },
    { model: '208',  re: /\b208\b/ },
    { model: '301',  re: /\b301\b/ },
    { model: '306',  re: /\b306\b/ },
    { model: '307',  re: /\b307\b/ },
    { model: '308',  re: /\b308\b/ },
    { model: '405',  re: /\b405\b/ },
    { model: '406',  re: /\b406\b/ },
    { model: '407',  re: /\b407\b/ },
    { model: '408',  re: /\b408\b/ },
    { model: '508',  re: /\b508\b/ },
    { model: '605',  re: /\b605\b/ },
    { model: '607',  re: /\b607\b/ },
    { model: '2008', re: /\b2008\b/ },
    { model: '3008', re: /\b3008\b/ },
    { model: '5008', re: /\b5008\b/ },
    { model: 'Partner',   re: /\bpartner\b/i },
    { model: 'Expert',    re: /\bexpert\b/i },
    { model: 'Boxer',     re: /\bboxer\b/i },
    { model: 'Bipper',    re: /\bbipper\b/i },
    { model: 'Traveller', re: /\btraveller\b/i },
    { model: 'RCZ',       re: /\brcz\b/i },
  ],
  'Citroën': [
    { model: 'C1',           re: /\bc1\b/i },
    { model: 'C2',           re: /\bc2\b/i },
    { model: 'C3 Aircross',  re: /c3\s*aircross/i },
    { model: 'C3 Picasso',   re: /c3\s*picasso/i },
    { model: 'C3',           re: /\bc3\b/i },
    { model: 'C4 Grand Picasso', re: /c4\s*(grand\s*picasso|grand)/i },
    { model: 'C4 Picasso',   re: /c4\s*picasso/i },
    { model: 'C4 Cactus',    re: /c4\s*cactus/i },
    { model: 'C4',           re: /\bc4\b/i },
    { model: 'C5',           re: /\bc5\b/i },
    { model: 'C6',           re: /\bc6\b/i },
    { model: 'C8',           re: /\bc8\b/i },
    { model: 'C-Elysée',     re: /c.ely/i },
    { model: 'Berlingo',     re: /\bberlingo\b/i },
    { model: 'Jumpy',        re: /\bjumpy\b/i },
    { model: 'Jumper',       re: /\bjumper\b/i },
    { model: 'Nemo',         re: /\bnemo\b/i },
    { model: 'Saxo',         re: /\bsaxo\b/i },
    { model: 'Xantia',       re: /\bxantia\b/i },
    { model: 'Xsara Picasso',re: /xsara\s*picasso/i },
    { model: 'Xsara',        re: /\bxsara\b/i },
    { model: 'ZX',           re: /\bzx\b/i },
    { model: 'DS3',          re: /\bds3\b/i },
    { model: 'DS4',          re: /\bds4\b/i },
    { model: 'DS5',          re: /\bds5\b/i },
  ],
  'Fiat': [
    { model: '500',     re: /\b500\b/ },
    { model: '500L',    re: /\b500l\b/i },
    { model: '500X',    re: /\b500x\b/i },
    { model: 'Doblo',   re: /\bdoblo\b/i },
    { model: 'Ducato',  re: /\bducato\b/i },
    { model: 'Punto',   re: /\bpunto\b/i },
    { model: 'Panda',   re: /\bpanda\b/i },
    { model: 'Bravo',   re: /\bbravo\b/i },
    { model: 'Stilo',   re: /\bstilo\b/i },
    { model: 'Marea',   re: /\bmarea\b/i },
    { model: 'Tipo',    re: /\btipo\b/i },
    { model: 'Fiorino', re: /\bfiorino\b/i },
    { model: 'Qubo',    re: /\bqubo\b/i },
    { model: 'Scudo',   re: /\bscudo\b/i },
    { model: 'Multipla',re: /\bmultipla\b/i },
    { model: 'Idea',    re: /\bidea\b/i },
    { model: 'Linea',   re: /\blinea\b/i },
    { model: 'Croma',   re: /\bcroma\b/i },
    { model: 'Uno',     re: /\buno\b/i },
  ],
};

const CATEGORY_PATTERNS = [
  { cat: 'Освітлення',      re: /фар[аиу]|ліхтар|lamp|light|фонар|headlight|taillight|осв[іи]тл/i },
  { cat: 'Кузов',           re: /бампер|крило|капот|двер|hood|bumper|fender|door|wing|порог|панел|решітк/i },
  { cat: 'Двигун та КПП',   re: /двигун|мотор|кпп|коробк|engine|gearbox|поршень|клапан|розпод|голівк|блок цил/i },
  { cat: 'Підвіска',        re: /підвіск|важіл|стійк|амортиз|пружин|bearing|suspension|arm|strut|шаровa|рульов/i },
  { cat: 'Гальма',          re: /гальм|колодк|диск|супорт|brake|caliper|диск гальм/i },
  { cat: 'Електрика',       re: /електр|генерат|стартер|датчик|sensor|реле|проводк|signal|сигнал|блок управл/i },
  { cat: "Інтер'єр",        re: /салон|сидін|килим|ручк|interior|panel|торпед|дзеркало внутр/i },
  { cat: 'Охолодження',     re: /радіат|охолод|термостат|помпа|cooling|radiator|вентилятор охолод/i },
  { cat: 'Паливна система', re: /паливн|форсунк|насос|injector|fuel|pump|карбюр/i },
  { cat: 'Трансмісія',      re: /трансміс|привод|шрус|піввісь|cardан|driveshaft|transmission/i },
];

function detectCategory(name) {
  for (const { cat, re } of CATEGORY_PATTERNS) {
    if (re.test(name)) return cat;
  }
  return 'Кузов'; // default
}

function detectCompatibility(name) {
  const compat = [];
  for (const { brand, re } of BRAND_PATTERNS) {
    if (re.test(name)) {
      const models = MODEL_PATTERNS[brand] || [];
      const matched = models.filter(m => m.re.test(name)).map(m => m.model);
      if (matched.length) {
        matched.forEach(model => compat.push({ brand, model }));
      } else {
        compat.push({ brand, model: '' });
      }
    }
  }
  return compat;
}

function detectCondition(name) {
  if (/нов[ий|а|е]|new\b/i.test(name)) return 'new';
  if (/б\/у|бу\b|used|вживан/i.test(name)) return 'used';
  return 'used'; // most avtopro listings are used
}

// Parse CSV
const raw = zlib.gunzipSync(fs.readFileSync(INPUT)).toString('utf8').replace(/^﻿/, '');
const lines = raw.split('\n').filter(l => l.trim());

console.log(`Total lines: ${lines.length}`);

const products = [];
let id = 1;

for (const line of lines) {
  const cols = line.split(';');
  if (cols.length < 4) continue;

  const supplierBrand = (cols[0] || '').trim();
  const article      = (cols[1] || '').trim();
  const name         = (cols[2] || '').trim();
  const price        = parseFloat((cols[3] || '0').replace(',', '.')) || 0;
  const stock        = parseInt(cols[4]) || 0;
  const imagesRaw    = (cols[6] || '').trim();
  const oem          = (cols[8] || '').trim();

  if (!name || !price) continue;

  const imageList = imagesRaw ? imagesRaw.split(',').map(u => u.trim()).filter(Boolean) : [];
  const compat = detectCompatibility(name);

  products.push({
    id: id++,
    name,
    brand: compat[0]?.brand || '',
    model: compat[0]?.model || '',
    compatibility: compat,
    category: detectCategory(name),
    condition: detectCondition(name),
    price,
    stock,
    oem,
    article,
    supplierBrand,
    images: imageList,
    image: imageList[0] || null,
    description: '',
    yearFrom: '',
    yearTo: '',
    createdAt: new Date().toISOString(),
  });
}

fs.writeFileSync(OUTPUT, JSON.stringify(products, null, 2));

// Stats
const withCompat = products.filter(p => p.compatibility.length > 0).length;
const cats = {};
products.forEach(p => cats[p.category] = (cats[p.category]||0)+1);

console.log(`\nImported: ${products.length} products`);
console.log(`With car brand detected: ${withCompat} (${Math.round(withCompat/products.length*100)}%)`);
console.log('\nBy category:');
Object.entries(cats).sort((a,b)=>b[1]-a[1]).forEach(([c,n])=>console.log(`  ${c}: ${n}`));
