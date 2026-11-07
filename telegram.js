// Telegram reminders: "time to order" alerts (15 min before + at remindAt) and a 9:00 HKT heads-up the day before a deadline.
// Setup: create a bot with @BotFather, put its token in TELEGRAM_BOT_TOKEN, then send /start to the bot —
// the first chat that does so is remembered (or set TELEGRAM_CHAT_ID explicitly).
const fs = require('fs');
const path = require('path');

const HK_OFFSET = 8 * 3600e3;
const hkNow = () => new Date(Date.now() + HK_OFFSET); // read with getUTC* to get Hong Kong wall-clock values
const hkDate = (d = hkNow()) => d.toISOString().slice(0, 10);
const hkTimeToMs = (local) => Date.parse(`${local}:00+08:00`); // "YYYY-MM-DDTHH:MM" in Hong Kong time

function createTelegram({ dataDir, getItems, publicUrl, ask }) {
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const stateFile = path.join(dataDir, 'telegram.json');
  let state = { chatId: process.env.TELEGRAM_CHAT_ID || '', sent: {}, offset: 0 };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch { /* first run */ }
  if (process.env.TELEGRAM_CHAT_ID) state.chatId = process.env.TELEGRAM_CHAT_ID;
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));

  async function call(method, body, timeoutMs = 15000) {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
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
    return `• <b>${esc(it.name)}</b>${esc(price)}${it.platform ? '\n  ' + esc(it.platform) : ''}${links ? '\n  ' + links : ''}`;
  }

  // ---------- answering messages ----------
  const live = () => getItems().filter((it) => !['已取消', '已放棄', '搶唔到', '已收貨'].includes(it.status));
  // When does the user next need to act on a wishlist item? (remind time, else deadline at 23:59)
  function nextAction(it) {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(it.remindAt || '')) return { at: hkTimeToMs(it.remindAt), label: `⏰ ${it.remindAt.slice(5, 10).replace('-', '/')} ${it.remindAt.slice(11)}` };
    if (/^\d{4}-\d{2}-\d{2}/.test(it.deadline || '')) {
      const t = it.deadline.slice(11, 16);
      return { at: hkTimeToMs(`${it.deadline.slice(0, 10)}T${t || '23:59'}`), label: `📅 ${it.deadline.slice(5, 10).replace('-', '/')}${t ? ' ' + t : ''} 截止` };
    }
    return null;
  }
  function countdown(ms) {
    const m = Math.max(0, Math.round(ms / 60e3)), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
    return d ? `${d} 日 ${h} 個鐘後` : h ? `${h} 個鐘 ${m % 60} 分鐘後` : `${m} 分鐘後`;
  }
  function replyNext(limit = 5) {
    const now = Date.now();
    const upcoming = live().filter((it) => it.kind === 'wish').map((it) => ({ it, a: nextAction(it) }))
      .filter((x) => x.a && x.a.at > now).sort((x, y) => x.a.at - y.a.at);
    if (!upcoming.length) return '暫時冇排咗時間嘅預訂 🙂\n（喺網站「💭 想預訂」幫商品設「提醒時間」或「預訂截止」就會出現喺度）';
    const groups = [];
    for (const x of upcoming) {
      const g = groups.find((g) => g.label === x.a.label);
      if (g) g.items.push(x.it); else groups.push({ label: x.a.label, at: x.a.at, items: [x.it] });
    }
    return `<b>最近要預訂</b>（香港時間）\n\n` + groups.slice(0, limit).map((g) =>
      `<b>${esc(g.label)}</b>（${countdown(g.at - now)}）\n${g.items.map(itemLine).join('\n')}`).join('\n\n');
  }
  function replyWish() {
    const w = live().filter((it) => it.kind === 'wish');
    if (!w.length) return '想預訂清單係空嘅。';
    return `<b>💭 想預訂（${w.length} 件）</b>\n\n` + w.map((it) => {
      const a = nextAction(it);
      return itemLine(it) + (a ? `\n  ${esc(a.label)}` : '');
    }).join('\n\n');
  }
  function replyPending() {
    const o = live().filter((it) => it.kind !== 'wish');
    if (!o.length) return '冇未收貨嘅訂單 🎉';
    return `<b>📦 未收貨（${o.length} 件）</b>\n\n` + o.map((it) =>
      `• ${esc(it.name.slice(0, 50))}\n  ${esc(it.platform || '')} ・ ${esc(it.status)} ・ 預計 ${esc(it.shipDate || '—')}`).join('\n');
  }
  const HELP = '你可以問我：\n/next — 最近要預訂嘅商品同倒數\n/wish — 全部想預訂\n/pending — 未收貨訂單\n或者直接打字問，例如「GU 嗰三個幾時到？」';

  // Daily caps on Claude-answered questions from people other than the owner (they cost API credit).
  const PER_USER = Number(process.env.TG_DAILY_PER_USER || 30), TOTAL = Number(process.env.TG_DAILY_TOTAL || 200);
  let quota = { day: '', total: 0, by: {} };
  function allowQuestion(chatId) {
    const day = hkDate();
    if (quota.day !== day) quota = { day, total: 0, by: {} };
    if (quota.total >= TOTAL || (quota.by[chatId] || 0) >= PER_USER) return false;
    quota.total++; quota.by[chatId] = (quota.by[chatId] || 0) + 1;
    return true;
  }

  async function sendLong(text, html = true, chatId = state.chatId) {
    for (let i = 0; i < text.length; i += 3800) {
      const part = text.slice(i, i + 3800);
      await call('sendMessage', { chat_id: chatId, text: part, disable_web_page_preview: true, ...(html ? { parse_mode: 'HTML' } : {}) });
    }
  }

  async function handleMessage(msg) {
    const chatId = String(msg.chat.id);
    if (!state.chatId) {
      state.chatId = chatId; save();
      await send(`✅ 已連接「預訂商品記錄」。夠鐘預訂同截止前一日都會喺度通知你。\n\n${HELP}`);
      return;
    }
    // Anyone may use the bot; reminders still go only to the linked owner chat.
    const owner = chatId === state.chatId;
    const reply = (t) => sendLong(t, true, chatId);
    const text = (msg.text || '').trim();
    if (!text) return;
    const cmd = text.split(/[\s@]/)[0].toLowerCase();
    if (cmd === '/start' || cmd === '/help') return reply(HELP);
    if (cmd === '/next' || /^(下次|最近|幾時|下一次)|幾時(預訂|開賣|截止|落單)|要(預訂|買)咩/.test(text)) return reply(replyNext());
    if (cmd === '/wish') return reply(replyWish());
    if (cmd === '/pending') return reply(replyPending());
    if (!ask) return reply(HELP);
    if (!owner && !allowQuestion(chatId)) return reply('今日自由發問嘅次數用晒，聽日再問啦 🙏\n（/next、/wish、/pending 照用得）');
    await call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    try {
      await sendLong(await ask(text, getItems()), false, chatId);
    } catch (e) {
      await reply(`答唔到：${esc(e.message)}\n\n${HELP}`);
    }
  }

  // Long-poll Telegram for messages (only one poller per bot; a redeploy may briefly overlap, so retry).
  async function pollLoop() {
    for (;;) {
      try {
        const updates = await call('getUpdates', { offset: state.offset, timeout: 50, allowed_updates: ['message'] }, 65000);
        for (const u of updates) {
          state.offset = u.update_id + 1; save();
          if (u.message?.chat) await handleMessage(u.message).catch((e) => console.error('telegram reply:', e.message));
        }
      } catch (e) {
        if (!/abort|timeout/i.test(e.message)) console.error('telegram poll:', e.message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  async function check() {
    if (!state.chatId) return;
    const now = Date.now();
    const items = getItems().filter((it) => !['已取消', '已放棄', '搶唔到', '已收貨'].includes(it.status));
    const due = { soon: [], now: [], tomorrow: [], closing: [] };
    for (const it of items) {
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(it.remindAt || '')) {
        const at = hkTimeToMs(it.remindAt);
        const key = `${it.id}|${it.remindAt}`;
        if (now >= at - 15 * 60e3 && now < at && !state.sent[`soon|${key}`]) { due.soon.push(it); state.sent[`soon|${key}`] = now; }
        if (now >= at && now < at + 6 * 3600e3 && !state.sent[`now|${key}`]) { due.now.push(it); state.sent[`now|${key}`] = now; }
      }
      // 2 hours before a deadline that has a time (skip when it coincides with the remind time, which already alerts)
      if (it.kind === 'wish' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(it.deadline || '') && it.deadline !== it.remindAt) {
        const end = hkTimeToMs(it.deadline), key = `close|${it.id}|${it.deadline}`;
        if (now >= end - 2 * 3600e3 && now < end && !state.sent[key]) { due.closing.push(it); state.sent[key] = now; }
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
    if (due.closing.length) await send(`⌛ <b>快截止！</b>\n\n${due.closing.map((it) => `${itemLine(it)}\n  截止：香港時間 ${esc(it.deadline.slice(5, 16).replace('-', '/').replace('T', ' '))}`).join('\n\n')}`);
    if (due.tomorrow.length) await send(`📅 <b>聽日截止／開賣</b>\n\n${due.tomorrow.map(itemLine).join('\n\n')}\n\n<a href="${esc(publicUrl)}">打開網站</a>`);
    if (due.soon.length || due.now.length || due.tomorrow.length || due.closing.length) {
      // forget old entries so the file stays small
      for (const [k, t] of Object.entries(state.sent)) if (now - t > 30 * 86400e3) delete state.sent[k];
      save();
    }
  }

  function start() {
    if (!token) { console.log('telegram: TELEGRAM_BOT_TOKEN not set, reminders off'); return; }
    const tick = () => check().catch((e) => console.error('telegram:', e.message));
    tick();
    setInterval(tick, 60e3).unref();
    pollLoop();
    call('setMyCommands', { commands: [
      { command: 'next', description: '最近要預訂嘅商品' },
      { command: 'wish', description: '全部想預訂' },
      { command: 'pending', description: '未收貨訂單' },
      { command: 'help', description: '用法' },
    ] }).catch(() => {});
    console.log(`telegram: reminders on${state.chatId ? '' : ' (waiting for /start)'}`);
  }

  return {
    start,
    status: () => ({ configured: !!token, linked: !!state.chatId }),
    async test() {
      if (!token) throw Object.assign(new Error('未設定 TELEGRAM_BOT_TOKEN'), { status: 503 });
      if (!state.chatId) throw Object.assign(new Error('Bot 未連接：請喺 Telegram 打開你個 bot 撳「開始」（或者傳 /start），再試一次。'), { status: 409 });
      await send('🔔 測試通知：Telegram 提醒運作正常。');
      return { ok: true };
    },
  };
}

module.exports = { createTelegram };
