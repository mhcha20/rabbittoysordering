(() => {
const STATUSES = ['待確認', '已下單', '已確認', '已發貨', '已到貨', '已取消'];
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (cur, n) => (cur === 'JPY' ? '¥' : 'HK$') + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
const total = (it) => it.price * it.qty + it.shipping;

// ---------- storage (IndexedDB, falls back to memory) ----------
const DB = {
  db: null,
  open() {
    return new Promise((res) => {
      try {
        const r = indexedDB.open('rabbit-toys', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => { this.db = r.result; res(); };
        r.onerror = () => res();
      } catch { res(); }
    });
  },
  get() {
    return new Promise((res) => {
      if (!this.db) return res(null);
      const q = this.db.transaction('kv').objectStore('kv').get('items');
      q.onsuccess = () => res(q.result || null);
      q.onerror = () => res(null);
    });
  },
  set(v) {
    if (!this.db) return;
    this.db.transaction('kv', 'readwrite').objectStore('kv').put(v, 'items');
  },
};

let items = [];
let editing = null; // item being edited (draft copy)
let view = 'grid';
const save = () => DB.set(items);

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

// ---------- rendering ----------
function filtered() {
  const q = $('#q').value.trim().toLowerCase();
  const p = $('#fPlatform').value, s = $('#fStatus').value, c = $('#fCur').value;
  const showC = $('#showCancelled').checked;
  let list = items.filter((it) =>
    (showC || it.status !== '已取消') &&
    (!p || it.platform === p) && (!s || it.status === s) && (!c || it.currency === c) &&
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
  $('#summary').innerHTML = `
    <div class="stat"><small>港幣訂單（${h.orders} 張・${h.n} 件）</small><b>${fmt('HKD', h.sum)}</b></div>
    <div class="stat"><small>日圓訂單（${j.orders} 張・${j.n} 件）</small><b>${fmt('JPY', j.sum)}</b></div>
    <div class="stat"><small>有效商品款數</small><b>${live.length}</b></div>
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
      <article class="card ${it.status === '已取消' ? 'cancelled' : ''}" data-id="${esc(it.id)}">
        <div class="pic">${it.photos[0] ? `<img loading="lazy" src="${esc(it.photos[0])}" alt="">` : '尚無照片'}
          ${it.photos.length > 1 ? `<span class="cnt">${it.photos.length} 張</span>` : ''}</div>
        <div class="body">
          <span class="badge s-${esc(it.status)}">${esc(it.status)}</span>
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
        <td><span class="badge s-${esc(it.status)}">${esc(it.status)}</span></td></tr>`).join('')}
      </tbody></table></div>`;
  }
  // filter option lists
  const plats = [...new Set(items.map((i) => i.platform).filter(Boolean))].sort();
  const cur = $('#fPlatform').value;
  $('#fPlatform').innerHTML = '<option value="">全部店舖</option>' + plats.map((p) => `<option ${p === cur ? 'selected' : ''}>${esc(p)}</option>`).join('');
  $('#platforms').innerHTML = plats.map((p) => `<option value="${esc(p)}">`).join('');
}

// ---------- editor ----------
function renderThumbs() {
  $('#photoPreview').innerHTML = editing.photos.map((src, i) =>
    `<div class="thumb"><img src="${esc(src)}" alt=""><button type="button" data-rm="${i}" title="移除">×</button></div>`).join('');
}
function openEditor(it) {
  const isNew = !it;
  editing = it ? JSON.parse(JSON.stringify(it)) : { id: 'i' + Date.now(), platform: '', orderNo: '', orderDate: '', name: '', qty: 1, currency: 'JPY', price: 0, shipping: 0, shipDate: '', delivery: '', status: '已下單', notes: '', photos: [] };
  $('#dlgTitle').textContent = isNew ? '新增商品' : '商品詳情 / 編輯';
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
  Object.assign(editing, {
    name: f.name.value.trim(), platform: f.platform.value.trim(), orderNo: f.orderNo.value.trim(), orderDate: f.orderDate.value.trim(),
    shipDate: f.shipDate.value.trim(), qty: Math.max(1, +f.qty.value || 1), currency: f.currency.value, price: +f.price.value || 0,
    shipping: +f.shipping.value || 0, status: f.status.value, delivery: f.delivery.value.trim(), notes: f.notes.value,
  });
  const i = items.findIndex((x) => x.id === editing.id);
  if (i >= 0) items[i] = editing; else items.unshift(editing);
  save(); render();
});
$('#btnCancel').onclick = () => $('#dlg').close();
$('#btnDelete').onclick = () => {
  if (!confirm('確定刪除這個商品記錄？')) return;
  items = items.filter((x) => x.id !== editing.id);
  save(); render(); $('#dlg').close();
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
  const row = e.target.closest('[data-id]');
  if (row) openEditor(items.find((x) => x.id === row.dataset.id));
};
$('#btnAdd').onclick = () => openEditor();
for (const id of ['#q', '#fPlatform', '#fStatus', '#fCur', '#sort', '#showCancelled']) $(id).addEventListener('input', render);
document.querySelectorAll('.view button').forEach((b) => b.onclick = () => {
  view = b.dataset.view;
  document.querySelectorAll('.view button').forEach((x) => x.classList.toggle('on', x === b));
  render();
});

// ---------- backup ----------
$('#btnExport').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(items)], { type: 'application/json' }));
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
    items = data.map((d) => ({ photos: [], notes: '', ...d }));
    save(); render();
  } catch { alert('備份檔格式不正確'); }
};

// ---------- init ----------
(async () => {
  $('#fStatus').innerHTML += STATUSES.map((s) => `<option>${s}</option>`).join('');
  await DB.open();
  items = (await DB.get()) || JSON.parse(JSON.stringify(window.SEED_ITEMS));
  if (!(await DB.get())) save();
  render();
})();
})();
