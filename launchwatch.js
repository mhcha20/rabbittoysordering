// Launch watch: around a wishlist item's remind time, look at the shop once a minute and, as soon as a product
// with a matching name is on sale, send its direct link on Telegram (for normal Shopify shops also one
// "buy all at once" cart link). It only reads public pages a visitor or search engine would read; adding to the
// cart and paying stay with the user.
const fs = require('fs');
const path = require('path');
const { commonRun, HEADERS } = require('./cart');

const BEFORE = 60 * 60e3; // start watching an hour early (also warms the title cache)
const AFTER = 30 * 60e3;  // keep watching for half an hour after the remind time
const POCKET = 'https://chiikawa-pocket-goods-store.com';
const SOCIAL = /(^|\.)(instagram|threads|x|twitter|facebook|tiktok|youtube|youtu|weibo|xiaohongshu|line)\.(com|net|me|be)$/i;
const hkTimeToMs = (local) => Date.parse(`${local}:00+08:00`);
const get = (u, accept) => fetch(u, { headers: { ...HEADERS, Accept: accept }, redirect: 'follow', signal: AbortSignal.timeout(15000) });

// Names written by people / AI carry Chinese translations in brackets; keep only brackets with Japanese kana.
function normName(s, dropChinese) {
  let t = String(s || '').normalize('NFKC');
  if (dropChinese) t = t.replace(/[(（【\[]([^()（）【】\[\]]*)[)）】\]]/g, (m, inner) => (/[぀-ヿ]/.test(inner) ? inner : ''));
  return t.replace(/[<＜][^>＞]*[>＞]/g, '').replace(/\d{4}年\d{1,2}月(発売|発送)?予定/g, '')
    .replace(/[\s【】「」『』()（）\[\]・･、,.!！?？~〜ー-]/g, (c) => (c === 'ー' ? c : '')).toLowerCase();
}
function matches(wishName, title) {
  const w = normName(wishName, true), t = normName(title, false);
  if (w.length < 4 || t.length < 4) return false;
  const run = commonRun(w, t);
  return run >= 6 && run / t.length >= 0.6 && run / w.length >= 0.6;
}

// The wish already carries this product's own page (e.g. a pre-listed Shopify product).
const handleOf = (u) => { try { return (new URL(u).pathname.match(/\/products\/([^/?#]+)/) || [])[1] || ''; } catch { return ''; } };
const sameProduct = (it, url) => { const h = handleOf(url); return !!h && [it.orderUrl, it.link].some((u) => handleOf(u) === h); };

function createLaunchWatch({ dataDir, getItems, notify }) {
  const file = path.join(dataDir, 'launchwatch.json');
  let state = { titles: {}, sent: {}, shopify: {} };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first run */ }
  const save = () => fs.writeFileSync(file, JSON.stringify(state));

  function watched(now) {
    return getItems().filter((it) => it.kind === 'wish' && it.status === '想買').map((it) => {
      const t = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(it.remindAt || '') ? it.remindAt
        : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(it.deadline || '') ? it.deadline : '';
      const at = t && hkTimeToMs(t);
      if (!at || now < at - BEFORE || now > at + AFTER) return null;
      const text = [it.orderUrl, it.link, it.platform, it.notes].join(' ');
      const shops = new Set();
      if (/chiikawa-pocket-goods-store|ぽけっとグッズストア/.test(text)) shops.add(POCKET);
      for (const u of [it.orderUrl, it.link]) {
        try {
          const o = new URL(u);
          if (o.protocol === 'https:' && !SOCIAL.test(o.hostname) && !o.hostname.includes('chiikawa-pocket-goods-store')) shops.add(o.origin);
        } catch { /* not a URL */ }
      }
      return shops.size ? { it, shops: [...shops] } : null;
    }).filter(Boolean);
  }

  // ちいかわぽけっとグッズストア: its pages are drawn in the browser, but the sitemap lists every product page
  // and each page's <title> carries the product name.
  async function pocketProducts() {
    const r = await get(`${POCKET}/sitemap.xml`, 'application/xml');
    if (!r.ok) throw new Error(`sitemap ${r.status}`);
    const urls = [...new Set([...(await r.text()).matchAll(/<loc>(https:\/\/chiikawa-pocket-goods-store\.com\/products\/[0-9a-f]{16,}\/?)<\/loc>/g)].map((m) => m[1]))];
    const todo = urls.filter((u) => !(u in state.titles)).reverse().slice(0, 15);
    for (const u of todo) {
      try {
        const html = await (await get(u, 'text/html')).text();
        const m = html.match(/<title>([^<]*)<\/title>/);
        state.titles[u] = m ? m[1].replace(/\s*\|\s*【公式】.*$/, '').replace(/&amp;/g, '&').trim() : '';
      } catch { /* try again next minute */ }
    }
    return urls.filter((u) => state.titles[u]).map((u) => ({ url: u, title: state.titles[u], variantId: null, available: null }));
  }

  // A normal Shopify shop publishes its products as JSON.
  async function shopifyProducts(origin) {
    if (state.shopify[origin] === false) return [];
    const r = await get(`${origin}/products.json?limit=250`, 'application/json').catch(() => null);
    const j = r?.ok ? await r.json().catch(() => null) : null;
    if (!j || !Array.isArray(j.products)) { state.shopify[origin] = false; return []; }
    state.shopify[origin] = true;
    return j.products.map((p) => {
      const v = (p.variants || []).find((x) => x.available) || (p.variants || [])[0] || {};
      return { url: `${origin}/products/${p.handle}`, title: p.title, variantId: v.id, available: !!v.available, price: Number(v.price) || null };
    });
  }

  async function check() {
    const now = Date.now();
    const list = watched(now);
    if (!list.length) return;
    const cache = {};
    const productsOf = async (shop) => (cache[shop] ||= (shop === POCKET ? pocketProducts() : shopifyProducts(shop)).catch((e) => { console.error('launchwatch', shop, e.message); return []; }));
    const found = []; // { it, p, shop }
    for (const { it, shops } of list) {
      for (const shop of shops) {
        for (const p of await productsOf(shop)) {
          if (p.available === false || !(sameProduct(it, p.url) || matches(it.name, p.title))) continue;
          const key = `${it.id}|${p.url}`;
          if (state.sent[key]) continue;
          state.sent[key] = now;
          found.push({ it, p, shop });
        }
      }
    }
    for (const [k, t] of Object.entries(state.sent)) if (now - t > 30 * 86400e3) delete state.sent[k];
    save();
    if (!found.length) return;
    const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const lines = found.map(({ p }) => `• <a href="${esc(p.url)}">${esc(p.title)}</a>${p.price ? ` — ¥${Number(p.price).toLocaleString('en-US')}` : ''}`);
    const carts = {};
    for (const { p, shop } of found) if (p.variantId && p.available) (carts[shop] ||= new Set()).add(p.variantId);
    const cartLines = Object.entries(carts).map(([shop, ids]) =>
      `🛒 <a href="${esc(`${shop}/cart/${[...ids].map((id) => `${id}:1`).join(',')}`)}">一次過買 ${ids.size} 件（${esc(new URL(shop).hostname)}）</a>`);
    const pocketNote = found.some((f) => f.shop === POCKET) ? '\n\nちいかわぽけっと：逐條撳入去按「カートに入れる」，再去購物車付款。' : '';
    await notify(`🚀 <b>上架喇！</b>（香港時間 ${new Date(now + 8 * 3600e3).toISOString().slice(11, 16)}）\n\n${lines.join('\n')}${cartLines.length ? '\n\n' + cartLines.join('\n') : ''}${pocketNote}`);
  }

  return {
    start() {
      const tick = () => check().catch((e) => console.error('launchwatch:', e.message));
      setInterval(tick, 60e3).unref();
      tick();
    },
    check, matches,
  };
}

module.exports = { createLaunchWatch, matches };
