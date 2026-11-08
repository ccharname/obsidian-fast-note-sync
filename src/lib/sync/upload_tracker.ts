/**
 * 每路径单飞上传 + 请求登记。
 * 服务端 NoteModifyAck 不带请求标识，只有保证「同一路径同时只有一个在途 NoteModify」，
 * Ack 才能无歧义地对应到刚发出的那份内容（Ack 后 base = 该内容）。
 * 纯逻辑，无外部依赖。
 */

export type UploadKind = "edit" | "needpush" | "merge" | "resolved" | "recreate"

export interface UploadEntry {
  seq: number
  path: string
  content: string
  contentHash: string
  baseHash: string | null
  kind: UploadKind
  sentAt: number
  /** NeedPush 驱动的上传携带的同步 context */
  context?: string
}

export class UploadTracker {
  private entries = new Map<string, UploadEntry>()
  private dirty = new Set<string>()
  /** 超时释放的请求：单飞下该路径不会有第二个在途请求，其迟到的 Ack 仍可对应到它 */
  private expired = new Map<string, UploadEntry>()
  private seq = 0

  has(path: string): boolean {
    return this.entries.has(path)
  }

  get(path: string): UploadEntry | undefined {
    return this.entries.get(path)
  }

  size(): number {
    return this.entries.size
  }

  paths(): string[] {
    return [...this.entries.keys()]
  }

  /** 登记在途请求；该路径已有在途则返回 null（调用方应 markDirty） */
  begin(path: string, e: Omit<UploadEntry, "seq" | "path" | "sentAt">, now: number): UploadEntry | null {
    if (this.entries.has(path)) return null
    this.expired.delete(path)
    const entry: UploadEntry = { ...e, seq: ++this.seq, path, sentAt: now }
    this.entries.set(path, entry)
    return entry
  }

  /** 真实 Ack / 530 到达：取出并清除登记；无登记返回 undefined（迟到/重复） */
  complete(path: string): UploadEntry | undefined {
    const e = this.entries.get(path)
    if (e) this.entries.delete(path)
    return e
  }

  /** 迟到 Ack：取回该路径超时释放的请求（一次性） */
  takeExpired(path: string): UploadEntry | undefined {
    const e = this.expired.get(path)
    if (e) this.expired.delete(path)
    return e
  }

  /** 在途期间又有新编辑：只记脏位，等 Ack/530 后读盘重发 */
  markDirty(path: string): void {
    this.dirty.add(path)
  }

  takeDirty(path: string): boolean {
    return this.dirty.delete(path)
  }

  isDirty(path: string): boolean {
    return this.dirty.has(path)
  }

  /** 超时：释放登记（之后到达的 Ack 视为迟到，不更新 base） */
  expire(now: number, timeoutMs: number): UploadEntry[] {
    const out: UploadEntry[] = []
    for (const [p, e] of this.entries) {
      if (now - e.sentAt >= timeoutMs) {
        out.push(e)
        this.entries.delete(p)
        this.expired.set(p, e)
      }
    }
    return out
  }

  /** 断线重连：在途全部作废，保留脏位 */
  clearInFlight(): UploadEntry[] {
    const all = [...this.entries.values()]
    this.entries.clear()
    return all
  }

  /** 删除/重命名路径时清理 */
  forget(path: string): void {
    this.entries.delete(path)
    this.dirty.delete(path)
    this.expired.delete(path)
  }
}
