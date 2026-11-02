// Uses Claude (with web search/fetch) to turn order screenshots, or a link to a product post, into draft items.
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-opus-5-5';
const STATUSES = ['待確認', '已下單', '已確認', '已發貨', '已收貨', '已取消'];
const CURRENCIES = ['HKD', 'JPY', 'CNY', 'TWD', 'USD'];

const ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'platform', 'orderNo', 'orderDate', 'qty', 'currency', 'price', 'shipping', 'shipDate', 'delivery', 'status', 'notes', 'photoUrls'],
  properties: {
    name: { type: 'string', description: 'Full product name, official name if found (keep original Japanese, add Chinese in brackets if helpful)' },
    platform: { type: 'string', description: 'Shop / platform name, e.g. GU, Premium Bandai, ちいかわマーケット' },
    orderNo: { type: 'string' },
    orderDate: { type: 'string', description: 'YYYY-MM-DD, or empty' },
    qty: { type: 'integer' },
    currency: { type: 'string', enum: CURRENCIES },
    price: { type: 'number', description: 'Unit price' },
    shipping: { type: 'number', description: 'Shipping for this line; put the whole order shipping on the first item only' },
    shipDate: { type: 'string', description: 'Expected ship / arrival date as shown, e.g. 2026-11 中旬' },
    delivery: { type: 'string', description: 'Pickup / delivery method' },
    status: { type: 'string', enum: STATUSES },
    notes: { type: 'string', description: 'Useful details in Traditional Chinese: variant, size, product page URL, anything uncertain' },
    photoUrls: { type: 'array', items: { type: 'string' }, description: 'Direct image URLs (jpg/png/webp) of this exact product, taken from pages you fetched' },
  },
};
const resultSchema = (itemSchema) => ({
  type: 'object',
  additionalProperties: false,
  required: ['items', 'summary'],
  properties: {
    items: { type: 'array', items: itemSchema },
    summary: { type: 'string', description: 'One or two sentences in Cantonese/Traditional Chinese for the user: what was found, and anything they should double-check' },
  },
});

const WISH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'platform', 'currency', 'price', 'shipDate', 'deadline', 'notes', 'photoUrls'],
  properties: {
    name: { type: 'string', description: 'Official product name (keep original Japanese, add Chinese in brackets if helpful)' },
    platform: { type: 'string', description: 'Where it can be pre-ordered (official shop / store), or the maker if unknown' },
    currency: { type: 'string', enum: CURRENCIES },
    price: { type: 'number', description: 'Official retail price incl. tax, 0 if unknown' },
    shipDate: { type: 'string', description: 'Release / shipping date as announced, e.g. 2027年3月, or empty' },
    deadline: { type: 'string', description: 'Pre-order deadline as YYYY-MM-DD (add time in notes), or empty if none / unknown' },
    notes: { type: 'string', description: 'Traditional Chinese: what it is, variants, pre-order period and how/where to order, official page URL, anything uncertain' },
    photoUrls: { type: 'array', items: { type: 'string' }, description: 'Direct image URLs (jpg/png/webp) of this exact product, taken from pages you fetched' },
  },
};

const WISH_SYSTEM = `You help a collector in Hong Kong keep a wishlist of toys and character goods they are thinking of pre-ordering (Precure, Chiikawa, Bandai, etc.).
The user gives you a link (often an Instagram / X / Threads post by a shop or maker announcing a product), sometimes with screenshots of the post, plus whatever the link preview shows.

How to work:
1. Fetch the link first. Social media pages often need a login; if the fetch fails or shows no post text, use the link preview text and screenshots provided instead.
2. Identify the product(s) announced, then use web search and web fetch to find the official page: official name, maker, retail price and currency, pre-order period / deadline, release or shipping date, where to pre-order, and official product photos.
   Budget your searches: once a result points to the official product page (or a news / press article with product photos), fetch it straight away.
3. Return one entry per product the user could pre-order. If a post covers a whole line-up of many small variants (more than 6), group them into one entry and list the variants in notes.
4. For photoUrls, only use image URLs that appear on pages you actually fetched (official page images, og:image, press-release images). Never guess or construct an image URL.
5. Write notes and summary in Traditional Chinese (Hong Kong). Mention anything you are unsure about so the user can check it.`;

const SYSTEM = `You help a collector in Hong Kong record pre-orders of toys and character goods (Precure, Chiikawa, Bandai, etc.).
You receive screenshots of an order (order page, confirmation email, receipt) and must return one entry per distinct product line.

How to work:
1. Read everything visible in the screenshots: shop, order number, dates, item names, quantities, prices, currency, shipping, totals, expected ship/arrival dates, pickup method, payment status.
   Copy order numbers and other long numbers exactly, digit by digit; count the digits and re-read them against the image before answering.
2. Product names in screenshots are often cut off, and some screenshots only show product thumbnails. Use web search and web fetch to identify each product exactly (match by shop, collaboration, thumbnail look, price and date), and find its official name, official price and an official product photo.
   Budget your searches: once a search result points to the official product or collection page (or a news article with product photos), fetch that page straight away rather than searching more. If the official store page cannot be fetched, use a news / press article about the same products instead.
3. For photoUrls, only use image URLs that appear on pages you actually fetched (product page images, og:image, press-release images). Prefer the official shop. Never guess or construct an image URL. If none is found, return an empty list.
4. If per-item prices are not shown, use the official prices you found; if you still cannot tell, split the order total sensibly and say so in notes. Make sure qty x price (+ shipping) adds up to the order total shown, when a total is shown.
5. Map the order state to one of: ${STATUSES.join('、')}. "已付款" / paid but not shipped means 已下單; shipped means 已發貨; picked up / received means 已收貨.
6. Write notes and summary in Traditional Chinese (Hong Kong). Mention anything you are unsure about so the user can check it.`;

let client;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error('未設定 ANTHROPIC_API_KEY：請在 Railway 的 web 服務加入這個變數。');
    err.status = 503;
    throw err;
  }
  client ||= new Anthropic();
  return client;
}

async function isImage(url) {
  try {
    const r = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0' } });
    const ok = r.ok && (r.headers.get('content-type') || '').startsWith('image/');
    r.body?.cancel();
    return ok;
  } catch { return false; }
}

const fail = (status, message) => Object.assign(new Error(message), { status });

function imageBlocks(images) {
  const blocks = [];
  for (const img of images || []) {
    const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s.exec(img || '');
    if (m) blocks.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
  }
  return blocks;
}

// Plain link preview (og: tags), so there is something to go on even when the page itself needs a login.
async function linkPreview(url) {
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'RabbitToysOrdering/1.0 (link preview)', 'Accept-Language': 'zh-HK,ja;q=0.8,en;q=0.6' } });
    if (!r.ok) return {};
    const html = (await r.text()).slice(0, 2_000_000);
    const meta = (prop) => {
      const m = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i').exec(html);
      const c = m && /content=["']([^"']*)["']/i.exec(m[0]);
      return c ? c[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '';
    };
    const title = meta('og:title') || (/<title[^>]*>([^<]*)/i.exec(html) || [])[1] || '';
    return { title: title.trim(), description: (meta('og:description') || meta('description')).trim(), image: meta('og:image') };
  } catch { return {}; }
}

// Social-media image links expire after a while, so keep a copy (stored as a file when the item is saved).
async function toDataUrl(url) {
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
    const type = r.headers.get('content-type') || '';
    if (!r.ok || !/^image\/(png|jpeg|webp|gif)/.test(type)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length < 8_000_000 ? `data:${type.split(';')[0]};base64,${buf.toString('base64')}` : null;
  } catch { return null; }
}

async function runClaude({ system, schema, content }) {
  const anthropic = getClient();
  const messages = [{ role: 'user', content }];
  let response;
  for (let turn = 0; turn < 5; turn++) {
    response = await anthropic.beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: resultSchema(schema) } },
      system,
      tools: [
        { type: 'web_search_20260209', name: 'web_search', max_uses: 12 },
        { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 20 },
      ],
      messages,
    }).finalMessage();
    if (response.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: response.content }); // server resumes the paused tool loop
  }

  if (response.stop_reason === 'refusal') throw fail(422, 'AI 未能處理呢個請求，請手動輸入。');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let result;
  try { result = JSON.parse(text); } catch {
    throw fail(502, response.stop_reason === 'max_tokens' ? 'AI 回覆太長被截斷，請少啲截圖再試。' : 'AI 回覆格式有誤，請再試一次。');
  }
  return result;
}

async function checkPhotos(result) {
  // Keep only photo URLs that really are reachable images.
  for (const item of result.items) {
    const urls = [...new Set((item.photoUrls || []).filter((u) => /^https:\/\//.test(u)))].slice(0, 4);
    const checks = await Promise.all(urls.map(isImage));
    item.photos = urls.filter((_, i) => checks[i]);
    delete item.photoUrls;
  }
  return result;
}

async function parseOrder({ images, hint }) {
  const content = imageBlocks(images);
  if (!content.length) throw fail(400, '請上傳至少一張截圖');
  content.push({ type: 'text', text: `今日日期：${new Date().toISOString().slice(0, 10)}。${hint ? '用戶補充：' + hint : ''}\n請分析以上訂單截圖並找出每件商品的資料同官方圖片。` });
  const result = await checkPhotos(await runClaude({ system: SYSTEM, schema: ITEM_SCHEMA, content }));
  for (const item of result.items) item.kind = 'order';
  return result;
}

async function parseWish({ link, images, hint }) {
  if (!/^https?:\/\//.test(link || '') && !(images || []).length) throw fail(400, '請貼上連結或者上傳截圖');
  const preview = link ? await linkPreview(link) : {};
  const content = imageBlocks(images);
  content.push({ type: 'text', text: [
    `今日日期：${new Date().toISOString().slice(0, 10)}。`,
    link ? `連結：${link}` : '',
    preview.title || preview.description ? `連結預覽 — 標題：${preview.title || '（無）'}\n內容：${preview.description || '（無）'}` : '連結預覽：攞唔到（可能要登入）。',
    hint ? `用戶補充：${hint}` : '',
    '請搵出呢個帖文介紹嘅商品資料（官方名稱、價錢、預訂截止、發售日、喺邊度預訂）同官方圖片。',
  ].filter(Boolean).join('\n') });
  const result = await checkPhotos(await runClaude({ system: WISH_SYSTEM, schema: WISH_SCHEMA, content }));
  const postImage = preview.image ? await toDataUrl(preview.image) : null;
  for (const item of result.items) {
    Object.assign(item, { kind: 'wish', status: '想買', link: link || '', qty: 1, shipping: 0 });
    if (postImage) item.photos.push(postImage); // the post's own picture as a fallback / extra
  }
  return result;
}

module.exports = { parseOrder, parseWish };
