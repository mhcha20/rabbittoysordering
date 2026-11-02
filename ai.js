// Reads order screenshots with Claude, looks the products up on the web, and returns draft items.
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-opus-5-5';
const STATUSES = ['待確認', '已下單', '已確認', '已發貨', '已到貨', '已取消'];

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
    currency: { type: 'string', enum: ['HKD', 'JPY'] },
    price: { type: 'number', description: 'Unit price' },
    shipping: { type: 'number', description: 'Shipping for this line; put the whole order shipping on the first item only' },
    shipDate: { type: 'string', description: 'Expected ship / arrival date as shown, e.g. 2026-11 中旬' },
    delivery: { type: 'string', description: 'Pickup / delivery method' },
    status: { type: 'string', enum: STATUSES },
    notes: { type: 'string', description: 'Useful details in Traditional Chinese: variant, size, product page URL, anything uncertain' },
    photoUrls: { type: 'array', items: { type: 'string' }, description: 'Direct image URLs (jpg/png/webp) of this exact product, taken from pages you fetched' },
  },
};
const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'summary'],
  properties: {
    items: { type: 'array', items: ITEM_SCHEMA },
    summary: { type: 'string', description: 'One or two sentences in Cantonese/Traditional Chinese for the user: what was found, and anything they should double-check' },
  },
};

const SYSTEM = `You help a collector in Hong Kong record pre-orders of toys and character goods (Precure, Chiikawa, Bandai, etc.).
You receive screenshots of an order (order page, confirmation email, receipt) and must return one entry per distinct product line.

How to work:
1. Read everything visible in the screenshots: shop, order number, dates, item names, quantities, prices, currency, shipping, totals, expected ship/arrival dates, pickup method, payment status.
   Copy order numbers and other long numbers exactly, digit by digit; count the digits and re-read them against the image before answering.
2. Product names in screenshots are often cut off, and some screenshots only show product thumbnails. Use web search and web fetch to identify each product exactly (match by shop, collaboration, thumbnail look, price and date), and find its official name, official price and an official product photo.
   Budget your searches: once a search result points to the official product or collection page (or a news article with product photos), fetch that page straight away rather than searching more. If the official store page cannot be fetched, use a news / press article about the same products instead.
3. For photoUrls, only use image URLs that appear on pages you actually fetched (product page images, og:image, press-release images). Prefer the official shop. Never guess or construct an image URL. If none is found, return an empty list.
4. If per-item prices are not shown, use the official prices you found; if you still cannot tell, split the order total sensibly and say so in notes. Make sure qty x price (+ shipping) adds up to the order total shown, when a total is shown.
5. Map the order state to one of: ${STATUSES.join('、')}. "已付款" / paid but not shipped means 已下單; shipped means 已發貨; picked up / received means 已到貨.
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

async function parseOrder({ images, hint }) {
  const anthropic = getClient();
  const content = [];
  for (const img of images) {
    const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s.exec(img || '');
    if (m) content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
  }
  if (!content.length) { const e = new Error('請上傳至少一張截圖'); e.status = 400; throw e; }
  content.push({ type: 'text', text: `今日日期：${new Date().toISOString().slice(0, 10)}。${hint ? '用戶補充：' + hint : ''}\n請分析以上訂單截圖並找出每件商品的資料同官方圖片。` });

  const messages = [{ role: 'user', content }];
  let response;
  for (let turn = 0; turn < 5; turn++) {
    response = await anthropic.beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: RESULT_SCHEMA } },
      system: SYSTEM,
      tools: [
        { type: 'web_search_20260209', name: 'web_search', max_uses: 12 },
        { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 20 },
      ],
      messages,
    }).finalMessage();
    if (response.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: response.content }); // server resumes the paused tool loop
  }

  if (response.stop_reason === 'refusal') { const e = new Error('AI 未能處理這張截圖，請手動輸入。'); e.status = 422; throw e; }
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let result;
  try { result = JSON.parse(text); } catch {
    const e = new Error(response.stop_reason === 'max_tokens' ? 'AI 回覆太長被截斷，請少啲截圖再試。' : 'AI 回覆格式有誤，請再試一次。');
    e.status = 502; throw e;
  }

  // Keep only photo URLs that really are reachable images.
  for (const item of result.items) {
    const urls = [...new Set((item.photoUrls || []).filter((u) => /^https:\/\//.test(u)))].slice(0, 4);
    const checks = await Promise.all(urls.map(isImage));
    item.photos = urls.filter((_, i) => checks[i]);
    delete item.photoUrls;
  }
  return result;
}

module.exports = { parseOrder };
