# Beacon.js

以 **WSS + OAuth** 提供遊戲分區大廳的 TypeScript / Node.js 26 服務：先驗證、選遊戲，再列出、建立或加入房間。支援密碼、遊戲 API 指定的人數上限、即時推播與 SQLite 持久化，並涵蓋準備／開局與遊戲場次交接、安全重連、房主管理與封鎖、搜尋與快速加入、好友／隊伍／自動配對、請求冪等與快照、身分更新與撤銷，以及受保護的內部管理與維運介面。不實作帳號系統、遊戲邏輯或前端大廳 UI；`index.html` 只是介紹頁。

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

package.json 指令：`build` = tsc；`typecheck` = tsc --noEmit；`start` = node dist/main.js；`test` = 建置後 node:test；`backup` = node dist/store/backup.js；`restore:drill` = 建置後執行還原演練；`load` = 建置後執行本機容量情境；`verify` = typecheck、test、npm audit --omit=dev。這份文件不是測試已通過的證明。

CI 使用 Node.js **24／26** × **macOS 26（arm64）、Ubuntu 24.04 LTS／26.04 LTS（各含 x64 與 arm64）**，共十組；每組執行 npm ci、typecheck、完整測試、部署工具安全測試與 runtime dependencies audit，單組失敗不取消其他組。Runner 標籤固定為 `macos-26`（本身即 arm64）、`ubuntu-24.04`、`ubuntu-24.04-arm`、`ubuntu-26.04`、`ubuntu-26.04-arm`（[官方可用映像](https://github.com/actions/runner-images#available-images)）。Node.js 24 僅作相容性回歸測試，**不改變正式啟動與部署要求的 Node.js ≥26**；npm 在 Node.js 24 顯示的專案 engine 警告屬預期。

## 設定與正式啟動

**根目錄 `config.yaml` 為唯一部署設定真值**。為避免新增 YAML 解析依賴，檔案只接受 **YAML 1.2 flow-style JSON 結構加 `#` 中文註解**：雙引號 key、花括號與逗號結構；引號外 `#` 至行尾為註解，引號內 `#` 保留。不支援一般 block YAML 縮排語法。所有必要欄位與配額已列於該檔，必須保留完整結構；不以環境變數覆蓋設定。`node dist/main.js --config /absolute/path/config.yaml` 可選擇另一份完整設定。相對路徑以執行工作目錄為基準。工具請呼叫 loadConfig，不可直接 JSON.parse 原始檔。

- `server`：loopback listenHost、listenPort（預設 34568）、trustProxy、trustedProxyAddresses、allowedOrigins、allowNoOrigin。瀏覽器 Origin 必須明列白名單；CLI 無 Origin 是否接受由 allowNoOrigin 決定。
- `public`：domain（預設 lobby.ysgs.app）、tls（proxy / direct）；direct 必須提供 certPath / keyPath，私鑰不得入庫。
- `auth.mode`：正式部署選 `jwks` 或 `remote`，**不能 mock**。JWKS 設完整 jwksUrl、issuer、audience，僅支援 **RS256**，驗證簽章／exp／iss／aud，再取 sub 與 name；remote 的 apiUrl 設 **API base URL**（不是完整 verify 端點），adapter 附加 `/v1/verify`，以 POST + Authorization: Bearer 呼叫，成功回 `{ "playerId": "…", "displayName": "…" }`，401 拒絕。玩家 ID／displayName 上限各 **128 UTF-8 bytes**。驗證不可達 fail-closed，timeoutMs 控制期限。
- `games.apiUrl`：**API base URL**（不是完整清單端點），adapter 附加 `/v1/games` 並 GET，回 `[{"gameId":"…","name":"…","maxPlayersPerRoom":8,"enabled":true}]`，可含 serverHint。遊戲 ID／name 上限各 **128 UTF-8 bytes**，serverHint 上限 **1024 UTF-8 bytes**；maxPlayersPerRoom 必須是後端提供的正安全整數，不把列表 pageSize 上限當作遊戲人數上限。遠端回應受 byte 上限保護。cacheTtlSec 預設 60；遠端失敗採快取或 fallback 並記 warning，不將備援冒充已實串接。fallback 可為空清單；沒有可用遊戲時選取回 `game_not_found`。
- `room.emptyTtlSec`：預設 1800，0 永不清理；`db.path`：預設 data/beacon.db。
- `limits`：驗證／心跳期限、來源連線配額、訊息／密碼限流、房間數、入站 4096 bytes、出站 65536 bytes、背壓與分頁上限。
- `games.sessionApiUrl` / `games.serviceTokenFile`：遊戲場次 API 的 **base URL**，與選用的私密 bearer token 檔（一般檔案、擁有者讀寫 0600、不得為符號連結，內容不入設定檔）。未設定 `sessionApiUrl` 時 `start_game` 回 `game_service_unavailable`，**不以假資料冒充場次**。契約：`POST /v1/matches`（帶 `Idempotency-Key`，回 `{matchId,serverUrl,expiresAt,tickets:{<playerId>:<ticket>}}`）、`POST /v1/matches/:id/admissions`（`{playerId,role}` → `{serverUrl,ticket,expiresAt}`）、`GET /v1/matches/:id`（`{state:starting|in_game|ended|failed}`）、`DELETE /v1/matches/:id`。遊戲可在清單中附選用的 `versions`、`modes`、`regions`（各至多 32 項、每項 64 bytes）。房間人數上限仍完全由遊戲 API 的 `maxPlayersPerRoom` 決定，不另設總量上限；送出的場次請求受序列化後 262144 bytes 限制。
- `auth.revocationUrl` / `auth.revocationTokenFile` / `auth.revocationIntervalMs`：選用的 HTTPS 撤銷清單。每個間隔以 GET 輪詢，**非 mock 必須**帶 `Authorization: Bearer`（token 來自 0600 一般檔，拒絕符號連結；不得把 token 寫進設定檔）。回 `[{"playerId":"…","tokenId":"…","revokedBefore":<ms>}]`（`playerId` 與 `tokenId` 至少一項；`revokedBefore` 僅能搭配 `playerId`）。**設定後即為必要依賴、fail-closed**：拉取失敗時拒絕新驗證並中斷現有連線，直到恢復。遠端驗證可回選用 `issuedAt`（毫秒）與 `tokenId`，JWKS 取 `iat` 與 `jti`；`revokedBefore` 比對時**缺少簽發時間視為已撤銷**。mock 開發可省略 token 檔。
- `lobby`：`reconnectGraceMs`（斷線保留席位，預設 30000，0＝立即離房）、`maxRoomsPerPlayer`（每位擁有者的房間配額，**含已離開的空房**，預設 3）、`requestCacheSize`／`requestCacheTtlMs`（冪等重播，預設 128／120000）、`snapshotTtlMs`、`inviteTtlMs`、`maxSpectators`、`matchmakingWaitMs`、`maxPartySize`。
- `operations`：內部管理 HTTP（`enabled` 預設 false，`listenHost` 僅接受 loopback、`listenPort` 預設 34569、`tokenFile` 為 0600 私密 bearer token 檔）、持久輪替日誌（`logPath`、`logMaxBytes`、`logFiles`）、排程備份（`backupDirectory`、`backupIntervalMs`、`backupRetention`）、告警 webhook（`alertUrl`、`alertTokenFile`、`alertIntervalMs`），以及關機排空期限 `drainTimeoutMs`。各項留空即**明確停用**並記錄，不會假裝成功；管理 HTTP 停用不影響備份與告警。

```sh
npm run build
npm start
```

**預設 mock 設定下 npm start 拒絕啟動是刻意行為**；先填妥真實 OAuth 設定。不要為部署加開發旗標。API 實際契約若不同只改 adapter，參考 [PLAN.md](PLAN.md) 與 [AGENTS.md](AGENTS.md)。

## WSS 協定摘要（protocol v2）

JSON 單物件，未知欄位拒絕；入站單則 4 KB、出站單則 64 KB，大型快照拆包而非截斷。連線後先收到 `hello`（含 `protocolVersion: 2` 與 `capabilities`），須在 authDeadlineMs 內送 `auth`（預設 10 秒；可帶 `protocolVersion: 2`，其他版本回 `unsupported_protocol`）。**任何客戶端訊息都可附 `requestId`**（1–128 字元識別碼）。

```json
{"type":"auth","token":"<OAuth access token>","protocolVersion":2,"requestId":"r1"}
{"type":"refresh_auth","token":"<新的 token>"}
{"type":"select_game","gameId":"g-001","version":"1.0","mode":"ranked","region":"asia"}
{"type":"list_games"}
{"type":"list_rooms","query":"abc","availableOnly":true,"sort":"name","pageSize":50}
{"type":"create_room","name":"一起玩","password":"<room password>","maxPlayers":4,"visibility":"public","joinPolicy":"spectate","maxSpectators":4}
{"type":"join_room","roomId":"<id>","password":"<pw>","role":"player","invitationToken":"<token>"}
{"type":"quick_join"}
{"type":"ready","ready":true}
{"type":"start_game"}
{"type":"update_room","name":"新名稱","locked":true,"password":""}
{"type":"kick_player","playerId":"bob","ban":true}
{"type":"unban_player","playerId":"bob"}
{"type":"transfer_host","playerId":"bob"}
{"type":"invite_player","playerId":"bob"}
{"type":"leave_room"}
{"type":"delete_room"}
{"type":"queue_join","minPlayers":2,"maxPlayers":4}
{"type":"queue_leave"}
{"type":"party_create"}
{"type":"party_invite","playerId":"bob"}
{"type":"party_accept","invitationToken":"<token>"}
{"type":"party_leave"}
{"type":"friend_request","playerId":"carol"}
{"type":"friend_respond","playerId":"carol","accept":true}
{"type":"friend_remove","playerId":"carol"}
{"type":"list_friends"}
{"type":"sync_state"}
{"type":"switch_game","gameId":"g-002"}
{"type":"ping"}
```

**請求回應與冪等。** 帶 `requestId` 的指令，其直接回應（含 `error`）都會帶相同 `requestId`，並以終結訊息 `{"type":"result","requestId":…,"ok":true}` 結束；失敗則為 `{"type":"error",…,"ok":false}`。其他玩家造成的廣播**不帶** `requestId`，所以客戶端應以終結訊息而非廣播判斷完成。同一位已驗證玩家在 `requestCacheTtlMs` 內重送**相同 requestId 與相同內容**，伺服器重播原本的直接回應（標 `replayed:true`，終結訊息並帶 `resyncRequired:true`，客戶端須接著 `sync_state` 再套用狀態），**不會重複執行**；相同 requestId 但內容不同回 `request_conflict`。`ping`、各 `list_*`、`sync_state`、`auth`、`refresh_auth` 不納入冪等快取。

**驗證後的快照。** `auth_ok`（含 `protocolVersion`、`expiresAt`）之後，伺服器在同一個 `auth` 請求內送出完整狀態快照：`session_state`、所在房間的 `room_state`、好友、隊伍與 `queue_state`，最後才是 `result`；客戶端不必再送 `sync_state`。需要時可隨時 `sync_state` 重新取得（在進行中場次內的玩家會因此取得新的 `game_admission`）。

**房間與開局。** 房間狀態為 `open → starting → in_game → open`。房主在全員 `ready` 後 `start_game`，伺服器向遊戲場次 API 建立場次，成功後各成員只收到**屬於自己**的 `game_started`（含 `serverUrl`、`ticket`、`expiresAt`）；場次回報 `ended`／`failed` 時房間回到 `open` 並清除準備狀態。呼叫結果不明確時房間保持 `starting` 並保留原請求，維護程序以同一個 idempotency key 重放，**不虛構完成**。`joinPolicy`：`closed` 開局後禁止加入、`fill` 允許補位、`spectate` 允許觀戰；加入進行中的場次要等遊戲回報 `in_game`，觀戰者容量獨立於玩家、不能 `ready`、不能成為房主。`visibility`：`public` 列出、`unlisted` 不列出、`invite` 須受邀。

**擁有者與房主。** 建立者永遠是 `ownerId`；`hostId` 是目前主持人，可 `transfer_host`，離開時移交最早的在線玩家。擁有者重啟後仍可重新進入自己的上鎖／邀請制房間。`update_room` 可改名稱、密碼（空字串＝移除）、上限（不得低於現有人數）、可見度、上鎖、加入政策；`kick_player` 可帶 `ban` 封鎖該房，`unban_player` 解除。邀請 token 綁定特定玩家與房間、逾期或房間設定變更即失效。

**重連。** 傳輸中斷後席位、準備狀態與房間保留 `lobby.reconnectGraceMs`；期間仍占名額。同一位玩家重新驗證（**必須重新驗證，不能憑 playerId／roomId 取回**）即接回原房間並收到完整快照；逾時才離房並移交房主。同一玩家的新連線會取代舊連線（舊連線收 `session_replaced`，關閉碼 4001）。

**搜尋與快速加入。** `list_rooms` 支援 `query`（不分大小寫）、`availableOnly`、`sort`（`created`｜`name`｜`players`，同值依建立順序）與相容性過濾；加入時 `version`／`mode`／`region` 必須與房間相符，否則 `incompatible_version`。`page` 從 1 起算，依 `nextPage` 取下一頁；改用 `cursor` 可取得**穩定快照**（逾 `snapshotTtlMs` 回 `snapshot_expired`，且只限原玩家使用）。`quick_join` 只會選公開、未上鎖、相容且有空位的房間，找不到回 `room_not_found`。

**好友、隊伍與配對。** 好友需雙方同意，任一方可移除；在線狀態只對好友可見。隊伍由隊長邀請，`queue_join` 以隊伍為單位**不拆開**，依 FIFO 與遊戲／版本／模式／區域／人數範圍配對，配成後建立真實持久房間並送 `match_found`，之後仍須各自 `ready` 並 `start_game`；逾 `matchmakingWaitMs` 或離線會自動退出佇列。

**快照、revision 與拆包。** 房間與大廳訊息帶 `revision`／`lobbyRevision`，客戶端應丟棄較舊者。大型成員、房間、好友、遊戲清單與隊伍快照會拆包：每包帶同一個 `snapshotId`、**從 0 起算的 `chunkIndex`** 與 `chunkCount`，須收齊同一 `snapshotId` 的全部分包再套用。單一項目本身超過出站上限時（例如極大的遊戲相容性清單）改用 `{"type":"snapshot_chunk","snapshotType","snapshotId","revision","chunkIndex","chunkCount","payload"}`，把原訊息 JSON 切段，依 `chunkIndex` 串接 `payload` 後即為完整原訊息。官方 SDK 已處理這些情況。

**身分更新與撤銷。** token 到期前客戶端以 `refresh_auth` 在同一連線更新（必須是同一個玩家，否則 `forbidden`），Beacon 不保存 refresh token。管理員封禁／撤銷（見下）與 `auth.revocationUrl` 都會即時影響連線中的玩家；封禁持久化於 SQLite，重啟後仍有效。密碼猜測限制以**玩家**為單位，斷線重連不會重置。

**維護與關機。** 維護模式會拒絕新的驗證、建房、加入、配對與開局；既有連線不受影響。關機時先對所有連線送 `{"type":"server_draining","deadline":<ms>}`，等待 `operations.drainTimeoutMs` 後才關閉。

驗證失敗 `auth_fail` 後斷線；其餘 error `{code,message}`。協定 v2 新增錯誤碼：`forbidden`、`not_ready`、`invalid_state`、`game_service_unavailable`、`incompatible_version`、`invitation_required`、`invitation_expired`、`player_banned`、`maintenance`、`request_conflict`、`not_in_party`、`party_full`、`queue_timeout`、`token_revoked`、`unsupported_protocol`、`snapshot_expired`；完整表以 src/protocol/ 為準。未 `select_game` 不得取得房間；列表預設 50、上限 200；空房保留 `hostId`，首位加入者成為新房主；重啟保留房間、密碼雜湊、上限、擁有者、封鎖名單與 `hostId`，但成員清空。

## Client SDK

`src/client/` 是不依賴 `ws` 的 protocol v2 SDK（瀏覽器與 Node 通用；匯出路徑 `@js-package/beacon/client`，建置後為 `dist/client/index.js`）。預設只接受 `wss://`；本機開發才可明確傳 `allowInsecure: true`。

```js
import { BeaconClient } from '@js-package/beacon/client';
const client = new BeaconClient({ url: 'wss://lobby.ysgs.app', token: () => getAccessToken() });
client.on('state', state => render(state));
await client.connect();                       // 驗證並取得完整快照
await client.selectGame('g-001', { version: '1.0' });
const { messages } = await client.createRoom({ name: '一起玩', maxPlayers: 4 });
await client.setReady(true);
await client.startGame();
```

每個請求以 `requestId` 關聯並等到終結訊息才完成；逾時與斷線會釋放暫存並回 `BeaconError`。**會改變狀態的指令預設不會在重連後自動重送**，需要時明確傳 `{ retryOnReconnect: true }`，伺服器以相同 `requestId` 去重。SDK 依 `snapshotId`／`revision` 組裝分包、丟棄過期狀態，自動以 `token()` 在到期前 `refresh_auth`，並以退避加抖動重連；永久性拒絕（被取代、驗證失敗）不會無限重連。

## 內部管理與維運

`operations.enabled: true` 才會在 loopback 開啟管理 HTTP（對外網域仍只接受 WSS，不提供任何網頁）。**所有端點都需要** `Authorization: Bearer <token>`（token 來自 0600 私密檔，以常數時間比對）：

- `GET /health`、`GET /ready`（維護模式、撤銷清單失效或儲存層失敗時為 503）、`GET /metrics`（僅彙總數值，不含玩家 ID 或憑證）、`GET /audit?limit=1..200`。
- `POST /ban {playerId,until,reason}`、`/unban {playerId}`、`/revoke {playerId,before}`、`/rooms/close {roomId}`、`/maintenance {enabled}`。每項管理操作都寫入持久稽核紀錄。

排程備份使用 SQLite backup API 產生私密（0600）快照並只輪替自己建立的檔案；日誌為私密檔案、依大小輪替並遮蔽 token／ticket／authorization／密碼；告警 webhook 僅送 `service`／`event`／`at`，有冷卻時間。**還原演練**會在隔離的暫存位置對備份跑完整性檢查與遷移並驗證房間可載入，從不改動原檔或運作中的資料：

```sh
npm run restore:drill -- /absolute/private/backups/beacon-backup-….sqlite
```

本機容量情境（`npm run load -- --clients 800 --rounds 2 --room-size 8`）用真實 WebSocket 客戶端對隔離的暫時伺服器反覆建房、加入、準備、離開與解散並回報延遲、事件迴圈延遲與記憶體；**這只是單機回歸量測，不是正式容量保證**。


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

## 本機驗證紀錄（2026-10-04，v2 擴充）

- Node.js **26.7.0**：`npm run verify` 通過——typecheck、`npm test` **91/91**、`npm audit --omit=dev` **0 vulnerabilities**；部署工具安全測試 **4/4**。完整測試重複執行多次皆全數通過。
- 以真實伺服器、真實 `HttpGameSessions` 經 HTTP 對遊戲場次 fixture（驗證 `Idempotency-Key`、bearer token）與 SDK 客戶端完成：未準備拒絕開局且不呼叫遊戲服務 → 準備 → 開局 → 每位玩家只收到自己的 ticket、服務 token 不外洩 → 場次回報 `in_game` 後觀戰者以 provider 入場 → 玩家斷線於保留期內重連，回到同一房間並取得**單一**新入場 → 場次 `ended` 後房間回到 `open`。
- 同樣以真實伺服器驗證：受邀制（邀請綁定對象）、上鎖、踢人封鎖／解封、移交房主、依名稱排序與關鍵字過濾、`quick_join`、**重連後仍有效**的密碼猜測限制、好友需同意與在線狀態、隊伍以整組配對進同一房間、`queue_leave`。
- 實際執行備份路徑（0600、約 7 ms）與 `restore:drill`（完整性 ok、房間可載入、遷移版本 `[1,2]`；壞檔被拒絕且原檔不變）。外部驗收 CLI 與預設設定的正式啟動仍拒絕 mock。
- 本機容量情境（800 位大廳在線者、8 人房間，單機且客戶端同程序）：建房／加入／準備／離開／解散 6400 次請求，p50 約 8.9 ms、p95 約 28.7 ms，結束時房間、預留席位與處理中請求皆為 0。修正前同情境每請求約 602 則訊息，修正後約 404 則。**這不是正式容量保證**；事件迴圈延遲在此量測中受同程序客戶端影響，未據以宣稱改善。
- 上述端到端腳本為一次性驗證，已移除，不屬測試套件；其中的外部系統（遊戲場次、驗證）皆為本機模擬。**尚未驗證**：真實 OAuth 與真實遊戲場次 API 整合、Cloudflare Tunnel／Mac mini 部署、CI 十組矩陣與 Node.js 24（本機只跑 Node 26.7.0）。
- 尚未 push／發布 Pages／部署 Mac mini／設定 Cloudflare；Gate D 的遠端推送與 Gate E 的外部驗收仍待使用者操作及真實端點。`PLAN.md` 已升為 v2.0，**不再與桌面企劃書逐 byte 相同**（桌面檔案未動）。

## 授權

Apache-2.0，見 [LICENSE](LICENSE)。完整定案企劃見 [PLAN.md](PLAN.md)，開發安全規範見 [AGENTS.md](AGENTS.md)。
