// Telegram reminders: "time to order" alerts (15 min before + at remindAt) and a 9:00 HKT heads-up the day before a deadline.
// Setup: create a bot with @BotFather, put its token in TELEGRAM_BOT_TOKEN, then send /start to the bot —
// the first chat that does so is remembered (or set TELEGRAM_CHAT_ID explicitly).
const fs = require('fs');
const path = require('path');

const HK_OFFSET = 8 * 3600e3;
const hkNow = () => new Date(Date.now() + HK_OFFSET); // read with getUTC* to get Hong Kong wall-clock values
const hkDate = (d = hkNow()) => d.toISOString().slice(0, 10);
const hkTimeToMs = (local) => Date.parse(`${local}:00+08:00`); // "YYYY-MM-DDTHH:MM" in Hong Kong time

function createTelegram({ dataDir, getItems, publicUrl }) {
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const stateFile = path.join(dataDir, 'telegram.json');
  let state = { chatId: process.env.TELEGRAM_CHAT_ID || '', sent: {}, offset: 0 };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch { /* first run */ }
  if (process.env.TELEGRAM_CHAT_ID) state.chatId = process.env.TELEGRAM_CHAT_ID;
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));

  async function call(method, body) {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(j.description || `Telegram ${method} failed (${r.status})`);
    return j.result;
  }
  const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const send = (text, chatId = state.chatId) => call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });

  function itemLine(it) {
    const price = it.price ? ` — ${it.currency} ${Number(it.price).toLocaleString('en-US')}` : '';
    const links = [it.orderUrl && `<a href="${esc(it.orderUrl)}">🛒 預訂頁</a>`, it.link && `<a href="${esc(it.link)}">🔗 原帖</a>`].filter(Boolean).join('  ');
    return `• <b>${esc(it.name)}</b>${esc(price)}\n  ${esc(it.platform || '')}${links ? '\n  ' + links : ''}`;
  }

  // Remember the chat of whoever sends /start (only while no chat is linked yet).
  async function pollForChat() {
    if (state.chatId) return;
    const updates = await call('getUpdates', { offset: state.offset, timeout: 0, allowed_updates: ['message'] });
    for (const u of updates) {
      state.offset = u.update_id + 1;
      const chat = u.message?.chat;
      if (chat && !state.chatId) {
        state.chatId = String(chat.id);
        await send('✅ 已連接「預訂商品記錄」。夠鐘預訂同截止前一日都會喺度通知你。');
      }
    }
    save();
  }

  async function check() {
    if (!state.chatId) return;
    const now = Date.now();
    const items = getItems().filter((it) => it.status !== '已取消' && it.status !== '已放棄' && it.status !== '已收貨');
    const due = { soon: [], now: [], tomorrow: [] };
    for (const it of items) {
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(it.remindAt || '')) {
        const at = hkTimeToMs(it.remindAt);
        const key = `${it.id}|${it.remindAt}`;
        if (now >= at - 15 * 60e3 && now < at && !state.sent[`soon|${key}`]) { due.soon.push(it); state.sent[`soon|${key}`] = now; }
        if (now >= at && now < at + 6 * 3600e3 && !state.sent[`now|${key}`]) { due.now.push(it); state.sent[`now|${key}`] = now; }
      }
      // day-before heads-up for wishlist deadlines, sent from 09:00 Hong Kong time
      const tomorrow = hkDate(new Date(hkNow().getTime() + 86400e3));
      if (it.kind === 'wish' && (it.deadline || '').slice(0, 10) === tomorrow && hkNow().getUTCHours() >= 9 && !state.sent[`eve|${it.id}|${tomorrow}`]) {
        due.tomorrow.push(it); state.sent[`eve|${it.id}|${tomorrow}`] = now;
      }
    }
    const hhmm = (it) => it.remindAt.slice(11);
    if (due.soon.length) await send(`⏳ <b>快夠鐘預訂</b>（香港時間 ${hhmm(due.soon[0])}）\n\n${due.soon.map(itemLine).join('\n\n')}`);
    if (due.now.length) await send(`⏰ <b>夠鐘預訂喇！</b>\n\n${due.now.map(itemLine).join('\n\n')}`);
    if (due.tomorrow.length) await send(`📅 <b>聽日截止／開賣</b>\n\n${due.tomorrow.map(itemLine).join('\n\n')}\n\n<a href="${esc(publicUrl)}">打開網站</a>`);
    if (due.soon.length || due.now.length || due.tomorrow.length) {
      // forget old entries so the file stays small
      for (const [k, t] of Object.entries(state.sent)) if (now - t > 30 * 86400e3) delete state.sent[k];
      save();
    }
  }

  function start() {
    if (!token) { console.log('telegram: TELEGRAM_BOT_TOKEN not set, reminders off'); return; }
    const tick = () => pollForChat().then(check).catch((e) => console.error('telegram:', e.message));
    tick();
    setInterval(tick, 60e3).unref();
    console.log(`telegram: reminders on${state.chatId ? '' : ' (waiting for /start)'}`);
  }

  return {
    start,
    status: () => ({ configured: !!token, linked: !!state.chatId }),
    async test() {
      if (!token) throw Object.assign(new Error('未設定 TELEGRAM_BOT_TOKEN'), { status: 503 });
      if (!state.chatId) await pollForChat();
      if (!state.chatId) throw Object.assign(new Error('Bot 未連接：請喺 Telegram 打開你個 bot 撳「開始」（或者傳 /start），再試一次。'), { status: 409 });
      await send('🔔 測試通知：Telegram 提醒運作正常。');
      return { ok: true };
    },
  };
}

module.exports = { createTelegram };
