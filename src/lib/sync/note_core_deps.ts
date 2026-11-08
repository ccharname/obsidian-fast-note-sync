/**
 * NoteMergeCore 的 Obsidian / 插件适配层，以及冲突状态（conflictedPaths + conflict-notes 文件）的统一读写。
 */
import { TFile, normalizePath, Platform } from "obsidian"
import type FastSync from "../../main"
import { hashContent, getPluginDir, getSafeCtime, dump, dumpError } from "../utils/helpers"
import { SyncLogManager } from "./sync_log_manager"
import { BaseStore } from "../storage/base_store"
import { IgnoreRefs, conflictStem } from "./conflict_paths"
import { NoteMergeCore, type CoreDeps, type ConflictInfo } from "./note_merge_core"
import { $ } from "../../i18n/lang"

export const isAutoMerge = (plugin: FastSync): boolean => plugin.settings.conflictMode === "clientAutoMerge" && !!plugin.noteCore

// ---------------------------------------------------------------- conflict-notes 文件

export function conflictFilePaths(plugin: FastSync, path: string) {
  const dir = `${getPluginDir(plugin)}/conflict-notes`
  const stem = conflictStem(normalizePath(path), hashContent)
  return { dir, base: `${dir}/${stem}.base.md`, remote: `${dir}/${stem}.remote.md`, meta: `${dir}/${stem}.meta.json` }
}

/** 读取落盘的冲突元数据（serverHash 不再依赖内存日志） */
export async function readConflictMeta(plugin: FastSync, path: string): Promise<{ serverHash?: string; reason?: string } | null> {
  try {
    const f = conflictFilePaths(plugin, path)
    const a = plugin.app.vault.adapter
    if (!(await a.exists(f.meta))) return null
    return JSON.parse(await a.read(f.meta)) as { serverHash?: string; reason?: string }
  } catch {
    return null
  }
}

/** 清理某路径的冲突状态：conflictedPaths、持久化、角标、conflict-notes 备份 */
export async function clearConflictState(plugin: FastSync, path: string): Promise<void> {
  const p = normalizePath(path)
  if (plugin.syncState.conflictedPaths.delete(p)) {
    plugin.localStorageManager.setConflictedPaths(plugin.syncState.conflictedPaths)
    plugin.statusBarManager?.updateConflictBadge()
  }
  plugin.syncState.newConflictedPathsThisRound.delete(p)
  try {
    const f = conflictFilePaths(plugin, p)
    const a = plugin.app.vault.adapter
    for (const file of [f.base, f.remote, f.meta]) if (await a.exists(file)) await a.remove(file)
  } catch (e) {
    dump("[FastSync] clearConflictState: remove backups failed", e)
  }
}

/** 笔记被删除/重命名：丢弃运行态、迁移或删除 base、清冲突状态 */
export async function forgetNote(plugin: FastSync, path: string, renameTo?: string): Promise<void> {
  const np = normalizePath(path)
  plugin.noteCore?.forget(np)
  try {
    if (renameTo) await plugin.baseStore?.rename(np, normalizePath(renameTo))
    else await plugin.baseStore?.delete(np)
  } catch (e) {
    dump("[FastSync] forgetNote: base update failed", e)
  }
  if (plugin.syncState?.conflictedPaths?.has(np)) await clearConflictState(plugin, np)
}

// ---------------------------------------------------------------- 适配

const CAS_ABORT = new Error("cas-abort")
const LOST_DIR = "lost-notes"
const LOST_KEEP = 50

export function createNoteCore(plugin: FastSync): NoteMergeCore {
  const vault = plugin.app.vault
  const pluginDir = () => getPluginDir(plugin)

  const ignoreRefs = new IgnoreRefs()
  const unignoreLater = (path: string, written: string | null) => {
    window.setTimeout(() => {
      if (ignoreRefs.release(path)) plugin.removeIgnoredFile(path)
      if (written === null) return
      // 忽略窗口内用户的编辑事件被丢弃了：若磁盘内容已不是刚写入的内容，补发一次上传
      const f = vault.getFileByPath(path)
      if (!f) return
      void vault.read(f).then((cur) => {
        if (cur !== written) {
          void import("./operator_note").then((m) => m.noteModify(f, plugin, false))
        }
      })
    }, 500)
  }

  const deps: CoreDeps = {
    hash: hashContent,
    now: () => Date.now(),
    baseStore: plugin.baseStore,
    async locked(path, fn) {
      for (let i = 0; i < 8; i++) {
        let ran = false
        const r = await plugin.lockManager.withLock(path, async () => {
          ran = true
          return fn()
        }, { maxRetries: 40, retryInterval: 50 })
        if (ran) return r as Awaited<ReturnType<typeof fn>>
      }
      throw new Error(`lock timeout: ${path}`)
    },
    async readNote(path) {
      const f = vault.getFileByPath(normalizePath(path))
      return f ? await vault.read(f) : null
    },
    async casWrite(path, expected, next, opts) {
      const f = vault.getFileByPath(normalizePath(path))
      if (!f) return false
      plugin.addIgnoredFile(f.path)
      ignoreRefs.acquire(f.path)
      let ok = false
      try {
        await vault.process(f, (cur) => {
          if (cur !== expected) throw CAS_ABORT
          return next
        }, opts)
        ok = true
      } catch (e) {
        if (e !== CAS_ABORT) throw e
      } finally {
        unignoreLater(f.path, ok ? next : null)
      }
      return ok
    },
    async createNote(path, content, opts) {
      const np = normalizePath(path)
      const folder = np.split("/").slice(0, -1).join("/")
      if (folder !== "" && !vault.getFolderByPath(folder)) {
        try {
          await vault.createFolder(folder)
        } catch (e) {
          if (!vault.getFolderByPath(folder)) throw e
        }
      }
      plugin.addIgnoredFile(np)
      ignoreRefs.acquire(np)
      try {
        await vault.create(np, content, opts)
      } finally {
        unignoreLater(np, null)
      }
    },
    statNote(path) {
      const f = vault.getFileByPath(normalizePath(path))
      return f ? { mtime: f.stat.mtime, ctime: f.stat.ctime, size: f.stat.size } : null
    },
    getSyncHash: (path) => plugin.fileHashManager.getPathHash(path),
    setSyncHash: (path, hash, mtime, size) => plugin.fileHashManager.setFileHash(path, hash, mtime ?? 0, size ?? 0),
    removeSyncHash: (path) => plugin.fileHashManager.removeFileHash(path),
    isConflicted: (path) => plugin.syncState.conflictedPaths.has(normalizePath(path)),
    async registerConflict(path, info: ConflictInfo) {
      const np = normalizePath(path)
      const already = plugin.syncState.conflictedPaths.has(np)
      try {
        const f = conflictFilePaths(plugin, np)
        const a = vault.adapter
        if (!(await a.exists(f.dir))) await a.mkdir(f.dir)
        await a.write(f.base, info.base ?? info.local)
        await a.write(f.remote, info.remote)
        await a.write(f.meta, JSON.stringify({ serverHash: info.serverHash, reason: info.reason, hasTrueBase: info.base !== null, ts: Date.now() }))
      } catch (e) {
        dumpError(`[FastSync] write conflict-notes failed: ${np}`, e)
      }
      plugin.syncState.conflictedPaths.add(np)
      if (!already) plugin.syncState.newConflictedPathsThisRound.add(np)
      plugin.localStorageManager.setConflictedPaths(plugin.syncState.conflictedPaths)
      plugin.statusBarManager?.updateConflictBadge()
      const reasonText: Record<string, string> = {
        overlap: "两端修改了同一处内容，需要手动处理",
        "no-base": "本地没有可信的共同起点版本（升级前已分叉或从未同步确认），无法自动合并",
        retries: "自动合并重试次数用尽，转人工处理",
        "hash-mismatch": "服务端内容与其 hash 不一致，转人工处理",
      }
      SyncLogManager.getInstance().addLog("error", "NoteManualMergeConflict", JSON.stringify({
        serverContent: info.remote,
        baseContent: info.base ?? "",
        serverHash: info.serverHash,
        message: `${$("ui.log.error_code.530") || "检测到同步冲突，需要手动处理"}（${reasonText[info.reason] ?? info.reason}）`,
      }), "error", np, plugin.settings.vault)
    },
    clearConflict: async (path) => {
      if (plugin.syncState.conflictedPaths.has(normalizePath(path))) await clearConflictState(plugin, path)
    },
    async sendUpload(path, e) {
      const f = vault.getFileByPath(normalizePath(path))
      if (!f) return false
      const data = {
        vault: plugin.settings.vault,
        ctime: getSafeCtime(f.stat),
        mtime: f.stat.mtime,
        path: f.path,
        pathHash: hashContent(f.path),
        content: e.content,
        contentHash: e.contentHash,
        ...(e.baseHash !== null ? { baseHash: e.baseHash } : { baseHashMissing: true }),
        ...(e.kind === "resolved" ? { isConflictResolved: true } : {}),
      }
      if (!(await plugin.concurrencyLimiter.waitForSlot(f.path))) return false
      // 等槽位期间笔记可能已被删除/重命名（登记已作废）：此时发出 NoteModify 会让服务端复活幽灵文件
      if (!e.isCurrent() || !vault.getFileByPath(normalizePath(path))) {
        plugin.concurrencyLimiter.releaseSlot(f.path)
        return false
      }
      plugin.pendingNoteDeleteAcks.delete(f.path)
      void plugin.websocket.SendMessage("NoteModify", data, undefined, undefined, e.context)
      dump(`Note modify send (auto-merge)`, data.path, data.contentHash, data.mtime, e.baseHash)
      return true
    },
    sendRePush(path) {
      void plugin.websocket.SendMessage("NoteRePush", { vault: plugin.settings.vault, path, pathHash: hashContent(path) })
    },
    releaseSlot: (path) => plugin.concurrencyLimiter.releaseSlot(path),
    setPending(path, hash) {
      plugin.pendingNoteModifies.set(path, hash)
      plugin.localStorageManager.savePending("pendingNoteModifies", plugin.pendingNoteModifies)
    },
    clearPending(path) {
      if (plugin.pendingNoteModifies.delete(path)) plugin.localStorageManager.savePending("pendingNoteModifies", plugin.pendingNoteModifies)
    },
    async saveLost(path, content, why) {
      try {
        const a = vault.adapter
        const dir = `${pluginDir()}/${LOST_DIR}`
        if (!(await a.exists(dir))) await a.mkdir(dir)
        const stem = conflictStem(normalizePath(path), hashContent)
        await a.write(`${dir}/${stem}.${Date.now()}.${why}.md`, content)
        const files = (await a.list(dir)).files.sort()
        for (const old of files.slice(0, Math.max(0, files.length - LOST_KEEP))) await a.remove(old)
        SyncLogManager.getInstance().addLog("info", "NoteLostCopy", `已保存本地副本（服务端并发写入覆盖风险）: ${path}`, "success", path)
      } catch (e) {
        dumpError("[FastSync] saveLost failed", e)
      }
    },
    log(action, message, status, path) {
      SyncLogManager.getInstance().addLog("info", action, message, status, path)
    },
    schedule: (fn, ms) => void window.setTimeout(fn, ms),
  }
  return new NoteMergeCore(deps)
}

export function createBaseStore(plugin: FastSync): BaseStore {
  const dir = `${getPluginDir(plugin)}/base`
  return new BaseStore({
    adapter: plugin.app.vault.adapter,
    dir,
    hash: hashContent,
    // 移动端总量上限降到 50 MiB（桌面 200 MiB）
    limits: Platform.isMobile ? { maxTotalChars: 50 * 1024 * 1024, maxNotes: 5000 } : undefined,
    isProtected: (p) => plugin.syncState.conflictedPaths.has(p) || (plugin.noteCore?.tracker.has(p) ?? false),
    log: (m, ...a) => dump(m, ...a),
  })
}

/** 冷启动种子：对 syncHash 已知而 base 缺失的 .md，本地内容 hash 恰等于 syncHash 时存为 base */
export async function seedBases(plugin: FastSync): Promise<void> {
  const core = plugin.noteCore
  if (!core) return
  let n = 0
  let seeded = 0
  for (const f of plugin.app.vault.getMarkdownFiles()) {
    const known = plugin.fileHashManager.getPathHash(f.path)
    if (known === null) continue
    if (plugin.baseStore.peekHash(f.path) === known) continue
    if (plugin.syncState.conflictedPaths.has(f.path)) continue
    try {
      const content = await plugin.app.vault.read(f)
      if (await core.seedIfMatches(f.path, content)) seeded++
    } catch {
      // 读失败跳过
    }
    if (++n % 20 === 0) await new Promise((r) => window.setTimeout(r, 0))
  }
  await plugin.baseStore.flush()
  dump(`[BaseStore] seed done: scanned ${n}, seeded ${seeded}, total ${plugin.baseStore.size}`)
}

export function isMarkdown(f: unknown): f is TFile {
  return f instanceof TFile && f.path.endsWith(".md")
}
