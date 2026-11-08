/**
 * 笔记「客户端自动三方合并」核心（clientAutoMerge 模式）。
 *
 * 握手时对服务端固定声明 manualMerge，只借用它的 baseHash CAS：
 *   - 上传携带 baseHash=本机最后确认的服务端 hash；服务端 hash 不同 → 530 + serverContent/serverHash；
 *   - 服务端不改写客户端提交的内容，所以「Ack 后 base = 自己发出的内容」是精确的。
 * 本模块只含协议无关的状态机；所有对 Obsidian / WebSocket 的访问经 CoreDeps 注入，
 * 因此可以在 node 里用桩服务端驱动两个客户端核心做时序测试。
 *
 * 并发约定：本类的入口方法（requestUpload/onAck/onConflict/onRemote/sweep…）自己按路径加锁；
 * 以 *Locked 结尾的内部方法要求调用方已持有该路径锁。
 */
import { diff3Merge } from "./diff3"
import { UploadTracker, type UploadKind } from "./upload_tracker"

export interface RemoteNote {
  path: string
  content: string
  contentHash: string
  mtime?: number
  ctime?: number
}

export type ConflictReason = "overlap" | "no-base" | "retries" | "hash-mismatch" | "error"

export interface ConflictInfo {
  /** 真 base（可信才有），无则 null */
  base: string | null
  local: string
  remote: string
  serverHash: string
  reason: ConflictReason
  conflicts?: number
}

export interface CoreBaseStore {
  /** base 登记的 hash（不读文件）；插件目录文件为准，localStorage 丢失重建 syncHash 时靠它识别「本地其实已分叉」 */
  peekHash(path: string): string | null
  get(path: string, expectedHash: string | null): Promise<string | null>
  put(path: string, content: string, hash: string): Promise<boolean>
  delete(path: string): Promise<void>
}

export interface CoreDeps {
  hash(s: string): string
  now(): number
  baseStore: CoreBaseStore
  /** 取路径锁并执行；必须保证 fn 最终被执行（抢不到锁要重试，不得静默丢弃） */
  locked<T>(path: string, fn: () => Promise<T>): Promise<T>
  readNote(path: string): Promise<string | null>
  /** 原子比较并交换：当前内容 === expected 才写入 next；用户又改了内容 → 返回 false */
  casWrite(path: string, expected: string, next: string, opts?: { ctime?: number; mtime?: number }): Promise<boolean>
  createNote(path: string, content: string, opts?: { ctime?: number; mtime?: number }): Promise<void>
  statNote(path: string): { mtime: number; ctime: number; size: number } | null
  getSyncHash(path: string): string | null
  setSyncHash(path: string, hash: string, mtime?: number, size?: number): void
  removeSyncHash(path: string): void
  isConflicted(path: string): boolean
  registerConflict(path: string, info: ConflictInfo): Promise<void>
  clearConflict(path: string): Promise<void>
  /** 发送 NoteModify；返回 false 表示未能占到并发槽位 */
  sendUpload(path: string, entry: { content: string; contentHash: string; baseHash: string | null; kind: UploadKind; context?: string; isCurrent: () => boolean }): Promise<boolean>
  sendRePush(path: string): void
  releaseSlot(path: string): void
  setPending(path: string, hash: string): void
  clearPending(path: string): void
  saveLost(path: string, content: string, why: string): Promise<void>
  log(action: string, message: string, status: "success" | "error" | "cancelled", path: string): void
  schedule(fn: () => void, ms: number): void
}

export type RemoteOutcome = "applied" | "confirmed" | "merged" | "conflict" | "deferred"
export type UploadOutcome = "sent" | "queued" | "blocked" | "nochange" | "missing"

export const MAX_530_RETRIES = 5
export const RECENT_ACK_WINDOW_MS = 5000
export const UPLOAD_TIMEOUT_MS = 30000
const REPUSH_MIN_INTERVAL_MS = 3000
const CAS_RETRY_MS = 1500

export class NoteMergeCore {
  readonly tracker = new UploadTracker()
  private deps: CoreDeps
  private attempts = new Map<string, number>()
  private deferred = new Map<string, RemoteNote>()
  private deferredTimers = new Set<string>()
  private lastRePush = new Map<string, number>()
  private recentAck = new Map<string, { hash: string; at: number; prevBase: string | null }>()

  constructor(deps: CoreDeps) {
    this.deps = deps
  }

  /**
   * 本机「最后确认的服务端版本」hash，用于判断本地是否分叉。
   * base 存储（插件目录文件）与 syncHashMap（localStorage）本应同步更新；两者都有而不一致时，
   * 说明其中一份不可信（典型：移动端 localStorage 被系统清掉后 syncHash 按本地内容重建，直接信它会把
   * 已分叉的笔记误判为「已一致」而覆盖本地）。此时不信任任何一方，返回 null，由后续逻辑转人工而不是覆盖。
   */
  private knownHash(path: string): string | null {
    const sync = this.deps.getSyncHash(path)
    const baseHash = this.deps.baseStore.peekHash(path)
    if (baseHash !== null && baseHash !== sync) return null
    return sync
  }

  // ------------------------------------------------------------------ 上传

  /** 用户编辑 / NeedPush / 恢复被远端删除的笔记 */
  requestUpload(path: string, opts: { kind?: "edit" | "needpush" | "recreate"; context?: string } = {}): Promise<UploadOutcome> {
    return this.deps.locked(path, () => this.uploadLocked(path, opts.kind ?? "edit", opts.context))
  }

  private async uploadLocked(path: string, kind: UploadKind, context?: string): Promise<UploadOutcome> {
    const d = this.deps
    if (d.isConflicted(path)) {
      // #276：冲突路径禁止上传本地内容；改为向服务端拉最新版本再尝试合并
      this.kickConflict(path)
      return "blocked"
    }
    if (this.tracker.has(path)) {
      this.tracker.markDirty(path)
      return "queued"
    }
    const content = await d.readNote(path)
    if (content === null) return "missing"
    const contentHash = d.hash(content)
    const baseHash = d.getSyncHash(path)
    // 只有「本机确认版本」可信（base 与 syncHash 一致）时才能据 hash 相等判无改动；不一致时照常上传，由服务端 CAS 把关
    if (kind === "edit" && contentHash === baseHash && this.knownHash(path) !== null) return "nochange"
    const entry = this.tracker.begin(path, { content, contentHash, baseHash, kind, context }, d.now())
    if (!entry) {
      this.tracker.markDirty(path)
      return "queued"
    }
    d.setPending(path, contentHash)
    const sent = await d.sendUpload(path, { content, contentHash, baseHash, kind, context, isCurrent: () => this.tracker.get(path)?.seq === entry.seq })
    if (!sent) {
      this.tracker.complete(path)
      d.clearPending(path)
      return "blocked"
    }
    return "sent"
  }

  /** 冲突解决弹窗的合并稿上传：绕过冲突闸，带 isConflictResolved；Ack 后同样 syncHash/base 前进 */
  uploadResolved(path: string, baseHash: string | null): Promise<boolean> {
    return this.deps.locked(path, async () => {
      const d = this.deps
      if (this.tracker.has(path)) return false
      const content = await d.readNote(path)
      if (content === null) return false
      const contentHash = d.hash(content)
      const entry = this.tracker.begin(path, { content, contentHash, baseHash, kind: "resolved" }, d.now())
      if (!entry) return false
      d.setPending(path, contentHash)
      if (!(await d.sendUpload(path, { content, contentHash, baseHash, kind: "resolved", isCurrent: () => this.tracker.get(path)?.seq === entry.seq }))) {
        this.tracker.complete(path)
        d.clearPending(path)
        return false
      }
      return true
    })
  }

  /** 冲突路径上有新编辑/NeedPush：节流后向服务端请求最新版本，回包走 onRemote 重试合并 */
  private kickConflict(path: string): void {
    const now = this.deps.now()
    if (now - (this.lastRePush.get(path) ?? 0) < REPUSH_MIN_INTERVAL_MS) return
    this.lastRePush.set(path, now)
    this.deps.sendRePush(path)
  }

  // ------------------------------------------------------------------ Ack

  /** 收到 NoteModifyAck。返回 true 表示对应一个登记的请求；false 为迟到/重复 Ack（不更新 base） */
  onAck(path: string): Promise<boolean> {
    return this.deps.locked(path, async () => {
      const d = this.deps
      const entry = this.tracker.complete(path) ?? this.tracker.takeExpired(path)
      d.releaseSlot(path)
      if (!entry) return false
      this.attempts.delete(path)
      d.clearPending(path)
      // 首次创建（baseHash 为空）时 Ack 之前的版本就是空文档
      const prevBase = entry.baseHash === null ? "" : await d.baseStore.get(path, entry.baseHash)
      await this.markSyncedLocked(path, entry.content, entry.contentHash, undefined, undefined, true)
      this.recentAck.set(path, { hash: entry.contentHash, at: d.now(), prevBase })
      await this.drainLocked(path)
      return true
    })
  }

  /** 单飞释放后的后续：先处理被推迟的远端推送，再处理期间产生的新编辑 */
  private async drainLocked(path: string): Promise<void> {
    const dr = this.deferred.get(path)
    if (dr) {
      this.deferred.delete(path)
      await this.reconcileLocked(path, dr, {})
    }
    if (this.tracker.takeDirty(path) && !this.tracker.has(path)) {
      await this.uploadLocked(path, "edit")
    }
  }

  // ------------------------------------------------------------------ 530

  /** 收到 530（服务端 CAS 拒绝）。serverContent/serverHash 缺失时只释放并重新拉取 */
  onConflict(p: { path: string; serverContent?: string; serverHash?: string; baseContent?: string }): Promise<void> {
    return this.deps.locked(p.path, async () => {
      const d = this.deps
      const path = p.path
      const entry = this.tracker.complete(path)
      d.releaseSlot(path)
      d.clearPending(path)
      this.tracker.takeDirty(path)
      if (typeof p.serverContent !== "string" || !p.serverHash) {
        d.log("NoteConflict530", "530 缺少 serverContent/serverHash，改为请求服务端最新版本", "success", path)
        this.kickConflict(path)
        return
      }
      // 530 之前到达的推送都比它旧；530 本身即服务端最新版本
      this.deferred.delete(path)
      const n = (this.attempts.get(path) ?? 0) + 1
      this.attempts.set(path, n)
      const remote: RemoteNote = { path, content: p.serverContent, contentHash: p.serverHash }
      if (n > MAX_530_RETRIES) {
        this.attempts.delete(path)
        const local = (await d.readNote(path)) ?? ""
        await d.registerConflict(path, { base: null, local, remote: remote.content, serverHash: remote.contentHash, reason: "retries" })
        return
      }
      // 不信任服务端 baseContent：只有 hash 等于请求 baseHash 才可作为候选
      let serverBase: string | null = null
      if (typeof p.baseContent === "string" && entry?.baseHash && d.hash(p.baseContent) === entry.baseHash) serverBase = p.baseContent
      await this.reconcileLocked(path, remote, { serverBase })
    })
  }

  // ------------------------------------------------------------------ 远端推送

  onRemote(remote: RemoteNote): Promise<RemoteOutcome> {
    return this.deps.locked(remote.path, async () => {
      if (this.tracker.has(remote.path)) {
        // 自己有在途上传：等 Ack/530 之后再处理，避免 base 被中途改写
        this.deferred.set(remote.path, remote)
        return "deferred" as RemoteOutcome
      }
      return this.reconcileLocked(remote.path, remote, {})
    })
  }

  /**
   * 统一对账：本地当前内容 vs 远端版本。
   *   相同 → 确认；本地未分叉 → 快进；分叉 → diff3（有可信 base）否则进冲突 UI。
   */
  private async reconcileLocked(path: string, remote: RemoteNote, o: { serverBase?: string | null }): Promise<RemoteOutcome> {
    try {
      return await this.reconcileInner(path, remote, o)
    } catch (e) {
      // 自动合并过程抛异常（读写盘失败等）：降级为人工冲突流程，保留双方内容，绝不直接放弃
      const d = this.deps
      d.log("NoteAutoMerge", `自动合并出错，转人工处理: ${e instanceof Error ? e.message : String(e)}`, "error", path)
      let local = ""
      try { local = (await d.readNote(path)) ?? "" } catch { /* 读不到则空 */ }
      await d.registerConflict(path, { base: null, local, remote: remote.content, serverHash: remote.contentHash, reason: "error" })
      this.attempts.delete(path)
      return "conflict"
    }
  }

  private async reconcileInner(path: string, remote: RemoteNote, o: { serverBase?: string | null }): Promise<RemoteOutcome> {
    const d = this.deps
    const trusted = d.hash(remote.content) === remote.contentHash
    const local = await d.readNote(path)
    const opts = { ...(remote.ctime && remote.ctime > 0 ? { ctime: remote.ctime } : {}), ...(remote.mtime && remote.mtime > 0 ? { mtime: remote.mtime } : {}) }
    if (local === null) {
      await d.createNote(path, remote.content, opts)
      await this.markSyncedLocked(path, remote.content, remote.contentHash, remote.mtime, undefined, trusted)
      this.attempts.delete(path)
      return "applied"
    }
    const localHash = d.hash(local)
    const known = this.knownHash(path)

    if (localHash === remote.contentHash) {
      await this.markSyncedLocked(path, local, remote.contentHash, undefined, undefined, trusted)
      await d.clearConflict(path)
      this.attempts.delete(path)
      return "confirmed"
    }

    let diverged = known === null || localHash !== known
    // Ack 窗口内收到他端不同内容：服务端 CAS 非原子窗口下两端都被接受，本机刚确认的版本已被后写覆盖。
    // 此时 syncHash 已前进到本地内容，不能当「未分叉」快进（双方会互相覆盖成对方的文本且都不报冲突），
    // 必须按「以 Ack 前的版本为 base 的真分叉」处理：能合并就合并并上传，不能合并进冲突流程。
    let ackBase: string | null | undefined
    if (!diverged) {
      const ra = this.recentAck.get(path)
      if (ra && ra.hash === localHash && d.now() - ra.at < RECENT_ACK_WINDOW_MS) {
        let contained = false
        if (ra.prevBase !== null) {
          const r = diff3Merge(local, ra.prevBase, remote.content)
          contained = r.ok && r.merged === remote.content
          // 对端是以「它自己在前」合并出的结果（同点插入顺序与我相反）也算已包含，否则两端各自按己方在前互相重合并，永不收敛
          if (!contained) { const r2 = diff3Merge(remote.content, ra.prevBase, local); contained = r2.ok && r2.merged === remote.content }
          // 首次创建（空 base）时两侧都是「插入」，diff3 会保留双方；远端若只是在我这份之后追加，同样算已包含
          if (!contained && ra.prevBase === "" && remote.content.startsWith(local)) contained = true
        }
        if (!contained) { diverged = true; ackBase = ra.prevBase }
      }
    }
    if (!diverged) {
      if (!(await d.casWrite(path, local, remote.content, opts))) {
        this.scheduleRetry(path, remote)
        return "deferred"
      }
      await this.markSyncedLocked(path, remote.content, remote.contentHash, remote.mtime, undefined, trusted)
      await d.clearConflict(path)
      this.attempts.delete(path)
      return "applied"
    }

    // 分叉：需要可信 base
    if (!trusted) {
      await d.registerConflict(path, { base: null, local, remote: remote.content, serverHash: remote.contentHash, reason: "hash-mismatch" })
      return "conflict"
    }
    let base = ackBase !== undefined ? ackBase : await d.baseStore.get(path, known)
    if (base === null && known !== null && o.serverBase && d.hash(o.serverBase) === known) base = o.serverBase
    if (base === null) {
      d.log("NoteMergeNoBase", "本地无可信 base（升级前已分叉或从未种子），转人工冲突处理", "success", path)
      await d.registerConflict(path, { base: null, local, remote: remote.content, serverHash: remote.contentHash, reason: "no-base" })
      this.attempts.delete(path)
      return "conflict"
    }
    const r = diff3Merge(local, base, remote.content)
    if (!r.ok) {
      await d.registerConflict(path, { base, local, remote: remote.content, serverHash: remote.contentHash, reason: "overlap", conflicts: r.conflicts })
      this.attempts.delete(path)
      return "conflict"
    }
    const merged = r.merged
    if (merged !== local) {
      if (!(await d.casWrite(path, local, merged))) {
        // 用户又在输入：放弃本次，稍后重试，不弹窗
        this.scheduleRetry(path, remote)
        return "deferred"
      }
    }
    for (const n of r.notes) d.log("NoteMergeNote", n, "success", path)
    d.log("NoteAutoMerge", `已自动三方合并: ${path}`, "success", path)
    // 写盘成功：本机已知的服务端版本前进到 remote，base 暂记为 remote；Ack 后 base ← merged
    d.setSyncHash(path, remote.contentHash)
    await this.putOrDrop(path, remote.content, remote.contentHash, true)
    await d.clearConflict(path)
    if (d.hash(merged) === remote.contentHash) {
      this.attempts.delete(path)
      return "merged"
    }
    await this.uploadLocked(path, "merge")
    return "merged"
  }

  /** 写入「已与服务端确认一致」的状态：syncHash + base */
  private async markSyncedLocked(path: string, content: string, hash: string, mtime: number | undefined, size: number | undefined, trusted: boolean): Promise<void> {
    const d = this.deps
    const st = d.statNote(path)
    d.setSyncHash(path, hash, mtime ?? 0, size ?? st?.size ?? 0)
    await this.putOrDrop(path, content, hash, trusted)
  }

  /** base 写失败/超限/不可信时必须删旧 base，避免残留的过期 hash 被当作「已确认版本」 */
  private async putOrDrop(path: string, content: string, hash: string, trusted: boolean): Promise<void> {
    const d = this.deps
    if (!(trusted && d.hash(content) === hash && (await d.baseStore.put(path, content, hash)))) await d.baseStore.delete(path)
  }

  // ------------------------------------------------------------------ 重试 / 超时 / 重连

  private scheduleRetry(path: string, remote: RemoteNote): void {
    this.deferred.set(path, remote)
    if (this.deferredTimers.has(path)) return
    this.deferredTimers.add(path)
    this.deps.schedule(() => {
      this.deferredTimers.delete(path)
      void this.processDeferred(path)
    }, CAS_RETRY_MS)
  }

  async processDeferred(path: string): Promise<void> {
    await this.deps.locked(path, async () => {
      if (this.tracker.has(path)) return // Ack/530 后会 drain
      const dr = this.deferred.get(path)
      if (!dr) return
      this.deferred.delete(path)
      await this.reconcileLocked(path, dr, {})
    })
  }

  /** 定期调用：释放超时无回应的在途上传（之后的迟到 Ack 视为无登记，不更新 base） */
  sweep(): void {
    const d = this.deps
    for (const e of this.tracker.expire(d.now(), UPLOAD_TIMEOUT_MS)) {
      d.releaseSlot(e.path)
      d.clearPending(e.path)
      d.log("NoteModify", `上传超时无回应，已释放（下次编辑或同步会重试）: ${e.path}`, "error", e.path)
      if (this.deferred.has(e.path)) void this.processDeferred(e.path)
    }
  }

  /** 断线：在途请求全部作废（服务端是否收到未知，重连后的同步轮次会重新对账） */
  onDisconnect(): void {
    for (const e of this.tracker.clearInFlight()) this.deps.clearPending(e.path)
  }

  /** 路径被删除/重命名：丢弃该路径的运行态 */
  forget(path: string): void {
    this.tracker.forget(path)
    this.attempts.delete(path)
    this.deferred.delete(path)
    this.recentAck.delete(path)
    this.lastRePush.delete(path)
  }

  /** 冷启动种子：仅当本地内容 hash 恰等于已确认的 syncHash 才可作为 base */
  async seedIfMatches(path: string, content: string): Promise<boolean> {
    const known = this.deps.getSyncHash(path)
    if (known === null || this.deps.hash(content) !== known) return false
    if (this.deps.baseStore.peekHash(path) !== null && this.deps.baseStore.peekHash(path) !== known) return false
    return this.deps.baseStore.put(path, content, known)
  }
}
