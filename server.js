// Rabbit toys pre-order tracker — zero-dependency Node server.
// Data: $DATA_DIR/items.json, photos: $DATA_DIR/photos/*. Access is protected by APP_PASSWORD (HTTP Basic auth).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseOrder, parseWish, readReceipt, answerQuestion, findOfficialPhotos } = require('./ai');
const { createTelegram } = require('./telegram');
const { buildCart, findSiblings } = require('./cart');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PASSWORD = process.env.APP_PASSWORD || '';
const PUBLIC = path.join(__dirname, 'public');
const ITEMS_FILE = path.join(DATA_DIR, 'items.json');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const MAX_BODY = 50 * 1024 * 1024;

fs.mkdirSync(PHOTO_DIR, { recursive: true });

function loadSeed() {
  const src = fs.readFileSync(path.join(PUBLIC, 'seed.js'), 'utf8');
  return JSON.parse(src.slice(src.indexOf('['), src.lastIndexOf(']') + 1));
}
let items;
try { items = JSON.parse(fs.readFileSync(ITEMS_FILE, 'utf8')); } catch { items = loadSeed(); }
items = items.map((it) => ({ kind: 'order', link: '', orderUrl: '', deadline: '', remindAt: '', ...it, ...receivedFields(it) }));
let version = Date.now();

function persist() {
  const tmp = ITEMS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(items));
  fs.renameSync(tmp, ITEMS_FILE);
  version = Date.now();
}
persist();

const telegram = createTelegram({
  dataDir: DATA_DIR,
  getItems: () => items,
  ask: (process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.XAI_API_KEY) ? answerQuestion : null,
  publicUrl: process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/` : ''),
});
telegram.start();

// Turn embedded data: URLs into stored files so items.json stays small.
function imageExt(buf) {
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8) return 'jpg';
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
  if (buf.length > 6 && buf.slice(0, 4).toString() === 'GIF8') return 'gif';
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'webp';
  return '';
}
function storeList(list) {
  return (Array.isArray(list) ? list : []).map((p) => {
    const m = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/s.exec(p || '');
    if (!m) return p;
    const buf = Buffer.from(m[2], 'base64');
    const ext = imageExt(buf);
    if (!ext) return '';
    const name = crypto.randomUUID() + '.' + ext;
    fs.writeFileSync(path.join(PHOTO_DIR, name), buf);
    return '/photos/' + name;
  }).filter(Boolean);
}
function storePhotos(item) {
  item.photos = storeList(item.photos);
  item.orderShots = storeList(item.orderShots);
  return item;
}

// Shops often block the phone from loading their images. Keep a copy we serve ourselves.
async function rehostRemote(url) {
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'image/*,*/*;q=0.8' } });
    const buf = Buffer.from(await r.arrayBuffer());
    const ext = r.ok ? imageExt(buf) : '';
    if (!ext || buf.length > 8_000_000) return null;
    const name = crypto.randomUUID() + '.' + ext;
    fs.writeFileSync(path.join(PHOTO_DIR, name), buf);
    return '/photos/' + name;
  } catch { return null; }
}
async function rehostExisting() {
  let changed = false;
  for (const it of items) {
    const photos = [];
    for (const p of it.photos || []) {
      if (!/^https:\/\//.test(p)) { photos.push(p); continue; }
      const local = await rehostRemote(p);
      photos.push(local || p);
      if (local) changed = true;
    }
    if (photos.some((p, i) => p !== it.photos[i])) { it.photos = photos; changed = true; }
  }
  if (changed) persist();
}
async function keepLocalPhotos(item) {
  const next = [];
  for (const p of item.photos || []) {
    if (!/^https:\/\//.test(p)) { next.push(p); continue; }
    const local = await rehostRemote(p);
    if (local) next.push(local);
  }
  if (next.length) item.photos = next;
  return item;
}
rehostExisting().catch((e) => console.error('rehost photos', e.message));

// A phone screenshot is tall. Product photos are not. Move the tall ones out of the product gallery once.
function imageSize(buf) {
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xFF) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf.length > 24) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP' && buf.slice(12, 16).toString() === 'VP8X' && buf.length >= 30) {
    return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
  }
  return null;
}
function isReceiptPhoto(p) {
  if (!String(p).startsWith('/photos/')) return false;
  try {
    const size = imageSize(fs.readFileSync(path.join(PHOTO_DIR, path.basename(p))));
    return !!(size && size.h > size.w * 1.35);
  } catch { return false; }
}
function splitOrderShots() {
  const flag = path.join(DATA_DIR, '.order-shots-split');
  if (fs.existsSync(flag)) return;
  let changed = false;
  for (const it of items) {
    const shots = Array.isArray(it.orderShots) ? it.orderShots.slice() : [];
    const photos = [];
    for (const p of it.photos || []) (isReceiptPhoto(p) ? shots : photos).push(p);
    const next = [...new Set(shots)];
    if (photos.length !== (it.photos || []).length || next.length !== (it.orderShots || []).length) {
      it.photos = photos;
      it.orderShots = next;
      changed = true;
    }
  }
  if (changed) persist();
  fs.writeFileSync(flag, new Date().toISOString());
}
splitOrderShots();

// Status "已收貨" carries the date it was received and the status to go back to if it is un-ticked.
function hkToday() { return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); }
function receivedFields(raw) {
  if (raw.status === '已到貨') raw.status = '已收貨'; // old name
  const received = raw.status === '已收貨';
  return {
    receivedAt: received ? String(raw.receivedAt || hkToday()) : '',
    prevStatus: raw.prevStatus && raw.prevStatus !== '已收貨' ? String(raw.prevStatus) : '',
  };
}

const CURRENCIES = ['HKD', 'JPY', 'CNY', 'TWD', 'USD'];

function cleanItem(raw) {
  const s = (v) => (v == null ? '' : String(v));
  return storePhotos({
    id: s(raw.id) || 'i' + Date.now(), platform: s(raw.platform), orderNo: s(raw.orderNo), orderDate: s(raw.orderDate),
    kind: raw.kind === 'wish' ? 'wish' : 'order', link: /^https?:\/\//.test(s(raw.link)) ? s(raw.link) : '', orderUrl: /^https?:\/\//.test(s(raw.orderUrl)) ? s(raw.orderUrl) : '', deadline: s(raw.deadline), remindAt: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s(raw.remindAt)) ? s(raw.remindAt) : '',
    name: s(raw.name), qty: Math.max(1, Number(raw.qty) || 1), currency: CURRENCIES.includes(raw.currency) ? raw.currency : 'JPY',
    price: Number(raw.price) || 0, shipping: Number(raw.shipping) || 0, shipDate: s(raw.shipDate), delivery: s(raw.delivery),
    status: s(raw.status) || '已下單', notes: s(raw.notes), photos: raw.photos, orderShots: raw.orderShots,
    failedAt: /^\d{4}-\d{2}-\d{2}$/.test(s(raw.failedAt)) ? s(raw.failedAt) : '',
    ...receivedFields(raw),
  });
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function serveFile(res, file, cache) {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': cache });
    res.end(buf);
  });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch (e) { e.status = 400; e.clientBody = true; reject(e); } });
    req.on('error', reject);
  });
}
function authorized(req) {
  if (!PASSWORD) return true;
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const pass = Buffer.from(m[1], 'base64').toString('utf8').split(':').slice(1).join(':');
  const a = Buffer.from(pass), b = Buffer.from(PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  if (p === '/healthz') return send(res, 200, { ok: true });
  if (!authorized(req)) return send(res, 401, '請輸入密碼', 'text/plain; charset=utf-8', { 'WWW-Authenticate': 'Basic realm="rabbit-toys", charset="UTF-8"' });

  try {
    if (p === '/api/items' && req.method === 'GET') return send(res, 200, { version, items });
    if (p === '/api/items' && req.method === 'PUT') { // replace everything (import backup)
      const data = await readBody(req);
      if (!Array.isArray(data)) return send(res, 400, { error: 'expected array' });
      items = data.map(cleanItem); persist();
      return send(res, 200, { version, items });
    }
    const m = /^\/api\/items\/([^/]+)$/.exec(p);
    if (m && req.method === 'PUT') {
      const item = await keepLocalPhotos(cleanItem({ ...(await readBody(req)), id: m[1] }));
      const i = items.findIndex((x) => x.id === item.id);
      if (i >= 0) items[i] = item; else items.unshift(item);
      persist();
      return send(res, 200, { version, item });
    }
    if (m && req.method === 'DELETE') {
      items = items.filter((x) => x.id !== m[1]); persist();
      return send(res, 200, { version });
    }
    if (p === '/api/ai/photos' && req.method === 'POST') {
      const body = await readBody(req);
      const found = await findOfficialPhotos({ name: body?.name, platform: body?.platform, orderUrl: body?.orderUrl });
      found.photos = (await keepLocalPhotos({ photos: found.photos })).photos;
      return send(res, 200, found);
    }
    if (p === '/api/ai/receipt' && req.method === 'POST') {
      const body = await readBody(req);
      const images = Array.isArray(body?.images) ? body.images.slice(0, 6) : [];
      const candidates = (Array.isArray(body?.candidates) ? body.candidates : []).slice(0, 300)
        .map((c) => ({ id: String(c?.id || '').slice(0, 80), name: String(c?.name || '').slice(0, 200), platform: String(c?.platform || '').slice(0, 80) }))
        .filter((c) => c.id && c.name);
      return send(res, 200, await readReceipt({ images, name: String(body?.name || '').slice(0, 300), candidates }));
    }
    if (p === '/api/ai/parse' && req.method === 'POST') {
      const body = await readBody(req);
      const images = Array.isArray(body?.images) ? body.images.slice(0, 6) : [];
      return send(res, 200, await parseOrder({ images, hint: String(body?.hint || '').slice(0, 500) }));
    }
    if (p === '/api/ai/link' && req.method === 'POST') {
      const body = await readBody(req);
      const images = Array.isArray(body?.images) ? body.images.slice(0, 4) : [];
      return send(res, 200, await parseWish({ link: String(body?.link || '').trim().slice(0, 2000), images, hint: String(body?.hint || '').slice(0, 500) }));
    }
    if (p === '/api/shop/siblings' && req.method === 'POST') return send(res, 200, await findSiblings(String(((await readBody(req)) || {}).url || '')));
    if (p === '/api/cart' && req.method === 'POST') return send(res, 200, await buildCart(((await readBody(req)) || {}).lines));
    if (p === '/api/telegram' && req.method === 'GET') return send(res, 200, telegram.status());
    if (p === '/api/telegram/test' && req.method === 'POST') return send(res, 200, await telegram.test());
    if (p.startsWith('/photos/') && req.method === 'GET') {
      const name = path.basename(p);
      return serveFile(res, path.join(PHOTO_DIR, name), 'private, max-age=31536000, immutable');
    }
    if (req.method === 'GET') {
      const file = path.join(PUBLIC, p === '/' ? 'index.html' : path.normalize(p).replace(/^([/\\])+/, ''));
      if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
      return serveFile(res, file, 'no-cache');
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    if (e instanceof SyntaxError && !e.clientBody) {
      console.error('bad JSON:', e.message);
      return send(res, 502, { error: 'AI 回覆格式有誤，請再試一次。' });
    }
    if (e.status && e.status >= 500) console.error(e);
    const code = e.message === 'too large' ? 413 : (Number.isInteger(e.status) && e.status >= 400 && e.status < 600 ? e.status : 400);
    send(res, code, { error: String(e.message || e) });
  }
}).listen(PORT, () => console.log(`listening on ${PORT}, data in ${DATA_DIR}, password ${PASSWORD ? 'on' : 'OFF'}`));

// Railway stops the old container with SIGTERM on every redeploy: finish in-flight requests and exit cleanly
// (exiting with an error code makes Railway report the deploy as crashed).
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`${sig} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  });
}
