// "Buy all at once": turn several Shopify product links into one cart link per shop.
// Shopify cart permalinks look like https://shop/cart/<variantId>:<qty>,<variantId>:<qty>
// and open checkout with every item already in it.

const UA = 'Mozilla/5.0 (rabbittoysordering cart helper)';

function parseLink(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const m = u.pathname.match(/\/products\/([^/?#]+)/);
  if (!m) return null;
  return { origin: u.origin, handle: decodeURIComponent(m[1]), variant: u.searchParams.get('variant') || '' };
}

const fixImg = (u) => (typeof u === 'string' && u.startsWith('//') ? 'https:' + u : typeof u === 'string' ? u : '');

async function lookup({ url, qty }) {
  const p = parseLink(url);
  if (!p) return { url, ok: false, error: '唔係 Shopify 商品連結（網址要有 /products/）' };
  const n = Math.max(1, Math.min(99, parseInt(qty, 10) || 1));
  try {
    const r = await fetch(`${p.origin}/products/${encodeURIComponent(p.handle)}.js`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (r.status === 404) return { url, ok: false, error: '店舖搵唔到呢件商品（可能未上架、已下架，或者連結有錯）' };
    if (!r.ok) return { url, ok: false, error: `店舖回覆 ${r.status}（可能唔係 Shopify 商店）` };
    const prod = await r.json();
    const variants = prod.variants || [];
    if (!variants.length) return { url, ok: false, error: '搵唔到款式' };
    const v = variants.find((x) => String(x.id) === p.variant) || variants.find((x) => x.available) || variants[0];
    return {
      url, ok: true, origin: p.origin, qty: n,
      title: prod.title, variantId: v.id,
      image: fixImg((v.featured_image && v.featured_image.src) || prod.featured_image || (prod.images || [])[0] || ''),
      variantTitle: variants.length > 1 ? v.title : '',
      manyVariants: variants.length > 1 && !p.variant,
      available: !!v.available,
      price: typeof v.price === 'number' ? v.price / 100 : null,
    };
  } catch (e) {
    return { url, ok: false, error: '連唔到店舖：' + (e.message || e) };
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
