(() => {
const STATUSES = ['待確認', '已下單', '已確認', '已發貨', '已收貨', '已取消'];
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (cur, n) => (cur === 'JPY' ? '¥' : 'HK$') + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
const total = (it) => it.price * it.qty + it.shipping;

// ---------- storage (server API, shared by every device) ----------
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}
const showError = (e) => alert('儲存失敗，請檢查網絡後再試。\n' + (e.message || e));

let items = [];
let editing = null; // item being edited (draft copy)
let view = 'grid';
let busy = false;
async function refresh() {
  if (busy || $('#dlg').open) return;
  try { items = (await api('GET', '/api/items')).items; render(); } catch { /* offline: keep what we have */ }
}

// ---------- helpers ----------
function shipKey(s) {
  const m = String(s || '').match(/(\d{4})\D+(\d{1,2})(?:\D+(\d{1,2}))?/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${(m[3] || '99').padStart(2, '0')}` : '9999';
}
function resizeImage(file, max = 900) {
  return new Promise((res, rej) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      res(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = rej;
    img.src = url;
  });
}

// Group pickup / delivery text by its main part, e.g. "日本國內配送 (Amazon Pay)" -> "日本國內配送".
const pickupKey = (d) => String(d || '').split(/\s*[（(]/)[0].trim() || '未填寫';

// ---------- rendering ----------
// the green "✓ 已收貨" button already says it, so skip the duplicate badge
const badge = (it) => (it.status === '已收貨' ? '<span></span>' : `<span class="badge s-${esc(it.status)}">${esc(it.status)}</span>`);
const shortDate = (d) => (d ? d.slice(5).replace('-', '/') : '');
const recvBtn = (it) => (it.status === '已取消' ? '' : it.status === '已收貨'
  ? `<button type="button" class="recv on" data-recv="${esc(it.id)}" title="撳一下改返未收貨">✓ 已收貨 ${shortDate(it.receivedAt)}</button>`
  : `<button type="button" class="recv" data-recv="${esc(it.id)}" title="撳一下標記已收貨">☐ 收貨</button>`);
async function toggleReceived(id) {
  const it = items.find((x) => x.id === id);
  if (!it) return;
  const name = it.name.length > 40 ? it.name.slice(0, 40) + '…' : it.name;
  const ask = it.status === '已收貨' ? `將「${name}」改返做未收貨？` : `確認已經收到「${name}」？`;
  if (!confirm(ask)) return;
  const draft = it.status === '已收貨'
    ? { ...it, status: it.prevStatus || '已下單', receivedAt: '', prevStatus: '' }
    : { ...it, prevStatus: it.status, status: '已收貨', receivedAt: '' };
  Object.assign(it, draft); render(); // instant feedback
  busy = true;
  try {
    const { item } = await api('PUT', '/api/items/' + encodeURIComponent(id), draft);
    Object.assign(it, item); render();
  } catch (e) { busy = false; showError(e); refresh(); } finally { busy = false; }
}

function filtered() {
  const q = $('#q').value.trim().toLowerCase();
  const p = $('#fPlatform').value, s = $('#fStatus').value, c = $('#fCur').value, pk = $('#fPickup').value;
  const showC = $('#showCancelled').checked;
  const pending = (it) => it.status !== '已收貨' && it.status !== '已取消';
  let list = items.filter((it) =>
    (showC || it.status !== '已取消') &&
    (!p || it.platform === p) && (!pk || pickupKey(it.delivery) === pk) && (!s || (s === '__pending' ? pending(it) : it.status === s)) && (!c || it.currency === c) &&
    (!q || [it.name, it.orderNo, it.notes, it.platform, it.delivery].join(' ').toLowerCase().includes(q)));
  const sort = $('#sort').value;
  list.sort((a, b) =>
    sort === 'total' ? total(b) - total(a) :
    sort === 'order' ? String(b.orderDate).localeCompare(String(a.orderDate)) :
    shipKey(a.shipDate).localeCompare(shipKey(b.shipDate)));
  return list;
}

function renderSummary() {
  const live = items.filter((i) => i.status !== '已取消');
  const by = (cur) => {
    const l = live.filter((i) => i.currency === cur);
    return { n: l.reduce((a, i) => a + i.qty, 0), sum: l.reduce((a, i) => a + total(i), 0), orders: new Set(l.map((i) => i.platform + i.orderNo)).size };
  };
  const h = by('HKD'), j = by('JPY');
  const cancelled = items.filter((i) => i.status === '已取消').length;
  const got = live.filter((i) => i.status === '已收貨').length;
  $('#summary').innerHTML = `
    <div class="stat"><small>港幣訂單（${h.orders} 張・${h.n} 件）</small><b>${fmt('HKD', h.sum)}</b></div>
    <div class="stat"><small>日圓訂單（${j.orders} 張・${j.n} 件）</small><b>${fmt('JPY', j.sum)}</b></div>
    <div class="stat"><small>已收貨 / 有效商品款數</small><b>${got} / ${live.length}</b></div>
    <div class="stat"><small>已取消款數</small><b>${cancelled}</b></div>`;
}

function render() {
  renderSummary();
  const list = filtered();
  $('#empty').hidden = list.length > 0;
  const el = $('#list');
  el.className = view === 'grid' ? 'grid' : '';
  if (view === 'grid') {
    el.innerHTML = list.map((it) => `
      <article class="card ${it.status === '已取消' ? 'cancelled' : ''} ${it.status === '已收貨' ? 'received' : ''}" data-id="${esc(it.id)}">
        <div class="pic">${it.photos.length ? `<div class="slides">${it.photos.map((src) => `<img loading="lazy" src="${esc(src)}" alt="">`).join('')}</div>` : '尚無照片'}
          ${it.photos.length > 1 ? `<button type="button" class="nav prev" data-slide="-1" aria-label="上一張">‹</button><button type="button" class="nav next" data-slide="1" aria-label="下一張">›</button><span class="cnt">1 / ${it.photos.length}</span>` : ''}</div>
        <div class="body">
          <div class="tags">${badge(it)}${recvBtn(it)}</div>
          <h3>${esc(it.name)}</h3>
          <div class="meta">${esc(it.platform)}${it.orderNo ? ' ・ ' + esc(it.orderNo) : ''}</div>
          <div class="meta">預計發貨：${esc(it.shipDate || '—')}</div>
          <div class="price">${fmt(it.currency, total(it))}
            <span class="meta">（${fmt(it.currency, it.price)} × ${it.qty}${it.shipping ? ' + 運費 ' + fmt(it.currency, it.shipping) : ''}）</span></div>
        </div>
      </article>`).join('');
  } else {
    el.innerHTML = `<div class="tableWrap"><table><thead><tr><th></th><th>商品</th><th>店舖 / 訂單</th><th>數量</th><th>總額</th><th>預計發貨</th><th>狀態</th></tr></thead><tbody>
      ${list.map((it) => `<tr class="row" data-id="${esc(it.id)}">
        <td>${it.photos[0] ? `<img loading="lazy" src="${esc(it.photos[0])}" alt="">` : ''}</td>
        <td>${esc(it.name)}</td><td>${esc(it.platform)}<br><span class="meta">${esc(it.orderNo)}</span></td>
        <td>${it.qty}</td><td>${fmt(it.currency, total(it))}</td><td>${esc(it.shipDate || '—')}</td>
        <td>${badge(it)} ${recvBtn(it)}</td></tr>`).join('')}
      </tbody></table></div>`;
  }
  // filter option lists
  const plats = [...new Set(items.map((i) => i.platform).filter(Boolean))].sort();
  const cur = $('#fPlatform').value;
  $('#fPlatform').innerHTML = '<option value="">全部店舖</option>' + plats.map((p) => `<option ${p === cur ? 'selected' : ''}>${esc(p)}</option>`).join('');
  const pickups = [...new Set(items.map((i) => pickupKey(i.delivery)))].sort();
  const curPk = $('#fPickup').value;
  $('#fPickup').innerHTML = '<option value="">全部取貨地點</option>' + pickups.map((k) => `<option ${k === curPk ? 'selected' : ''}>${esc(k)}</option>`).join('');
  $('#platforms').innerHTML = plats.map((p) => `<option value="${esc(p)}">`).join('');
}

// ---------- editor ----------
function renderThumbs() {
  $('#photoPreview').innerHTML = editing.photos.map((src, i) =>
    `<div class="thumb"><img src="${esc(src)}" alt=""><button type="button" data-rm="${i}" title="移除">×</button></div>`).join('');
}
const blankItem = () => ({ id: 'i' + Date.now() + Math.random().toString(36).slice(2, 6), platform: '', orderNo: '', orderDate: '', name: '', qty: 1, currency: 'JPY', price: 0, shipping: 0, shipDate: '', delivery: '', status: '已下單', notes: '', photos: [] });
function openEditor(it, { isNew = !it, title } = {}) {
  editing = it ? JSON.parse(JSON.stringify(it)) : blankItem();
  $('#dlgTitle').textContent = title || (isNew ? '新增商品' : '商品詳情 / 編輯');
  $('#btnDelete').hidden = isNew;
  const f = $('#form');
  f.status.innerHTML = STATUSES.map((s) => `<option>${s}</option>`).join('');
  for (const k of ['name', 'platform', 'orderNo', 'orderDate', 'shipDate', 'qty', 'currency', 'price', 'shipping', 'status', 'delivery', 'notes']) f[k].value = editing[k];
  renderThumbs();
  $('#dlg').showModal();
}

$('#form').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'ok') return;
  const f = $('#form');
  if (f.status.value === '已收貨' && editing.status !== '已收貨') editing.prevStatus = editing.status;
  Object.assign(editing, {
    name: f.name.value.trim(), platform: f.platform.value.trim(), orderNo: f.orderNo.value.trim(), orderDate: f.orderDate.value.trim(),
    shipDate: f.shipDate.value.trim(), qty: Math.max(1, +f.qty.value || 1), currency: f.currency.value, price: +f.price.value || 0,
    shipping: +f.shipping.value || 0, status: f.status.value, delivery: f.delivery.value.trim(), notes: f.notes.value,
  });
  const draft = editing;
  busy = true;
  api('PUT', '/api/items/' + encodeURIComponent(draft.id), draft).then(({ item }) => {
    const i = items.findIndex((x) => x.id === item.id);
    if (i >= 0) items[i] = item; else items.unshift(item);
    render();
  }).catch(showError).finally(() => { busy = false; });
});
$('#btnCancel').onclick = () => $('#dlg').close();
$('#btnDelete').onclick = () => {
  if (!confirm('確定刪除這個商品記錄？')) return;
  const id = editing.id;
  $('#dlg').close();
  api('DELETE', '/api/items/' + encodeURIComponent(id)).then(() => {
    items = items.filter((x) => x.id !== id); render();
  }).catch(showError);
};
$('#photoFile').onchange = async (e) => {
  for (const file of e.target.files) {
    try { editing.photos.push(await resizeImage(file)); } catch { alert('無法讀取圖片：' + file.name); }
  }
  e.target.value = ''; renderThumbs();
};
$('#photoUrl').onclick = () => {
  const u = prompt('貼上圖片網址（https://…）');
  if (u && /^https?:\/\//.test(u.trim())) { editing.photos.push(u.trim()); renderThumbs(); }
};
$('#photoPreview').onclick = (e) => {
  const rm = e.target.dataset.rm;
  if (rm !== undefined) { editing.photos.splice(+rm, 1); renderThumbs(); return; }
  if (e.target.tagName === 'IMG') { $('#lbImg').src = e.target.src; $('#lightbox').showModal(); }
};
$('#lbClose').onclick = () => $('#lightbox').close();
$('#lightbox').onclick = (e) => { if (e.target.id !== 'lbImg') $('#lightbox').close(); };

// ---------- list interactions ----------
$('#list').onclick = (e) => {
  const nav = e.target.closest('[data-slide]');
  if (nav) {
    e.stopPropagation();
    const box = nav.parentElement.querySelector('.slides');
    box.scrollBy({ left: Number(nav.dataset.slide) * box.clientWidth, behavior: 'smooth' });
    return;
  }
  const rb = e.target.closest('[data-recv]');
  if (rb) { e.stopPropagation(); toggleReceived(rb.dataset.recv); return; }
  const row = e.target.closest('[data-id]');
  if (row) openEditor(items.find((x) => x.id === row.dataset.id));
};
$('#btnAdd').onclick = () => openEditor();
// photo carousel: keep the "n / total" counter in step with swiping (scroll events don't bubble, so capture)
$('#list').addEventListener('scroll', (e) => {
  const box = e.target;
  if (!box.classList?.contains('slides')) return;
  const cnt = box.parentElement.querySelector('.cnt');
  if (cnt) cnt.textContent = `${Math.round(box.scrollLeft / box.clientWidth) + 1} / ${box.children.length}`;
}, true);

// ---------- AI: screenshot -> draft items ----------
let aiQueue = [];
function openNextDraft() {
  const next = aiQueue.shift();
  if (!next) return;
  openEditor(next.item, { isNew: true, title: `AI 草稿 ${next.n}/${next.total}：檢查後按儲存` });
}
$('#dlg').addEventListener('close', () => { if (aiQueue.length) setTimeout(openNextDraft, 200); });
$('#aiFile').onchange = async (e) => {
  const files = [...e.target.files].slice(0, 6); e.target.value = '';
  if (!files.length) return;
  $('#aiBusy').showModal();
  try {
    const images = await Promise.all(files.map((f) => resizeImage(f, 1800)));
    const result = await api('POST', '/api/ai/parse', { images });
    $('#aiBusy').close();
    if (!result.items?.length) { alert('AI 搵唔到商品資料。' + (result.summary || '')); return; }
    const total = result.items.length;
    aiQueue = result.items.map((d, i) => ({
      n: i + 1, total,
      item: { ...blankItem(), ...d, notes: d.notes || '', photos: [...(d.photos || []), ...images] }, // keep the screenshot too
    }));
    alert(`AI 搵到 ${total} 件商品。\n${result.summary || ''}\n\n會逐件打開，請檢查資料，啱就按「儲存」，唔要就按「取消」。`);
    openNextDraft();
  } catch (err) {
    $('#aiBusy').close();
    let msg = err.message || String(err);
    try { msg = JSON.parse(msg.replace(/^\d+ /, '')).error || msg; } catch { /* plain text */ }
    alert('AI 分析失敗：' + msg);
  }
};
for (const id of ['#q', '#fPlatform', '#fPickup', '#fStatus', '#fCur', '#sort', '#showCancelled']) $(id).addEventListener('input', render);
document.querySelectorAll('.view button').forEach((b) => b.onclick = () => {
  view = b.dataset.view;
  document.querySelectorAll('.view button').forEach((x) => x.classList.toggle('on', x === b));
  render();
});

// ---------- backup ----------
const toDataUrl = async (src) => {
  const blob = await (await fetch(src)).blob();
  return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
};
$('#btnExport').onclick = async () => {
  // embed uploaded photos so the backup file is self-contained
  const out = await Promise.all(items.map(async (it) => ({
    ...it, photos: await Promise.all(it.photos.map((p) => (p.startsWith('/photos/') ? toDataUrl(p).catch(() => p) : p))),
  })));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: 'application/json' }));
  a.download = `預訂商品備份-${new Date().toISOString().slice(0, 10)}.json`;
  a.click(); URL.revokeObjectURL(a.href);
};
$('#fileImport').onchange = async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data)) throw 0;
    if (!confirm(`匯入 ${data.length} 筆資料，會取代目前所有記錄，確定？`)) return;
    items = (await api('PUT', '/api/items', data.map((d) => ({ photos: [], notes: '', ...d })))).items;
    render();
  } catch { alert('備份檔格式不正確'); }
};

// ---------- init ----------
(async () => {
  $('#fStatus').innerHTML += '<option value="__pending">未收貨（全部）</option>' + STATUSES.map((s) => `<option>${s}</option>`).join('');
  await refresh();
  // keep every device in sync
  setInterval(refresh, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  $('#dlg').addEventListener('close', () => setTimeout(refresh, 500));
})();
})();
