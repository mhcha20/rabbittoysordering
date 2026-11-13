# 兔仔玩具預訂追蹤（rabbittoysordering）

給日後 AI 嘅項目背景。用戶用廣東話溝通，回覆用繁體廣東話；用戶唔係寫程式嘅人。所有網站一覽：`docs/ALL_SITES.md`。

## 係咩
收藏玩具／角色精品（光之美少女、Chiikawa、Bandai⋯）嘅**預訂紀錄網站**（2026-11-02 做好）：
- **訂單**：平台、訂單號、商品、數量、價錢／運費（HKD／JPY／CNY／TWD／USD）、出貨日、取貨／送貨地點、狀態（待確認／已下單／已確認／已發貨／已收貨／已取消）、備註、多張相片（可左右掃）、預訂網址（🛒）。
- **截圖入單**：上載訂單截圖，Claude 讀圖、仔細抄訂單號、上網搵產品頁同相片（`/api/ai/parse`）。
- **想預訂（wishlist）**：貼連結，AI 搵商品資料、開賣／截止時間（轉香港時間），睇埋帖文預覽圖（登入牆帖文都認到）（`/api/ai/link`）。
- **一次過買**（想預訂分頁「🛒 一次過買」）：剔選／貼 Shopify 商品連結（例如 ちいかわマーケット），伺服器讀 `/products/<handle>.js` 攞 variant id，砌 `https://店/cart/id:qty,id:qty` 連結，一撳直接去付款頁（`cart.js`，`POST /api/cart`）。視窗內「＋ 加入」貼連結會即時加卡並存入想預訂。
- **同系列其他款**：「🔗 貼連結新增」貼 Shopify 商品連結時，先 `POST /api/shop/siblings`（`cart.js` `findSiblings`：同名去尾括號，搵連結 collection（或商品日期 tag）嘅 products.json＋`/en/search/suggest.json`；同一批新品入面名有一大段相同嘅列做「可能同系列」預設唔剔），彈視窗揀；AI 只讀原連結，其他款複製草稿換名、相、價錢、連結。
- **編輯視窗上載訂單截圖**：自動讀（`/api/ai/receipt`，唔上網，快）訂單編號、日期、店舖、該件商品單價／數量；多件同單嘅運費寫入備註。
- **收據落單**（想預訂分頁「🧾 上傳收據落單」）：一張收據讀晒所有商品，AI 對返想預訂（`/api/ai/receipt` 帶 `candidates`，每行 `matchId`），確認視窗可改配對，剔咗嘅一次過轉做訂單（已下單；全單運費記第一件；收據相共用同一個檔）；想預訂冇嘅可新增訂單。
- **搶唔到**：想預訂狀態 想買／搶唔到／已放棄；卡上「✗ 搶唔到」一撳標記（記 `failedAt`），主清單收埋，統計格「😢 搶唔到」撳嚟睇，「↺ 改返想買」還原；Telegram 唔再提醒。
- 篩選：取貨／送貨地點、未收貨；一撳切換已收貨（會先問）；手機版表格變直排卡片；編輯視窗手機全螢幕（頂部 ✕、底部儲存欄固定）。
- **Telegram bot**（`telegram.js`）：預訂提醒（提醒時間前 15 分鐘＋到鐘）、有時間嘅截止前 2 小時「快截止」、截止前一日 09:00（香港）預告；指令 `/next`（最近要預訂＋倒數）、`/wish`、`/pending`（未收貨），自由發問用 Claude 答。任何人都用得指令；非主人每日自由發問有上限（`TG_DAILY_PER_USER`、`TG_DAILY_TOTAL`）；提醒只發去連結咗嘅主人 chat（`/start` 綁定，存喺 `DATA_DIR`）。

## 檔案
- `server.js`：零依賴 Node 伺服器（除咗 `@anthropic-ai/sdk`）。全站 HTTP Basic auth（`APP_PASSWORD`）；`/healthz` 開放。
  API：`GET/PUT /api/items`（PUT＝整份覆蓋，匯入備份用）、`PUT/DELETE /api/items/<id>`、`POST /api/ai/parse`、`POST /api/ai/link`、`POST /api/ai/receipt`、`POST /api/cart`、`GET /api/telegram`、`POST /api/telegram/test`、`GET /photos/<檔名>`。
- `ai.js`：AI JSON schema 抽取訂單／wishlist、讀收據、答問題。次序：Claude（`claude-opus-5-5`）先；Claude 用唔到（冇餘額、key 錯、429、5xx）就轉 Google Gemini（`GEMINI_API_KEY`，REST，零依賴；上網用 `GEMINI_MODEL` 預設 `gemini-pro-latest`＋google_search／url_context，讀收據同 Telegram 用 `GEMINI_FAST_MODEL` 預設 `gemini-flash-latest`）；再唔得先轉 xAI。搵官方相後備用 Gemini（有 key）否則 xAI。
- `cart.js`：Shopify 多件購物車連結。
- `telegram.js`：bot 輪詢、每分鐘 tick 發提醒。
- `public/`：`index.html`、`app.js`（前端）、`style.css`、`seed.js`（第一次冇資料時嘅種子訂單）。
- 資料：`$DATA_DIR/items.json`（原子寫入）、`$DATA_DIR/photos/*`。Railway volume `rabbit-data` 掛 `/data`。

## 部署
- Railway project `rabbittoysordering`（id `f6b339ba-7955-4426-8e16-a3ceadc260b2`），service `web`（`9f266569-5f99-464d-9496-affba4c855c9`），環境 `production`（`c34d6b3c-e10a-469a-adfc-456d1e5444bf`）。
- **部署 branch：`claude/keen-cerf-g5e2qs`**（亦係 GitHub 默認 branch）。網址 https://web-production-89b33.up.railway.app
- `railway.json`：`node server.js`、healthcheck `/healthz`；SIGTERM 正常退出（避免「Deploy Crashed」電郵）。
- Variables（只記名稱）：`APP_PASSWORD`、`ANTHROPIC_API_KEY`、`TELEGRAM_BOT_TOKEN`、`DATA_DIR`（`/data`）、`XAI_API_KEY`（Claude 後備）；選填 `GEMINI_API_KEY`（已設，Claude 之後嘅後備）、`GEMINI_MODEL`、`GEMINI_FAST_MODEL`、 `TELEGRAM_CHAT_ID`、`TG_DAILY_PER_USER`、`TG_DAILY_TOTAL`、`PUBLIC_URL`。

## 注意
- repo **公開**：新資料唔好入 repo（用網站入，存 volume）。
- 時間一律當香港時間處理（`remindAt`／`deadline` 格式 `YYYY-MM-DDTHH:MM`）。

## 修改歷史（摘要，全部 2026-11-02）
預訂追蹤網站＋相片上載＋種子訂單 → Node 伺服器多裝置同步 → 截圖 AI 入單 → 取貨地點篩選、手機直排表格、已收貨切換 → 相片輪播 → 想預訂分頁（連結 AI 查詢）→ 預訂網址欄 → 香港時間換算 → Telegram 提醒 → Telegram 問答 → 截止可帶時間、2 小時快截止提醒 → bot 開放俾任何人用（非主人有每日上限）。2026-11-06：一次過買（Shopify 購物車連結）。2026-11-13：收據落單預設全剔；加 Google Gemini 做 Claude 後備（Claude → Gemini → xAI）。
