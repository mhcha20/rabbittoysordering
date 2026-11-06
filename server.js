// Rabbit toys pre-order tracker — zero-dependency Node server.
// Data: $DATA_DIR/items.json, photos: $DATA_DIR/photos/*. Access is protected by APP_PASSWORD (HTTP Basic auth).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseOrder, parseWish, answerQuestion } = require('./ai');
const { createTelegram } = require('./telegram');

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
  ask: (process.env.ANTHROPIC_API_KEY || process.env.XAI_API_KEY) ? answerQuestion : null,
  publicUrl: process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/` : ''),
});
telegram.start();

// Turn embedded data: URLs into stored files so items.json stays small.
function storePhotos(item) {
  item.photos = (Array.isArray(item.photos) ? item.photos : []).map((p) => {
    const m = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/s.exec(p || '');
    if (!m) return p;
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const name = crypto.randomUUID() + '.' + ext;
    fs.writeFileSync(path.join(PHOTO_DIR, name), Buffer.from(m[2], 'base64'));
    return '/photos/' + name;
  });
  return item;
}

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
    status: s(raw.status) || '已下單', notes: s(raw.notes), photos: raw.photos,
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
      const item = cleanItem({ ...(await readBody(req)), id: m[1] });
      const i = items.findIndex((x) => x.id === item.id);
      if (i >= 0) items[i] = item; else items.unshift(item);
      persist();
      return send(res, 200, { version, item });
    }
    if (m && req.method === 'DELETE') {
      items = items.filter((x) => x.id !== m[1]); persist();
      return send(res, 200, { version });
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
