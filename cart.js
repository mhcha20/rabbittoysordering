// "Buy all at once": turn several Shopify product links into one cart link per shop.
// Shopify cart permalinks look like https://shop/cart/<variantId>:<qty>,<variantId>:<qty>
// and open checkout with every item already in it.

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
// Our server sits in the US; ask as a Japanese visitor so products limited to the Japan market are visible.
const HEADERS = { 'User-Agent': UA, 'Accept-Language': 'ja,zh-HK;q=0.8,en;q=0.5', Cookie: 'localization=JP; cart_currency=JPY' };
const get = (u, accept) => fetch(u, { headers: { ...HEADERS, Accept: accept }, redirect: 'follow', signal: AbortSignal.timeout(15000) });

function parseLink(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const m = u.pathname.match(/\/products\/([^/?#]+)/);
  if (!m) return null;
  return { origin: u.origin, path: u.pathname, handle: decodeURIComponent(m[1]), variant: u.searchParams.get('variant') || '' };
}

const fixImg = (u) => (typeof u === 'string' && u.startsWith('//') ? 'https:' + u : typeof u === 'string' ? u : '');

const NOT_FOUND = '店舖搵唔到呢件商品（可能未上架、已下架，或者連結有錯）';

async function productJs(origin, handle) {
  const r = await get(`${origin}/products/${encodeURIComponent(handle)}.js`, 'application/json');
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`店舖回覆 ${r.status}（可能唔係 Shopify 商店）`);
  const prod = await r.json();
  return {
    title: prod.title, tags: prod.tags || [],
    image: prod.featured_image || (prod.images || [])[0] || '',
    variants: (prod.variants || []).map((v) => ({
      id: v.id, title: v.title, available: !!v.available,
      price: typeof v.price === 'number' ? v.price / 100 : null,
      image: v.featured_image && v.featured_image.src,
    })),
  };
}

// Fallback: open the product page itself (follows redirects) and read what the page carries.
async function productPage(origin, path, handle) {
  const r = await get(origin + path, 'text/html');
  if (!r.ok) { console.log(`cart: page ${origin}${path} -> ${r.status}`); return null; }
  const finalHandle = (new URL(r.url).pathname.match(/\/products\/([^/?#]+)/) || [])[1];
  if (finalHandle && decodeURIComponent(finalHandle) !== handle) {
    const p = await productJs(origin, decodeURIComponent(finalHandle));
    if (p) return p;
  }
  const html = await r.text();
  const meta = html.match(/var meta = (\{[\s\S]*?\});\s*(?:\n|for|window)/);
  let variants = [];
  try {
    const m = JSON.parse(meta[1]);
    variants = (m.product?.variants || []).map((v) => ({ id: v.id, title: v.public_title || v.name || '', available: null, price: typeof v.price === 'number' ? v.price / 100 : null }));
  } catch { /* no meta block */ }
  if (!variants.length) {
    const ids = [...new Set([...html.matchAll(/[?&]variant=(\d{6,})/g)].map((x) => x[1]))];
    variants = ids.map((id) => ({ id: Number(id), title: '', available: null, price: null }));
  }
  if (!variants.length) return null;
  const og = (k) => (html.match(new RegExp(`<meta[^>]+property=["']og:${k}["'][^>]+content=["']([^"']*)`, 'i')) || [])[1] || '';
  const ld = html.match(/"availability"\s*:\s*"[^"]*\/(\w+)"/);
  if (ld && variants.length === 1) variants[0].available = ld[1] === 'InStock';
  const unesc = (t) => t.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  return { title: unesc(og('title')) || handle, image: og('image'), variants };
}

async function lookup({ url, qty }) {
  const p = parseLink(url);
  if (!p) return { url, ok: false, error: '唔係 Shopify 商品連結（網址要有 /products/）' };
  const n = Math.max(1, Math.min(99, parseInt(qty, 10) || 1));
  try {
    const prod = (await productJs(p.origin, p.handle)) || (await productPage(p.origin, p.path, p.handle));
    if (!prod) { console.log(`cart: not found ${p.origin}${p.path}`); return { url, ok: false, error: NOT_FOUND }; }
    const variants = prod.variants;
    if (!variants.length) return { url, ok: false, error: '搵唔到款式' };
    const v = variants.find((x) => String(x.id) === p.variant) || variants.find((x) => x.available) || variants[0];
    return {
      url, ok: true, origin: p.origin, qty: n,
      title: prod.title, variantId: v.id,
      image: fixImg(v.image || prod.image || ''),
      variantTitle: variants.length > 1 ? v.title : '',
      manyVariants: variants.length > 1 && !p.variant,
      available: v.available, // true / false / null (unknown)
      price: v.price,
    };
  } catch (e) {
    return { url, ok: false, error: e.message?.startsWith('店舖') ? e.message : '連唔到店舖：' + (e.message || e) };
  }
}

async function buildCart(lines) {
  const list = (Array.isArray(lines) ? lines : []).slice(0, 40);
  const items = await Promise.all(list.map((l) => lookup(l || {})));
  const shops = {};
  for (const it of items) {
    if (!it.ok) continue;
    const s = (shops[it.origin] ||= {});
    s[it.variantId] = (s[it.variantId] || 0) + it.qty;
  }
  const carts = Object.entries(shops).map(([origin, vs]) => ({
    shop: new URL(origin).hostname,
    url: `${origin}/cart/${Object.entries(vs).map(([id, q]) => `${id}:${q}`).join(',')}`,
    count: Object.values(vs).reduce((a, b) => a + b, 0),
  }));
  return { items, carts };
}

// Same series, other characters: shops like ちいかわマーケット list each character as its own product,
// e.g. 「… Christmas（ちいかわ）」「…（ハチワレ）」「…（うさぎ）」. Find them by the title without the last bracket.
const seriesBase = (t) => String(t || '').replace(/\s*[（(][^（）()]*[）)]\s*$/, '').trim();

// Longest run of characters two names share, e.g. 「 ボンボンドロップシール ジュエル」.
function commonRun(a, b) {
  let best = 0; const prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : 0;
      if (prev[j] > best) best = prev[j];
      diag = tmp;
    }
  }
  return best;
}
const core = (t) => seriesBase(t).replace(/^ちいかわ\s*/, '');

async function findSiblings(url) {
  const p = parseLink(url);
  if (!p) return { items: [] };
  const self = await productJs(p.origin, p.handle).catch(() => null) || await productPage(p.origin, p.path, p.handle).catch(() => null);
  if (!self) return { items: [] };
  const base = seriesBase(self.title);
  const hasBracket = base !== self.title;
  const prefix = (p.path.match(/^\/([a-z]{2}(?:-[a-z]+)?)\/(?:collections|products)\//i) || [])[1];
  const link = (h) => `${p.origin}${prefix ? '/' + prefix : ''}/products/${h}`;
  const found = new Map(); // handle -> {title,image,price,available,related}
  const selfCore = core(self.title);
  const minRun = Math.max(6, Math.ceil(selfCore.length * 0.4));
  // 1. the release the product belongs to (the collection in the link, or a date tag such as 20261106)
  const col = (p.path.match(/\/collections\/([^/]+)\//) || [])[1] || (self.tags || []).find((t) => /^\d{8}$/.test(t));
  if (col) {
    for (let page = 1; page <= 4; page++) {
      const r = await get(`${p.origin}/collections/${encodeURIComponent(col)}/products.json?limit=250&page=${page}`, 'application/json').catch(() => null);
      if (!r?.ok) break;
      const list = (await r.json()).products || [];
      for (const x of list) {
        if (x.handle === p.handle) continue;
        const same = hasBracket && seriesBase(x.title) === base;
        // a similar name in the same release, e.g. 超まじかる… / てんし♡あくま… ボンボンドロップシール ジュエル
        const related = !same && commonRun(selfCore, core(x.title)) >= minRun;
        if (!same && !related) continue;
        const v = x.variants?.[0] || {};
        found.set(x.handle, { title: x.title, image: x.images?.[0]?.src || '', price: Number(v.price) || null, available: !!v.available, related });
      }
      if (list.length < 250) break;
    }
  }
  // 2. the shop's search (only the English storefront answers it): same name apart from the last bracket only
  if (hasBracket) {
    const q = encodeURIComponent(base.replace(/^ちいかわ\s*/, ''));
    const r = await get(`${p.origin}/en/search/suggest.json?q=${q}&resources[type]=product&resources[limit]=10&resources[options][unavailable_products]=show`, 'application/json').catch(() => null);
    if (r?.ok) {
      const hits = ((await r.json()).resources?.results?.products || []).map((x) => x.handle).filter((h) => h !== p.handle && !found.has(h));
      await Promise.all(hits.map(async (h) => {
        const x = await productJs(p.origin, h).catch(() => null);
        if (x && seriesBase(x.title) === base) {
          const v = x.variants[0] || {};
          found.set(h, { title: x.title, image: x.image, price: v.price, available: v.available, related: false });
        }
      }));
    }
  }
  if (!found.size) return { base, items: [] };
  const v0 = self.variants[0] || {};
  found.set(p.handle, { title: self.title, image: self.image, price: v0.price, available: v0.available, related: false });
  const items = [...found.entries()].map(([h, x]) => ({ ...x, image: fixImg(x.image), url: h === p.handle ? url : link(h), self: h === p.handle }))
    .sort((a, b) => (b.self - a.self) || (a.related - b.related) || a.title.localeCompare(b.title, 'ja'));
  return { base, items };
}

module.exports = { buildCart, parseLink, findSiblings };
