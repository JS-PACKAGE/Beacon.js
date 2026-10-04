# Beacon.js 開發規則

## 撰寫方式
- Node.js 26、TypeScript ESM、strict；禁止以 `any` 敷衍型別；維持 exactOptionalPropertyTypes / noUncheckedIndexedAccess。
- 執行期唯一第三方相依為 `ws`。crypto、SQLite、HTTP、測試使用 Node 內建模組。
- 根目錄 `config.yaml` 是唯一部署設定真值；僅接受 YAML 1.2 flow-style JSON 結構（雙引號與逗號），支援引號外 `#` 中文行註解，不支援一般 block YAML 或環境變數設定覆蓋。CLI `--config PATH` 可明確選擇部署設定檔；工具使用 loadConfig，不直接 JSON.parse 原始檔。
- 外部 API 呼叫只能透過 `src/auth/` 的 AuthProvider 與 `src/games/` 的 GameProvider adapter；不得散落於大廳。
- 房間變更由 RoomManager 序列化，持久操作提交成功後才修改記憶體、回應成功；不得吞掉儲存失敗。外部 HTTP（遊戲場次、驗證）與 scrypt 必須在序列化佇列**之外**執行，回來後重新驗證狀態再套用；遊戲場次只能經 `GameSessionProvider`，大廳不得自行發 HTTP。
- 備份一律經 `src/store/backup.ts` 的 `backupDatabase`，不得直接呼叫 `node:sqlite` 的 `backup()`：它不會被自身進度喚醒，事件迴圈上有其他 handle 時會卡到下一次無關喚醒（實測在有 HTTP server 的程序中等了 30 秒）；`backupDatabase` 以短暫計時器處理此問題。
- 訊息關聯：只有對指令的**直接回應**經 `Peer.reply` 並帶 `requestId`；廣播一律用 `Peer.send`、不帶 `requestId`。成員／大廳推播只在對方**看得到**的欄位改變時才送（`ready` 等不顯示於列表的變更不得推給整個大廳）。

## 結構
`src/net/` 傳輸、`src/protocol/` schema、錯誤碼與請求冪等帳本（`requests.ts`）、`src/auth/` OAuth 與撤銷 adapter、`src/games/` 遊戲註冊表與場次 adapter、`src/lobby/` 狀態機（房間、重連、社交、配對）、`src/security/` 密碼與限流、`src/store/` SQLite（房間、封鎖、好友、稽核）、`src/log/` 憑證遮蔽與輪替日誌、`src/ops/` 管理 HTTP／備份排程／告警／還原演練、`src/client/` 對外 SDK（不得 import `ws`）、`src/main.ts` 組裝。`test/` 使用 node:test；`scripts/` 為使用者主動執行的部署、外部驗收與本機容量工具。

## 建置與測試
`npm ci`、`npm run build`、`npm run typecheck`、`npm test`、`npm run verify`。`npm start` 啟動正式模式；預設 mock 設定拒絕正式啟動是刻意的安全行為。`npm run dev` 建置後以兩個明確開發旗標啟動；不得將旗標用於部署。
`npm run backup -- OUTPUT --config config.yaml` 使用 SQLite backup API；不得直接複製運作中的 WAL 資料庫。

## 提交與交付
保持小而完整的變更，提交訊息說明目的與影響；不要提交資料庫、憑證、token、私鑰、dist 或 node_modules。未獲使用者明確要求，不 commit、push、部署或發布。更新相關測試與 README；企劃變動同步完整 PLAN.md。僅報告實際執行的檢查結果。真實 OAuth 與外部部署證據未到位，整合／部署驗收不得宣稱通過。

## 安全性架構（14 條硬規則）
1. **傳輸（分層定義，兩層各自成立、不得混淆）**：
   - **外網層（使用者 ↔ Cloudflare）**：**僅 `wss://lobby.ysgs.app`（`config.yaml`）**——443 只放行 WebSocket 升階（`Upgrade: websocket`），一般 HTTP(S) 一律回 403／426，不提供任何網頁。
   - **本機 upstream 層（Tunnel／代理 ↔ 本程序 `127.0.0.1:34568`）**：本程序**只綁 loopback，且只接受來自 loopback 的連線——非 loopback 來源（不論明文或 TLS）一律拒絕**。此段明文是「TLS 已在 Cloudflare 終結」的設計性安排，**不是安全豁免**：外網強制 wss 與本機僅回環是兩條同時生效的規則。
   - **開發明文**：任何形式的明文 ws（含綁 `127.0.0.1`）**僅限 `--dev-insecure-ws` 旗標**；非開發模式下綁非 loopback 的明文啟動直接被拒絕。
   - 若改 `public.tls: direct`（本程序自持憑證、不經隧道），於 `config.yaml` 啟用；本機層仍僅回環。
2. **驗證前置**：連線 10 秒內未 `auth` 即斷線；`auth_fail` 後斷線；驗證系統不可達 → 拒絕新驗證（fail-closed），不得放行匿名。
3. **來源與連線配額**：升階請求檢查 `Origin`（白名單，非白名單拒絕，CLI 客戶端可豁免）；每 IP 連線數上限（預設 10）、全服務連線總量上限（預設 5000）、每 IP 新連線頻率限制（預設 5/10 秒）。**來源 IP 判定（防偽造）**：僅當連線來自受信任代理（`config.yaml: server.trustProxy: true` 且 socket remote 為 loopback／設定之代理位址）時，才採 `CF-Connecting-IP` 或 `X-Forwarded-For` 的最右可信值；**其餘一律用 socket remoteAddress——絕不直接信任用戶端可自行偽造的轉送標頭**；`Origin` 檢查在經代理時同理取轉送後實際來源。
4. **密碼**：房間密碼以 `node:crypto` scrypt（每房隨機 salt）雜湊儲存，常數時間比較（`timingSafeEqual`）；密碼不得出現在日誌、推播、房間列表（列表只回 `hasPassword`）；加入密碼驗證失敗頻率限制（預設 5 次/分鐘/連線，超過回 `rate_limited`）。
5. **競態與滿員**：`join_room` 流程＝「同步檢查＋預留名額 → 非同步驗密碼 → 確認或釋放」；密碼驗證期間名額已佔，失敗即釋放——兩客戶端同秒加入不得超過 `maxPlayers`。
6. **輸入驗證**：每訊息 4 KB 上限；JSON 解析失敗計次，單連線 3 次即斷線；所有欄位過 schema（型別、長度、字元集：房名 1–32 字、禁控制字元）；未知欄位拒絕。
7. **頻率限制**：每連線 token bucket（預設 20 訊息/10 秒），超限回 `rate_limited`，持續超限斷線。
8. **憑證衛生**：玩家 token／JWT、房間密碼明文**一律不入日誌**（log 模組自動遮蔽 `token`、`password` 欄位）；錯誤對外 generic，堆疊與外部 API 回應體只進伺服器日誌。
9. **依賴與供應鏈**：依賴最小化（預設僅 `ws`，儲存層 `node:sqlite` 內建）、鎖定 lockfile、CI 跑 `npm audit --omit=dev`；禁止 `eval`/`Function()`、禁止動態 require 使用者輸入。**`data/beacon.db` 權限 0600、與 WAL／-shm 一併保護；資料檔路徑配置於 `config.yaml`**。
10. **資源防護**：ping/pong 死連線回收、socket `highWaterMark` 與背壓處理（推播佇列過大即踢除該連線）、房間數量上限（預設 1000/遊戲）防止房間表炸裂。
11. **驗證模式管制（fail-closed）**：`auth.mode: mock` **僅限本地開發與自動化測試**——啟動時若 `mode=mock` 而未帶開發旗標 `--dev-mock-auth`，**拒絕啟動**；正式部署必須為 `jwks` 或 `remote`。**真實 OAuth 未接通前，不得宣稱正式整合驗收通過**（Gate E ⑧）。
12. **管理介面**：`operations` HTTP 只綁 loopback、**每個端點**（含 health／ready／metrics）都要 bearer 認證，token 來自 0600 一般檔案（拒絕符號連結、過寬權限），以常數時間比對；請求大小與欄位嚴格受限；每項管理操作寫入持久稽核；metrics 只輸出彙總數值，不含玩家 ID、token、ticket。對外網域仍不得提供任何 HTTP 頁面或管理路由。
13. **場次憑證隱私**：遊戲 ticket／admission 只送給**該玩家本人**，不得廣播、不得寫入日誌、不得出現在其他玩家可見的訊息或 metrics；服務 bearer token 與 ticket 同屬 `log` 遮蔽範圍。冪等快取只保存雜湊後的請求內容。
14. **撤銷 fail-closed**：設定了 `auth.revocationUrl` 就是必要依賴——拉取失敗時拒絕新驗證並中斷現有連線；比對 `revokedBefore` 時缺少簽發時間一律視為已撤銷，**不得以 `authAt`（驗證時間）充當簽發時間**。非 mock 必須另有 0600 的 `revocationTokenFile`，GET 帶 `Authorization: Bearer`；token 不得寫入設定檔或日誌。


日誌補充：第 8 條的伺服器診斷也不得包含可能回顯 token 的任意外部回應體、錯誤訊息或堆疊；僅記安全的分類與遮蔽後欄位。代理模式必須同時驗證受信任 loopback、forwarded HTTPS 與設定網域 Host；Cloudflare 必須另設規則拒絕 HTTP（包含 WS upgrade），不能僅依賴 HTTPS redirect。
