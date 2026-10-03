# Beacon.js 遊戲大廳系統 企劃書 v2.0

一句話：一個以 **wss://（WebSocket over TLS）** 為通訊基礎的遊戲大廳系統（**Beacon.js**），玩家經 OAuth 驗證後，在進入大廳前先選定「遊戲」，再依遊戲尋找房間；房間可設密碼、有同時連線人數上限（上限依後端遊戲伺服器 API 設定）。

### 基本資料

| 欄位 | 內容 |
|---|---|
| 套件名稱 | **Beacon.js** |
| 程式語言 | **TypeScript** |
| 執行環境 | **Node.js v26**（本機實測 `node -v` = v26.3.1，見假設 1） |
| 通訊協定 | **wss://**（RFC 6455 over TLS；生產環境不得降級為 ws） |
| 遠端倉庫 | https://github.com/JS-PACKAGE/Beacon.js.git（main） |
| 介紹網址 | https://beacon.js-package.xyz（CNAME 已就位，目前回 404，見假設 5） |
| 部署平台 | **現階段：Mac mini M1**（Apple Silicon，暫定）；**穩定對外上線後另覓機房（亞洲／美西，另案裁示，不鎖定雲端）**——見八與假設 6 |
| 本地監聽 | **port `34568`**（本機監聽埠，配置於 `config.yaml`，見 R11） |
| 對外網域 | **`lobby.ysgs.app`** —— **僅接受 `wss://` 連線**，不提供一般網頁；**配置於 `config.yaml`**（見 R11、六.1、八） |
| 授權 | **Apache-2.0**（`LICENSE` 已推送） |
| 外部系統 A | OAuth 驗證系統 —— **另案製作**，以另外的 API 介接（契約見四） |
| 外部系統 B | 遊戲伺服器 —— **另案製作**，以另外的 API 串接（契約見四） |
| 倉庫前置檔案 | `CNAME`、`LICENSE`、`.nojekyll` **三檔已在 main**（2026-10-03 經 GitHub API 驗證，見 Gate 0） |

結構：〇 概述 → 一 需求總表 → 二 系統架構 → 三 通訊協定 → 四 外部 API 介接 → 五 資料模型 → 六 安全性架構 → 七 必要文件規格 → 八 倉庫與部署 → 九 風險 → 十 里程碑與 Gate → 十一 已知假設。全程以「執行 Agent」泛指實作方，不綁定特定工具。

---

## 〇、專案概述

### 目標
- 一個 Node.js v26 服務（TypeScript 撰寫），對外提供 **wss://** 大廳連線。
- 玩家連線後經 **OAuth 驗證**（由另案驗證系統的 API 完成，本系統只做介接與憑證驗證）。
- 玩家**進入大廳前先選定所屬「遊戲」**，大廳內容（房間列表）以遊戲為範圍。
- 房間可**加密碼**；房間有**同時連線人數上限**，上限由後端遊戲伺服器 API 設定。
- **房間資料持久化**：服務重啟後房間仍在（名稱、密碼雜湊、上限、所屬遊戲、建立時間）——連線不持久，重啟後成員清空（R12）。
- 倉庫齊備必要文件：`README.md`、`AGENTS.md`、`CLAUDE.md`、`PLAN.md`。

### 範圍外
- 不做遊戲本體、遊戲邏輯、遊戲狀態同步（屬遊戲伺服器另案）。
- 不做帳號密碼登入、註冊、密碼重設——驗證系統另案，本系統只介接其 API。
- 不做前端大廳 Web UI（介面交付物是 wss 協定與文件；介紹頁屬八的靜態頁）。
- 不主動發布 npm 套件 registry（未要求；倉庫本身即交付物）。

### 硬性要求
| 編號 | 要求 |
|---|---|
| R1 | 程式語言 TypeScript；執行環境 Node.js v26 |
| R2 | 對外通訊為 **wss://**（TLS）；生產設定下明文 ws 必須被拒絕，僅允許開發旗標啟用 |
| R3 | 登入驗證採 **OAuth**，驗證系統另案另 API；本系統不得自行實作帳號密碼儲存或驗證邏輯 |
| R4 | 玩家**進入大廳前即已確定所屬遊戲**：未 `select_game` 不得取得任何房間資訊 |
| R5 | 玩家依「遊戲」尋找／列出房間，房間列表僅顯示同遊戲者 |
| R6 | 房間可被加密碼；加入時驗證密碼，密碼錯誤不得加入 |
| R7 | 房間有同時連線人數上限，上限值依後端遊戲伺服器 API 回傳設定；滿員不可再加入 |
| R8 | 必要文件齊備：`README.md`（用途）、`AGENTS.md`（撰寫方式＋安全性架構）、`CLAUDE.md`（引用 `AGENTS.md`）、`PLAN.md`（匯入本企劃書全文之定案稿） |
| R9 | `LICENSE` = Apache 2.0；`CNAME` 內容 = `beacon.js-package.xyz`；`.nojekyll` 存在 |
| R10 | 實作順序：**先推送 `CNAME`、`LICENSE`、`.nojekyll` 三檔，之後才開始寫程式**（三檔已在 main，見 Gate 0） |
| R11 | **部署設定一律配置於專案根目錄 `config.yaml`，程式不得寫死**——至少含：本地監聽埠 **`34568`**、對外網域 `lobby.ysgs.app`、TLS／代理模式、驗證系統與遊戲伺服器 API 端點、各項配額預設值；改設定不需改碼 |
| R12 | **房間資料持久化**（使用者裁示 2026-10-03）：房間存 SQLite，**服務重啟後房間仍存在**；連線與在線成員不持久——重啟後房間成員清空、`hostId` 保留，**首位加入者成為新房主**（見三·邊界規則 5、五）；持久操作**落庫提交成功才回成功** |

---

## 一、需求總表

| 面向 | 需求 |
|---|---|
| 連線 | wss:// 服務；連線後限時內完成驗證，否則斷線；心跳（ping/pong）清理死連線 |
| 驗證 | OAuth：客戶端帶 token → 本系統呼叫驗證系統 API 換取玩家身分 → 建立會話 |
| 遊戲選擇 | 遊戲清單來自遊戲伺服器 API；玩家於大廳前選定一個遊戲，會話內可切換（切換＝離開當前房間） |
| 房間 | 建立（可設密碼、可設上限但不得超過遊戲上限）、列出、加入（驗證密碼、驗證滿員）、離開、解散（房主）、房間生命週期（房主解散；空房依 `room.emptyTtlSec` 清除） |
| 持久化 | 房間資料存 **SQLite**（`data/beacon.db`，0600＋WAL）——重啟後房間保留、成員清空；即時連線狀態仍在記憶體（R12） |
| 即時同步 | 房間人數、成員變動即時推播給房間內所有連線；大廳房間列表變動推播給同遊戲大廳內所有連線 |
| 列表與訊息大小 | `list_rooms` **分頁**（預設 50/頁、上限 200）；**入站單則 4 KB、出站單則 64 KB**——超過者分頁／拆包，絕不截斷（三） |
| 人數上限 | 每遊戲預設上限來自遊戲伺服器 API；建房時可指定更低上限；滿員加入一律拒絕（含競態，見六.5） |
| 安全性 | wss only、驗證前置、密碼雜湊儲存、頻率限制、輸入驗證、憑證不入日誌——完整規則見六，並寫入 `AGENTS.md` |
| 專案文件 | `README.md`、`AGENTS.md`、`CLAUDE.md`（引用 AGENTS.md）、`PLAN.md`（本企劃書定案稿）——規格見七，驗收見 Gate E |
| 設定 | **根目錄 `config.yaml` 為唯一設定真值來源（R11）**：本地監聽 `127.0.0.1:34568`、對外網域 `lobby.ysgs.app`、TLS／代理模式、外部 API 端點、配額預設值——程式不寫死 |
| 部署 | **現階段 Mac mini M1 執行 wss 服務（本地監聽 34568）**，對外 **`wss://lobby.ysgs.app`（僅接受 WSS，不提供網頁）**；穩定上線後另覓機房（另案）；GitHub Pages 僅服務介紹頁（`beacon.js-package.xyz`，`CNAME`＋`.nojekyll` 已就位）——見八 |

---

## 二、系統架構

```
[遊戲客戶端] ⇄ wss:// [Beacon.js 大廳服務 (Node.js 26 + TypeScript)]
                        ├─ src/net/        TLS + WebSocket 接受連線、幀讀寫、心跳、連線生命週期
                        ├─ src/protocol/   訊息型別定義、schema 驗證、錯誤碼（唯一真值來源）
                        ├─ src/auth/       AuthProvider 介面（驗證系統 API / JWT-JWKS / Mock 三實作）
                        ├─ src/games/      遊戲註冊表（遊戲伺服器 API 快取，TTL + 手動刷新）
                        ├─ src/lobby/      大廳與房間狀態機：選遊戲、房間表、加入/離開、上限佇列
                        ├─ src/security/   頻率限制、密碼雜湊 (scrypt)、來源檢查、連線配額
                        ├─ src/store/      SQLite 持久化（node:sqlite → data/beacon.db；房間表、schema 版本）
                        ├─ src/log/        結構化日誌（憑證與 token 遮蔽）
                        └─ config.yaml    部署設定（唯一設定真值，R11）：本地監聽 127.0.0.1:34568、
                                          對外網域 lobby.ysgs.app、TLS/代理模式、外部 API 端點、配額
外部：驗證系統 API（另案） 、遊戲伺服器 API（另案）——契約見四，皆以介面抽象 + Mock 實作先行開發
```

- **語言與建置**：全專案 TypeScript；`tsc` 編譯 `src/` → `dist/`，Node 26 執行 `dist/`；型別檢查 `tsc --noEmit`；測試用 Node 內建 `node:test`（免測試框架相依）。
- **依賴策略（已定案，使用者裁示 2026-10-03）**：**WebSocket 伺服器端採 `ws` 套件**（成熟、無原生相依、資安經實戰；自製幀層風險高於收益），為執行期**唯一**第三方相依——CI 跑 `npm audit --omit=dev`。其餘一律 Node 內建：`node:https`（TLS／代理側）、`node:crypto`（scrypt、隨機數）、`node:test`、**`node:sqlite`（房間持久化，R12；Node 26 API 狀態於實作期驗證，見假設 8）**。自製 RFC 6455 **不採用**。
- **狀態儲存**：**連線／會話在記憶體，房間資料持久化到 SQLite**（`node:sqlite` 內建 → `data/beacon.db`，0600＋WAL；見五與假設 8）；單節點部署。
- **部署形態**：
  - **現階段（暫定）**：wss 服務跑於 **使用者的 Mac mini M1**（Apple Silicon、macOS、Node 26），**本地監聽 `127.0.0.1:34568`（port 配置於 `config.yaml`）**，**`lobby.ysgs.app` 經 Cloudflare Tunnel（已定案）轉送至該埠，TLS 終結於 Cloudflare**。
  - **後續（不設時機）**：**穩定對外上線後另覓機房（亞洲／美西，另案裁示，GCP 已取消、不鎖定特定雲端）**——屆時僅換主機與啟動方式（systemd），程式與 `config.yaml` 不動。
  - **`lobby.ysgs.app` 僅接受 WebSocket 升階（`wss://`），一般 HTTP(S) 請求一律拒絕**（見六.1）。介紹頁屬 GitHub Pages（`beacon.js-package.xyz`），與本網域無關。

---

## 三、通訊協定（wss://，JSON 訊息）

所有訊息為單一 JSON 物件 `{ "type": string, ... }`。**大小限制分入站與出站**：**入站（Client→Server）單則 4 KB**，超限即斷線；**出站（Server→Client）單則 64 KB**，超過者一律分頁（列表，見 `list_rooms`）或拆包傳輸，**絕不靜默截斷**。未知 `type` 回 `error{code:"unknown_type"}`（不斷線），schema 驗證失敗回 `error{code:"bad_request"}`。

### 連線生命週期
1. TCP + TLS + WebSocket 升階（來源檢查，見六.3）。
2. 伺服器發 `hello{serverVersion, authDeadlineMs}`。
3. 客戶端須在期限內（預設 10 秒）送 `auth`，否則斷線。
4. `auth` 成功 → 取得玩家身分 → 才能 `select_game`。
5. 心跳：伺服器每 30 秒送 ping，60 秒無 pong 斷線。

### Client → Server
| type | 欄位 | 說明 |
|---|---|---|
| `auth` | `token` | OAuth access token；伺服器交驗證系統 API 換身分（四.1） |
| `select_game` | `gameId` | 進入大廳前必填；`gameId` 不在遊戲註冊表 → `error{game_not_found}` |
| `list_rooms` | `page?`, `pageSize?` | 取得當前遊戲房間列表**第 `page` 頁**（分頁：預設 `pageSize`=50、上限 200；回 `lobby_state{rooms[], nextPage?, total}`）；首頁可直接以 `lobby_state` 取得，後續變動以 `lobby_update` 增量推播 |
| `create_room` | `name`, `password?`, `maxPlayers?` | 建立房間並成為房主；`maxPlayers` 不得超過遊戲上限，未填＝遊戲上限 |
| `join_room` | `roomId`, `password?` | 加入房間；有密碼房需附密碼；滿員回 `room_full` |
| `leave_room` | — | 離開房間（回大廳；房主離職則移交） |
| `delete_room` | — | **解散房間（僅房主）**：落庫刪除並推播 `lobby_update{change:"remove"}` |
| `switch_game` | `gameId` | 離開當前房間並切換遊戲（等同 leave + select） |
| `ping` | — | 應用層心跳（`pong` 回應） |

### Server → Client
| type | 欄位 | 說明 |
|---|---|---|
| `hello` | `serverVersion`, `authDeadlineMs` | 連線即發 |
| `auth_ok` | `player{id, displayName}` | 驗證成功 |
| `auth_fail` | `code` | 驗證失敗（Generic 對外，細節入日誌）；伺服器隨後斷線 |
| `lobby_state` | `game`, `rooms[]`, `nextPage?`, `total` | 遊戲大廳**單頁**快照（每房間 `{id, name, playerCount, maxPlayers, hasPassword, state}`）——**受 `pageSize` 與出站 64 KB 雙重約束**，兩者取小 |
| `lobby_update` | `change`, `room` | 房間增／改／刪的增量推播（同遊戲大廳內所有人） |
| `room_joined` | `room{id, name, playerCount, maxPlayers}`, `members[]` | 加入成功 |
| `room_state` | `playerCount`, `members[]`, `change``join`/`leave` | 房間內人數與成員變動即時推播 |
| `room_closed` | `roomId`, `reason``deleted`/`expired` | 房間被解散或空房 TTL 到期——房內成員**自動回到該遊戲大廳**（`select_game` 狀態保留），大廳內所有人另收 `lobby_update{change:"remove"}` |
| `error` | `code`, `message` | 錯誤碼（唯一真值表放 `src/protocol/`） |

### 錯誤碼（對外）
`auth_required`、`auth_failed`、`auth_expired`、`game_not_found`、`not_in_lobby`、`room_not_found`、`room_full`、`room_password_required`、`room_password_incorrect`、`already_in_room`、`wrong_game`、`host_only`、`session_replaced`、`storage_error`、`rate_limited`、`bad_request`、`unknown_type`、`server_error`。

### 會話與房間邊界規則（**已選定，實作不得自行猜測**）
1. **同一玩家多連線＝單會話策略**：同一 `playerId` 再次驗證成功時，**保留最新連線，舊連線以 `error{code:"session_replaced"}` 斷線**——避免雙重佔位與跨連線狀態分裂。
2. **加入途中斷線**：`join_room` 於「預留名額／驗密碼」階段斷線 → **釋放預留名額、不留下幽靈成員**；加入成功後才斷線 → 視同 `leave_room`（人數即時遞減，房間保留）。**不做斷線重連保留位子**——重連須重新 `auth`＋`join_room`（密碼房重新驗證密碼）。
3. **跨遊戲加入一律拒絕**：房間操作僅限當前 `currentGameId`——`join_room`／`create_room` 目標房間的 `gameId` 與會話不符 → `error{wrong_game}`（須先 `leave_room`＋`switch_game`）；`list_rooms` 只回當前遊戲的房間。
4. **解散／到期後的成員去向**：`delete_room` 與空房 TTL 到期 → 房內成員收 `room_closed` 並**自動回到該遊戲大廳**（無需重選遊戲），大廳推播 `lobby_update{change:"remove"}`。
5. **房主規則（本企劃書選定）**：
   - 房主＝落庫的 `hostId`；**僅在線房主可 `delete_room`／變更房間設定**，其他人回 `error{host_only}`。
   - 房主 `leave_room` → 權限**移交房內最早加入的成員**（落庫改寫 `hostId`）。
   - 空房的 `hostId` 保留原玩家；**第一位成功加入者成為新房主（落庫改寫）**——是實際移交，非「僅暫代」。
   - 移交後原房主重新加入＝普通成員，**不恢復房主權限**；僅當 `hostId` 仍為他時才是房主。
   - hostless 空房（無人）無人能刪——等首位加入者成為房主，或空房 TTL 到期清除。

### 流程範例
```
連線 → hello → auth(token) → auth_ok
      → select_game("g-001") → lobby_state{房間列表}
      → join_room{roomId, password} → room_joined →（其他玩家）room_state
      → leave_room → lobby_state
```

---

## 四、外部 API 介接（兩套皆另案，先定契約 + Mock）

> 兩個外部系統皆「另外處理 API」——本企劃書先定**本系統需要的介面契約**，實作期以 Mock 落地、API 到位後換實串接，程式碼不得散落對外部的直接呼叫（一律經 `src/auth/`、`src/games/` 的介面）。

### 4.1 驗證系統 API（OAuth，另案）
本系統需要的最小契約（**待驗證系統定案，見假設 2**）：
- **路徑 A（JWT 驗證，預設）**：驗證系統公開 JWKS 端點；本系統驗證 JWT 簽章、`exp`、`iss`、`aud` 後取得 `sub`（玩家 ID）與 `name`。本系統不代為發 token。
- **路徑 B（伺服器交換）**：`POST {AUTH_API}/v1/verify`，Header `Authorization: Bearer <token>` → `200 {playerId, displayName}` / `401`。
- **AuthProvider 介面**：`verify(token) → Player | AuthError`；實作：`JwksProvider`、`RemoteVerifyProvider`、`MockAuthProvider`（**僅限本地開發與自動化測試**）。驗證失敗一律斷線，不得降級為匿名。
- **Mock 使用限制**：`auth.mode: mock` **僅限開發與測試**——正式環境啟動時遇 `mode=mock` 即拒絕啟動（六.11）；**Gate E 的部署驗收與整合驗收禁止以 Mock 通過**：真實 OAuth 尚未接通前，只能宣稱「開發驗收＋部署驗收通過」，**整合驗收維持 blocked，不得隱瞞**（Gate E ⑧）。
- token **僅存於連線記憶體**，不落日誌、不落檔、不回傳給第三方。

### 4.2 遊戲伺服器 API（另案）
本系統需要的最小契約（**待遊戲伺服器定案，見假設 4**）：
- `GET {GAME_API}/v1/games` → `[{ gameId, name, maxPlayersPerRoom, enabled }]`
  - 用途：遊戲清單、每遊戲房間人數上限（R7 的上限來源）。
- 快取 TTL 60 秒；啟動時若遠端失敗 → 採上次快取或啟動期設定檔，並記 warning；遊戲註冊表不得為空到無法運作（至少可回 `game_not_found`）。
- 本系統**不呼叫**遊戲伺服器的加入/對戰端點——玩家離開大廳後由遊戲客戶端自行連遊戲伺服器（本系統僅在 `room_joined` 附帶該遊戲的 `serverHint` 供客戶端銜接；欄位可選，無則省略）。
- 遊戲伺服器 API 的實際格式若與上列不同，**只改 `src/games/` 的 adapter**，不動大廳狀態機。

---

## 五、資料模型（房間持久化至 SQLite＋連線狀態在記憶體，單節點）

```
# ── 記憶體（連線狀態，重啟即失） ──
Game      { gameId, name, maxPlayersPerRoom, enabled, source: "api"|"cache"|"config" }
Room      { id, gameId, name, hostId, passwordHash?: string,   // scrypt：salt+hash，永不明文
            maxPlayers, players: Map<playerId, Connection>, state: "open"|"closed", createdAt }
Player    { id, displayName, authAt, currentGameId?, currentRoomId? }
Connection{ socket, playerId?, lastPongAt, msgWindow: RateBucket, ip }
RateBucket{ tokens, updatedAt }                                // token bucket

# ── SQLite data/beacon.db（持久化，R12） ──
rooms     id PK, game_id, name, password_hash?, max_players,
          host_id, state, created_at, updated_at
schema_migrations version, applied_at
```

### 持久化規則（R12）
- **寫入語意＝先落庫、後應答（write-then-ack）**：所有持久操作（建房、解散、房間設定變更、房主移交）在單一序列化佇列中**先提交 SQLite，提交成功才套用記憶體狀態、才回成功訊息**；**落庫失敗 → 回 `error{code:"storage_error"}`，記憶體不得有任何變更**——因此不會發生「建房回成功卻遺失」，也不會發生「刪房回成功、重啟後復活」（刪除失敗即回失敗，房間保持原狀可重試）。
- **落庫時機**：建房、解散（`delete_room`）、房間屬設定變更、房主移交時寫入；`hostId` 於移交時更新（三·邊界規則 5）。
- **不落庫**：在線成員、人數（一律以實際連線計算）、玩家資料、連線狀態。
- **重啟後重載**：由 `rooms` 表重建房間 → 成員清空、`players.size = 0`、`hostId` 保留；**首位加入者成為新房主（落庫改寫）**，原房主之後回歸不恢復權限（規則見三·邊界規則 5）。
- **啟動容錯（嚴格，不自動清空）**：`data/beacon.db` **不存在 → 建立新表**；**檔案存在但開啟或 integrity check 失敗 → 拒絕啟動**（明確 exit code＋錯誤訊息指出「保留原檔、請還原備份或修復」）——**不得覆寫、不得自動改名移走、不得以空房間表替代既有檔案**。
- **備份／還原**：備份用 SQLite backup API（或 `PRAGMA wal_checkpoint` 後複製）；還原＝停止服務 → 換回備份檔 → 啟動。流程寫入 README。
- 儲存層以 `src/store/` 隔離（預設 `node:sqlite`；若改 `better-sqlite3` 只動此層，見假設 8）。
- **房間生命週期**：房主離開 → 房主移交最舊成員（無成員則房主欄位保留）；房主可 `delete_room` 解散（落庫刪除＋推播 `lobby_update{change:"remove"}`）；**無人房間依 `config.yaml: room.emptyTtlSec`（預設 1800 秒、0＝永不）清除**——重啟後載入的空房同樣套用，避免垃圾房間累積。
- **上限保證**：加入前檢查 `players.size < maxPlayers`，且密碼驗證期間**預留名額**（見六.5）。
- **連線不持久化**：玩家連線與在線身分無法持久——重啟後所有人需重新連線與驗證（房間本身保留，見上）。
- 單執行緒事件迴圈內的狀態變更以單一 `RoomManager` 序列化（所有 join/leave 走同一佇列），避免競態；**持久操作的落庫亦經此佇列——落庫失敗即回 `storage_error` 且記憶體不變（見下）**。

---

## 六、安全性架構（**須完整寫入 `AGENTS.md` 作為撰寫硬規則**）

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

---

## 七、必要文件規格

| 檔案 | 內容要求 |
|---|---|
| `README.md` | **本套件的用途**：Beacon.js 是什麼（wss 遊戲大廳）、解決什麼問題、系統圖、需求（Node 26）、安裝與啟動、wss 協定摘要與訊息範例、驗證／遊戲伺服器 API 設定方式、開發與測試指令、授權（Apache-2.0）宣告 |
| `AGENTS.md` | **本套件的撰寫方式**：TypeScript 規範（ESM、`strict`、禁止 `any` 敷衍）、建置與測試指令、程式碼結構（對應二節目錄）、提交慣例、**安全性架構章節＝第六節全部規則（逐條編號，作為實作與審查硬規則）**、外部 API 一律經 adapter 介面不得散落呼叫 |
| `CLAUDE.md` | 僅**引用 `AGENTS.md`**（一行指向 + 摘要），並強調安全性架構須遵守——不重複內容，避免雙真值來源 |
| `PLAN.md` | **本企劃書全文匯入之定案稿**（內容與桌面版一致；企劃書更新時同步） |

---

## 八、倉庫與部署

- **前置三檔（R10）**：`CNAME`（內容 `beacon.js-package.xyz`）、`LICENSE`（Apache 2.0 全文）、`.nojekyll` —— **已於 main**，2026-10-03 經 GitHub API 驗證（倉庫僅此三檔、3 commits）。三檔齊備後才開始寫程式。
- **介紹頁**：`index.html`（GitHub Pages，`CNAME`＋`.nojekyll` 已可作用）——目前網址回 **404**（Pages 已接但無 index.html），列為 Phase 4 交付。
- **wss 服務部署（現階段定案；機房遷移另案——使用者裁示 2026-10-03 取消 GCP）**——與 GitHub Pages 無關（Pages 不支援 WebSocket）：
  - **現階段（暫定）＝使用者的 Mac mini M1**（Apple Silicon、macOS、Node 26；launchd 開機自動啟動；macOS 防火牆僅允許必要程式）——**本程序本地監聽 `127.0.0.1:34568`（port 配置於 `config.yaml`，R11）**。
  - **連外方式已定案（使用者裁示 2026-10-03）＝Cloudflare Tunnel**：`cloudflared` 以 LaunchDaemon 隨開機啟動，把 `wss://lobby.ysgs.app` 轉送至 `127.0.0.1:34568`——**不開路由器埠、不受家用浮動 IP 影響、TLS 由 Cloudflare 終結（自動管理無續期問題）、仍維持僅 WSS**（`ysgs.app` NS 已驗證在 Cloudflare）。需使用者於 Cloudflare 後台建立 Tunnel 並指派 `lobby.ysgs.app` hostname（見假設 6b）。port forward 443＋自動憑證**僅列備援**，不採為預設。
  - **後續（不設時機，GCP 已取消）**：穩定對外上線後**另覓機房（亞洲／美西，另案裁示）**——屆時僅替換主機與啟動方式（Linux 主機用 systemd、防火牆僅開 22 限 IP 與 443），**程式與 `config.yaml` 不因遷移改動**。
  - 網域與 TLS：**`lobby.ysgs.app` DNS 指向現階段主機**（Cloudflare A 記錄或 Tunnel，由使用者設定）；代理僅轉送 WebSocket 升階——**一般 HTTP 請求一律拒絕**；對外位址固定 **`wss://lobby.ysgs.app`**；憑證續期自動化列入部署說明。
  - **設定檔 `config.yaml`（專案根目錄，唯一設定真值來源，R11）**——本地監聽 port 與對外網域皆配置於此，示例：

    ```yaml
    server:
      listenHost: 127.0.0.1    # 本地監聽位址（僅 loopback）
      listenPort: 34568        # 本地監聽服務 port
      trustProxy: true         # 受信任代理來源才採 XFF／CF-Connecting-IP（六.3）
    public:
      domain: lobby.ysgs.app   # 對外網域：僅接受 wss
      tls: proxy               # proxy = 代理/隧道終結 TLS｜direct = 本程序持憑證
    auth:                      # OAuth 驗證系統（另案）
      mode: mock               # mock＝僅限本地開發（正式環境啟動即拒絕，六.11）｜jwks｜remote
      jwksUrl: ""
      apiUrl: ""
    games:                     # 遊戲伺服器（另案）
      apiUrl: ""
      cacheTtlSec: 60
    room:
      emptyTtlSec: 1800        # 空房清除秒數（0＝永不）
    db:
      path: data/beacon.db      # SQLite 資料檔（0600＋WAL）
    limits: {}                 # 六節各項配額預設值
    ```
  - **部署作業模式（使用者裁示 2026-10-03，混合）**：**開發與測試在本執行環境（MacBook Air M5）完成**；**部署與現階段主機上的驗證由使用者於 Mac mini 操作**——執行 Agent 產出部署腳本、逐步指令與逐項驗收 checklist，使用者依序執行並回報每步輸出；執行 Agent 不直接 SSH 遠端主機。
  - 備份／還原：**房間資料檔 `data/beacon.db` 需備份**（SQLite backup API 或 checkpoint 後複製）；主機重建＝重跑部署腳本＋還原 DB——流程寫入 README，部署腳本同步交付。

---

## 九、風險與因應

| 風險 | 影響 | 因應 |
|---|---|---|
| 驗證系統 API 契約未定案 | `auth` 無法實串接 | 四.1 先定契約＋Mock；AuthProvider 介面隔離，換實作不動大廳邏輯 |
| 遊戲伺服器 API 契約未定案 | 遊戲清單／上限來源不穩 | 四.2 adapter + 60 秒快取 + 啟動期設定檔備援 |
| 加密碼房暴力猜密碼 | 房間被侵入 | 六.4 頻率限制 + 斷線；可列後續（指數退避） |
| 滿員加入競態（同秒雙人加入） | 超過上限 | 六.5 預留名額機制；列入 Gate C 測試案例 |
| 惡意連線洪水／巨型訊息 | 資源耗盡 | 六.3 配額、六.6 尺寸與解析失敗斷線、六.10 背壓 |
| WebSocket 幀層實作的邊界漏洞 | 資安風險 | **已定案採 `ws`（2026-10-03 裁示）**，自製 RFC 6455 不採用；執行期唯一第三方相依，CI 跑 `npm audit --omit=dev` |
| Node 26 相依相容性（含 `ws`） | 啟動失敗 | 本機 v26.3.1 實測；Gate A 以 Node 26 建置＋啟動驗證 |
| 介紹網址 404 | 對外無門面 | Phase 4 交 `index.html` |
| SQLite 寫入失敗／資料檔損毀 | 操作失敗或資料遺失 | 寫入失敗 → 回 `storage_error`、記憶體不變（五）；檔損毀 → **拒絕啟動並保留原檔**（不自動清空），人工還原備份；定期備份（五） |
| `node:sqlite` 在 Node 26 API 有缺口 | 儲存層受阻 | 實作期驗證；有缺口改 `better-sqlite3`（新增執行期相依與原生編譯）並同步更新假設 3 與二 |
| 單節點瓶頸 | 大量連線 | 上限參數化（六.3、六.10）；水平擴充列為未來版 |
| 現階段 Mac mini M1 停機／休眠／家用網路中斷 | 大廳中斷 | launchd 自動重啟、`pmset` 關閉休眠；重建＝重跑部署腳本＋還原 `data/beacon.db`（五）；穩定上線後遷移機房（八）可消除 |
| TLS 憑證過期 | wss 中斷 | Tunnel 模式下憑證由 Cloudflare 自動管理（無續期作業）；備援路徑（Caddy / certbot）自動續期並列入部署說明 |
| Cloudflare Tunnel 中斷／Cloudflare 帳號異常 | 對外 wss 中斷 | `cloudflared` 以 LaunchDaemon 自動啟動與重連；本地服務本身不受影響（僅對外不可達）；備援路徑可臨時切換 |
| 部署由使用者操作（混合模式） | 指令誤植、驗證盲區 | 部署全程指令化＋逐項驗收 checklist；每步要求回傳輸出核對；失敗可重跑（DB 可由備份還原） |

---

## 十、里程碑與 Gate（逐關通過才進下一階段）

### Phase 0 — 倉庫前置三檔（R10）
推送 `CNAME`、`LICENSE`、`.nojekyll`。
**Gate 0**：遠端 main 含三檔且內容正確（`CNAME` = `beacon.js-package.xyz`、`LICENSE` 為 Apache 2.0 全文、`.nojekyll` 存在）。—— **已達成**（2026-10-03 驗證）。

### Phase 1 — 骨架與協定
TS 專案初始化（`tsc`、ESM、`strict`）、TLS + wss 接受連線、心跳、`src/protocol/` 訊息型別與 schema、錯誤碼表、Mock AuthProvider、Mock 遊戲註冊表。
**Gate A**：`tsc --noEmit` 零錯誤；Node 26 啟動並完成一次 wss 連線→`hello`→`auth`(Mock)→`select_game`→`lobby_state`；**`data/beacon.db` 初始化成功（建表＋`schema_migrations`）**；`node --test` 單測通過（協定解析、錯誤碼）；**非開發模式下綁非 loopback 的明文 ws 啟動被拒絕、本機層僅接受 loopback 來源**（六.1 分層：外網僅 wss、本機 upstream 僅回環——兩者不衝突）；`auth.mode=mock` 且無開發旗標時拒絕啟動（六.11）。

### Phase 2 — 驗證與遊戲註冊表實作
`JwksProvider`／`RemoteVerifyProvider` 對接驗證系統 API（或 Mock 伺服器模擬遠端），遊戲註冊表對接遊戲伺服器 API（含 TTL 快取、失敗備援）。
**Gate B**：以模擬外部 API 完成真實 HTTP 路徑驗證：有效 token → `auth_ok`、過期／錯誤 token → `auth_fail`＋斷線；遊戲清單與 `maxPlayersPerRoom` 正確載入並快取過期重取；外部不可達時 fail-closed 與備援行為符合六.2／四.2。

### Phase 3 — 大廳與房間
建房（含密碼雜湊＋落庫）、房間列表（依遊戲範圍）、加入（密碼、滿員）、離開、房主移交、`delete_room` 解散（落庫刪除）、空房 TTL 清除、**SQLite 持久化與重啟重載（R12）**、`lobby_update`／`room_state` 即時推播、切換遊戲。
**Gate C**：整合測試（`node --test` + 假 wss 客戶端）通過——①未 `select_game` 取不到房間（R4）；②房間列表僅同遊戲（R5）；③密碼房錯誤密碼不可入、正確密碼可入、列表不洩漏密碼（R6）；④**同秒雙連線加入不超過 `maxPlayers`**（R7、六.5）；⑤空房 TTL 清除與 `delete_room` 解散推播正確；⑥頻率限制與 4 KB 上限實際觸發；⑦**重啟服務後房間仍在（R12）**——成員清空、首位加入者成為新房主（原房主回歸不恢復權限）、`delete_room` 落庫刪除、空房 TTL 計時正確；⑧**持久化失敗語意**——注入 DB 寫入失敗 → 回 `storage_error` 且記憶體無任何變化；損毀 DB 檔 → **拒絕啟動且原檔完整保留**（五）；⑨**邊界規則**——加入途中斷線釋放預留名額、同 `playerId` 第二條連線使舊線收 `session_replaced`、跨遊戲加入回 `wrong_game`、解散後房內成員自動回到遊戲大廳（三·邊界規則）。

### Phase 4 — 安全驗收、文件與介紹頁
第六節全數落地並複查；四份必要文件撰寫；`index.html` 介紹頁。
**Gate D**：安全性逐條 checklist（六.1–6.10）全過，日誌抽查無 token／密碼明文；`README.md`、`AGENTS.md`（含安全章節）、`CLAUDE.md`（引用 AGENTS.md）、`PLAN.md`（本企劃書全文）齊備並推上 main。
**Gate E（交付關）**：①`git` 遠端 main 含全部檔案；②三檔前置內容仍正確；③介紹網址回 200；④以 Node 26 乾淨 clone → 安裝 → 建置 → 啟動 → 走完三.流程範例一次成功；⑤**依部署腳本部署至現階段主機（Mac mini M1；使用者操作，混合模式；本地監聽 `34568` 由 `config.yaml` 配置），從外部以 `wss://lobby.ysgs.app` 完成同一流程範例**（TLS 有效、無需對外開埠），驗收以使用者回報之逐步輸出核對；⑥對 `https://lobby.ysgs.app` 發一般 HTTP(S) 請求**不得**取得任何網頁（僅 WSS，符合六.1）；⑦`config.yaml` 改網域／port 後重啟即生效、程式無需修改（R11）；⑧**整合驗收不得以 Mock 通過**——正式部署 `auth.mode` 不得為 `mock`（六.11），真實 OAuth 至少完成一次成功驗證才可宣稱整合驗收通過；驗證系統（另案）未接通時，本關只能結論為「**開發＋部署驗收通過，整合驗收 blocked**」，不得隱瞞。

---

## 十一、已知假設與未定項

1. **Node.js v26 為指定執行環境**（使用者裁示）；本機實測 `node -v` = **v26.3.1**。若部署主機版本不同，以 ≥ 26 為準並於 README 標明。
2. **驗證系統 API 契約未定案**（另案）——**開發策略已定案（使用者裁示 2026-10-03）：先 Mock＋抽象契約開發**（四.1：JWT-JWKS 預設、伺服器 verify 端點備用、`MockAuthProvider` 落地），契約確定後**只換 `src/auth/` adapter**，不擋其他部分進度；與驗證系統實際定案衝突時，**以驗證系統為準**。
3. **依賴策略已定案（使用者裁示 2026-10-03）**：執行期第三方相依＝`ws`（理由見二），自製 RFC 6455 不採用；儲存層預設用內建 `node:sqlite`（零新增相依），**若實作期改用 `better-sqlite3` 則成為第二個執行期相依**，須同步更新本條與二（見假設 8）。
4. **遊戲伺服器 API 契約未定案**（另案）：以 `GET /v1/games`（含 `maxPlayersPerRoom`）先行定案（四.2）；實際格式不同只改 `src/games/` adapter。`serverHint` 為可選欄位，遊戲伺服器未提供即省略。
5. **介紹網址現為 404**：CNAME（`beacon.js-package.xyz`）已生效並指向 Cloudflare，但 Pages 無 `index.html`——介紹頁列 Phase 4。
6. **部署平台與設定（使用者裁示 2026-10-03）**：**現階段＝使用者的 Mac mini M1（Apple Silicon）**——本程序**本地監聽 `127.0.0.1:34568`**、對外 **`wss://lobby.ysgs.app`（僅接受 WSS，不提供一般網頁）**；**GCP 已取消（使用者裁示 2026-10-03）**——**穩定對外上線後另覓機房（亞洲／美西，另案裁示，不鎖定特定雲端）**，屆時僅換主機與啟動方式。**port `34568`、`lobby.ysgs.app` 及其餘部署設定一律配置於根目錄 `config.yaml`（R11），程式不得寫死**。**連外方式已定案（使用者裁示 2026-10-03）＝Cloudflare Tunnel**（免開路由器埠、TLS 由 Cloudflare 終結、維持僅 WSS）；port forward 443＋自動憑證僅列備援。**部署操作已定案（使用者裁示 2026-10-03，混合模式）**：開發與測試在本執行環境（MacBook Air M5）完成；**部署與主機端驗證由使用者於 Mac mini 依執行 Agent 產出之腳本與指令操作並回報輸出**（不 SSH 遠端）。**待定項**：a) **需使用者於 Cloudflare 後台建立 Tunnel 並指派 `lobby.ysgs.app` hostname**（`ysgs.app` NS 已在 Cloudflare；`lobby.ysgs.app` 目前無 DNS 記錄），並提供 `cloudflared` token／憑證給部署作業；b) 未來機房（亞洲／美西）之選擇——**穩定對外上線後**另案裁示。a–b 不影響程式實作，僅影響八的部署作業。
7. **無前端大廳 UI**：功能敘述未要求，列範圍外；若需要展示頁另立企劃。
8. **房間持久化已拉進範圍（使用者裁示 2026-10-03，R12）**：房間資料存 SQLite（`data/beacon.db`）——預設採 Node 內建 **`node:sqlite`**，其在 Node 26 的 API 狀態**於實作期驗證**；若有缺口改用 `better-sqlite3`（新增執行期相依），並同步更新假設 3 與二。**連線／在線成員不持久**：重啟後房間保留、成員清空、首位加入者成為新房主（見三·邊界規則 5）——語意見五；空房依 `room.emptyTtlSec`（預設 1800 秒）清除，為**新創預設值，可調整**。
9. 頻率限制、配額、上限等數值（六.3、6.4、6.6、6.7、6.10；三節入站 4 KB／出站 64 KB／`pageSize` 預設 50 上限 200；`room.emptyTtlSec` 1800）為**新創預設值，可調整**。

### 十二、v2 擴充（使用者裁示 2026-10-04：全部實作）

v1 的邊界是「安全的房間目錄與成員管理」。v2 補上讓大廳能支撐完整組隊、開局與長時間遊玩的閉環，**仍維持「大廳負責組隊與交接、遊戲伺服器負責遊戲邏輯」**——Beacon 不做遊戲邏輯與同步。

| 編號 | 需求 |
|---|---|
| R13 | 準備／開局：房間狀態 `open → starting → in_game → open`；房主於全員準備後 `start_game`，經 `GameSessionProvider` 對遊戲場次 API 建立場次、各玩家只取得自己的 ticket；結果不明確時保留 `starting` 與原請求，以同一 idempotency key 重放，不虛構完成；加入政策 `closed`／`fill`／`spectate`，觀戰者容量獨立 |
| R14 | 重連：斷線保留席位與準備狀態 `lobby.reconnectGraceMs`，**必須重新驗證**才可恢復；擁有者（建立者）與房主（主持人）分離 |
| R15 | 協定 v2：`requestId` 關聯與終結訊息 `result`；同玩家同 id 同內容冪等重播、不同內容 `request_conflict`；`revision`／`snapshotId`／穩定游標；`hello` 協商 `protocolVersion`；單一項目超過出站上限時以 `snapshot_chunk` 切段而非截斷 |
| R16 | 房主工具：改名／改密碼／改上限／可見度／上鎖／加入政策、踢人與房間封鎖、移交房主、受邀制（邀請綁定對象與房間） |
| R17 | 身分：同連線 `refresh_auth`（同一玩家）、`auth.revocationUrl` 撤銷（fail-closed）、管理員封禁與撤銷（持久化）、玩家建房配額、**跨連線**密碼猜測限制 |
| R18 | 找房：關鍵字、排序、僅可加入、版本／模式／區域相容性、`quick_join`；官方 SDK `src/client/` |
| R19 | 社交：雙方同意的好友與在線狀態、隊伍、以隊伍為單位不拆開的 FIFO 自動配對 |
| R20 | 維運：loopback 且全端點 bearer 認證的管理 HTTP（health／ready／metrics／audit／ban／unban／revoke／rooms-close／maintenance）、持久稽核、告警 webhook、輪替遮蔽日誌、排程 SQLite 備份與隔離還原演練、維護模式與關機排空（`server_draining`）、本機容量情境 |

**實作中發現並修正**：①`node:sqlite` 非同步 `backup()` 在程序有其他 handle 時不會被自身進度喚醒，排程備份與啟動會被拖延（實測 30 秒）——`backupDatabase` 以短暫計時器處理；②房間內的準備／重連等變更原本會推給整個大廳，實測 800 位大廳在線者的情境下每個請求約 602 則訊息，改為僅在列表可見欄位改變時推播後降為約 404 則。

**未決的產品問題（待使用者裁示）**：`lobby.maxRoomsPerPlayer` 計入擁有者**已離開的空房**，因此玩家在空房 TTL（預設 30 分鐘）內連續建立並離開三間房後無法再建房，且沒有清除手段。可選：維持現狀、讓擁有者能刪除自己名下的空房、或建立新房時回收其最舊的空房（會靜默刪除擁有者可能想保留的常駐房）。

**限制**：本機容量情境是單機、同程序客戶端的回歸量測，不是正式容量保證；真實 OAuth 與遊戲場次 API 尚未接通，整合與外部部署驗收仍為 blocked（見 Gate E ⑧）。

---

開始執行。
