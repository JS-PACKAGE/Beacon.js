# Beacon.js 遊戲大廳系統 企劃書 v3.0

定案範圍：以 **WSS + OAuth** 提供遊戲分區大廳；大廳負責房間、社交、組隊、配對確認與遊戲場次交接，遊戲後端負責遊戲邏輯、技能與實測延遲。本次將前一版所有擴充建議納入，HA 採 **跨主機 gateway + etcd quorum + 單一 elected authority**，不是共享 SQLite 檔案。

本文件是完整現行企劃，不以舊章節與附錄互相覆蓋。取代 v2 的即時配房、記憶體佇列、席位暫存結果與根套件 SDK 匯出；桌面原始企劃檔未修改。真實外部整合、實體跨主機部署與發布仍需另取得端點、基礎設施與授權。

## 〇、基本資料、目標與邊界

| 欄位 | 內容 |
|---|---|
| 服務 | Beacon.js，根套件 `@js-package/beacon` 3.0.0，private |
| SDK | `@js-package/beacon-client` 3.0.0，獨立可打包、無 runtime dependencies，未發布 npm |
| 語言／執行 | TypeScript ESM／strict；服務 Node.js ≥26，本機證據 Node 26.7.0；SDK browser／Node ≥22 |
| 對外協定 | protocol v3，`wss://lobby.ysgs.app`；一般 HTTP(S) 不提供網頁 |
| 本機監聽 | public upstream 預設 `127.0.0.1:34568`；管理預設 34569；私有 HA control 預設 34570；均可配置、均只綁 loopback |
| 設定 | 根目錄 `config.yaml` 唯一部署真值；CLI `--config PATH` 明確選擇另一份完整設定 |
| 倉庫／介紹頁 | https://github.com/JS-PACKAGE/Beacon.js.git；GitHub Pages 介紹域名 `beacon.js-package.xyz`，不承載 WSS |
| 部署 | 單機 Mac mini M1／launchd 仍可使用；HA 可跨主機；Linux systemd 工具已備但本機未部署驗證 |
| 授權 | Apache-2.0；CNAME／LICENSE／.nojekyll 的先行推送要求為已完成的歷史 gate |

### 目標

- 玩家限時完成 OAuth 驗證，選遊戲後才能看房間；房間密碼與容量受嚴格驗證。
- 開局、補位、觀戰與重連只透過遊戲場次 provider 取得該玩家自己的 ticket。
- 房間、社交、配對、私人結果與 moderation 可持久恢復，成功 ACK 必須晚於持久提交。
- 所有十二項本次擴充均有真實實作；缺少必要後端明確拒絕，不用 stub、假 ticket、假 profile 或假完成。
- 單機與 HA 使用相同 RoomManager、協定與 SDK；HA 不允許多個 writer 各自接受不同房間狀態。

### 範圍外

- 帳號註冊／密碼登入／重設、OAuth token 發行、遊戲本體與狀態同步。
- 排名／經濟資料庫、客戶端自報技能／權威延遲、全域／語音聊天、前端大廳 UI。
- 未經明確授權的 commit／push、npm publish、release、Pages 發布、Cloudflare／production 操作。
- 自動 SSH 部署；外部主機作業由使用者依工具與文件操作並回報安全證據。

## 一、需求總表

| 編號 | 現行要求 |
|---|---|
| R1 | TypeScript ESM strict、exactOptionalPropertyTypes／noUncheckedIndexedAccess；禁止以 any 敷衍型別；服務 Node ≥26 |
| R2 | 外網只 WSS；app upstream 只 loopback；開發明文必須明確旗標，不能用於部署 |
| R3 | OAuth 只經 AuthProvider；驗證不可達 fail-closed，不發匿名身分 |
| R4 | 未選遊戲不得取得房間資訊 |
| R5 | 房間列表按遊戲／版本／模式／區域隔離 |
| R6 | 每房隨機 salt 的 scrypt 密碼，常數時間比對，列表只顯示 hasPassword |
| R7 | 遊戲 API 決定人數上限；密碼／admission 外部工作期間預留名額，競態不得超員 |
| R8 | README、AGENTS、CLAUDE（引用 AGENTS）、完整現行 PLAN 齊備且與契約一致 |
| R9 | Apache-2.0 LICENSE、CNAME=beacon.js-package.xyz、.nojekyll 保留 |
| R10 | CNAME／LICENSE／.nojekyll 必須先推送再開發；此歷史要求已完成，本次不重新發布 |
| R11 | config.yaml 唯一部署真值，完整 flow-style JSON + 引號外 # 註解；不支援 block YAML 或環境變數覆蓋 |
| R12 | SQLite 持久房間／寬限席，提交後成功；損毀保留原檔並拒絕啟動；HA 本機 DB 是物化，不是全群組權威 |
| R13 | open → starting → in_game → open；全員 ready 才開局；未知配置結果以原 operationId reconcile，不虛構成功 |
| R14 | ownerId 與 hostId 分離；重連必須重新驗證；寬限席占容量並可跨重啟恢復 |
| R15 | protocol v3 requestId、terminal result、revision、穩定房間游標、snapshot 分包；v2 乾淨切換、不提供 shim |
| R16 | 房主改設定／踢人／房間封鎖／移交／受邀制；owner 可管理自己的無其他成員空房 |
| R17 | 同身分 refresh_auth、必要撤銷 fail-closed、持久管理封禁、擁有者房間配額、跨連線密碼猜測限制 |
| R18 | 搜尋／排序／只可加入／quick_join／相容性；不洩露不可見房間 |
| R19 | 雙方同意好友、好友限定在線狀態、完整隊伍、不拆隊配對 |
| R20 | 私有 bearer 管理 HTTP、持久稽核、備份／隔離還原、遮蔽輪替日誌、告警、維護／排空與容量 CLI |
| R21 | 封鎖原子關閉既有好友關係、待處理邀請與不相容隊伍／佇列／提案；解除不恢復舊同意 |
| R22 | matchId／原始 roster／本人私人結果與 ACK 獨立持久化；刪房／離房／重啟後晚回報與去重仍成立 |
| R23 | incoming／outgoing 邀請收件匣、登入同步、收件人拒絕／寄件人撤回及持久終態 |
| R24 | 隊長移交／踢人／解散、整隊密碼／admission 預留與原子進房；失敗不可半隊落庫 |
| R25 | 配對先提案，接受／拒絕／期限；全員接受才建房，其餘合格隊伍回列且保留原等待年齡 |
| R26 | 完整 typed SDK events／results／social state、AbortSignal、雙向機器 JSON Schema、runtime 不接受假型別 |
| R27 | 遊戲 capability／typed rule descriptors 驗證 create／update／start／admit；provider 是最終場次權威 |
| R28 | 管理房間／場次列表與詳情、queue／proposal／dependency／HA 診斷、安全 provider reconcile |
| R29 | room／party 聊天、私密歷史、封鎖過濾、限流、禁言、檢舉／私有管理審查、保留與容量界線 |
| R30 | 可信技能與後端實測 RTT、完整隊伍／角色／隊伍技能平衡、有限等待放寬、可控搜尋預算；無可信後端拒絕 advanced |
| R31 | 獨立 SDK exports／d.ts／browser／Node／LICENSE／schema／tarball，隔離 consumer 安裝驗證；不發布 |
| R32 | 跨主機 HA：etcd quorum 選舉／lease／epoch fencing、gateway 路由、changeset journal／checkpoint、故障接管與跨重啟有界 request outcome 去重 |

## 二、系統架構與工程約束

```text
遊戲客戶端 → Cloudflare WSS → 本機 gateway
                                │ 私網 WSS（shared bearer、TLS、來源重驗）
                                ↓
                         elected authority
                         單一 RoomManager
                          ├ AuthProvider／撤銷
                          ├ GameProvider／GameSessionProvider／可信 profile
                          ├ SQLite（本機）
                          └ etcd worker：lease、原生 changeset、分塊 checkpoint
```

| 目錄 | 職責 |
|---|---|
| src/net | 只接受 loopback 的 public／private control 傳輸、配額、心跳、背壓 |
| src/protocol | schema、版本、錯誤碼、requestId outcome 帳本 |
| src/auth | remote／JWKS／mock、HTTP 邊界與私密憑證、撤銷 |
| src/games | 註冊表、capability、場次／admission／profile adapters |
| src/lobby | 房間、社交、邀請、結果、聊天、提案與 bounded pure matcher |
| src/security | scrypt、常數時間驗證、來源／頻率限制 |
| src/store | SQLite schema 5、normalized domain_records、backupDatabase／migration |
| src/cluster | etcd JSON gateway client、協調 worker、leader RPC／gateway routing |
| src/ops、src/log | 私有管理／診斷、備份／告警／還原與安全日誌 |
| src/client、packages/client | SDK 型別原始碼與獨立可發佈產物 |
| scripts、test | 使用者主動部署／驗收／容量／HA 工具、node:test 行為回歸 |

- Runtime 唯一第三方依賴是鎖定的 ws；SQLite、HTTP、crypto、測試均用 Node 內建。SDK 無 runtime dependencies，不 import ws。
- 所有房間／領域變更由 RoomManager 序列化；外部 auth／game／profile HTTP 與 scrypt 在佇列外，返回後重驗身分、群組、房間、提案與 reservation。
- 多實體 mutation 以 SQLite transaction 原子提交；輸出／關閉等可見 side effects 延至提交後。失敗還原記憶體與 staged cache，不能先成功再吞儲存失敗。
- Read-only 指令不複製整個領域或寫 SQLite；immutable domain records 以結構共享與鍵差異持久化，小寫入不反覆 serialize 全部聊天／結果歷史。
- 已 shutdown 的 manager 不再排新 SQL；shutdown 保存寬限狀態、等待工作，再關 store，不讓延遲 socket callback 寫入已關閉資料庫。

## 三、通訊協定（protocol v3）

每訊息是一個 JSON 物件。入站預設 4096 bytes，出站 65536 bytes；未知欄位拒絕。大型集合分頁／分包，不默默截斷。完整欄位與錯誤碼以 src/protocol、src/client 的 discriminated unions 與建置產生的 protocol.schema.json 為準。

### 生命週期與主要命令

1. WSS 升階檢查 → hello（protocolVersion=3）→ 10 秒內 auth。
2. auth_ok → session／room／friend／party／invitation／queue／proposal／未 ACK 結果快照 → terminal result。
3. select_game 後才能列／建／加入房間；token 到期前同身分 refresh_auth。
4. peer heartbeat 清死連線；同玩家最新驗證連線取代舊連線（4001），不准未驗證 playerId 直接取席。

| 類別 | 命令 |
|---|---|
| 身分／同步 | auth、refresh_auth、sync_state、ping |
| 大廳／房間 | list_games、select_game、switch_game、list_rooms、list_owned_rooms、create_room、join_room、quick_join、leave_room、delete_room |
| 房主 | ready、start_game、update_room、kick_player、unban_player、transfer_host、invite_player |
| 社交 | friend_request、friend_respond、friend_remove、list_friends、block_player、unblock_player、list_blocks |
| 邀請 | list_invitations（incoming／outgoing）、decline_invitation、revoke_invitation；join_room／party_accept 是真實接受路徑 |
| 隊伍 | party_create、party_invite、party_accept、party_leave、party_transfer_leader、party_kick、party_disband、party_join_room |
| 配對 | queue_join（basic／advanced、rolePreferences）、queue_leave、match_accept、match_decline |
| 私人結果 | list_match_results（cursor／limit）、ack_match_result（resultId） |
| 聊天 | chat_send、chat_history（room／party）、chat_mute（scope／playerId／until）、chat_report（messageId／reason） |

### 關聯、重播與分包

- 直接回應用 Peer.reply 帶原 requestId；廣播用 Peer.send，不帶 requestId。
- 成功以 result{ok:true} 結束，失敗以 error{ok:false,code,message} 結束；收到廣播或第一個中間 response 不代表完成。
- 同玩家／相同 requestId／相同內容重播原直接 outcome；不同內容 request_conflict。只存請求內容雜湊，auth／refresh／ping／list／sync 不納入 mutation cache。
- Replay 帶 replayed／resyncRequired；SDK 先取得完整新 sync 再暴露 live state，不以舊 room_joined／leave response 復活已刪或錯清新房。
- 房間／大廳 revision 各自處理；snapshotId、0 起算 chunkIndex 與 chunkCount 必須收齊後原子套用，不能混合不同快照。單一巨大項目用 snapshot_chunk JSON payload 切段。
- 房間 cursor 是原玩家限定的穩定快照，逾期 snapshot_expired；游標／連線不持久。
- SDK convenience methods 接 RequestOptions.signal；abort 釋放 listener／deadline／request 等待，不承諾撤銷已提交 server 操作。mutation 僅明確 retryOnReconnect 才以原 id 重試。

### 房間與社交邊界

- owner 是建立者，host 是主持人；房內只有 host 可改設定／解散。owner 可 list_owned_rooms 後刪自己的無其他成員／寬限席／reservation 空房，空房仍計配額。
- host 離開後移交最早在線／保留玩家，無人回 owner；首位成功加入空房者成為新 host，原 host 回來不自動恢復權限。
- 加入先檢查並預留，再於佇列外驗密碼／admission；失敗／斷線釋放全部預留，最後重驗狀態、容量、版本、遊戲、封鎖與邀請。
- 隊長整隊加入也遵循上述流程且同一 transaction，不留下半隊或半個 accepted invitation。
- 房間設定變更／刪除、隊伍終止／變更、封鎖等會撤銷相關 pending 邀請；終態保留至 invitationRetentionMs。token 只給有權寄收件人，不能列第三方 mailbox。
- 配對先提案，不提前配置房間；全員接受才建房。拒絕／期限／斷線／維護／社交變更取消提案，其餘合格群組保留 queuedAt 回列；離線者不被新配對。
- block 是持久原子操作，清理舊社交同意與不相容群組；解封必須重新建立同意，不能接受封鎖前的舊 request。

### 聊天、結果與可見性

- 房間／隊伍訊息有穩定 id、時間、scope、原收件人集合；即時與歷史均檢查封鎖、原收件與目前成員資格，新成員不得取得舊私人歷史。
- 聊天專用 rate bucket 加上連線全域限流；字數預設 500、最高 2000，仍受 4 KB frame 約束；歷史、報告、禁言各有容量／保留／時長設定。
- 只有 host／leader 可 mute 合格成員；只有有權看訊息者能 report；有限原始證據持久保留，僅受保護管理 API 可審查／dismiss／mute／ban。
- durable match 保存原始參與 roster，不因房間、席位或目前遊戲切換遺失。晚結果僅接原 roster 身分；同內容回報冪等，不同內容衝突。
- 私人 resultId／內容／ACK 獨立持久。list_match_results 返回本人含已 ACK 歷史，登入／sync 只推未 ACK；SDK state.results 只表示 pending inbox，history query 不復活已 ACK 通知。
- 場次、結果、聊天、提案、邀請等清理均遵守配置上限／保留政策；不得因「已傳送」立即刪結果。

## 四、外部 API 契約

這些是 Beacon adapter 契約，不宣稱另案真實後端已上線。格式不同只改 adapter，不能把 HTTP 散落到大廳。

### OAuth／撤銷

- JWKS：RS256，驗 exp／iss／aud，取 sub／name、iat／jti；不由 Beacon 發 token。
- remote：POST {auth.apiUrl}/v1/verify，Authorization: Bearer 玩家 token；200 {playerId,displayName,issuedAt?,tokenId?}，401 拒絕。身分／名稱各最多 128 UTF-8 bytes。
- auth.mode=mock 僅 --dev-mock-auth 開發／測試；正式為 jwks／remote，無匿名 fallback。
- 設定 revocationUrl 後是必要依賴：GET 受保護撤銷清單 [{playerId?,tokenId?,revokedBefore?}]，非 mock 必須 bearer；拉取失敗拒絕新 auth 並中斷現有連線。缺 issuedAt 不得用 authAt 補。

### 遊戲清單、能力與場次

- GET {games.apiUrl}/v1/games → [{gameId,name,maxPlayersPerRoom,enabled,serverHint?,versions?,modes?,regions?,capabilities?}]。遊戲 ID／name 128 bytes、hint 1024 bytes；相容性陣列各 32 項／64 bytes。快取預設 60 秒；API 不可達使用明確標示 cache／config 的備援，不假稱真串接。
- capabilities 包含 joinPolicies、minPlayers、rules、roles、teams{count,size,requiredRoles}；rules 是 boolean／number／string descriptor，含合法 default、range、integer、enum 或長度。配置／清單載入驗證 descriptor，操作重驗；未提供 descriptor 的既有遊戲維持合法原行為。
- rules 至多 16 鍵、鍵 32 字元、字串 128 code points、JSON 1024 UTF-8 bytes；值為有限且安全範圍內的數值／字串／布林，number 可小數，integer:true 才限制整數，敏感 credential key 拒絕。
- POST {sessionApiUrl}/v1/matches：Idempotency-Key=operationId，body 含 operationId／roomId／gameId／版本／模式／區域／players／joinPolicy／rules；玩家 team／gameRole 與配對 assignments 一致。回 matchId／serverUrl／expiresAt／各玩家 tickets。
- POST /v1/matches/:id/admissions：{playerId,role} → 本人 serverUrl／ticket／expiresAt；GET 該 match 查 starting／in_game／ended／failed；DELETE 取消。URL 僅 HTTPS／WSS、禁止 URL 內憑證；回應大小與期限有界。
- GameSessionProvider 是最終場次權威，open／starting／in_game 轉換、持久 operationId 與重驗避免 callback 競態；serviceTokenFile 私密，未設定 API 明確 game_service_unavailable。
- 結束與個人結果經 bearer 管理 HTTP POST /matches/result 與 /matches/player-result。單機／HA 均保留原 match／roster，不要求房間仍存在。

### 可信配對 profile（新增提案契約）

POST {profileApiUrl}/v1/matchmaking/profiles；service bearer，body {gameId,playerIds}，回 {gameId,profiles:[{playerId,skill,regionRttMs,measuredAt}]}。

- 技能由遊戲後端維護，有限 0..1000000；regionRttMs 由後端實測，整數毫秒 0..60000；measuredAt 為 epoch 毫秒。
- 每個要求的身分恰有一筆，單次最多 256；缺漏／多出／重複／錯遊戲／未來／過期均拒絕。profileMaxAgeMs 是硬 freshness 界線。
- advanced 沒有後端、service bearer 或新鮮資料即 profile_unavailable；不接受 client 自報 skill／RTT，不靜默降級 basic。
- matching 設定所有技能範圍、隊伍技能差、RTT 上限、等待放寬起點／間隔／步長／最大值、searchLimit。pure matcher 先檢查容量／角色供給，搜尋有界且不拆隊；預算耗盡明確回 matchmaking_search_exhausted 並保留佇列。
- 維護不需新 queue_join 即可按等待門檻再配；profile 更新在佇列外並重驗當前群組／身分，接受提案也重驗，變成無效不能配置房間。

## 五、資料模型、遷移與耐久性

| 層 | 資料／權威 |
|---|---|
| 連線記憶體 | WebSocket／auth session／deadline／正在進行 reservation，重啟需重新 auth |
| SQLite rooms／social／moderation／audit | 房間與密碼雜湊、擁有者／房主、seats、好友、隊伍、帶寄收件者終態邀請、封鎖、管理處分與稽核 |
| SQLite domain_records(kind,id,data) | 正規化 match／private result／chat／report／mute／queue／proposal records；不是每次寫全 domain blob |
| HA etcd | leader lease／epoch、鍵差異 request outcomes、原生 SQLite changeset journal、分塊 checkpoint manifest；跨主機權威 |
| 各主機本機 DB | authority／worker materialization，保護 DB、WAL、SHM 與 replica 檔，不共用網路檔案 |

- schema 5；啟動原地 migration、先備份。舊席位 pendingResult lossless 搬到私人 inbox；缺可信 sender／createdAt／status 的舊邀請失效，不能猜 sender 授權。錯誤／損毀不清空資料。
- 每次改動僅寫 changed keys／records；nested transaction staged cache 與 SQL 一致，rollback 也恢復 cache，不能讓暫加再刪的資料殘留。
- 單機：SQLite COMMIT → 記憶體／可見輸出 → 成功。HA：同 transaction 的 changeset 先經 etcd epoch-guarded commit → 本機 COMMIT → ACK；遠端提交後本機失敗立即 self-fence，不能留下兩個 writer。
- Native applyChangeset 衝突 abort，不 OMIT／REPLACE 掩蓋還原不一致。Checkpoint 有界分塊、manifest／hash／大小驗證；小 mutation 不輸出整個 SQLite snapshot。
- lease／quorum 失效：拒絕寫入／新 auth，關閉受影響 tunnels，舊 writer 即使暫停後恢復也不得提交或送過期 authority 的私人 ticket／ACK。
- durable outcome 綁 player／requestId／canonical payload hash。已知終態 TTL 淘汰；未知 outcome 留有界 indeterminate tombstone，不能因 TTL 到期重新執行。不明結果先查 provider／reconcile，禁止換 id 盲重試。
- queue／proposal、結果／ACK 與 chat 可重載；在線連線、列表 cursor 不持久。重新 auth 後才恢復席位與合格配對，不能把離線 roster 當在線。
- 備份一律 backupDatabase；不可直接複製運作中的 DB／WAL，亦不可直接呼叫可能卡住的 node:sqlite backup。單機還原需停止 writer、保留舊 DB／WAL／SHM、驗證備份再換檔。
- HA 災難還原需保存／還原 etcd authoritative snapshot 與私有設定；現存 quorum 會覆蓋本機舊資料，不能只換一份 SQLite 回滾全群組。停全部 Beacon、只啟一個確認一致的 quorum，禁止 split restored clusters。

## 六、安全性架構（十四條硬規則）

1. **傳輸分層**：外網僅 WSS／設定 domain、一般 HTTP(S) 403／426；app upstream 與 control／ops 只綁 loopback 且拒絕非 loopback 來源。Cloudflare TLS 終結後的本機 upstream 不解除外網 WSS 規則。開發明文只限明確旗標；direct TLS 仍只 loopback。
2. **驗證前置**：預設 10 秒內 auth，失敗後斷線；外部驗證不可達 fail-closed，無匿名 fallback。
3. **來源與配額**：Origin 白名單；無 Origin CLI 由設定決定；預設每 IP 10、總量 5000、新連線 5/10 秒。只有受信任 loopback／代理來源才採 CF-Connecting-IP／XFF 最右可信值，其餘用 socket remoteAddress。代理同驗 forwarded HTTPS 與 exact Host，不能相信 client 自造標頭。
4. **密碼**：每房獨立隨機 salt、scrypt 與 timingSafeEqual；不入日誌／推播／列表；預設 5 次/分鐘/玩家、跨連線不重置，重啟不持久。
5. **競態與容量**：同步預留 → 佇列外驗密碼／admission → 重驗／原子確認或全部釋放；整隊也不得超員／拆隊。
6. **輸入**：入站 4 KB、三次 JSON 解析失敗即斷線；所有欄位型別／長度／字元集驗證，未知欄位拒絕，房名 1–32 字、禁止控制字元。
7. **限流**：每連線預設 20/10 秒 token bucket，超限 rate_limited、連續違規斷線；聊天另有專用 bucket／保留容量。
8. **憑證與日誌**：token／JWT／password／ticket／admission／authorization 一律遮蔽；外部任意 response body、錯誤訊息、堆疊可能回顯憑證，連伺服器診斷也不記，只記安全分類／欄位。聊天本文不入一般日誌。
9. **供應鏈／資料**：runtime 只有 ws、lockfile、CI npm audit --omit=dev；不使用 eval／Function 或 user-input dynamic require。SQLite／WAL／SHM／replica、secret／password／私鑰與備份均私密；資料檔預設 0600，路徑來自 config。
10. **資源**：ping／pong 回收、highWaterMark／背壓、慢連線踢除、每遊戲預設 1000 房；入出站、分頁、聊天／結果／報告、配對搜尋、checkpoint／journal／request cache 皆有界，不靜默截斷正規快照。
11. **驗證模式**：mock 只 --dev-mock-auth 開發／測試；正式 jwks／remote，不用開發旗標部署；真實 OAuth 未接通不得宣稱正式整合驗收通過。
12. **管理**：只 loopback，每個端點含 health／ready／metrics 都 bearer；token 為 0600 一般檔、拒絕符號連結／過寬權限，常數時間比對；嚴格 body／欄位限額，mutation 持久稽核，metrics 僅彙總。
13. **場次隱私**：ticket／admission／私人結果只給本人，不能廣播／日誌／metrics；冪等請求內容僅 hash，不能保存原 token／房密 request body。結果回報驗原 roster，不以目前房間成員代替。
14. **撤銷 fail-closed**：設定 revocationUrl 後不可達即拒絕新 auth 並中斷現有；缺 token 簽發時間時 revokedBefore 視為撤銷，不以 authAt 代替。

**HA 補充**：production etcd endpoints 必須 HTTPS、專屬 user／private password／CA，選用 client cert／key 成對；私有 control 必須 WSS、server cert／key／CA、shared bearer、loopback 與 forwarded IP／Origin／Host 重驗。development:true 仍必須 --dev-insecure-ws，HTTP／WS 只允許 loopback。privileged etcd 管理／compaction／defrag／snapshot 由基礎設施擁有者執行，app 不改全域 cluster 保留政策。

Cloudflare **另設 block 規則**拒絕設定 domain 的所有 HTTP scheme，包含 WS upgrade，不能只靠 HTTPS redirect。

## 七、文件與 SDK 交付

| 檔案 | 規格 |
|---|---|
| README.md | 實際安裝／設定／protocol v3／SDK tarball／私有管理／單機與 HA 部署／備份／真實驗收與已觀察證據 |
| AGENTS.md | 工程、架構、資料／adapter／安全硬規則；實作必須遵守，不藉本企劃弱化 |
| CLAUDE.md | 引用 AGENTS，不建立第二套安全真值 |
| PLAN.md | 完整現行企劃、R1–R32、架構／契約／安全／部署／風險／gates，不能只附一個不一致的 v3 待辦 |
| packages/client | 可獨立打包 exports／d.ts／ESM／LICENSE／README／JSON Schema，未發布，不保留根 ./client alias |

SDK typed subscription、BeaconResult.get 與 state 在 browser／Node 對應真實 wire；未識別／malformed 訊息不進 typed events。打包後必須在隔離 consumer 安裝 tarball、實際 import、strict TypeScript browser／Node compile，不能只斷言檔案文字。

## 八、部署與內部維運

### 單機與 public Tunnel

- Mac mini：使用者以標準 app 身分先 build／typecheck，再明確 sudo 執行 install-launchd；app 不是 root，開機未登入由 system LaunchDaemon 啟動。existing plist 不覆寫；root 僅安裝服務，不跑 npm。
- cloudflared 是另一個受審核 LaunchDaemon，私密 credentials JSON／token-file 不放命令列／plist／history。使用者建立 Tunnel／DNS／WSS／HTTP block 規則，loopback upstream 保留設定 Host 與 forwarded HTTPS。
- Linux 另用 install-systemd、已存在非 root app 使用者；本次未在 Linux／Mac mini 部署，不以本機 fixture 替代。
- config 只 flow-style JSON 與引號外 # 註解，不使用舊企劃的 block YAML 摘錄。全部完整欄位以根 config.yaml 為準，改 domain／port 與代理配置需人工同步、重啟。

### 跨主機 HA

1. 管理者建立 3／5 etcd 成員，分離 failure domains，client／peer 私網 TLS、專屬 prefix ACL、operator-managed compaction／defrag／snapshot；app 不安裝或重配 etcd。
2. 每個 gateway 使用完整 config、唯一 nodeId／本機 db.path、相同 endpoints／prefix／control secret；enabled:true、development:false、HTTPS etcd 認證。控制埠仍 loopback。
3. 每台 control 使用不同私網 wss advertiseUrl，配置可信 cert／key／CA；透過私網 TLS pass-through 或 re-encryption 代理到 loopback，保留 Host。私有 authority 不放到公開 lobby domain，ops 不對外路由。
4. 從單機升級先停服務並 backup；只啟持有正確 DB 的一個節點 bootstrap 空 prefix，再啟其他節點。已有 authority 時所有重啟以 etcd 為真值，不合併不同舊 DB。
5. 公開 gateway 可多個轉送 authority；所有 mutation 與私人 outbound 必須有當前 lease／epoch。失去 quorum 關閉 tunnels／拒絕 auth與寫入，重連需重新 auth／sync。
6. leader-only 業務 admin mutation／查詢在 follower 明確 not_leader；GET /cluster 可看各節點健康／role／lease／還原進度。GET /ready 表示本節點 authority readiness，follower 503 不表示 gateway 不能轉送；quorum 失效全部 503。
7. scripts/cluster-smoke.mjs 對專用隔離 quorum 實測 gateway／接管／pause／去重；--quorum-marker 由操作者停止兩個測試成員後建立，不能不做就宣稱通過。--tls-directory／--etcd-user／--etcd-password-file 支援真正 HTTPS auth／私有 WSS，但 OAuth／遊戲仍是本機 fixture，不能算正式整合。

### 管理介面

每個端點包含 health／ready／metrics 都 loopback bearer；GET audit／rooms／rooms/:id／matches／matches/:id／queue／integrations／cluster／chat/reports／chat/reports/:id 採有界安全投影。列表最多 200 與 65536 bytes 雙界線，必須依 nextCursor 續取，不能假設滿 limit。

POST ban／unban／revoke／rooms/close／maintenance／matches/result／matches/player-result／matches/reconcile／chat/reports/review 持久稽核。reconcile provider HTTP 在序列化外，回來重新驗證；不以管理按鈕虛構場次成功。review action=dismiss／mute／ban，until／reason 必填，dismiss until=0，其他 future，reason ≤256 UTF-8 bytes；一般 metrics 不含身分／報告本文／ticket。

排程備份只輪替自身產物；告警僅 service／event／severity／id／at，backup_failed=critical、not_ready=warning；所有停用依賴明確記分類。維護拒絕新 auth／建房／加入／配對／開局；server_draining 提供 deadline 後排空關機。

## 九、風險與處理

| 風險 | 因應／界線 |
|---|---|
| 真實 OAuth／遊戲／profile 契約未上線 | adapter 實作與明確提案契約已備；advanced／開局 fail-closed，正式 gate blocked，不假造整合證據 |
| 單機／quorum／authority／私有網路故障 | lease／epoch、durable changeset、隔離接管／paused writer／quorum-loss 演練；實體跨主機與 SLA 還需實際部署證據 |
| 外部配置未知 outcome | 同 operationId provider reconcile；durable indeterminate request 不過期重做；滿容量 fail-closed，不自動換 id |
| 巨量聊天室／結果／checkpoint | 正規化 changed records、小 changeset、TTL／筆數／bytes／search budgets；不以整庫拷貝回應每次 mutation |
| 配對組合爆炸／無角色供給 | suffix 容量與角色可行性剪枝、有界搜尋，無解／budget exhaustion 區分，保留隊伍與原年齡 |
| 儲存提交／recovery 衝突 | SQL＋記憶體 rollback，遠端已 commit 而 local fail 立即 fence，apply conflict abort，保留證據，不吞 error |
| 私人結果／聊天／憑證洩漏 | 原 roster／recipient 可見性、typed 嚴格 wire、admin allowlist／byte-budget、日誌安全分類與 metrics 彙總 |
| v2／v3 或不同 namespace 資料混跑 | 服務／SDK 同步切換、先 backup／單節點 bootstrap、schema 5 migration；不保留 legacy export 或兼容 alias |
| Mac mini 休眠／Tunnel／Cloudflare outage | 使用者審核不休眠／非 root daemon／私有備份；HA 實際 failure domains／proxy 路由另驗，不能以同機三程序保證跨機可用性 |
| 容量／CI 跨平台未量測 | 本機容量結果僅回歸、不承諾 production；Node24／十組 CI 矩陣與其他 OS 以實際執行為準 |

## 十、里程碑與驗收 Gate

| Gate | 驗收要求與本次狀態 |
|---|---|
| 0 歷史前置 | 三檔先行推送已完成；本次不重查／重推，也不把舊發布當 v3 已發布 |
| A 協定／建置／本機安全 | build／typecheck、限時 auth／WSS／loopback／mock 管制及 schema 回歸通過 |
| B adapter 開發整合 | 本機 HTTP fixture 驗 auth／games／session／profile，真實 adapter 執行；不代表真實外部整合 |
| C 房間／持久化 | 房密競態／容量／owner-host／restart／DB failure／atomic rollback 行為與 live SDK 場景通過 |
| D 本機擴充 | R21–R31 端到端 smoke、typed schema／SDK／isolated tarball／chat moderation／immutable ACK results 通過；文件本地已同步，v3 未 push |
| HA 本機故障證據 | 真實 etcd 3.7.2 三成員＋三 Beacon，HTTP loopback development 及 HTTPS+auth/private WSS 兩模式：共享／kill+restore／原檔重啟／去重／SIGSTOP stale writer 與延遲 ticket／quorum loss 均通過 |
| E 正式外部交付 | **blocked**：真實 OAuth 有效／過期 token、真實遊戲與 profile、外部 WSS／HTTP block、Mac mini 開機未登入／非 root／備份還原、跨實體主機 TLS／failover／quorum、設定改動生效與安全證據；不以 mock 通過 |
| 提交／發布 | 依使用者指示分功能提交；push／release／npm publish／Pages／production 仍需另行授權，本次未執行 |

### 2026-10-04 本次實際證據

- Node 26.7.0：build、typecheck、完整 node --test **144/144**、部署安全工具測試 **4/4**，npm audit --omit=dev **0 vulnerabilities**。
- 實際 SDK → WebSocket → SQLite → HTTP game/profile：封鎖與重新同意、邀請 mailbox 終態、隊伍權限／密碼整隊入房、capability 小數 rules、聊天／report／mute、刪房後結果／重複衝突／ACK／restart、可信角色配對提案與全員接受、AbortSignal 通過。
- 真實 Chromium／原生 WebSocket／獨立 SDK：auth、建房／owner 刪房、party state、abort 後 ping 通過，已觀察畫面／截圖，browser errors 為空。
- 真正 npm pack tarball 13 files，隔離 npm install／Node import、browser／Node strict TS consumer 通過，無 runtime dependencies，未發布。
- 真實 etcd HTTPS 開啟帳密認證、private control WSS、cluster.development=false 的演練也完成 quorum-loss；測試 peer 與公開 mock 都是本機 fixture，不宣稱 production 跨主機部署。
- 容量 CLI 32 clients／4 人房／1 round／160 requests；p50 約 1.14 ms、p95 2.26 ms，最後 rooms／reservations／inFlight=0；不是正式容量保證。
- 一次性驗證頁／腳本、私鑰／密碼、暫時 databases／etcd instances 均在交付前回收；可重用 HA／容量／部署工具留在 scripts。

## 十一、已知條件與外部待備

1. 根 config 預設 auth.mode=mock、games API／session／profile endpoint 空、operations／cluster 停用，正式啟動拒絕 mock 是安全設計。需要有權的真實 OAuth／遊戲／profile 端點與部署設定，不搜尋或索取任意憑證。
2. 新 profile、capabilities／team／gameRole、結果 callback 是 Beacon 的明確契約；外部系統若不同需由所有者確認並改 adapter，不能聲稱另案已採用。
3. 正式 HA 需 3／5 quorum 的真實 failure domains、私網 DNS／proxy／TLS／ACL／受保護 backup；本機獨立程序與自簽 fixture 證書只證程式路徑，不證基礎設施 SLA。
4. Cloudflare Tunnel／DNS／HTTP block、Mac mini 開機與權限、真實 token 驗證／外部 WSS／真實場次與可信 profile 證據尚不可用；完成可達實作，不宣稱 Gate E 通過。
5. CI 保留 Node24／26 十平台組合；本次只跑此 macOS arm64 的 Node26，未把 CI 設定當執行結果。
6. npm package 名稱已選 @js-package/beacon-client，但 registry 尚未發布，也未驗證遠端命名權限；本次交付的是可安裝 tarball 與原始碼，不是已可 npm install 的公開版本。
