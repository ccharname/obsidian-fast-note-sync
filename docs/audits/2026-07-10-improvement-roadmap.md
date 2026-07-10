# 双端提升点深度复审与路线图（2026-07-10）

对象：fastnotesync（插件 v2.3.1）+ fast-note-sync-service（服务端 HEAD=28f0066a，v3.6.0）。
方法：4 路并行深度调研（客户端性能 / 服务端性能 / 协议架构演进 / 功能面盘点），全部发现带 file:line 证据；三个最重发现（冲突代码被注释、rename ack FIFO、删除路径直写）经主审独立亲验。
基线：2026-07-09 审计的 38 项修复 + 2.3.0/3.6.0 滑动窗口流水线均已确认落地（含 E2E 报告发现的 pipeline-window 配置 0 回滚失效，已由 `bf5d253c` 修复）。本报告只列**当前 HEAD 仍存在**的问题与机会。

## 核心结论

1. **最痛的不是缺大功能，而是三个"最后一公里"**：冲突发生了不告诉用户（双端代码都写好了、被注释掉）、失败了用户找不到失败清单、分享了没有管理台。全部低成本高回报。
2. **两个伪装成性能取舍的正确性漏洞**：>10MB 文件只采样头尾 5MB 哈希 → 中段修改永不同步（确定性遗漏，非概率）；rename ack 盲 FIFO 匹配在滑动窗口时代错位概率上升（协议字段服务端早已下发，纯客户端未接）。
3. **大库上传慢的真实第一瓶颈已经不在协议层**：窗口化后 RTT 已压到亚秒级，瓶颈移到服务端 per-user 写队列每 op 内联"DB 写+文件写+Bleve 索引写"三段同步 IO，1 万笔记 ≈ 10-20s 纯串行墙钟。
4. **Merkle 树的价值形状变了**：窗口化没有触碰"每次同步都传全量清单"的字节地板（1 万文件 ≈ 300-450KB 压缩后）。Merkle（或轻量两级根哈希对比）的价值全部集中在零变化/小变化的日常轮询同步 → 几十字节。投入前先埋点量化"零变化同步占比"。
5. **配置 0 值被吞的坑是一类不是一个**：pipeline-window 修了，但 `max-open-conns`/`max-idle-conns`（双层吞回，且 0 是 database/sql 合法语义）和 `HistoryKeepVersions` 同款仍在。

## Tier 0 · 正确性级（应最先修）

| # | 问题 | 证据 | 成本 | 端 |
|---|---|---|---|---|
| A1 | **冲突处理最后一公里被注释**：服务端检测到真冲突后静默硬拼接双方文本（`MergeTextsIgnoreConflictIgnoreDelete`），通知用户的 `ErrorSyncConflict` 响应和 `ConflictService.CreateConflictFile`（生成 `{name}.conflict.{ts}{ext}` 副本）整段注释；ConflictService 功能完整、已注入 DI、全仓零调用。客户端 `ERROR_SYNC_CONFLICT=530` 处理分支+五语文案全就绪，永远收不到 | 服务端 `ws_note.go:297-340`（todo 注释亲验）、`services.go:86`；客户端 `websocket_manager.ts:16,359-362,530` | **低**（解注释+接线） | 双端（客户端近零改动） |
| A2 | **rename ack 盲 FIFO 错位**：`receiveNoteRenameAck` 只声明 `{lastTime?}`、`pendingNoteRenames.shift()` 盲匹配；协议字段 `path`/`pathHash` 服务端早已下发（proto:201, ws_note.go:587-591）、pb mapper 也能解出。滑动窗口多批在途后，断线丢 ack 场景错位概率上升，会把 B 的 hash 写到 A 的路径。同文件 `receiveNoteDeleteAck` 已是 path 匹配写法，照抄即可 | 客户端 `operator_note.ts:641-654`（亲验）；`pb/protobuf_mapper.ts:234-243` | **极低**（≤2 文件） | 纯客户端 |
| A3 | **大文件采样哈希 → 中段修改永不同步**：>10MB 只 hash 头尾各 5MB，中段变化+mtime 变 → 重算后哈希不变 → 判"未修改"。视频/音频/大 PDF 中间修改确定性静默丢失，无任何披露 | 客户端 `helpers.ts:427-428,442-456,511-538` | 中（换 crypto.subtle / Node crypto 流式；至少先在设置里披露） | 纯客户端 |
| A4 | **墓碑 7 天物理清除 → 离线设备复活已删文件**：设备离线超 `SoftDeleteRetentionTime`（默认 7d）再上线，错过已物理清除的删除墓碑，可能把已删文件当"服务端没有"重新上传复活 | 服务端 `note_repository.go:471`、`note_service.go:950-951`、`config/app.go:24` | 中（如：客户端记录"上次成功同步时间"，超期强制走全量对账/提示） | 双端 |

## Tier 1 · 性能高性价比

### 客户端

| # | 问题 | 证据 | 影响（1 万文件基准） | 成本 |
|---|---|---|---|---|
| P1 | **删除路径绕过防抖，整表 stringify 直写 localStorage 复发**（历史白屏 bug 第三条路径）：`removeFileHash()` 等直接 `saveToStorage()` 未走已有 `scheduleSave()` 500ms 防抖；config_hash / folder_snapshot 同款。调用点全在接收远端删除/rename Ack 的高频路径 | `file_hash_manager.ts:219-224`（亲验）、`config_hash_manager.ts:243-248`、`folder_snapshot_manager.ts:209-213`；调用点 `operator_note.ts:457,553,646,661` 等 | 远端批量删 1000 文件 = 1000 次数百 KB 同步序列化写，移动端明显卡顿 | **极低**（三处换 scheduleSave） |
| P2 | 首次冷建哈希表纯串行，未复用 0b94508 的 6 路并发（dadad99 镜像兜底没管到三级缓存全 miss 的真冷建） | `file_hash_manager.ts:97-154`、`config_hash_manager.ts:100-150` | 全新安装/存储全清场景慢 3-6× | 低 |
| P3 | `sleep(0)` 被 Chromium 4ms 钳制：全量扫描主循环 ~500 次让出 ≈ 2s 纯排队白等 | `operator.ts:629-630,792,810,823,841`、`helpers.ts:615` | 每次连接/重连的 handleSync 多 ~2s | 低（换 MessageChannel/scheduler.yield） |
| P4 | 大文件下载完成时逐片读回+拼接，峰值 2× 文件大小内存；"磁盘分片"只保护下载中 | `operator_file.ts:1318-1343` | 50MB 文件完成瞬间 100MB+ 峰值，多文件并发叠加 | 低-中 |
| P5 | 增量缺失检测 O(库大小)：实为两遍 O(N)+Set 查找（毫秒级），且只在连接/重连触发；结合 P3 修复后实际收益不大 | `operator.ts:597,817-848` | 低（降级为低优先，先做 P3 再量化） | 中 |

### 服务端

| # | 问题 | 证据 | 影响 | 成本 |
|---|---|---|---|---|
| P6 | **写队列每 op 内联 3 段同步慢 IO**：per-user 单 worker 串行跑 ①GORM 写 ②`SaveContentToFile`（MkdirAll+WriteFile）③`upsertFTS`（Bleve 同步 Index）。drainBatch 只优化了调度开销这个次要矛盾。方向：正文文件/FTS 摘出写关键路径异步攒批（Bleve 原生 Batch API），Delete 顺带消掉 deleteFTS 冗余 SELECT | `writequeue/manager.go:284-334`、`note_repository.go:353-467,1140-1188`、`dao_helper.go:37-43` | 1 万笔记全量上传 10-20s 纯串行墙钟（网络卷放大），当前大库上传第一瓶颈 | 中（一致性权衡） |
| P7 | **配置 0 值吞回同类坑**（E2E 报告点名的排查兑现）：`max-open-conns`/`max-idle-conns` 裸 int 被二次 defaults.Set 吞回 10/100，且 `dao.go:482-494` 调用点又把 0 当未设置（双层）；0 在 database/sql 是合法运维语义。`HistoryKeepVersions` 同款（0=无限保留被吞回 100） | `config/database.go:19-20`、`app/config.go:78`、`dao/dao.go:482-494`、`config/app.go:30`+`note_history_service.go:486` | 容量调优安全阀失效 | 低（照抄 bf5d253c 指针化模式，含调用点） |
| P8 | 批量删除逐条同步广播等待：`doNoteSync` 循环内逐条 `Delete`+`BroadcastResponse`，每条等最慢设备 `wg.Wait()` | `ws_note.go:807-877` | 大目录清空 × 一台慢设备 = N 次广播等待叠加 | 中（攒批/异步发送） |
| P9 | 【推测】gws 应用层写入无超时：仅心跳设 WriteDeadline；僵尸连接（挂起移动端）可阻塞 WriteMessage 至 OS TCP 超时，且写锁互斥连心跳探测一起卡死，拖住整个用户的广播扇出。需一次"暂停设备网络"实测坐实 | `pkg/app/websocket.go:588-608,736-802` | 多设备用户广播链路分钟级卡死风险 | 低-中（统一短写超时 5-10s，接入现有 failCount 熔断） |

已确认非问题：下载缓存正文物化（07f34e3e 已改按页回填，窗口化未放大）；WS permessage-deflate 已默认开启（`config/app.go:62-64`、`router.go:66-73`）；protobuf 未覆盖的只剩体积可忽略的控制消息；React 日志视图分页+节流双保险；MySQL/PG 索引随 GORM tag 同等生效。

## Tier 2 · 功能补全（按价值/成本比）

| # | 缺口 | 现状证据 | 价值/成本 | 端 |
|---|---|---|---|---|
| F1 | **同步失败项视图**：筛选器无 status=error；错误缺省只显裸 `Code: 403`；5000 条上限冲掉早期失败。加"仅看失败"+失败项持久化+错误码文案表+状态栏红点 | `sync-log-view.tsx:430-443`、`sync_log_manager.ts:58,145-151,241,246` | 高/低 | 客户端 |
| F2 | **13 种语言已翻译未启用**：import 整段注释；ja/ko/zh-TW 各缺 1-2 个 key | `lang.ts:3-26,115-129` | 中/极低 | 客户端 |
| F3 | **分享管理中心+过期时间**：无 expireAt 字段、无集中管理列表（REST 已有列表接口，插件无 UI）；取消分享要去文件树找文件。有密码无过期是安全半成品 | `http_api_service.ts:660-824`、`REST_API.md:979-1080` | 高/低-中 | 双端 |
| F4 | **冲突 diff/合并 UI**：A1 只是告知+留副本；note-history 的 diff 渲染组件可直接复用做并排预览/逐块选取 | `history-detail.tsx:17-95`、`operator_note.ts:257-261` | 高/中 | 双端 |
| F5 | **include-only 选择性同步**：规则引擎纯 exclude-based，"只同步 A 目录"要 `.*`+白名单组合技且 UI 零引导；无 per-rule 大小阈值。移动端只拉子集是刚需 | `helpers.ts:45-48,131-165,238-261` | 中高/中 | 客户端为主 |
| F6 | **设备管理踢出/吊销**：ws-clients 面板纯只读，无 kick/token 吊销；叠加 SSO obsidian:// 明文传 token、cloud preview 回退 URL 拼 apiToken 进 query（泄露到日志/referrer） | `http_api_service.ts:848`、`main.ts:416-463`、`file_cloud_preview.ts:627-635` | 中高/中 | 双端 |
| F7 | 版本历史补全：无任意两版对比、无单版删除、保留策略客户端不可见；`soft-delete-retention-time` 未配置时整个全局清理任务静默不跑 | `note_history_service.go:100-131,309-427`、`task_db_clean.go:144-147` | 中高/中 | 双端 |
| F8 | MCP 语义检索：现状纯 CRUD+BM25，无 embedding；"AI 知识库"卖点下 MCP 侧性价比最高增量；folder tool 缺 list/create | `note_repository.go:1234-1331`、`folder_tools.go:21-67` | 中高/中 | 服务端 |

## Tier 3 · 架构级（先量化/定调，再动手）

| # | 方向 | 新基线下判断 |
|---|---|---|
| R1 | **Merkle / 两级根哈希对账** | 价值形状从"省 RTT"变为"省带宽"：窗口化后 13 个窗口周期已亚秒级，但零变化轮询同步仍传 300-450KB 全量清单，Merkle 压到 ~64B。**先埋点统计"一次同步真实变化数/总量"分布**——长尾零变化占多数才投；轻量替代：根哈希优先对比，miss 才发全量清单（两级机制，成本远低于全 Merkle 树） |
| R2 | **E2EE** | 服务端全链路明文（六存储后端、DB content、Bleve 倒排都必须经手明文），且 E2EE 与核心卖点（服务端三方合并/FTS/网页分享/MCP）全冲突；客户端 README 承诺了、服务端 roadmap 未列——**口径先统一**。务实路线：先做静态加密（落盘/备份加密，密钥服务端持有，不破坏功能）；E2EE 若做，per-vault 可选并明示功能损失 |
| R3 | CRDT/实时协作 | 不建议现在做。个人多设备画像下，A1+F4 闭环后现有三方合并够用；先补多设备(3+)并发编辑压测，再判断是否需要 version vector |
| R4 | 正文/元数据解耦+字节分页 | 文件层早已是分离模型；剩余价值收窄为"大笔记页平滑流水线尾延迟"（条数分页混入大笔记可能触发 15s 假性超时重发），排最后 |
| R5 | diff-based 增量传输 | 不可行起步：服务端无客户端版本快照做 diff 基线，需新增版本存储基础设施；已有 WS 压缩兜底，收益跑不赢成本 |

## 落地状态（2026-07-10 当日 Workflow 执行完成，18 项计划 17 项落地）

- **客户端 12 commit**：`1dc9e80..4f2001c`（A2 rename ack 精确匹配 / P1 删除防抖 / P3 yieldToMain / P2 冷建并发 / A3 三段采样+披露 / P4 下载 2× 内存消除 / F1 失败项视图 / A4 离线守护 / X1 分享管理台+过期 / X2 冲突合并 UI / 审查回修离线守护取消后失效）
- **服务端 8 commit**：`83be2b95..46c688c7`（P7+HistoryKeepVersions 0 值指针化 / A4 保留期 90d / P9 WS 写超时 / P8 删除广播异步化 / A1 冲突接线 530+副本 / P6 FTS 异步攒批 / F3 分享过期 / 审查回修 task_db_clean 0 值+FTS 队列关闭竞态）
- **跳过 1 项**：F2 启用 13 语——核实上游 `4826412` 已主动删除 13 个语言文件（"去掉一些小语种支持"），本条目前提不成立，撤销
- **审查阶段拦下 3 真问题**：客户端离线守护"取消一次后下轮即失效"（high，已修）；服务端 task_db_clean 又一处 0 值吞回（high，已修）、FTS 队列优雅关闭 send-on-closed-channel 竞态（medium，已修）；分享永久默认经核实为既定语义非回归（旧版 expiry 存了但校验分支从未触发，实际行为等价）
- **验证**：服务端 build/vet/test 全绿 + 4 个并发包 -race 通过；客户端 build+test:mirror 绿，test:auth 为既有破损（引用 `a759a0a` 就已删除的 src/lib/websocket.ts，与本轮无关）
- **待人工验收**：F1 失败视图 / X1 分享管理台 / X2 冲突合并 UI 三个 UI 件需真机体验；A1 冲突链路建议双设备实测一次
- **未做（维持待拍板）**：R1-R5 架构级全部、F5-F8 功能件

## 建议执行顺序

1. **一波小修（全部低成本）**：A2 rename ack path 匹配 → P1 删除路径防抖 → P7 配置 0 值指针化（含 HistoryKeepVersions）→ F2 启用 13 语 → P3 sleep 换 yield → P2 冷建并发。
2. **冲突闭环（本轮最大产品增量）**：A1 解注释接线（通知+冲突副本）→ F1 失败项视图 → F4 冲突 diff UI。
3. **性能主攻**：P6 写队列摘出文件 IO/FTS（大库上传第一瓶颈）；P8/P9 先 E2E 复测坐实再修。
4. **正确性补漏**：A3 大文件哈希策略（至少先披露采样行为）；A4 离线超墓碑期对账。
5. **量化后拍板**：R1 埋点零变化同步占比 → 决定两级根哈希/Merkle；R2 E2EE 口径统一+静态加密。
