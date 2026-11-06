// Uses Claude (with web search/fetch) to turn order screenshots, or a link to a product post, into draft items.
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-opus-5-5';
const XAI_MODEL = process.env.XAI_MODEL || 'grok-4.7';
const STATUSES = ['待確認', '已下單', '已確認', '已發貨', '已收貨', '已取消'];
const CURRENCIES = ['HKD', 'JPY', 'CNY', 'TWD', 'USD'];

const ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'platform', 'orderNo', 'orderDate', 'qty', 'currency', 'price', 'shipping', 'shipDate', 'delivery', 'status', 'notes', 'photoUrls', 'orderUrl'],
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
    orderUrl: { type: 'string', description: 'URL of the page where this exact product is (or was) ordered / pre-ordered: the official shop or the shop in the screenshot, empty if not found' },
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
  required: ['name', 'platform', 'currency', 'price', 'shipDate', 'deadline', 'notes', 'photoUrls', 'orderUrl', 'remindAt'],
  properties: {
    name: { type: 'string', description: 'Official product name (keep original Japanese, add Chinese in brackets if helpful)' },
    platform: { type: 'string', description: 'Where it can be pre-ordered (official shop / store), or the maker if unknown' },
    currency: { type: 'string', enum: CURRENCIES },
    price: { type: 'number', description: 'Official retail price incl. tax, 0 if unknown' },
    shipDate: { type: 'string', description: 'Release / shipping date as announced, e.g. 2027年3月, or empty' },
    deadline: { type: 'string', description: 'Pre-order / lottery deadline in Hong Kong time: YYYY-MM-DDTHH:MM when the time is known, else YYYY-MM-DD; empty if none / unknown' },
    notes: { type: 'string', description: 'Traditional Chinese: what it is, variants, pre-order period and how/where to order, official page URL, anything uncertain' },
    orderUrl: { type: 'string', description: 'URL of the page where this exact product is (or was) ordered / pre-ordered: the official shop or the shop in the screenshot, empty if not found' },
    remindAt: { type: 'string', description: 'Hong Kong local date-time YYYY-MM-DDTHH:MM when the user should act (pre-order / sale / lottery opens), only if that moment is still in the future; otherwise empty' },
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
5. Write notes and summary in Traditional Chinese (Hong Kong). Mention anything you are unsure about so the user can check it.
6. The user lives in Hong Kong (HKT, UTC+8). Convert every date-time you write (deadlines, sale start times, lottery periods) to Hong Kong time and show the original next to it, e.g. 「香港時間 10:00（日本 11:00）」. Japan (JST) is 1 hour ahead of Hong Kong; check the time zone of other sources. If a time converts across midnight, use the Hong Kong date (also for deadline).
   A sale that starts at a fixed time (first come, first served) with no pre-order period: put the sale start (Hong Kong date and time) in deadline and in remindAt so the user gets a countdown and an alert, and say so in notes.`;

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
6. Write notes and summary in Traditional Chinese (Hong Kong). Mention anything you are unsure about so the user can check it.
7. The user lives in Hong Kong (HKT, UTC+8). Convert every date-time you write (deadlines, sale start times, lottery periods) to Hong Kong time and show the original next to it, e.g. 「香港時間 10:00（日本 11:00）」. Japan (JST) is 1 hour ahead of Hong Kong; check the time zone of other sources. If a time converts across midnight, use the Hong Kong date (also for deadline).`;

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

function creditExhausted(err) {
  const msg = `${err?.status || ''} ${err?.message || ''} ${err?.error?.message || ''}`;
  return /credit balance is too low/i.test(msg)
    || /purchase credits/i.test(msg)
    || /insufficient(?:\s+\w+){0,3}\s+credits?/i.test(msg);
}

// xAI image input is jpeg/png only. Screenshots are already jpeg; skip anything else.
function xaiInput(content) {
  const parts = [];
  let text = '';
  let skipped = 0;
  for (const block of content || []) {
    if (block.type === 'text') { text += (text ? '\n' : '') + block.text; continue; }
    if (block.type !== 'image' || !block.source?.data) continue;
    const mt = block.source.media_type === 'image/jpg' ? 'image/jpeg' : block.source.media_type;
    if (mt !== 'image/jpeg' && mt !== 'image/png') { skipped += 1; continue; }
    parts.push({ type: 'input_image', image_url: `data:${mt};base64,${block.source.data}`, detail: 'high' });
  }
  if (skipped) text += `\n（有 ${skipped} 張圖格式 xAI 唔支援，只得 jpeg/png，已略過。）`;
  parts.push({ type: 'input_text', text: text || '請根據指示回覆。' });
  return parts;
}

function messageTexts(data) {
  const chunks = [];
  for (const item of data?.output || []) {
    if (item.type && item.type !== 'message') continue;
    for (const c of item.content || []) {
      if ((c.type === 'output_text' || c.type === 'text') && typeof c.text === 'string' && c.text.trim()) chunks.push(c.text);
    }
  }
  if (!chunks.length && typeof data?.output_text === 'string') chunks.push(data.output_text);
  return chunks;
}

function extractOutputText(data) {
  const chunks = messageTexts(data);
  for (let i = chunks.length - 1; i >= 0; i--) {
    const t = chunks[i].trim();
    if (t.includes('"items"') || t.startsWith('{') || t.startsWith('```')) return t;
  }
  return chunks.join('\n').trim();
}

// First-to-last brace slice breaks when the model (or citations) adds text after a finished JSON object.
function balancedObjects(raw) {
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}' && depth) {
      depth--;
      if (depth === 0 && start >= 0) out.push(raw.slice(start, i + 1));
    }
  }
  return out;
}

function parseJsonLoose(text) {
  const raw = String(text || '').trim();
  const tryParse = (s) => {
    try {
      const v = JSON.parse(s);
      if (v && Array.isArray(v.items)) return v;
    } catch { /* next candidate */ }
    return null;
  };
  let hit = tryParse(raw);
  if (hit) return hit;
  for (const block of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    hit = tryParse(block[1]);
    if (hit) return hit;
  }
  const objs = balancedObjects(raw);
  for (let i = objs.length - 1; i >= 0; i--) {
    hit = tryParse(objs[i]);
    if (hit) return hit;
  }
  console.error('xAI reply was not usable JSON, length', raw.length);
  throw fail(502, 'xAI 回覆格式有誤，請再試一次。');
}

async function callXai({ instructions, input, schema, effort, maxOutput, search }) {
  const key = process.env.XAI_API_KEY;
  if (!key) {
    throw fail(503, process.env.ANTHROPIC_API_KEY
      ? 'Anthropic 餘額已經用晒。請確認 Railway 有 XAI_API_KEY，先可以用 xAI 做後備。'
      : '未設定 ANTHROPIC_API_KEY 或 XAI_API_KEY。');
  }
  const body = {
    model: XAI_MODEL,
    instructions,
    input,
    store: false,
    reasoning: { effort },
    max_output_tokens: maxOutput,
  };
  if (search) body.tools = [{ type: 'web_search', enable_image_search: true, enable_image_understanding: true }];
  if (schema) {
    body.text = { format: { type: 'json_schema', name: 'parse_result', schema: resultSchema(schema), strict: true } };
  }
  const r = await fetch('https://api.x.ai/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  const raw = await r.text();
  if (!r.ok) {
    let detail = raw.slice(0, 300);
    try { detail = JSON.parse(raw).error?.message || JSON.parse(raw).error || detail; } catch { /* keep slice */ }
    throw Object.assign(fail(502, `xAI 後備失敗（${r.status}）：${detail}`), { upstream: r.status });
  }
  try { return JSON.parse(raw); } catch { throw fail(502, 'xAI 回覆唔係 JSON。'); }
}

async function runGrok({ system, schema, content }) {
  const instructions = system + '\n\nYou are the backup model because Anthropic credits are exhausted. Use web search and open the official product page. photoUrls must be direct photographs of the product itself (shop CDN, official page, or image-search results). Never use the user\'s order screenshot, a receipt, a logo, or an icon. Never invent a URL.';
  const input = [{ role: 'user', content: xaiInput(content) }];
  let data;
  try {
    data = await callXai({ instructions, input, schema, effort: 'medium', maxOutput: 8000, search: true });
  } catch (err) {
    if (err.upstream !== 400) throw err;
    console.error('xAI rejected structured output, retrying as plain JSON');
    data = await callXai({
      instructions: instructions + '\nReturn one JSON object only, no markdown, matching this schema:\n' + JSON.stringify(resultSchema(schema)),
      input, schema: null, effort: 'medium', maxOutput: 8000, search: true,
    });
  }
  const result = parseJsonLoose(extractOutputText(data));
  if (!Array.isArray(result.items)) throw fail(502, 'xAI 回覆缺少商品資料。');
  result.summary = '（Anthropic 餘額用晒，已改用 xAI）' + (result.summary || '');
  return result;
}

async function runAI(opts) {
  if (process.env.ANTHROPIC_API_KEY) {
    try { return await runClaude(opts); }
    catch (err) {
      if (!creditExhausted(err)) throw err;
      console.error('Anthropic credits exhausted, falling back to xAI');
    }
  }
  return runGrok(opts);
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

const IMG_URL = /https:\/\/[^\s"'<>\\)]+?\.(?:jpe?g|png|webp)(?:\?[^\s"'<>\\)]*)?/gi;
function likelyProductImage(url) {
  const u = String(url || '').toLowerCase();
  if (!u.startsWith('https://')) return false;
  if (/(logo|icon|sprite|favicon|pixel|badge|payment|visa|banner|header|footer|avatar|emoji|button)/.test(u)) return false;
  if (/(16x16|32x32|48x48|1x1)/.test(u)) return false;
  return true;
}
function collectImageUrls(text) {
  return [...new Set(String(text || '').match(IMG_URL) || [])].filter(likelyProductImage);
}
function imageScore(url) {
  const u = url.toLowerCase();
  let s = 0;
  if (/cdn\.shopify|\/cdn\/shop\/|\/products\/|product/.test(u)) s += 3;
  if (/\.(jpe?g|png|webp)(\?|$)/.test(u)) s += 1;
  return s;
}
async function pageImages(url) {
  if (!/^https:\/\//.test(url || '')) return [];
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ja,zh-HK;q=0.8,en;q=0.6' } });
    if (!r.ok) return [];
    const html = (await r.text()).slice(0, 1_500_000);
    return collectImageUrls(html).sort((a, b) => imageScore(b) - imageScore(a)).slice(0, 6);
  } catch { return []; }
}

// The card should show the product, not the order screenshot. Look the photo up when the first pass found none.
async function searchOfficialPhotos(items) {
  if (!process.env.XAI_API_KEY || !items.length) return;
  const lines = items.map((it, i) => `${i + 1}. ${it.name} | ${it.platform || ''} | ${it.orderUrl || ''}`).join('\n');
  let data;
  try {
    data = await callXai({
      instructions: 'Find the official product photo for each numbered item. Use web search. Return JSON only, matching the schema. urls must be direct https image files of that exact product from the shop or maker. Never return an order-page screenshot, a logo, an icon, or a URL you did not see.',
      input: lines,
      schema: {
        type: 'object', additionalProperties: false, required: ['n', 'urls'],
        properties: { n: { type: 'integer' }, urls: { type: 'array', items: { type: 'string' } } },
      },
      effort: 'low', maxOutput: 2000, search: true,
    });
  } catch (e) {
    console.error('official photo search', e.message);
    return;
  }
  let grouped = null;
  try { grouped = parseJsonLoose(extractOutputText(data)); } catch { grouped = null; }
  const byN = new Map();
  for (const row of grouped?.items || []) {
    if (row && row.n) byN.set(Number(row.n), row.urls || row.photoUrls || []);
  }
  for (let i = 0; i < items.length; i++) {
    const urls = [...new Set((byN.get(i + 1) || []).filter(likelyProductImage))].slice(0, 4);
    const checks = await Promise.all(urls.map(isImage));
    const ok = urls.filter((_, j) => checks[j]);
    if (ok.length) items[i].photos = ok.slice(0, 3);
  }
}

async function ensureOfficialPhotos(result) {
  for (const item of result.items) {
    const urls = [...new Set([...(item.photos || []), ...await pageImages(item.orderUrl)])]
      .filter(likelyProductImage)
      .sort((a, b) => imageScore(b) - imageScore(a))
      .slice(0, 6);
    const checks = await Promise.all(urls.map(isImage));
    item.photos = urls.filter((_, i) => checks[i]).slice(0, 3);
  }
  const missing = result.items.filter((it) => !(it.photos || []).length);
  if (missing.length) await searchOfficialPhotos(missing);
  return result;
}

async function findOfficialPhotos({ name, platform, orderUrl }) {
  const item = { name: String(name || '').slice(0, 300), platform: String(platform || '').slice(0, 120), orderUrl: /^https?:\/\//.test(orderUrl || '') ? String(orderUrl).slice(0, 2000) : '', photos: [] };
  if (!item.name) throw fail(400, '未有商品名稱');
  await ensureOfficialPhotos({ items: [item] });
  if (!item.photos.length) throw fail(404, '搵唔到呢件商品嘅官方圖，可以自己上傳。');
  return { photos: item.photos };
}

async function parseOrder({ images, hint }) {
  const content = imageBlocks(images);
  if (!content.length) throw fail(400, '請上傳至少一張截圖');
  content.push({ type: 'text', text: `今日日期：${new Date().toISOString().slice(0, 10)}。${hint ? '用戶補充：' + hint : ''}\n請分析以上訂單截圖並找出每件商品的資料同官方圖片。` });
  const result = await ensureOfficialPhotos(await checkPhotos(await runAI({ system: SYSTEM, schema: ITEM_SCHEMA, content })));
  for (const item of result.items) item.kind = 'order';
  return result;
}

async function parseWish({ link, images, hint }) {
  if (!/^https?:\/\//.test(link || '') && !(images || []).length) throw fail(400, '請貼上連結或者上傳截圖');
  const preview = link ? await linkPreview(link) : {};
  // The post's own picture usually shows the product even when the page itself needs a login: let Claude see it.
  const postImage = preview.image ? await toDataUrl(preview.image) : null;
  const content = imageBlocks(postImage && postImage.length < 5_000_000 ? [postImage, ...(images || [])] : images);
  content.push({ type: 'text', text: [
    `今日日期：${new Date().toISOString().slice(0, 10)}。`,
    link ? `連結：${link}` : '',
    preview.title || preview.description ? `連結預覽 — 標題：${preview.title || '（無）'}\n內容：${preview.description || '（無）'}` : '連結預覽：攞唔到（可能要登入）。',
    postImage ? '第一張圖係帖文本身嘅圖（由連結預覽攞到），請睇圖認出商品（包裝、角色、品牌、文字）。' : '',
    hint ? `用戶補充：${hint}` : '',
    '請搵出呢個帖文介紹嘅商品資料（官方名稱、價錢、預訂截止、發售日、喺邊度預訂）同官方圖片。',
  ].filter(Boolean).join('\n') });
  const result = await ensureOfficialPhotos(await checkPhotos(await runAI({ system: WISH_SYSTEM, schema: WISH_SCHEMA, content })));
  for (const item of result.items) {
    Object.assign(item, { kind: 'wish', status: '想買', link: link || '', qty: 1, shipping: 0 });
    if (postImage) item.photos.push(postImage); // the post's own picture as a fallback / extra
  }
  return result;
}

// Answer a free-text question from Telegram using the user's own records.
const QA_SYSTEM = `You answer questions on Telegram about a Hong Kong collector's toy orders and pre-order wishlist, using only the records given.
Reply in Cantonese (Traditional Chinese, Hong Kong), short and friendly, plain text (no Markdown, no HTML), suitable for a phone chat.
Times are Hong Kong time. Cancelled (已取消) and abandoned (已放棄) items only count if the question is about them. If the records don't answer the question, say so.`;

function questionRecords(items) {
  return items.map((it) => ({
    種類: it.kind === 'wish' ? '想預訂' : '訂單', 狀態: it.status, 商品: it.name, 店舖: it.platform, 訂單編號: it.orderNo || undefined,
    下單日期: it.orderDate || undefined, 數量: it.qty, 幣別: it.currency, 單價: it.price, 運費: it.shipping || undefined,
    預計發貨或發售: it.shipDate || undefined, 預訂截止: it.deadline || undefined, 提醒時間HKT: it.remindAt || undefined,
    取貨: it.delivery || undefined, 收貨日期: it.receivedAt || undefined, 預訂頁: it.orderUrl || undefined,
    備註: it.notes ? it.notes.slice(0, 300) : undefined,
  }));
}

async function answerWithClaude(question, records, now) {
  const anthropic = getClient();
  const response = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low' },
    system: QA_SYSTEM,
    messages: [{ role: 'user', content: [
      { type: 'text', text: `而家香港時間：${now}\n\n我嘅記錄（JSON）：\n${JSON.stringify(records)}` },
      { type: 'text', text: `問題：${question}` },
    ] }],
  });
  if (response.stop_reason === 'refusal') throw fail(422, 'AI 未能回答呢條問題');
  return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim() || '（冇答案）';
}

async function answerWithGrok(question, records, now) {
  const data = await callXai({
    instructions: QA_SYSTEM,
    input: `而家香港時間：${now}\n\n我嘅記錄（JSON）：\n${JSON.stringify(records)}\n\n問題：${question}`,
    effort: 'low',
    maxOutput: 1200,
    search: false,
  });
  return extractOutputText(data).trim() || '（冇答案）';
}

async function answerQuestion(question, items) {
  const records = questionRecords(items);
  const now = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
  if (process.env.ANTHROPIC_API_KEY) {
    try { return await answerWithClaude(question, records, now); }
    catch (err) {
      if (!creditExhausted(err)) throw err;
      console.error('Anthropic credits exhausted, falling back to xAI');
    }
  }
  return '（已改用 xAI）' + await answerWithGrok(question, records, now);
}

module.exports = { parseOrder, parseWish, answerQuestion, findOfficialPhotos };
