/** Protocol 1: the server owns merge decisions; this client retains draft ancestry and request identity. */
import type { CoreDeps as LegacyDeps, ConflictInfo, RemoteOutcome, UploadOutcome } from "./note_merge_core"
import type { UploadKind } from "./upload_tracker"

export interface RemoteNote {
  path: string; content: string; contentHash: string; revision?: string; mergeProtocol?: number
  mtime?: number; ctime?: number; conflictPath?: string; deleted?: boolean
}
export interface MergeAck extends RemoteNote { requestId?: string }
export interface PendingUpload {
  requestId: string; content: string; contentHash: string; baseContent: string | null
  kind: UploadKind; context?: string; sentAt: number; baseRevision: string; recreate: boolean
}
export interface MutationIntent { kind: "delete" | "rename"; requestId: string; baseRevision: string; renameTo?: string; sentAt: number; previousUpload?: PendingUpload }
export interface PathState { baseContent: string | null; revision: string; pending?: PendingUpload; mutation?: MutationIntent; blockedDeletedContent?: string; deleted?: boolean }
export interface CoreDeps extends Omit<LegacyDeps, "sendUpload"> {
  sendUpload(path: string, entry: PendingUpload & { baseHash: string | null; isCurrent: () => boolean }): Promise<boolean>
  loadJournal(): Promise<Record<string, PathState>>
  saveJournal(path: string, state: PathState | null): Promise<void>
  requestId(): string
  sendMutation(path: string, intent: MutationIntent & { isCurrent: () => boolean }): Promise<boolean>
}
export type { ConflictInfo }
export class ServerMergeCore {
  private states: Record<string, PathState> = Object.create(null)
  private deferred = new Map<string, RemoteNote>()
  private ready = false
  private saving: Promise<void> = Promise.resolve()
  readonly tracker = { has: (p: string) => !!(this.states[p]?.pending || this.states[p]?.mutation) }
  constructor(private deps: CoreDeps) {}
  async initialize(): Promise<void> { this.states = Object.assign(Object.create(null), await this.deps.loadJournal()) }
  setProtocolReady(ready: boolean): void { this.ready = ready }
  get protocolReady(): boolean { return this.ready }
  private state(p: string): PathState { return this.states[p] ??= { baseContent: null, revision: "0" } }
  private async persist(path: string): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(this.state(path))) as PathState
    // Persist before send. A failed write must prevent the upload; later writes may recover.
    const next = this.saving.catch(() => {}).then(() => this.deps.saveJournal(path, snapshot))
    this.saving = next
    await next
  }
  private validRemote(r: RemoteNote): boolean { return r.mergeProtocol === 1 && typeof r.content === "string" && typeof r.revision === "string" && /^\d+$/.test(r.revision) }
  private newer(a: string, b: string): boolean { return BigInt(a) > BigInt(b) }
  async requestUpload(path: string, o: { kind?: "edit" | "needpush" | "recreate"; context?: string } = {}): Promise<UploadOutcome> {
    return this.deps.locked(path, () => this.upload(path, o.kind ?? "edit", o.context))
  }
  private async upload(path: string, kind: UploadKind, context?: string): Promise<UploadOutcome> {
    if (!this.ready) return "blocked"
    const d = this.deps, s = this.state(path)
    if (d.isConflicted(path) && kind !== "resolved") return "blocked"
    const content = await d.readNote(path)
    if (content === null) return "missing"
    // A deliberate local recreation supersedes the older delete/rename intent.
    if (s.mutation) delete s.mutation
    if (content === s.blockedDeletedContent && kind !== "resolved") return "blocked"
    if (s.pending) return "queued"
    if (content === s.baseContent && kind === "edit") return "nochange"
    const p: PendingUpload = { requestId: d.requestId(), content, contentHash: d.hash(content), baseContent: s.baseContent, kind, context, sentAt: d.now(), baseRevision: s.revision, recreate: s.baseContent === null && s.deleted === true }
    s.pending = p
    await this.persist(path)
    d.setPending(path, p.contentHash)
    return await this.send(path, p) ? "sent" : "queued"
  }
  private async send(path: string, p: PendingUpload): Promise<boolean> {
    if (!this.ready) return false
    await this.persist(path)
    p.sentAt = this.deps.now()
    return await this.deps.sendUpload(path, { ...p, baseHash: p.baseContent === null ? null : this.deps.hash(p.baseContent), isCurrent: () => this.states[path]?.pending?.requestId === p.requestId })
  }
  async uploadResolved(path: string, _baseHash: string | null): Promise<boolean> {
    return this.deps.locked(path, async () => (await this.upload(path, "resolved")) === "sent")
  }
  async onAck(path: string, ack?: MergeAck): Promise<boolean> {
    return this.deps.locked(path, async () => {
      const before = JSON.parse(JSON.stringify(this.state(path))) as PathState
      try { return await this.ackLocked(path, ack) }
      catch (e) { this.states[path] = before; throw e }
    })
  }
  private async ackLocked(path: string, ack?: MergeAck): Promise<boolean> {
      const d = this.deps, s = this.state(path), p = s.pending
      if (!ack || !this.validRemote(ack) || !p || ack.requestId !== p.requestId) return false
      const local = await d.readNote(path)
      if (this.newer(s.revision, ack.revision!)) {
        delete s.pending
        d.releaseSlot(path); d.clearPending(path)
        await this.persist(path)
        d.sendRePush(path)
        return true
      }
      if (ack.deleted) {
        if (local !== null && local !== p.content) await d.saveLost(path, local, "deleted-post-submit")
        if (local !== null) await d.saveLost(path, local, "deleted-result")
        delete s.pending; s.revision = ack.revision!; s.baseContent = null; s.deleted = true; s.blockedDeletedContent = local ?? undefined
        await this.persist(path)
        d.releaseSlot(path); d.clearPending(path)
        // Retain the local draft; the server conflict copy is the durable sync result.
        return true
      }
      // A retry/older reply must never advance or rewind an unrelated draft.
      delete s.pending
      delete s.deleted
      d.releaseSlot(path)
      d.clearPending(path)
      if (this.newer(ack.revision!, s.revision)) s.revision = ack.revision!
      if (ack.conflictPath) {
        // The server durably saved this submitted branch as a synced conflict copy.
        // Preserve any newer local edit before accepting the canonical result.
        if (local !== null && local !== p.content) {
          await d.saveLost(path, local, "post-conflict-edit")
          s.baseContent = p.content
          await this.persist(path)
          await this.upload(path, "edit")
          return true
        }
        if (local !== null && !(await d.casWrite(path, local, ack.content))) {
          s.baseContent = p.content
          await this.persist(path)
          await this.upload(path, "edit")
          return true
        }
        s.baseContent = ack.content
        d.setSyncHash(path, ack.contentHash)
        await d.baseStore.put(path, ack.content, ack.contentHash)
        await d.clearConflict(path)
        d.log("NoteServerConflict", `服务端已保存冲突副本: ${ack.conflictPath}`, "success", path)
      } else if (local === p.content) {
        // Only replace the exact submitted snapshot. User typing can race disk IO.
        if (await d.casWrite(path, p.content, ack.content)) {
          s.baseContent = ack.content
          d.setSyncHash(path, ack.contentHash)
          await d.baseStore.put(path, ack.content, ack.contentHash)
          await d.clearConflict(path)
        } else s.baseContent = p.content
      } else if (local !== null) {
        // The next upload is the delta L1 -> L2, merged by the server into M.
        // Advancing its ancestor to M would silently erase remote changes.
        s.baseContent = p.content
      } else s.baseContent = ack.content
      await this.persist(path)
      const dr = this.deferred.get(path)
      this.deferred.delete(path)
      if (dr && this.newer(dr.revision!, s.revision)) await this.remote(path, dr)
      if (!s.pending && await d.readNote(path) !== s.baseContent) await this.upload(path, "edit")
      return true
  }
  async onRemote(r: RemoteNote): Promise<RemoteOutcome> {
    return this.deps.locked(r.path, async () => {
      const before = JSON.parse(JSON.stringify(this.state(r.path))) as PathState
      try { return await this.remote(r.path, r) }
      catch (e) { this.states[r.path] = before; throw e }
    })
  }
  private async remote(path: string, r: RemoteNote): Promise<RemoteOutcome> {
    const d = this.deps, s = this.state(path)
    if (!this.validRemote(r)) {
      d.log("NoteProtocol", "缺少服务端合并协议版本，已保留本地内容并停止应用", "error", path)
      return "deferred"
    }
    if (s.mutation) return "deferred"
    if (!this.newer(r.revision!, s.revision)) return "confirmed"
    if (s.pending) {
      const prev = this.deferred.get(path)
      if (!prev || this.newer(r.revision!, prev.revision!)) this.deferred.set(path, r)
      return "deferred"
    }
    const local = await d.readNote(path)
    if (local === r.content || local === s.baseContent || local === null) {
      if (local === null) await d.createNote(path, r.content, r)
      else if (local !== r.content && !(await d.casWrite(path, local, r.content, r))) {
        await this.upload(path, "edit")
        return "deferred"
      }
      s.baseContent = r.content; s.revision = r.revision!; delete s.blockedDeletedContent; delete s.deleted
      await this.persist(path)
      d.setSyncHash(path, r.contentHash)
      await d.baseStore.put(path, r.content, r.contentHash)
      await d.clearConflict(path)
      return "applied"
    }
    // Keep the draft's original ancestor. The service owns the three-way merge.
    await this.upload(path, "edit")
    return "deferred"
  }
  async onConflict(p: { path: string; serverContent?: string; serverHash?: string; baseContent?: string }): Promise<void> {
    // Protocol 1 returns a successful canonical result and durable conflictPath.
    // A legacy 530 must not settle a request by path or mutate its ancestor.
    this.deps.log("NoteProtocol", "服务端返回旧冲突协议，保留未确认正文并停止上传", "error", p.path)
    this.ready = false
  }
  sweep(): void {
    if (!this.ready) return
    for (const [path, s] of Object.entries(this.states)) if (s.mutation && this.deps.now() - s.mutation.sentAt >= 30000) {
      void this.deps.locked(path, () => this.sendMutation(path)).catch(e => this.deps.log("NoteMutationRetry", String(e), "error", path))
    }
    for (const [path, s] of Object.entries(this.states)) if (s.pending && this.deps.now() - s.pending.sentAt >= 30000) {
      void this.deps.locked(path, async () => { if (s.pending) await this.send(path, s.pending) }).catch(e => this.deps.log("NoteRetry", String(e), "error", path))
    }
  }
  onDisconnect(): void { this.ready = false }
  async resume(): Promise<void> {
    if (!this.ready) return
    for (const [path, s] of Object.entries(this.states)) {
      await this.deps.locked(path, async () => {
        if (s.mutation) await this.sendMutation(path)
        else if (s.pending) await this.send(path, s.pending)
        else if (await this.deps.readNote(path) !== s.baseContent) await this.upload(path, "edit")
      })
    }
  }
  async canApplyMutation(path: string, revision: string | undefined): Promise<boolean> {
    if (!revision || !/^\d+$/.test(revision)) return false
    const s = this.state(path)
    if (!this.newer(revision, s.revision)) return false
    const local = await this.deps.readNote(path)
    if (s.pending || s.mutation || this.deps.isConflicted(path) || (local !== null && local !== s.baseContent)) {
      if (local !== null) await this.deps.saveLost(path, local, "remote-mutation")
      this.deps.log("NoteMutation", "远端删除或重命名遇到本地未确认编辑，已保留正文", "error", path)
      return false
    }
    return true
  }
  async mutationApplied(path: string, revision: string): Promise<void> {
    this.state(path).revision = revision
    await this.persist(path)
  }
  async preserveLocal(path: string, reason: string): Promise<void> {
    const local = await this.deps.readNote(path)
    if (local !== null) await this.deps.saveLost(path, local, reason)
  }
  needsBaseline(path: string): boolean { return !this.states[path] }
  async beginMutation(path: string, renameTo?: string): Promise<void> {
    await this.deps.locked(path, () => this.forget(path, renameTo, true))
  }
  async forget(path: string, renameTo?: string, localMutation = false): Promise<void> {
    // Keep old-path tombstones so a late push cannot resurrect an obsolete path.
    const s = this.state(path)
    // Rename identifies the path mutation, not the body at the target path.
    // A remote edit may have happened before rename while this device was offline.
    if (s && renameTo) this.states[renameTo] = { baseContent: s.baseContent, revision: "0" }
    const mutation: MutationIntent | undefined = localMutation ? { kind: renameTo ? "rename" : "delete", requestId: this.deps.requestId(), baseRevision: s.revision, renameTo, sentAt: 0, previousUpload: s.pending } : undefined
    this.states[path] = { baseContent: null, revision: s.revision, ...(mutation ? { mutation } : { deleted: true }) }
    this.deferred.delete(path)
    await this.persist(path)
    if (renameTo) await this.persist(renameTo)
    this.deps.releaseSlot(path); this.deps.clearPending(path)
    if (localMutation) await this.sendMutation(path)
  }
  private async sendMutation(path: string): Promise<void> {
    const mutation = this.states[path]?.mutation
    if (!this.ready || !mutation) return
    await this.persist(path)
    mutation.sentAt = this.deps.now()
    await this.deps.sendMutation(path, { ...mutation, isCurrent: () => this.states[path]?.mutation?.requestId === mutation.requestId })
  }
  async onMutationAck(path: string, requestId: string | undefined, revision: string | undefined, mergeProtocol: number | undefined, superseded = false, oldRevision?: string): Promise<MutationIntent | null> {
    return this.deps.locked(path, async () => {
      const s = this.state(path), mutation = s.mutation
      if (mergeProtocol !== 1 || !mutation || mutation.requestId !== requestId || !revision || !/^\d+$/.test(revision)) return null
      const before = JSON.parse(JSON.stringify(s)) as PathState
      const tombstoneRevision = oldRevision && /^\d+$/.test(oldRevision) ? oldRevision : revision
      if (!superseded && this.newer(tombstoneRevision, s.revision)) s.revision = tombstoneRevision
      if (!superseded) s.deleted = true
      delete s.mutation
      try { await this.persist(path) } catch (e) { this.states[path] = before; throw e }
      this.deps.releaseSlot(mutation.renameTo ?? path)
      if (mutation.renameTo) this.deps.sendRePush(mutation.renameTo)
      if (superseded) this.deps.sendRePush(path)
      return mutation
    })
  }
  async seedIfMatches(_path: string, _content: string): Promise<boolean> { return false }
}
