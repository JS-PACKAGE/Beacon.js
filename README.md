# Beacon.js

以 **WSS + OAuth** 提供遊戲分區大廳的 TypeScript / Node.js 26 服務：先驗證、選遊戲，再列出、建立或加入房間。支援密碼、遊戲 API 指定的人數上限、即時推播與 SQLite 持久化。不實作帳號系統、遊戲邏輯或前端大廳 UI；`index.html` 只是介紹頁。

```text
遊戲客戶端 ─ WSS ─ Cloudflare Tunnel ─ loopback ─ Beacon.js
                                              ├ OAuth API / JWKS
                                              ├ 遊戲 API（快取與備援）
                                              └ SQLite（房間；在線成員不持久）
GitHub Pages ─ 靜態介紹頁（不承載 WebSocket）
```

## 安裝與開發

需要 Node.js 26 與 npm；Mac mini 部署需 macOS、launchd，Tunnel 另需 cloudflared。

```sh
npm ci
npm run typecheck
npm test
npm run dev
```

`dev` 執行 `npm run build && node dist/main.js --dev-mock-auth --dev-insecure-ws`。本機以 `ws://127.0.0.1:34568` 連線；mock tokens 是 `dev-alice`、`dev-bob`、`dev-carol`，備援遊戲為 `g-001`、`g-002`。只用於本機開發／測試。

package.json 指令：`build` = tsc；`typecheck` = tsc --noEmit；`start` = node dist/main.js；`test` = 建置後 node:test；`backup` = node dist/store/backup.js；`verify` = typecheck、test、npm audit --omit=dev。這份文件不是測試已通過的證明。

CI 使用 Node.js **24／26** × **macOS 26（arm64）、Ubuntu 24.04 LTS／26.04 LTS（各含 x64 與 arm64）**，共十組；每組執行 npm ci、typecheck、完整測試、部署工具安全測試與 runtime dependencies audit，單組失敗不取消其他組。Runner 標籤固定為 `macos-26`（本身即 arm64）、`ubuntu-24.04`、`ubuntu-24.04-arm`、`ubuntu-26.04`、`ubuntu-26.04-arm`（[官方可用映像](https://github.com/actions/runner-images#available-images)）。Node.js 24 僅作相容性回歸測試，**不改變正式啟動與部署要求的 Node.js ≥26**；npm 在 Node.js 24 顯示的專案 engine 警告屬預期。

## 設定與正式啟動

**根目錄 `config.yaml` 為唯一部署設定真值**。為避免新增 YAML 解析依賴，檔案只接受 **YAML 1.2 flow-style JSON 結構加 `#` 中文註解**：雙引號 key、花括號與逗號結構；引號外 `#` 至行尾為註解，引號內 `#` 保留。不支援一般 block YAML 縮排語法。所有必要欄位與配額已列於該檔，必須保留完整結構；不以環境變數覆蓋設定。`node dist/main.js --config /absolute/path/config.yaml` 可選擇另一份完整設定。相對路徑以執行工作目錄為基準。工具請呼叫 loadConfig，不可直接 JSON.parse 原始檔。

- `server`：loopback listenHost、listenPort（預設 34568）、trustProxy、trustedProxyAddresses、allowedOrigins、allowNoOrigin。瀏覽器 Origin 必須明列白名單；CLI 無 Origin 是否接受由 allowNoOrigin 決定。
- `public`：domain（預設 lobby.ysgs.app）、tls（proxy / direct）；direct 必須提供 certPath / keyPath，私鑰不得入庫。
- `auth.mode`：正式部署選 `jwks` 或 `remote`，**不能 mock**。JWKS 設完整 jwksUrl、issuer、audience，僅支援 **RS256**，驗證簽章／exp／iss／aud，再取 sub 與 name；remote 的 apiUrl 設 **API base URL**（不是完整 verify 端點），adapter 附加 `/v1/verify`，以 POST + Authorization: Bearer 呼叫，成功回 `{ "playerId": "…", "displayName": "…" }`，401 拒絕。玩家 ID／displayName 上限各 **128 UTF-8 bytes**。驗證不可達 fail-closed，timeoutMs 控制期限。
- `games.apiUrl`：**API base URL**（不是完整清單端點），adapter 附加 `/v1/games` 並 GET，回 `[{"gameId":"…","name":"…","maxPlayersPerRoom":8,"enabled":true}]`，可含 serverHint。遊戲 ID／name 上限各 **128 UTF-8 bytes**，serverHint 上限 **1024 UTF-8 bytes**；maxPlayersPerRoom 必須是後端提供的正安全整數，不把列表 pageSize 上限當作遊戲人數上限。遠端回應受 byte 上限保護。cacheTtlSec 預設 60；遠端失敗採快取或 fallback 並記 warning，不將備援冒充已實串接。fallback 可為空清單；沒有可用遊戲時選取回 `game_not_found`。
- `room.emptyTtlSec`：預設 1800，0 永不清理；`db.path`：預設 data/beacon.db。
- `limits`：驗證／心跳期限、來源連線配額、訊息／密碼限流、房間數、入站 4096 bytes、出站 65536 bytes、背壓與分頁上限。

```sh
npm run build
npm start
```

**預設 mock 設定下 npm start 拒絕啟動是刻意行為**；先填妥真實 OAuth 設定。不要為部署加開發旗標。API 實際契約若不同只改 adapter，參考 [PLAN.md](PLAN.md) 與 [AGENTS.md](AGENTS.md)。

## WSS 協定摘要

JSON 單物件，未知欄位拒絕；入站單則 4 KB、出站單則 64 KB，列表分頁而非截斷。連線收到 hello 後須在 authDeadlineMs 內驗證（預設 10 秒）。

```json
{"type":"auth","token":"<OAuth access token>"}
{"type":"select_game","gameId":"g-001"}
{"type":"list_rooms","page":1,"pageSize":50}
{"type":"create_room","name":"一起玩","password":"<room password>","maxPlayers":4}
{"type":"join_room","roomId":"<room id>","password":"<room password>"}
{"type":"leave_room"}
{"type":"delete_room"}
{"type":"switch_game","gameId":"g-002"}
{"type":"ping"}
```

依序收到 hello、auth_ok、lobby_state；加入收到 room_joined、成員變化 room_state；同遊戲大廳收 lobby_update；解散收 room_closed 並回原遊戲大廳。驗證失敗 auth_fail 後斷線；其餘 error `{code,message}`，完整錯誤碼以 src/protocol/ 為準。未 select_game 不得取得房間；列表預設 50、上限 200。相同玩家新連線取代旧會話。房主離開移交最早成員；空房保留 hostId，首位加入者成為新房主。重啟保留房間、密碼雜湊、上限與 hostId，但成員清空。

`list_rooms.page` **從 1 起算**，預設首頁；每頁同時受 pageSize（預設 50、上限 200）和出站 byte 上限约束，因此實際頁可能更小。依回應 nextPage 取得下一頁，無 nextPage 表示結束，不可自行假定固定每頁筆數。

大型 `room_joined`／`room_state` 成員快照會拆包：每包攜帶相同房間／變更 metadata，以及 **從 0 起算的 chunkIndex**、chunkCount 和該包 members。客戶端必須收齊該快照的全部 chunk、按 chunkIndex 組合完整 members 後才套用狀態；不能將單包誤當完整成員清單。一般未拆包訊息直接套用。

## Mac mini：使用者主動部署

不提供 SSH 或自動雲端動作；由使用者自行 clone／傳送檔案、設定真實 API、執行指令及回報結果。禁止追蹤憑證。專案目錄、使用者、Node 絕對路徑皆可配置：

```sh
npm ci
npm run typecheck
npm run build
# 以上以標準使用者執行；僅 installer 需要 sudo：
sudo "$(command -v node)" scripts/install-launchd.mjs --directory "$PWD" --user "$(id -un)" --node "$(command -v node)" --config "$PWD/config.yaml"
```

installer 要求預先以標準使用者完成 typecheck／build，再以指定 Node binary 降權至 `--user` 解析出的 uid/gid 檢查 Node 版本與正式設定，**不以 root 執行 npm 或專案驗證程式**。成功後安裝 `/Library/LaunchDaemons/app.ysgs.beacon.plist`（root:wheel、0644），`UserName`／`GroupName` 指定非 root app 使用者，system domain 在開機未登入時也啟動。PATH／HOME／USER／LOGNAME 明確設定，startup 使用絕對 Node binary，不使用 npm。專案、設定、資料目錄須可由該使用者存取。既有 plist 不覆寫；修改前先備份並 bootout，再人工移走旧 plist。stdout/stderr 位於專案 logs（0700、app 使用者擁有）。確認主機不休眠、防火牆僅允許必要程式，這些系統變更由使用者自行審核。

```sh
sudo launchctl print system/app.ysgs.beacon
sudo launchctl bootout system/app.ysgs.beacon
# 停止後重新啟動：
sudo launchctl bootstrap system /Library/LaunchDaemons/app.ysgs.beacon.plist
```

### Cloudflare Tunnel（獨立 LaunchDaemon）

使用者於 Cloudflare 建立 Tunnel、DNS hostname 與 HTTPS 邊緣規則，不由腳本呼叫雲端。將 hostname 對應至設定 listenPort 的 `http://127.0.0.1:<port>`，保留設定網域 Host，傳送 `X-Forwarded-Proto: https`。本程序代理模式只信任設定的 loopback 代理，驗證 forwarded HTTPS 與 domain Host；非 loopback 一律拒絕。不要將受信任代理設成任意來源。

**必須於 Cloudflare 建立 block 規則：hostname 為設定網域且 scheme 為 http，全部拒絕，包含帶 Upgrade 的 WS 請求。不要只做 HTTPS redirect。** 一般 HTTP(S) 非升階請求在 app 層拒絕 403／426；外網只接受 WSS。TLS 終結於 Cloudflare、upstream loopback 明文並不表示允許外部 WS。

以官方 cloudflared 的本機管理 named tunnel 設定方式安裝独立 LaunchDaemon：使用 JSON credentials file，不把 tunnel token 放命令列、plist、shell history 或版本庫。由管理員將憑證存於例如 `/Library/Application Support/BeaconTunnel/`（root 擁有，目錄 0700、credentials JSON 0600）；設定檔引用 credentials-file 絕對路徑及 tunnel ID，ingress 對應 hostname／loopback upstream，最後加 http_status:404。依安裝版本官方文件的 service install 設定方式安裝與審核 LaunchDaemon；cloudflared 啟動參數僅引用設定檔／tunnel ID，不帶 token。管理員權限只用於這項獨立系統服務，app 仍以標準使用者執行。若使用 remotely-managed tunnel，先確認該版本支援 token-file，再使用受保護的 token file，**不得直接貼 token 到命令列**。本專案沒有執行這些步驟，也不宣稱外部部署已成功。

依 [Cloudflare macOS 官方指引](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/as-a-service/macos/)，root LaunchDaemon 讀取 `/etc/cloudflared/config.yml`（不是 app 的 config.yaml）。管理員先建立 `/etc/cloudflared`（0700）並寫入設定（0600），例如下列**需替換實際 tunnel UUID、網域、port 與憑證路徑**的獨立 Tunnel 設定；app 配置真值仍是 config.yaml，修改後人工同步：

```yaml
tunnel: <your-tunnel-uuid>
credentials-file: /Library/Application Support/BeaconTunnel/tunnel-credentials.json
ingress:
  - hostname: lobby.ysgs.app
    service: http://127.0.0.1:34568
  - service: http_status:404
```

確認 private credentials 檔、設定檔權限與 Host／forwarded HTTPS 後，由使用者明確執行（cloudflared 需已安裝；不附任何 token）：

```sh
sudo cloudflared service install
sudo launchctl start com.cloudflare.cloudflared
# 設定變更後
sudo launchctl stop com.cloudflare.cloudflared
sudo launchctl start com.cloudflare.cloudflared
```

先檢查既有服務，不覆寫其他 Tunnel。審核 `/Library/LaunchDaemons/com.cloudflare.cloudflared.plist` 的 binary／設定路徑；官方日誌位於 `/Library/Logs/com.cloudflare.cloudflared.*.log`，同樣不得公開可能含敏感資訊的原始日誌。

## 備份與還原

```sh
npm run build
npm run backup -- /absolute/private/backups/beacon-backup.db --config config.yaml
# 等價：node dist/store/backup.js OUTPUT --config config.yaml
```

backup 使用 SQLite backup API，產物權限 0600，目的地必須是私密目錄；不可把資料库／WAL／SHM 交給 Git。不要直接複製運作中的 DB。

還原：先 bootout 停止 app，確認程序已退出且無其他 DB writer；將**旧 DB、-wal、-shm 一起保留**在新的私密復原目錄，不能只換 DB 而殘留旧 WAL。再把已驗證備份複製到 config 的 db.path，chmod 0600，確保父目錄私密且擁有者為 app 使用者，啟動。若 integrity check 失敗，保留原檔並停機調查／另選備份，不准自動清空。服務重建可重跑 installer（先處理旧 plist）並還原 DB；在線成員不會恢復。

## 外部驗收（使用者執行並保存不含憑證的證據）

```sh
BEACON_CONFIG=config.yaml BEACON_GAME=g-001 node scripts/client.mjs
```

CLI 需先 `npm run build`，使用正式模式 loadConfig 讀取 BEACON_CONFIG（預設根目錄 config.yaml）；**設定必須為 jwks／remote，mock 一律拒絕，不按 token 字面判斷驗證模式**。連線 URL 預設取設定 public.domain 的 WSS，可用 BEACON_URL 明確覆蓋外部驗收位址（仍僅允許 WSS，不改服務設定）。BEACON_GAME 指定實際啟用遊戲。CLI 使用 Node 內建 WebSocket，互動隱藏輸入真實 token；亦可由安全環境注入 BEACON_TOKEN（不要貼在 shell history）。驗證 hello／auth_ok／選遊戲／建房／離開／加入／解散；不記錄 token、房密或完整 response。此命令會建立並刪除測試房間，須由使用者明確執行。不是 mock 整合驗收工具。

- [ ] Node 26 乾淨 clone：npm ci、typecheck、test、audit 成功，記錄實際結果。
- [ ] 正式設定无 mock、真實 OAuth token 成功；過期／無效 token 被拒絕；真實遊戲 API 上限正確。
- [ ] Mac mini LaunchDaemon **未登入開機啟動**且程序為指定非 root 使用者；重啟與 SQLite 持久房間行為成功，備份還原驗證。
- [ ] 外部 WSS 有效 TLS 且 CLI 完成上述流程；無對外 router 開埠。
- [ ] `curl -i https://lobby.ysgs.app` 不回介紹頁；`curl -i http://lobby.ysgs.app` 被拒絕；以 WS upgrade 發 HTTP 亦被拒絕，不能是 redirect／101。
- [ ] 更改設定 domain／port 後重啟生效，Tunnel 同步更新；日誌无 token／密碼。
- [ ] 使用者自行 push main；介紹站回 200，前置 CNAME／LICENSE／.nojekyll 正確。

未有真實端點與上述外部證據前，**真實 OAuth 整合與外部部署驗收維持 blocked**。本機 mock 或模擬 API 測試不能替代它們。CI 僅測程式；Pages workflow 僅手動 dispatch，不自動發布，使用者自行決定啟用／發布。

## 本機驗證紀錄（2026-10-03）

- Node.js **26.7.0**：typecheck／build 成功，`npm test` **40/40**、部署工具安全測試 **4/4** 通過；`npm audit --omit=dev` 為 **0 vulnerabilities**。
- 實際 CLI 啟動後完成驗證、選遊戲、密碼建房、加入、離開、解散；一般 HTTP 回 **426**。
- 另以本機 HTTPS API fixture 與受信任測試憑證完成 **WSS** 全流程，驗證 remote／JWKS 成功、過期及竄改 token 拒絕、遊戲 API 上限與快取。此為模擬外部系統，**不是真實 OAuth 整合驗收**。
- 實際備份 CLI 產物通過 integrity check、保留 schema version 1 並為 0600；無開發旗標的預設 mock 啟動以 exit code 1 拒絕。暫存服務與測試資料已清除。
- SQLite 重啟重載、首位加入者房主移交、寫入失敗不改房間、損毀原檔保留、同時加入、TTL、分頁與成員拆包已由測試覆蓋；介紹頁已在瀏覽器檢查桌面／手機版。
- `PLAN.md` 與桌面企劃書逐 byte 相同。尚未 push／發布 Pages／部署 Mac mini／設定 Cloudflare；Gate D 的遠端推送與 Gate E 的外部驗收仍待使用者操作及真實端點。

## 授權

Apache-2.0，見 [LICENSE](LICENSE)。完整定案企劃見 [PLAN.md](PLAN.md)，開發安全規範見 [AGENTS.md](AGENTS.md)。
