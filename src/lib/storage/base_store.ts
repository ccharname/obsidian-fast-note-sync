/**
 * 三方合并用的 base 存储：每篇 .md 保存「最后一次与服务端确认一致的完整正文」。
 * 文件存在插件目录 `<dir>/<pathHash>.base`（JSON：path/hash/content）+ `base-index.json`（path → 元数据）。
 *
 * 可信约束（读取时全部校验，任一不满足即视为不存在）：
 *  - 条目 hash 必须等于调用方期望的 hash（通常是 syncHashMap[path]）
 *  - hashContent(content) === 条目 hash，且长度/行数与登记值一致
 *
 * 本模块不依赖 obsidian，adapter / hash / clock 均注入，便于 node 单测。
 */

export interface BaseAdapter {
  exists(path: string): Promise<boolean>
  read(path: string): Promise<string>
  write(path: string, data: string): Promise<void>
  remove(path: string): Promise<void>
  mkdir(path: string): Promise<void>
}

export interface BaseStoreLimits {
  /** 单篇上限（字符数，UTF-16 单元），超过不存 */
  maxNoteChars: number
  /** 总量上限（字符数） */
  maxTotalChars: number
  /** 篇数上限 */
  maxNotes: number
}

export const DEFAULT_BASE_LIMITS: BaseStoreLimits = {
  maxNoteChars: 512 * 1024,
  maxTotalChars: 200 * 1024 * 1024,
  maxNotes: 20000,
}

interface IndexEntry {
  file: string
  hash: string
  size: number
  lines: number
  lastUsed: number
}

interface BaseFile {
  path: string
  hash: string
  content: string
}

export interface BaseStoreOptions {
  adapter: BaseAdapter
  dir: string
  hash: (s: string) => string
  now?: () => number
  limits?: Partial<BaseStoreLimits>
  /** 被引用（冲突中 / 上传在途）的路径不淘汰 */
  isProtected?: (path: string) => boolean
  log?: (msg: string, ...args: unknown[]) => void
}

const countLines = (s: string) => (s === "" ? 0 : s.split("\n").length)

export class BaseStore {
  private adapter: BaseAdapter
  private dir: string
  private hash: (s: string) => string
  private now: () => number
  private limits: BaseStoreLimits
  private isProtected: (path: string) => boolean
  private log: (msg: string, ...args: unknown[]) => void
  private index = new Map<string, IndexEntry>()
  private totalChars = 0
  private loaded = false
  private chain: Promise<unknown> = Promise.resolve()
  private indexDirty = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(opts: BaseStoreOptions) {
    this.adapter = opts.adapter
    this.dir = opts.dir
    this.hash = opts.hash
    this.now = opts.now ?? (() => Date.now())
    this.limits = { ...DEFAULT_BASE_LIMITS, ...(opts.limits ?? {}) }
    this.isProtected = opts.isProtected ?? (() => false)
    this.log = opts.log ?? (() => {})
  }

  private get indexPath() {
    return `${this.dir}/base-index.json`
  }

  /** 串行化所有读写，避免 index 与文件互相踩 */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn)
    this.chain = p.catch(() => undefined)
    return p
  }

  async load(): Promise<void> {
    await this.serial(async () => {
      this.index.clear()
      this.totalChars = 0
      try {
        if (await this.adapter.exists(this.indexPath)) {
          const raw = JSON.parse(await this.adapter.read(this.indexPath)) as Record<string, IndexEntry>
          for (const [p, e] of Object.entries(raw)) {
            if (e && typeof e.file === "string" && typeof e.hash === "string" && typeof e.size === "number") {
              this.index.set(p, { file: e.file, hash: e.hash, size: e.size, lines: e.lines ?? 0, lastUsed: e.lastUsed ?? 0 })
              this.totalChars += e.size
            }
          }
        }
      } catch (e) {
        this.log("[BaseStore] index 损坏，按空库处理", e)
        this.index.clear()
        this.totalChars = 0
      }
      this.loaded = true
    })
  }

  get size(): number {
    return this.index.size
  }

  has(path: string): boolean {
    return this.index.has(path)
  }

  /** 登记的 hash（不读文件，不校验内容） */
  peekHash(path: string): string | null {
    return this.index.get(path)?.hash ?? null
  }

  /** 取 base 正文；expectedHash 不匹配 / 内容校验失败返回 null */
  async get(path: string, expectedHash: string | null): Promise<string | null> {
    return this.serial(async () => {
      const e = this.index.get(path)
      if (!e) return null
      if (expectedHash === null || e.hash !== expectedHash) return null
      try {
        const f = JSON.parse(await this.adapter.read(`${this.dir}/${e.file}`)) as BaseFile
        if (f.path !== path || f.hash !== e.hash || typeof f.content !== "string" ||
          f.content.length !== e.size || countLines(f.content) !== e.lines || this.hash(f.content) !== e.hash) {
          this.log(`[BaseStore] base 校验失败，丢弃: ${path}`)
          await this.dropLocked(path)
          return null
        }
        e.lastUsed = this.now()
        this.indexDirty = true
        return f.content
      } catch (err) {
        this.log(`[BaseStore] base 读取失败，丢弃: ${path}`, err)
        await this.dropLocked(path)
        return null
      }
    })
  }

  /** 写入 base。hash 必须等于 hashContent(content)，超限返回 false（同时移除旧 base，避免残留过期值） */
  async put(path: string, content: string, hash: string): Promise<boolean> {
    return this.serial(async () => {
      if (this.hash(content) !== hash) {
        this.log(`[BaseStore] put 拒绝：hash 与内容不符 ${path}`)
        return false
      }
      if (content.length > this.limits.maxNoteChars) {
        await this.dropLocked(path)
        this.scheduleFlush()
        return false
      }
      const old = this.index.get(path)
      if (old && old.hash === hash && old.size === content.length) {
        old.lastUsed = this.now()
        this.indexDirty = true
        return true
      }
      const file = old?.file ?? this.pickFileName(path)
      try {
        if (!(await this.adapter.exists(this.dir))) await this.adapter.mkdir(this.dir)
        const body: BaseFile = { path, hash, content }
        await this.adapter.write(`${this.dir}/${file}`, JSON.stringify(body))
      } catch (err) {
        this.log(`[BaseStore] 写文件失败: ${path}`, err)
        return false
      }
      if (old) this.totalChars -= old.size
      this.index.set(path, { file, hash, size: content.length, lines: countLines(content), lastUsed: this.now() })
      this.totalChars += content.length
      await this.evictLocked(path)
      this.scheduleFlush()
      return true
    })
  }

  async delete(path: string): Promise<void> {
    await this.serial(async () => {
      if (await this.dropLocked(path)) this.scheduleFlush()
    })
  }

  /** 重命名：内容与 hash 不变，只改 key */
  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.serial(async () => {
      const e = this.index.get(oldPath)
      if (!e) return
      try {
        const f = JSON.parse(await this.adapter.read(`${this.dir}/${e.file}`)) as BaseFile
        await this.dropLocked(newPath)
        const file = this.pickFileName(newPath)
        await this.adapter.write(`${this.dir}/${file}`, JSON.stringify({ path: newPath, hash: f.hash, content: f.content } as BaseFile))
        this.index.set(newPath, { ...e, file, lastUsed: this.now() })
        this.totalChars += e.size
        await this.dropLocked(oldPath)
        this.scheduleFlush()
      } catch (err) {
        this.log(`[BaseStore] rename 失败，丢弃旧 base: ${oldPath}`, err)
        await this.dropLocked(oldPath)
        this.scheduleFlush()
      }
    })
  }

  /** 清空（clearSyncTime 时调用） */
  async clear(): Promise<void> {
    await this.serial(async () => {
      for (const p of [...this.index.keys()]) await this.dropLocked(p)
      await this.flushIndexLocked()
    })
  }

  async flush(): Promise<void> {
    await this.serial(() => this.flushIndexLocked())
  }

  /** 全部 path（供淘汰/统计） */
  paths(): string[] {
    return [...this.index.keys()]
  }

  // --- 内部（必须在 serial 内调用） ---

  /** index 防抖落盘（base 文件本身自描述，index 丢失只影响命中率，不影响正确性） */
  private scheduleFlush(): void {
    this.indexDirty = true
    if (this.flushTimer !== null) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, 2000)
    ;(this.flushTimer as unknown as { unref?: () => void }).unref?.()
  }

  private pickFileName(path: string): string {
    const stem = this.hash(path)
    let name = `${stem}.base`
    let n = 0
    const used = new Set<string>()
    for (const [p, e] of this.index) if (p !== path) used.add(e.file)
    while (used.has(name)) name = `${stem}-${++n}.base`
    return name
  }

  private async dropLocked(path: string): Promise<boolean> {
    const e = this.index.get(path)
    if (!e) return false
    this.index.delete(path)
    this.totalChars -= e.size
    this.indexDirty = true
    try {
      if (await this.adapter.exists(`${this.dir}/${e.file}`)) await this.adapter.remove(`${this.dir}/${e.file}`)
    } catch (err) {
      this.log(`[BaseStore] 删除文件失败: ${e.file}`, err)
    }
    return true
  }

  private async evictLocked(justWritten: string): Promise<void> {
    if (this.index.size <= this.limits.maxNotes && this.totalChars <= this.limits.maxTotalChars) return
    const order = [...this.index.entries()]
      .filter(([p]) => p !== justWritten && !this.isProtected(p))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    for (const [p] of order) {
      if (this.index.size <= this.limits.maxNotes && this.totalChars <= this.limits.maxTotalChars) break
      await this.dropLocked(p)
    }
  }

  private async flushIndexLocked(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    try {
      if (!(await this.adapter.exists(this.dir))) await this.adapter.mkdir(this.dir)
      await this.adapter.write(this.indexPath, JSON.stringify(Object.fromEntries(this.index)))
      this.indexDirty = false
    } catch (err) {
      this.log("[BaseStore] 写 index 失败", err)
    }
  }
}
