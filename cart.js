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
    title: prod.title,
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

module.exports = { buildCart, parseLink };
