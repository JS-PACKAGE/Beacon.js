# Beacon.js

以 **WSS + OAuth** 提供遊戲分區大廳的 TypeScript / Node.js 26 服務。包含持久房間與私人場次結果、好友／封鎖、邀請收件匣、隊伍原子進房、配對確認、可信技能／角色／延遲配對、房間／隊伍聊天與檢舉、型別 SDK，以及受保護的管理介面；可選擇單機或 **etcd quorum 協調的跨主機 HA**。不實作帳號系統、遊戲邏輯、排名資料庫或前端大廳 UI；`index.html` 只是介紹頁。

```text
遊戲客戶端 ─ WSS ─ Cloudflare Tunnel ─ loopback ─ Beacon.js
                                              ├ OAuth API / JWKS
                                              ├ 遊戲 API（快取與備援）
                                              ├ SQLite（本機持久資料／HA materialization）
                                              └ 可選 etcd quorum + 私有 WSS authority
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

`build` 先由 TypeScript 型別產生雙向 `protocol.schema.json`，再編譯服務與獨立 SDK；`typecheck` 產生 schema 後執行 tsc --noEmit；`test` 建置後執行 node:test；`verify` 執行 typecheck、test、runtime audit。`backup`、`restore:drill`、`load` 分別是備份、隔離還原演練、本機容量工具；`pack:client` 準備 SDK tarball，**不發布**。這份文件不是測試已通過的證明。

CI 使用 Node.js **24／26** × **macOS 26（arm64）、Ubuntu 24.04 LTS／26.04 LTS（各含 x64 與 arm64）**，共十組；每組執行 npm ci、typecheck、完整測試、部署工具安全測試與 runtime dependencies audit，單組失敗不取消其他組。Runner 標籤固定為 `macos-26`（本身即 arm64）、`ubuntu-24.04`、`ubuntu-24.04-arm`、`ubuntu-26.04`、`ubuntu-26.04-arm`（[官方可用映像](https://github.com/actions/runner-images#available-images)）。Node.js 24 僅作相容性回歸測試，**不改變正式啟動與部署要求的 Node.js ≥26**；npm 在 Node.js 24 顯示的專案 engine 警告屬預期。

## 設定與正式啟動

**根目錄 `config.yaml` 為唯一部署設定真值**。為避免新增 YAML 解析依賴，檔案只接受 **YAML 1.2 flow-style JSON 結構加 `#` 中文註解**：雙引號 key、花括號與逗號結構；引號外 `#` 至行尾為註解，引號內 `#` 保留。不支援一般 block YAML 縮排語法。所有必要欄位與配額已列於該檔，必須保留完整結構；不以環境變數覆蓋設定。`node dist/main.js --config /absolute/path/config.yaml` 可選擇另一份完整設定。相對路徑以執行工作目錄為基準。工具請呼叫 loadConfig，不可直接 JSON.parse 原始檔。

- `server`：loopback listenHost、listenPort（預設 34568）、trustProxy、trustedProxyAddresses、allowedOrigins、allowNoOrigin。瀏覽器 Origin 必須明列白名單；CLI 無 Origin 是否接受由 allowNoOrigin 決定。
- `public`：domain（預設 lobby.ysgs.app）、tls（proxy / direct）；direct 必須提供 certPath / keyPath，私鑰不得入庫。
- `auth.mode`：正式部署選 `jwks` 或 `remote`，**不能 mock**。JWKS 設完整 jwksUrl、issuer、audience，僅支援 **RS256**，驗證簽章／exp／iss／aud，再取 sub 與 name；remote 的 apiUrl 設 **API base URL**（不是完整 verify 端點），adapter 附加 `/v1/verify`，以 POST + Authorization: Bearer 呼叫，成功回 `{ "playerId": "…", "displayName": "…" }`，401 拒絕。玩家 ID／displayName 上限各 **128 UTF-8 bytes**。驗證不可達 fail-closed，timeoutMs 控制期限。
- `games.apiUrl`：**API base URL**（不是完整清單端點），adapter 附加 `/v1/games` 並 GET，回 `[{"gameId":"…","name":"…","maxPlayersPerRoom":8,"enabled":true}]`，可含 serverHint。遊戲 ID／name 上限各 **128 UTF-8 bytes**，serverHint 上限 **1024 UTF-8 bytes**；maxPlayersPerRoom 必須是後端提供的正安全整數，不把列表 pageSize 上限當作遊戲人數上限。遠端回應受 byte 上限保護。cacheTtlSec 預設 60；遠端失敗採快取或 fallback 並記 warning，不將備援冒充已實串接。fallback 可為空清單；沒有可用遊戲時選取回 `game_not_found`。
- `room.emptyTtlSec`：預設 1800，0 永不清理；`db.path`：預設 data/beacon.db。
- `limits`：驗證／心跳期限、來源連線配額、訊息／密碼限流、房間數、入站 4096 bytes、出站 65536 bytes、背壓與分頁上限。
- `games.sessionApiUrl` / `games.serviceTokenFile`：場次 API **base URL** 與選用的私密 bearer token 檔（0600 一般檔，拒絕符號連結）。未設定 API 時 `start_game` 回 `game_service_unavailable`，不提供假場次。`POST /v1/matches` 帶 `Idempotency-Key`，body 包含玩家、相容性與 `rules`；配對分配以 `players[].team`／`players[].gameRole` 傳送。回 `{matchId,serverUrl,expiresAt,tickets:{<playerId>:<ticket>}}`。另有 `POST /v1/matches/:id/admissions`（`{playerId,role}` → `{serverUrl,ticket,expiresAt}`）、`GET /v1/matches/:id`（`{state:starting|in_game|ended|failed}`）、`DELETE /v1/matches/:id`。`versions`／`modes`／`regions` 各至多 32 項、每項 64 bytes；場次 body 上限 262144 bytes。`rules` 至多 16 鍵、JSON 1024 UTF-8 bytes，值為字串、布林或有限數值（可含小數，若 descriptor 指定 `integer:true` 才限整數），不得超出安全數值範圍。結束／個人結果由遊戲呼叫管理 HTTP。
- `auth.revocationUrl` / `auth.revocationTokenFile` / `auth.revocationIntervalMs`：選用的 HTTPS 撤銷清單。每個間隔以 GET 輪詢，**非 mock 必須**帶 `Authorization: Bearer`（token 來自 0600 一般檔，拒絕符號連結；不得把 token 寫進設定檔）。回 `[{"playerId":"…","tokenId":"…","revokedBefore":<ms>}]`（`playerId` 與 `tokenId` 至少一項；`revokedBefore` 僅能搭配 `playerId`）。**設定後即為必要依賴、fail-closed**：拉取失敗時拒絕新驗證並中斷現有連線，直到恢復。遠端驗證可回選用 `issuedAt`（毫秒）與 `tokenId`，JWKS 取 `iat` 與 `jti`；`revokedBefore` 比對時**缺少簽發時間視為已撤銷**。mock 開發可省略 token 檔。
- `lobby`：重連、房間／隊伍配額與冪等／快照期限；`matchConfirmMs`（預設 15000）控制配對確認；`resultRetentionMs`（7 天）／`maxResults`（50000）限制私人結果；`invitationRetentionMs`（1 天）保留終態邀請。擁有者的空房仍計入 `maxRoomsPerPlayer`，不因建新房自動刪除。
- `operations`：內部管理 HTTP（`enabled` 預設 false，`listenHost` 僅接受 loopback、`listenPort` 預設 34569、`tokenFile` 為 0600 私密 bearer token 檔）、持久輪替日誌（`logPath`、`logMaxBytes`、`logFiles`）、排程備份（`backupDirectory`、`backupIntervalMs`、`backupRetention`）、告警 webhook（`alertUrl`、`alertTokenFile`、`alertIntervalMs`），以及關機排空期限 `drainTimeoutMs`。各項留空即**明確停用**並記錄，不會假裝成功；管理 HTTP 停用不影響備份與告警。
- `games.profileApiUrl` / `profileMaxAgeMs`：可信配對資料 API base URL 與 freshness 上限（預設 60000 ms）。**advanced 必須另提供 serviceTokenFile**；沒有後端／憑證、資料缺漏／過期均拒絕，不改用自報技能或 basic 模式。
- `matching`：明確設定 `skillSpread`／`maxSkillSpread`、`teamSkillDelta`／`maxTeamSkillDelta`、`latencyMs`／`maxLatencyMs`、`relaxAfterMs`／`relaxEveryMs`、`skillStep`／`latencyStep` 與 `searchLimit`。只在設定的等待期限後逐步放寬到上限；搜尋預算用盡回 `matchmaking_search_exhausted` 並保留佇列，不任意拆隊或選不合規陣容。
- `chat`：`maxTextLength`（預設 500 字、最高 2000，仍受入站 byte 上限約束）、歷史／檢舉保留時間與筆數、獨立 `burst`／`windowMs` 限流、`maxMuteMs`。不提供全域聊天。
- `cluster`：預設停用；正式 HA 的 TLS、etcd 認證、authority 選舉、資料大小與 checkpoint 設定見下節。新設定完整結構以根目錄檔案為準，舊設定不可省略新增區段。

```sh
npm run build
npm start
```

**預設 mock 設定下 npm start 拒絕啟動是刻意行為**；先填妥真實 OAuth 設定。不要為部署加開發旗標。API 實際契約若不同只改 adapter，參考 [PLAN.md](PLAN.md) 與 [AGENTS.md](AGENTS.md)。

## WSS 協定摘要（protocol v3）

JSON 單物件，未知欄位拒絕；入站單則 4 KB、出站單則 64 KB，大型快照拆包而非截斷。連線後先收到 `hello`（含 `protocolVersion: 3` 與 `capabilities`），須在 authDeadlineMs 內送 `auth`（預設 10 秒；可帶 `protocolVersion: 3`，其他版本回 `unsupported_protocol`）。**v2 SDK 不相容，服務與 SDK 必須一起切換。** 任何客戶端訊息都可附 `requestId`（1–128 字元識別碼）。

```json
{"type":"auth","token":"<OAuth access token>","protocolVersion":3,"requestId":"r1"}
{"type":"refresh_auth","token":"<新的 token>"}
{"type":"select_game","gameId":"g-001","version":"1.0","mode":"ranked","region":"asia"}
{"type":"list_games"}
{"type":"list_rooms","query":"abc","availableOnly":true,"sort":"name","pageSize":50}
{"type":"create_room","name":"一起玩","password":"<room password>","maxPlayers":4,"visibility":"public","joinPolicy":"spectate","maxSpectators":4,"rules":{"map":"harbor"}}
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
{"type":"delete_room","roomId":"<owned empty room>"}
{"type":"list_owned_rooms"}
{"type":"block_player","playerId":"bob"}
{"type":"unblock_player","playerId":"bob"}
{"type":"list_blocks"}
{"type":"queue_join","minPlayers":2,"maxPlayers":4,"matching":"basic"}
{"type":"queue_join","minPlayers":4,"maxPlayers":4,"matching":"advanced","rolePreferences":["tank"]}
{"type":"match_accept","proposalId":"<proposal>"}
{"type":"match_decline","proposalId":"<proposal>"}
{"type":"queue_leave"}
{"type":"party_create"}
{"type":"party_invite","playerId":"bob"}
{"type":"party_accept","invitationToken":"<token>"}
{"type":"party_leave"}
{"type":"party_transfer_leader","playerId":"bob"}
{"type":"party_kick","playerId":"bob"}
{"type":"party_disband"}
{"type":"party_join_room","roomId":"<room>","password":"<pw>"}
{"type":"list_invitations","direction":"incoming"}
{"type":"decline_invitation","invitationToken":"<token>"}
{"type":"revoke_invitation","invitationToken":"<token>"}
{"type":"list_match_results","limit":50}
{"type":"ack_match_result","resultId":"<result>"}
{"type":"chat_send","scope":"room","text":"一起出發"}
{"type":"chat_history","scope":"party","limit":50}
{"type":"chat_report","messageId":"<message>","reason":"不當內容"}
{"type":"friend_request","playerId":"carol"}
{"type":"friend_respond","playerId":"carol","accept":true}
{"type":"friend_remove","playerId":"carol"}
{"type":"list_friends"}
{"type":"sync_state"}
{"type":"switch_game","gameId":"g-002"}
{"type":"ping"}
```

**請求回應與冪等。** 帶 `requestId` 的指令，其直接回應（含 `error`）都會帶相同 `requestId`，並以終結訊息 `{"type":"result","requestId":…,"ok":true}` 結束；失敗則為 `{"type":"error",…,"ok":false}`。其他玩家造成的廣播**不帶** `requestId`，所以客戶端應以終結訊息而非廣播判斷完成。同一位已驗證玩家在 `requestCacheTtlMs` 內重送**相同 requestId 與相同內容**，伺服器重播原本的直接回應（標 `replayed:true`，終結訊息並帶 `resyncRequired:true`，客戶端須接著 `sync_state` 再套用狀態），**不會重複執行**；相同 requestId 但內容不同回 `request_conflict`。`ping`、各 `list_*`、`sync_state`、`auth`、`refresh_auth` 不納入冪等快取。

**驗證後的快照。** `auth_ok` 之後，在同一請求內送出 session／房間／好友／隊伍／佇列／配對提案、待處理邀請與未 ACK 私人結果，再送 terminal `result`。需要時可 `sync_state`；進行中場次的玩家會經 provider 取得新的私人 `game_admission`。

**房間與開局。** 房間狀態為 `open → starting → in_game → open`。房主在全員 `ready` 後 `start_game`，伺服器向遊戲場次 API 建立場次，成功後各成員只收到**屬於自己**的 `game_started`（含 `serverUrl`、`ticket`、`expiresAt`）；場次回報 `ended`／`failed` 時房間回到 `open` 並清除準備狀態。呼叫結果不明確時房間保持 `starting` 並保留原請求，維護程序以同一個 idempotency key 重放，**不虛構完成**。`joinPolicy`：`closed` 開局後禁止加入、`fill` 允許補位、`spectate` 允許觀戰；加入進行中的場次要等遊戲回報 `in_game`，觀戰者容量獨立於玩家、不能 `ready`、不能成為房主。`visibility`：`public` 列出、`unlisted` 不列出、`invite` 須受邀。

**擁有者與房主。** 建立者永遠是 `ownerId`；`hostId` 是目前主持人，可 `transfer_host`，離開且寬限結束時移交最早的在線玩家或保留席，無人則回到擁有者。擁有者重啟後仍可重新進入自己的上鎖／邀請制房間，也可以 `list_owned_rooms` 後刪除自己名下、沒有其他成員／保留席／預留名額的空房；非擁有者回 `forbidden`。配額仍計入還沒刪的空房。`update_room` 可改名稱、密碼（空字串＝移除）、上限（不得低於現有人數）、可見度、上鎖、加入政策與 `rules`（空物件＝清除）；變更會撤銷既有邀請。`kick_player` 可帶 `ban` 封鎖該房，`unban_player` 解除。邀請 token 綁定特定玩家與房間、逾期或房間設定變更即失效。

**重連。** 傳輸中斷後席位、準備狀態與房間保留 `lobby.reconnectGraceMs`；期間仍占名額。同一位玩家重新驗證（**必須重新驗證，不能憑 playerId／roomId 取回**）即接回原房間並收到完整快照；逾時才離房並移交房主。同一玩家的新連線會取代舊連線（舊連線收 `session_replaced`，關閉碼 4001）。

**搜尋與快速加入。** `list_rooms` 支援 `query`（不分大小寫）、`availableOnly`、`sort`（`created`｜`name`｜`players`，同值依建立順序）與相容性過濾；加入時 `version`／`mode`／`region` 必須與房間相符，否則 `incompatible_version`。`page` 從 1 起算，依 `nextPage` 取下一頁；改用 `cursor` 可取得**穩定快照**（逾 `snapshotTtlMs` 回 `snapshot_expired`，且只限原玩家使用）。`quick_join` 只會選公開、未上鎖、相容且有空位的房間，找不到回 `room_not_found`。

**好友、封鎖、邀請、隊伍。** 好友需雙方同意；`block_player` 持久化並原子關閉既有好友關係、待處理邀請與不相容的隊伍／佇列／配對提案，解除封鎖不恢復舊同意。`list_blocks` 只回自己的名單。邀請可查 incoming／outgoing mailbox，保留 `pending`／`accepted`／`declined`／`revoked`／`expired` 狀態；只有收件人能拒絕、寄件人能撤回。隊長可移交、踢人、解散；`party_join_room` 先預留整隊名額，密碼／場次 admission 在序列化佇列外執行，回來重驗所有成員，成功才原子入房，失敗不留下半隊。

**配對確認與可信配對。** `queue_join` 預設 basic FIFO，整隊不可拆分。找齊陣容後先送 `match_proposal`；**所有玩家 `match_accept` 才建立房間並送 `match_found`**，仍須準備／開局。拒絕、逾期、斷線等會取消提案；其餘仍合格的隊伍回佇列並保留原等待時間。等待與提案持久化，但恢復後玩家仍須重新 auth，離線者不會被新配對。advanced 使用遊戲後端的可信技能／實測區域 RTT，遵守隊伍、角色需求、隊伍技能差與等待放寬上限；profile 在入列、接受與維護時重驗 freshness，不提供假排序或不可信 fallback。

**場次結果。** `matchId` 與原始 roster 獨立持久化；玩家離房、寬限結束、房間刪除或重啟後仍能收結果。回報只接受原 roster 成員；同內容重複回報冪等、不同內容衝突。`list_match_results` 只回本人，包含已 ACK 歷史；`ack_match_result` 持久化 ACK。登入／重連只推未 ACK 結果，傳送成功不等於 ACK，保留期限／筆數到達才清理。

**聊天與檢舉。** `chat_send`／`chat_history` 限 room 或 party；歷史只給訊息原收件人且仍屬該 scope 的成員，新成員看不到加入前私人訊息。封鎖影響即時與歷史。房主／隊長以 `chat_mute{scope,playerId,until}` 對有權限的成員禁言；`chat_report` 只能檢舉自己有權見到的訊息，持久保留有限證據供管理員審查。一般日誌與 metrics 不保存聊天本文。

**快照、revision 與拆包。** 房間與大廳訊息帶 `revision`／`lobbyRevision`，客戶端應丟棄較舊者。大型成員、房間、好友、遊戲清單與隊伍快照會拆包：每包帶同一個 `snapshotId`、**從 0 起算的 `chunkIndex`** 與 `chunkCount`，須收齊同一 `snapshotId` 的全部分包再套用。單一項目本身超過出站上限時（例如極大的遊戲相容性清單）改用 `{"type":"snapshot_chunk","snapshotType","snapshotId","revision","chunkIndex","chunkCount","payload"}`，把原訊息 JSON 切段，依 `chunkIndex` 串接 `payload` 後即為完整原訊息。官方 SDK 已處理這些情況。

**身分更新與撤銷。** token 到期前客戶端以 `refresh_auth` 在同一連線更新（必須是同一個玩家，否則 `forbidden`），Beacon 不保存 refresh token。管理員封禁／撤銷（見下）與 `auth.revocationUrl` 都會即時影響連線中的玩家；封禁持久化於 SQLite，重啟後仍有效。密碼猜測限制以**玩家**為單位，斷線重連不會重置。

**維護與關機。** 維護模式會拒絕新的驗證、建房、加入、配對與開局；既有連線不受影響。關機時先對所有連線送 `{"type":"server_draining","deadline":<ms>}`，等待 `operations.drainTimeoutMs` 後才關閉。

驗證失敗 `auth_fail` 後斷線；錯誤碼以 `src/protocol/` 與 `protocol.schema.json` 為準，含 `profile_unavailable`、`matchmaking_search_exhausted`、`request_indeterminate`、`chat_muted` 等。重啟保留房間、寬限席、社交、邀請終態、配對佇列／提案、場次／私人結果／ACK、聊天與管理處分；**連線、列表游標不恢復**。SQLite migration 自動升至 schema 5；舊席位結果轉為私人 inbox，無可信寄件者的舊邀請 fail-closed 失效，需重新邀請。升級前先備份，禁止混跑 v2／v3。

## Client SDK

`src/client/` 建置為獨立 **`@js-package/beacon-client` v3.0.0**，瀏覽器與 Node（≥22）通用、無執行期第三方相依，也不 import `ws`／伺服器模組；根服務仍是 private package，**移除舊 `@js-package/beacon/client` 匯出**。預設只接受 WSS，本機開發才可 `allowInsecure:true`。

尚未發布 registry；先 `npm run pack:client`，再於 consumer 執行 `npm install /path/to/js-package-beacon-client-3.0.0.tgz`。詳細 exports／型別契約見 [SDK README](packages/client/README.md)。

```js
import { BeaconClient } from '@js-package/beacon-client';
const client = new BeaconClient({ url: 'wss://lobby.ysgs.app', token: () => getAccessToken() });
client.on('state', state => render(state));
client.on('match_proposal', proposal => showConfirmation(proposal.proposalId));
await client.connect();                       // 驗證並取得完整快照
await client.selectGame('g-001', { version: '1.0' });
const { messages } = await client.createRoom({ name: '一起玩', maxPlayers: 4 });
await client.setReady(true);
await client.startGame();
```

事件與 `BeaconResult.get(type)` 是完整 discriminated union 型別；state 正規化好友、隊伍、邀請、封鎖、佇列、提案與**未 ACK 結果 inbox**（已 ACK 歷史只留在 typed 查詢回應）。每個請求等待 terminal response；逾時／斷線回 `BeaconError`。所有 convenience methods 接受 `RequestOptions.signal`；AbortSignal 清除等待與 listener，但**不能回滾伺服器已提交操作**。mutation 預設不重送，明確 `retryOnReconnect:true` 才以原 requestId 重試；HA 的未知 outcome 不會重執行。SDK 處理快照分包／revision、token 更新與退避重連，永久拒絕不無限重連。雙向機器 schema 隨 package 發行，不以鬆散物件假裝型別安全。

## 內部管理與維運

`operations.enabled: true` 才會在 loopback 開啟管理 HTTP（對外網域仍只接受 WSS，不提供任何網頁）。**所有端點都需要** `Authorization: Bearer <token>`（token 來自 0600 私密檔，以常數時間比對）：

- `GET /health`、`GET /ready`（維護模式、撤銷清單失效或儲存層失敗時為 503）、`GET /metrics`（僅彙總數值，不含玩家 ID 或憑證）、`GET /audit?limit=1..200`。
- `GET /rooms?limit=1..200&cursor=…`、`GET /rooms/:id`、`GET /matches?limit=…&cursor=…`、`GET /matches/:id`、`GET /queue`、`GET /integrations`、`GET /cluster`：安全欄位投影，不回房密／雜湊、token 或 tickets。診斷頁同時受 65536-byte 上限，可能不足 limit，必須依 `nextCursor` 繼續。
- `GET /chat/reports?limit=…&cursor=…`、`GET /chat/reports/:id`、`POST /chat/reports/review {reportId,action,until,reason}`（action 為 dismiss／mute／ban）：只有私有 bearer 管理員可看有限證據／審查。dismiss 的 until 必須 0，mute／ban 必須未來時間；reason 上限 256 UTF-8 bytes。
- `POST /ban {playerId,until,reason}`、`/unban {playerId}`、`/revoke {playerId,before}`、`/rooms/close {roomId}`、`/maintenance {enabled}`、`/matches/result {matchId,state}`（ended／failed）、`/matches/player-result {matchId,playerId,result}`。結果不依賴房間／保留席存在；回報非原 roster 或衝突內容會拒絕，找不到場次回 404。
- `POST /matches/reconcile {matchId}`：經 GameSessionProvider 查真實狀態，HTTP 在佇列外，回來重驗再更新與稽核，不強制假完成。所有管理 mutation 都持久稽核；HA 非 authority 會明確回 `not_leader`，依 `/cluster` 定位 authority 後再操作，勿盲重送不明 outcome。

排程備份使用 SQLite backup API 產生私密（0600）快照並只輪替自己建立的檔案；日誌為私密檔案、依大小輪替並遮蔽 token／ticket／authorization／密碼。告警 webhook 本文只有 `service`、`event`、`severity`、`id`、`at`（`backup_failed` 為 `critical`，`not_ready` 為 `warning`），有冷卻時間，不含玩家 ID 或憑證。**還原演練**會在隔離的暫存位置對備份跑完整性檢查與遷移並驗證房間可載入，從不改動原檔或運作中的資料：

```sh
npm run restore:drill -- /absolute/private/backups/beacon-backup-….sqlite
```

本機容量情境（`npm run load -- --clients 800 --rounds 2 --room-size 8`）用真實 WebSocket 客戶端對隔離的暫時伺服器反覆建房、加入、準備、離開與解散並回報延遲、事件迴圈延遲與記憶體；**這只是單機回歸量測，不是正式容量保證**。

## 跨主機 HA（選用，不共用 SQLite 檔）

```text
多個 loopback WSS gateways ─ 私網 WSS ─ 當前 authority（單一 RoomManager）
                                      │ lease / epoch fencing
                                3 或 5 個 etcd quorum 節點
                                      │ 原生 SQLite changeset journal + 分塊 checkpoint
                                各主機本機 SQLite materialization
```

1. 由基礎設施管理者建立 **etcd v3 JSON gateway**（已實測 v3.7.2），跨 failure domains 放置 3／5 個成員。client／peer 網路皆用私網、TLS 與認證；建立只准存取本服務 prefix 的專屬帳號，不用本機 smoke 的 root 帳號。設定 etcd 自身的 compaction／defrag 與受保護的 snapshot 備份；Beacon **不執行全域 etcd compaction**。
2. 每台 Beacon 使用自己的完整 config 與**唯一 nodeId、本機 db.path**，共用 endpoints／prefix／control secret。`cluster.enabled:true`、`development:false`，endpoints 只允許 HTTPS；etcd.username、passwordPath、caPath 必填，client certPath／keyPath 選用且成對。secret／password／私鑰均為私密一般檔，禁止入庫。
3. control.listenHost 仍僅 loopback；設定 certPath／keyPath／caPath 與各主機不同的 **wss:// 私網 advertiseUrl**。以私網 TLS pass-through 或重新加密代理轉送到 loopback 控制埠，保留 advertiseUrl 的 Host；程序仍要求 TLS 與 shared bearer secret，並重驗 gateway 轉送的來源 IP／Origin。此私有網域不得接到公開 `lobby.ysgs.app`，管理 HTTP 也不對外轉送。
4. 每個 gateway 的公開 upstream 仍透過原有 Cloudflare WSS 規則接入 loopback。不要用網路磁碟放 SQLite，也不要在各 gateway 各建獨立房間狀態；實際 mutation 全部路由 authority。
5. 從既有單機移轉：停止舊服務並以 backupDatabase 備份；先只啟動持有正確 DB 的一個節點，讓它 bootstrap 空 prefix，再啟動其他節點。**不可同時用不同舊資料 bootstrap 同一 prefix**。已有 authority 時，接管／重啟以 etcd journal／checkpoint 為真值，本機舊 DB 不會覆蓋 authority。
6. lease／quorum 遺失時 fail-closed、關閉受影響連線；SDK 重新驗證／同步後恢復。SQLite changeset 先經 epoch-guarded etcd transaction 持久提交，再本機 COMMIT、再 ACK；若遠端已提交而本機失敗，立即 self-fence。小 mutation 不輸出整庫；checkpoint 分塊且有 manifest／大小／hash 檢查，還原衝突 abort，不跳過資料。
7. HA request outcome 跨重啟去重，容量受每玩家配額與總量上限限制；內容只存雜湊。已知終態依 TTL 淘汰，**未知 outcome 留下有界 indeterminate tombstone，不過期後冒險重做**；容量用盡 fail-closed，管理診斷只回彙總。不得換新 requestId 盲重送付款／場次配置等不明操作，先由 provider 與管理員 reconcile。
8. `/cluster` 是每節點的協調／lease／還原診斷；`/ready` 是本節點 authority readiness，非 leader 回 503，**不代表其 gateway 不可轉送**。業務管理查詢／mutation 只由 leader 處理。quorum 不健康時所有節點 readiness 均失敗。

**隔離演練工具（勿對 production quorum 執行）**：

```sh
npm run build
node scripts/cluster-smoke.mjs --endpoints http://127.0.0.1:23791,http://127.0.0.1:23792,http://127.0.0.1:23793 --base-port 29100 --quorum-marker /private/tmp/quorum-lost
```

需事先建立三個專用 etcd 節點；工具只建立隔離 namespace、三個暫時 Beacon 與本機 mock 遊戲 API，不安裝／停止／改設定 etcd。印出 QUORUM_READY 後，由基礎設施擁有者停止兩個**專用測試**成員，再建立 marker，工具驗證拒絕寫入與 503 readiness；沒有 marker 不宣稱測過 quorum loss。可加 `--tls-directory DIR --etcd-user USER --etcd-password-file PATH`，此模式需 HTTPS endpoints，DIR 含 server.pem／server.key／ca.pem（憑證 SAN 包含 127.0.0.1），實際測 HTTPS 認證與私有 WSS，`cluster.development:false`。公開客戶端／OAuth／遊戲仍是本機開發 fixture，**不是正式整合驗收**。失敗時保留私密設定與只含安全事件分類的證據，切勿分享未遮蔽設定。

HA 備份必須另外保存 etcd 的權威狀態與私有 TLS／認證設定。SQLite backup／restore drill 只驗本機物化檔；quorum 存活時不能以換一份本機 DB 回滾 HA。災難還原應先停止全部 Beacon，再由管理者還原 etcd snapshot／確認 prefix 一致，最後接回 gateway；不可讓舊 quorum 與還原 quorum 同時服務。

### 遊戲能力與可信 profile 契約

`GET /v1/games` 可附 `capabilities`：`joinPolicies`、`minPlayers`、typed `rules`（boolean／number／string 的範圍、enum、default）、`roles` 與 `teams{count,size,requiredRoles}`。每支 create／update／start／admit 都重驗目前能力；無 descriptor 的既有遊戲保留原合法行為。GameSessionProvider 始終是場次最終權威。

**新增提案契約，不代表另案後端已提供**：`POST {profileApiUrl}/v1/matchmaking/profiles`，service bearer、body `{gameId,playerIds}`；回 `{gameId,profiles:[{playerId,skill,regionRttMs,measuredAt}]}`。skill 為有限 0..1000000；regionRttMs 是後端實測的 0..60000 整數毫秒；measuredAt 為 epoch 毫秒。每個要求身分必須恰有一筆、不可重複／多出、不可過期／未來時間；單次至多 256 個身分。遊戲後端須明確實作或調整 adapter，Beacon 不接受客戶端自行填 skill／RTT。


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

### Linux systemd（腳本已備，本環境未執行）

未來機房若改 Linux，用 `scripts/install-systemd.mjs`。它只接受 Linux、只接受 root 安裝，並把應用降權到已存在的非 root `--user`。既有 `/etc/systemd/system/beacon.service` 不覆寫。本機是 macOS，此腳本沒有在這裡執行，不宣稱 Linux 部署通過。

```sh
sudo "$(command -v node)" scripts/install-systemd.mjs --directory "$PWD" --user beacon --node "$(command -v node)" --config "$PWD/config.yaml"
```

`--user` 必須是已存在的非 root 使用者。成功後可用 `systemctl status beacon.service` 查看；stdout／stderr 在專案 `logs/`（0700）。

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

單機還原：先 bootout 停止 app，確認無其他 DB writer；把舊 DB／WAL／SHM 一起保留在私密復原目錄，再換入已驗證備份、設 0600 與正確擁有者後啟動。integrity check 失敗時保留原檔並停機調查，不自動清空。房間、社交、佇列／提案、私人結果／ACK 與 moderation 可重載，連線仍需重新驗證；只有仍合格／在線的玩家參與後續配對。HA 還原以 etcd 為真值，見上節，不能只換 SQLite。

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

## 本機驗證紀錄（2026-10-04，v3）

- Node **26.7.0**：`npm run build`、完整 `node --test test/*.test.mjs` **144/144**、`npm run typecheck`、部署工具安全測試 **4/4**、`npm audit --omit=dev` **0 vulnerabilities**。
- 實際 SDK → WebSocket → RoomManager → SQLite → HttpGameSessions／HttpGameProfiles fixture 完成封鎖與重新同意、邀請拒絕／撤回、隊長控制、密碼整隊原子進房、typed 小數 rules、聊天／檢舉／禁言、刪房後私人結果／去重／ACK／重啟、可信 profile 與全員確認配對、AbortSignal；正常重啟／關機不再向已關閉 SQLite 寫入。
- 真實 **etcd 3.7.2 三成員 + 三 Beacon 程序**：明文僅 loopback 的開發演練，以及 **etcd HTTPS + 啟用帳密認證 + 私有 WSS** 的嚴格 transport 演練均通過。覆蓋跨 gateway 房間／好友／私人結果、kill leader 接管、原檔重啟、request outcome 重播、暫停舊 authority 的寫入／延遲 ticket 不外洩，以及停止兩個 etcd 成員後拒絕 mutation／管理操作、全部 readiness 503。全在本機獨立程序，**尚未在不同實體主機部署**。
- 真實 Chromium／原生 WebSocket 載入獨立 SDK：驗證、建房／owner 刪房、隊伍正規化、AbortSignal 後仍可 ping；已觀察畫面並截圖，無 browser errors。正式產品沒有新增 UI，驗證頁已移除。
- 實際 npm tarball 安裝到隔離 consumer：13 個檔案、無 runtime dependencies；Node import、Node／browser strict TypeScript consumer 全通過，未發布 npm。
- 本次容量 CLI：32 clients、4 人房、1 round、160 requests；p50 約 **1.14 ms**、p95 約 **2.26 ms**，結束時房間／保留席／inFlight 皆 0。只是同程序本機回歸，**不是正式容量保證**，不拿 v2 的 800-client 歷史數據冒充本次量測。
- 尚未驗證：真實 OAuth／遊戲／可信 profile 後端、跨實體主機網路與 production TLS／Cloudflare／Mac mini 部署、CI 十組矩陣與 Node 24。預設仍 mock、外部 API 留空、cluster 停用；Gate E／正式 HA 部署維持 blocked。
- 本次依使用者指示分功能提交，未 push／部署／發布；先前版本的遠端歷史不代表 v3 已交付遠端。README／PLAN 同步 v3，桌面企劃檔未動。一次性 smoke／憑證／etcd／驗證頁均已回收。

## 授權

Apache-2.0，見 [LICENSE](LICENSE)。完整定案企劃見 [PLAN.md](PLAN.md)，開發安全規範見 [AGENTS.md](AGENTS.md)。
