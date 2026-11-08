import { conflictStem } from "./conflict_paths";
import { blockAliasedRemoteMutation } from "./remote_path_guard";
import { TFile, TAbstractFile, normalizePath } from "obsidian";

import { ReceiveMessage, ReceiveMtimeMessage, ReceivePathMessage, SyncEndData } from "../utils/types";
import { hashContent, hashContentAsync, dump, dumpError, isPathExcluded, getSafeCtime, checkAndNotifyCaseConflict, getPluginDir } from "../utils/helpers";
import { SyncLogManager } from "./sync_log_manager";
import { isAutoMerge, forgetNote, clearConflictState } from "./note_core_deps";
import type FastSync from "../../main";


/**
 * 笔记修改事件处理
 */
export const noteModify = async function (file: TAbstractFile, plugin: FastSync, eventEnter: boolean = false) {
  if (plugin.settings.syncEnabled == false || plugin.settings.readonlySyncEnabled) return
  if (!(file instanceof TFile)) return
  if (!file.path.endsWith(".md")) return
  if (eventEnter && plugin.isIgnoredFile(file.path)) return
  if (isPathExcluded(file.path, plugin)) return

  // clientAutoMerge：单飞上传 + 冲突闸 + 合并都在 NoteMergeCore 内（自己按路径加锁）
  if (isAutoMerge(plugin)) {
    await plugin.noteCore.requestUpload(file.path, { kind: "edit" })
    return
  }
  // #276：冲突路径禁止上传本地内容（否则非 manualMerge 的服务端会无条件覆盖对端版本）
  if (plugin.syncState.conflictedPaths.has(file.path)) {
    dump(`Note modify blocked (path in conflict): ${file.path}`)
    return
  }

  await plugin.lockManager.withLock(file.path, async () => {
    plugin.addIgnoredFile(file.path)

    try {
      const baseHash = plugin.fileHashManager.getPathHash(file.path)
      const lastSyncMtime = plugin.lastSyncMtime.get(file.path)

      // --- 优化：先尝试从缓存获取有效哈希 ---
      let contentHash = plugin.fileHashManager.getValidHash(file.path, file.stat.mtime, file.stat.size);
      let content: string | null = null;

      if (contentHash !== null) {
        // 如果哈希有效，且与 baseHash 和最后同步时间一致，则拦截
        if (contentHash === baseHash && (lastSyncMtime !== undefined && lastSyncMtime === file.stat.mtime)) {
          dump(`Note modify intercepted (cache match): ${file.path}`)
          return
        }
      } else {
        // 缓存失效或不存在，计算新哈希
        content = await plugin.app.vault.read(file)
        contentHash = await hashContentAsync(content)
      }

      if (content === null) content = await plugin.app.vault.read(file)

      const data = {
        vault: plugin.settings.vault,
        ctime: getSafeCtime(file.stat),
        mtime: file.stat.mtime,
        path: file.path,
        pathHash: hashContent(file.path),
        content: content,
        contentHash: contentHash,
        // 始终传递 baseHash 信息，如果不可用则标记 baseHashMissing
        ...(baseHash !== null ? { baseHash } : { baseHashMissing: true }),
      }
      // 将 hash 暂存到 pending map，等待服务端 NoteModifyAck 后再写入 hashManager
      // Temporarily store hash in pending map, update hashManager only after server NoteModifyAck
      if (contentHash != baseHash) {
        // 新建操作覆盖删除意图，清除 pending 防止晚到的 Ack 错误删除新文件 hash
        // New create supersedes delete intent; clear pending to prevent stale Ack from removing new hash
        plugin.pendingNoteDeleteAcks.delete(file.path)
        plugin.pendingNoteModifies.set(file.path, contentHash)
        plugin.localStorageManager.savePending('pendingNoteModifies', plugin.pendingNoteModifies)
      }
      if (!await plugin.concurrencyLimiter.waitForSlot(file.path)) return
      void plugin.websocket.SendMessage("NoteModify", data)
      dump(`Note modify send`, data.path, data.contentHash, data.mtime, data.pathHash)
    } finally {
      plugin.removeIgnoredFile(file.path)
    }
  }, { maxRetries: 5, retryInterval: 50 });
}

/**
 * 笔记删除事件处理
 */
export const noteDelete = async function (file: TAbstractFile, plugin: FastSync, eventEnter: boolean = false) {
  if (plugin.settings.syncEnabled == false || plugin.settings.readonlySyncEnabled) return
  if (!(file instanceof TFile)) return
  if (!file.path.endsWith(".md")) return
  if (eventEnter && plugin.isIgnoredFile(file.path)) return
  if (isPathExcluded(file.path, plugin)) return

  // --- 新增：删除拦截 ---
  if (plugin.lastSyncPathDeleted.has(file.path)) {
    dump(`Note delete intercepted: ${file.path}`)
    return
  }

  void forgetNote(plugin, file.path)
  await plugin.lockManager.withLock(file.path, async () => {
    // 清理可能存在的待确认上传记录，避免 pending map 内存泄漏
    // Clean up any pending note modify record to avoid memory leak
    plugin.pendingNoteModifies.delete(file.path)
    plugin.localStorageManager.savePending('pendingNoteModifies', plugin.pendingNoteModifies)
    plugin.addIgnoredFile(file.path)
    try {
      const data = {
        vault: plugin.settings.vault,
        path: file.path,
        pathHash: hashContent(file.path),
      }
      if (!await plugin.concurrencyLimiter.waitForSlot(file.path)) return
      void plugin.websocket.SendMessage("NoteDelete", data, undefined, () => {
        // 消息真正写入 TCP 缓冲区后加入 pending set，等待 NoteDeleteAck 再删 hash
        // Add to pending set only after message is actually buffered; remove hash only on NoteDeleteAck
        plugin.pendingNoteDeleteAcks.add(file.path)
      })

      dump(`Note delete send`, file.path)
    } finally {
      plugin.removeIgnoredFile(file.path)
    }
  }, { maxRetries: 3, retryInterval: 50 });
}

/**
 * 按路径字符串发送笔记删除消息（用于无法获取 TFile 对象的场景，如 rename 后旧路径已不存在）
 * Send note delete message by path string (for scenarios where TFile object is unavailable, e.g., old path after rename)
 */
export const noteDeleteByPath = async function (filePath: string, plugin: FastSync) {
  if (plugin.settings.syncEnabled == false || plugin.settings.readonlySyncEnabled) return
  if (!filePath.endsWith(".md")) return
  if (isPathExcluded(filePath, plugin)) return
  if (plugin.lastSyncPathDeleted.has(filePath)) return

  void forgetNote(plugin, filePath)
  await plugin.lockManager.withLock(filePath, async () => {
    // 清理可能存在的待确认上传记录，避免 pending map 内存泄漏
    // Clean up any pending note modify record to avoid memory leak
    plugin.pendingNoteModifies.delete(filePath)
    plugin.localStorageManager.savePending('pendingNoteModifies', plugin.pendingNoteModifies)
    plugin.addIgnoredFile(filePath)
    try {
      if (!await plugin.concurrencyLimiter.waitForSlot(filePath)) return
      void plugin.websocket.SendMessage("NoteDelete", {
        vault: plugin.settings.vault,
        path: filePath,
        pathHash: hashContent(filePath),
      }, undefined, () => {
        // 消息真正写入 TCP 缓冲区后加入 pending set，等待 NoteDeleteAck 再删 hash
        // Add to pending set only after message is actually buffered; remove hash only on NoteDeleteAck
        plugin.pendingNoteDeleteAcks.add(filePath)
      })
      dump(`Note delete by path send`, filePath)
    } finally {
      plugin.removeIgnoredFile(filePath)
    }
  }, { maxRetries: 3, retryInterval: 50 });
}

/**
 * 笔记重命名事件处理
 */
export const noteRename = async function (file: TAbstractFile, oldfile: string, plugin: FastSync, eventEnter: boolean = false) {
  if (plugin.settings.syncEnabled == false || plugin.settings.readonlySyncEnabled) return
  if (!(file instanceof TFile)) return
  if (!file.path.endsWith(".md")) return
  if (eventEnter && plugin.isIgnoredFile(file.path)) return
  const newExcluded = isPathExcluded(file.path, plugin)
  const oldExcluded = isPathExcluded(oldfile, plugin)

  // Cross-exclusion-boundary rename handling
  // 跨排除边界重命名处理
  if (newExcluded && !oldExcluded) {
    // Moving from normal folder to excluded folder: delete old path on server
    // 从正常文件夹移至排除文件夹：删除服务端旧路径
    void noteDeleteByPath(oldfile, plugin)
    return
  }
  if (!newExcluded && oldExcluded) {
    // Moving from excluded folder to normal folder: create new note on server
    // 从排除文件夹移至正常文件夹：在服务端创建新笔记
    void noteModify(file, plugin, true)
    return
  }
  if (newExcluded && oldExcluded) {
    // Both paths excluded: do nothing
    // 两个路径均被排除：不处理
    return
  }

  // --- 新增：重命名拦截 ---
  if (plugin.lastSyncPathRenamed.has(file.path)) {
    dump(`Note rename intercepted: ${file.path}`)
    return
  }

  // 重命名：base 随 key 迁移；旧路径的冲突状态/在途上传登记作废
  void forgetNote(plugin, oldfile, file.path)
  // 重命名涉及两个路径，我们锁定新路径，旧路径由调用方或原子性保证
  await plugin.lockManager.withLock(file.path, async () => {
    plugin.addIgnoredFile(file.path)
    try {
      let contentHash = plugin.fileHashManager.getPathHash(oldfile)
      if (contentHash == null) {
        const content: string = await plugin.app.vault.read(file)
        contentHash = await hashContentAsync(content)
      }

      const data = {
        vault: plugin.settings.vault,
        path: file.path,
        pathHash: hashContent(file.path),
        oldPath: oldfile,
        oldPathHash: hashContent(oldfile),
      }

      // 将重命名信息存入 Map（key 为 newPath），等待服务端 NoteRenameAck 按 path 精确匹配后再更新 hashManager
      // Store rename info in Map (keyed by newPath), update hashManager only after server NoteRenameAck matches by path
      plugin.pendingNoteRenames.set(file.path, { oldPath: oldfile, newPath: file.path, contentHash })
      if (!await plugin.concurrencyLimiter.waitForSlot(file.path, true)) return
      void plugin.websocket.SendMessage("NoteRename", data)
      dump(`Note rename send`, data.path, data.pathHash)
    } finally {
      plugin.removeIgnoredFile(file.path)
    }
  }, { maxRetries: 5, retryInterval: 50 });
}

/**
 * 接收服务端笔记修改通知
 */
export const receiveNoteSyncModify = async function (data: ReceiveMessage, plugin: FastSync, lockAttempt: number = 0) {
  if (plugin.settings.syncEnabled == false) return
  // 同步轮次中放行的无 context 实时推送不计入轮次进度
  const realtime = data.realtime === true
  const complete = () => { if (!realtime) plugin.recordSyncCompleted('note', data.pageIndex) }
  if (isPathExcluded(data.path, plugin)) {
    complete()
    return
  }
  dump(`Receive note modify:`, data.path, data.contentHash, data.mtime, data.pathHash)

  const normalizedPath = normalizePath(data.path)

  // clientAutoMerge：本地分叉判据与三方合并全部在 NoteMergeCore（基于 hash，不依赖内存 mtime/pending）
  if (isAutoMerge(plugin)) {
    try {
      const outcome = await plugin.noteCore.onRemote({
        path: normalizedPath, content: data.content, contentHash: data.contentHash, mtime: data.mtime, ctime: data.ctime,
      })
      if (outcome === "applied" || outcome === "confirmed" || outcome === "merged") {
        if (data.lastTime && data.lastTime > Number(plugin.localStorageManager.getMetadata("lastNoteSyncTime"))) {
          plugin.localStorageManager.setMetadata("lastNoteSyncTime", data.lastTime)
        }
        plugin.lastSyncMtime.set(data.path, data.mtime)
        plugin.pendingNoteModifies.delete(data.path)
        plugin.localStorageManager.savePending('pendingNoteModifies', plugin.pendingNoteModifies)
        plugin.pendingNoteDeleteAcks.delete(data.path)
      }
    } catch (e) {
      dumpError(`[FastSync] Failed to receiveNoteSyncModify (auto-merge): ${normalizedPath}`, e);
      if (!checkAndNotifyCaseConflict(e, data.path, plugin, 'NoteModify')) {
        SyncLogManager.getInstance().addLog('receive', 'NoteModify', e instanceof Error ? e.message : String(e), 'error', data.path);
      }
      plugin.noteSyncTasks.failed++
    } finally {
      complete()
    }
    return
  }

  let lockAcquired = false
  let retryScheduled = false
  try {
    await plugin.lockManager.withLock(normalizedPath, async () => {
      lockAcquired = true
      const file = plugin.app.vault.getFileByPath(normalizedPath)
      plugin.addIgnoredFile(normalizedPath)
      try {
        if (file) {
          // Fail-safe：写盘前检查本地是否有未推送的编辑，避免服务端推送盲覆盖用户刚做的改动
          // Fail-safe: before overwriting, check for unsynced local edits so a server push
          // doesn't blindly clobber changes the user just made
          const localContentHashNow = await hashContentAsync(await plugin.app.vault.read(file));
          const remoteContentHashNow = await hashContentAsync(data.content);
          const contentsMatch = localContentHashNow === remoteContentHashNow;
          const baseHashNow = plugin.fileHashManager.getPathHash(normalizedPath);
          // A replay of the unchanged server baseline is not a two-sided edit.
          if (!contentsMatch && baseHashNow !== null && remoteContentHashNow === baseHashNow) {
            plugin.pendingNoteModifies.set(normalizedPath, localContentHashNow);
            plugin.localStorageManager.savePending('pendingNoteModifies', plugin.pendingNoteModifies);
            return;
          }
          const hasPendingLocalEdit = plugin.pendingNoteModifies.has(data.path)
          let hasDivergedSinceLastSync = false
          if (!hasPendingLocalEdit) {
            const knownSyncMtime = plugin.lastSyncMtime.get(data.path)
            const localMtimeIsNewer = knownSyncMtime !== undefined && file.stat.mtime > knownSyncMtime
            if (localMtimeIsNewer) {
              // mtime 已比上次同步记录的新，进一步用内容哈希确认本地内容是否真的偏离了已知基准
              // mtime is newer than what we last synced; confirm with content hash whether
              // local content actually diverged from the known baseline
              const knownBaseHash = plugin.fileHashManager.getPathHash(normalizedPath)
              let localContentHash = plugin.fileHashManager.getValidHash(normalizedPath, file.stat.mtime, file.stat.size)
              if (localContentHash === null) {
                const localContent = await plugin.app.vault.read(file)
                localContentHash = await hashContentAsync(localContent)
              }
              hasDivergedSinceLastSync = localContentHash !== knownBaseHash
            }
          }

          if (!contentsMatch && (hasPendingLocalEdit || hasDivergedSinceLastSync || plugin.syncState.conflictedPaths.has(normalizedPath))) {
            dump(`[FastSync] Skip overwrite, local unsynced edit detected: ${normalizedPath}`)

            // 如果存在未同步的本地修改或已在冲突列表中，将服务端最新推送的内容写入/更新到远端备份文件 xxx.remote.md
            // If local unsynced edit exists or path is in conflict state, write/update the server's latest content into xxx.remote.md
            try {
              const adapter = plugin.app.vault.adapter;
              const conflictDir = `${getPluginDir(plugin)}/conflict-notes`;
              const stem = conflictStem(normalizedPath, hashContent);
              const baseBackupPath = `${conflictDir}/${stem}.base.md`;
              const remoteBackupPath = `${conflictDir}/${stem}.remote.md`;

              if (!(await adapter.exists(conflictDir))) {
                await adapter.mkdir(conflictDir);
              }

              // 写入服务端最新推送的内容至 remote 备份文件
              await adapter.write(remoteBackupPath, data.content || "");

              // 若 base 备份不存在，使用当前本地内容建立初始 base 备份
              if (!(await adapter.exists(baseBackupPath))) {
                const localContent = await plugin.app.vault.read(file);
                await adapter.write(baseBackupPath, localContent);
              }

              dump(`[FastSync] Updated remote backup file for conflict: ${remoteBackupPath}`);
            } catch (err) {
              dumpError(`[FastSync] Failed to update remote backup file: ${normalizedPath}`, err);
            }

            // 保持在冲突列表中并刷新状态栏
            plugin.syncState.conflictedPaths.add(normalizedPath);
            plugin.syncState.newConflictedPathsThisRound.add(normalizedPath);
            plugin.localStorageManager.setConflictedPaths(plugin.syncState.conflictedPaths);
            plugin.statusBarManager.updateConflictBadge();

            SyncLogManager.getInstance().addLog('receive', 'NoteModifyConflict', `本地存在未同步的改动，跳过服务端覆盖，等待下一轮同步处理冲突: ${normalizedPath}`, 'cancelled', data.path)
            return
          }

          await plugin.app.vault.modify(file, data.content, { ...(data.ctime > 0 && { ctime: data.ctime }), ...(data.mtime > 0 && { mtime: data.mtime }) })
        } else {
          const folder = normalizedPath.split("/").slice(0, -1).join("/")
          if (folder != "") {
            const dirExists = plugin.app.vault.getFolderByPath(folder)
            if (dirExists == null) {
              try {
                await plugin.app.vault.createFolder(folder)
              } catch (e) {
                // 并发竞争时只有一个调用成功，另一方忽略"已存在"错误
                // In concurrent race only one call succeeds; ignore "already exists" error
                if (!plugin.app.vault.getFolderByPath(folder)) throw e
              }
            }
          }
          await plugin.app.vault.create(normalizedPath, data.content, { ...(data.ctime > 0 && { ctime: data.ctime }), ...(data.mtime > 0 && { mtime: data.mtime }) })
        }
        if (data.lastTime && data.lastTime > Number(plugin.localStorageManager.getMetadata("lastNoteSyncTime"))) {
          plugin.localStorageManager.setMetadata("lastNoteSyncTime", data.lastTime)
        }

        // 服务端推送笔记更新,更新哈希表(使用内容哈希)
        // 注意：由于是服务端推送，我们信任服务端返回的 mtime，并尝试获取本地文件大小
        const updatedFile = plugin.app.vault.getFileByPath(normalizedPath);
        plugin.fileHashManager.setFileHash(data.path, data.contentHash, data.mtime, updatedFile?.stat.size || 0)
        // 记录同步后的 mtime 用于拦截
        plugin.lastSyncMtime.set(data.path, data.mtime)
        // 服务端版本已覆盖本地，清理 pending 避免增量过滤器旁路导致该笔记无限重传
        // Server version overrides local; clear pending to avoid incremental filter bypass loop
        plugin.pendingNoteModifies.delete(data.path)
        plugin.localStorageManager.savePending('pendingNoteModifies', plugin.pendingNoteModifies)
        // 服务端推送新内容说明该路径已被创建/更新，清理可能残留 de deleteAck pending
        // Server push means path was created/updated; clear any stale deleteAck pending
        plugin.pendingNoteDeleteAcks.delete(data.path)
      } finally {
        window.setTimeout(() => {
          plugin.removeIgnoredFile(normalizedPath)
        }, 500);
      }
    }, { maxRetries: 5, retryInterval: 100 });
    // 抢不到路径锁时不能静默丢弃这条推送：稍后重试（最多约 30 秒）
    if (!lockAcquired) {
      if (lockAttempt < 30) {
        retryScheduled = true
        window.setTimeout(() => { void receiveNoteSyncModify(data, plugin, lockAttempt + 1) }, 1000)
      } else {
        dumpError(`[FastSync] receiveNoteSyncModify gave up (path lock busy): ${normalizedPath}`, new Error("lock busy"))
        plugin.noteSyncTasks.failed++
      }
    }
  } catch (e) {
    dumpError(`[FastSync] Failed to receiveNoteSyncModify: ${normalizedPath}`, e);
    if (!checkAndNotifyCaseConflict(e, data.path, plugin, 'NoteModify')) {
      SyncLogManager.getInstance().addLog('receive', 'NoteModify', e instanceof Error ? e.message : String(e), 'error', data.path);
    }
    plugin.noteSyncTasks.failed++
  } finally {
    if (!retryScheduled) complete()
  }
}

/**
 * 接收服务端请求上传笔记
 */
export const receiveNoteUpload = async function (data: ReceivePathMessage, plugin: FastSync) {
  if (plugin.settings.syncEnabled == false) return
  if (plugin.settings.readonlySyncEnabled) {
    dump(`Read-only mode: Intercepted note upload request for ${data.path}`)
    plugin.recordSyncCompleted('note', data.pageIndex)
    return
  }
  if (isPathExcluded(data.path, plugin)) {
    plugin.recordSyncCompleted('note', data.pageIndex)
    return
  }
  dump(`Receive note need push:`, data.path)
  if (!data.path.endsWith(".md")) {
    plugin.recordSyncCompleted('note', data.pageIndex)
    return
  }
  const file = plugin.app.vault.getFileByPath(normalizePath(data.path))
  if (!file) {
    plugin.recordSyncCompleted('note', data.pageIndex)
    return
  }

  // #276：冲突路径禁止上传本地内容。clientAutoMerge 下改为向服务端拉最新版本并重试合并；off 模式保留在本地等人工解决
  const conflicted = plugin.syncState.conflictedPaths.has(file.path)
  if (conflicted && !isAutoMerge(plugin)) {
    dump(`Note upload request ignored (path in conflict): ${data.path}`)
    plugin.recordSyncCompleted('note', data.pageIndex)
    return
  }

  // NeedPush 驱动的上传-回执往返：Ack（receiveNoteModifyAck）本身不带 pageIndex，
  // 在此按 path 记下所属页，供 Ack 到达时查表归账（见 sync_state.ts pendingNotePushPageIndex 注释）
  // NeedPush-driven upload/ack round trip: the Ack (receiveNoteModifyAck) carries no pageIndex;
  // record the owning page by path here so the Ack can look it up on arrival (see sync_state.ts
  // pendingNotePushPageIndex comment)
  if (data.pageIndex !== undefined) {
    plugin.syncState.pendingNotePushPageIndex.set(file.path, data.pageIndex)
  }

  if (isAutoMerge(plugin)) {
    // 单飞上传：Ack 才更新 base；该路径已有在途/处于冲突时不重复发送，直接归账本页
    const outcome = await plugin.noteCore.requestUpload(file.path, { kind: "needpush", context: (data as ReceivePathMessage & { context?: string }).context })
    if (outcome !== "sent") {
      plugin.syncState.pendingNotePushPageIndex.delete(file.path)
      plugin.recordSyncCompleted('note', data.pageIndex)
    }
    return
  }

  plugin.addIgnoredFile(file.path)

  const baseHash = plugin.fileHashManager.getPathHash(file.path)
  // 尝试从缓存获取 (Try to get from cache)
  let contentHash = plugin.fileHashManager.getValidHash(file.path, file.stat.mtime, file.stat.size);
  const content = await plugin.app.vault.read(file);
  if (contentHash === null) contentHash = await hashContentAsync(content);

  if (content.length === 0) {
    dump(`Empty note upload: ${data.path}`);
  }

  const sendData = {
    vault: plugin.settings.vault,
    ctime: getSafeCtime(file.stat),
    mtime: file.stat.mtime,
    path: file.path,
    pathHash: hashContent(file.path),
    content: content,
    contentHash: contentHash,
    // 始终传递 baseHash 信息，如果不可用则标记 baseHashMissing
    ...(baseHash !== null ? { baseHash } : { baseHashMissing: true }),
  }
  // 将 hash 写入 pending map，等待 NoteModifyAck 确认后再写 hashManager
  // 若此路径已有旧 pending（来自中断的 noteModify），覆盖为最新 hash
  // Store hash in pending map; hashManager is written only after NoteModifyAck arrives.
  // Overwrites any stale pending entry left by a previously interrupted noteModify.
  plugin.pendingNoteModifies.set(file.path, contentHash)
  plugin.localStorageManager.savePending('pendingNoteModifies', plugin.pendingNoteModifies)
  if (!await plugin.concurrencyLimiter.waitForSlot(file.path)) {
    plugin.removeIgnoredFile(file.path)
    return
  }
  void plugin.websocket.SendMessage("NoteModify", sendData, undefined, () => {
    plugin.removeIgnoredFile(file.path)
  }, (data as ReceivePathMessage & { context?: string }).context)
  dump(`Note modify send`, sendData.path, sendData.contentHash, sendData.mtime, sendData.pathHash)
}

/**
 * 接收服务端笔记元数据(mtime)更新通知
 */
export const receiveNoteSyncMtime = async function (data: ReceiveMtimeMessage, plugin: FastSync) {
  if (plugin.settings.syncEnabled == false) return
  const pushPageIndex = plugin.syncState.pendingNotePushPageIndex.get(data.path);
  const completionPageIndex = pushPageIndex ?? data.pageIndex;
  plugin.syncState.pendingNotePushPageIndex.delete(data.path);
  plugin.concurrencyLimiter.releaseSlot(data.path);
  if (isPathExcluded(data.path, plugin)) {
    plugin.recordSyncCompleted('note', completionPageIndex)
    return
  }
  dump(`Receive note sync mtime:`, data.path, data.mtime)

  const normalizedPath = normalizePath(data.path)

  try {
    await plugin.lockManager.withLock(normalizedPath, async () => {
      const file = plugin.app.vault.getFileByPath(normalizedPath)
      if (file) {
        const content: string = await plugin.app.vault.read(file)
        plugin.addIgnoredFile(normalizedPath)
        try {
          await plugin.app.vault.modify(file, content, { ...(data.ctime > 0 && { ctime: data.ctime }), ...(data.mtime > 0 && { mtime: data.mtime }) })
          // 记录 mtime
          plugin.lastSyncMtime.set(data.path, data.mtime)
          // 服务端走 UpdateMtime 说明内容 hash 与客户端发送的一致，提交 pending hash 到 hashManager
          // Server UpdateMtime means content hash matches what client sent; commit pending hash to hashManager
          const pendingHash = plugin.pendingNoteModifies.get(data.path)
          if (pendingHash !== undefined) {
            plugin.fileHashManager.setFileHash(data.path, pendingHash, data.mtime, file.stat.size)
            // 服务端 hash 等于本地发出的 hash：本地内容若恰为该 hash，即可作为 base 种子
            if (isAutoMerge(plugin)) {
              // syncHash 刚前进到 pendingHash，base 必须同步：内容恰为该 hash 则存，否则删旧 base（避免 hash 不一致被当作不可信）
              if (hashContent(content) === pendingHash) void plugin.baseStore.put(normalizedPath, content, pendingHash)
              else void plugin.baseStore.delete(normalizedPath)
            }
            plugin.pendingNoteModifies.delete(data.path)
            plugin.localStorageManager.savePending('pendingNoteModifies', plugin.pendingNoteModifies)
          }
          // 更新同步时间
          if (data.lastTime && data.lastTime > Number(plugin.localStorageManager.getMetadata("lastNoteSyncTime"))) {
            plugin.localStorageManager.setMetadata("lastNoteSyncTime", data.lastTime)
          }
        } finally {
          plugin.removeIgnoredFile(normalizedPath)
        }
      }
    }, { maxRetries: 5, retryInterval: 100 });
  } catch (e) {
    dumpError(`[FastSync] Failed to receiveNoteSyncMtime: ${normalizedPath}`, e);
    if (!checkAndNotifyCaseConflict(e, data.path, plugin, 'NoteMtime')) {
      SyncLogManager.getInstance().addLog('receive', 'NoteMtime', e instanceof Error ? e.message : String(e), 'error', data.path);
    }
    plugin.noteSyncTasks.failed++
  } finally {
    plugin.recordSyncCompleted('note', completionPageIndex)
  }
}

/**
 * 接收服务端笔记删除通知
 */
export const receiveNoteSyncDelete = async function (data: ReceiveMessage, plugin: FastSync) {
  if (plugin.settings.syncEnabled == false) return
  const realtime = data.realtime === true
  const complete = () => { if (!realtime) plugin.recordSyncCompleted('note', data.pageIndex) }
  if (isPathExcluded(data.path, plugin)) {
    complete()
    return
  }
  dump(`Receive note delete:`, data.path, data.mtime, data.pathHash)
  const normalizedPath = normalizePath(data.path)
  let restoreFile: TFile | null = null

  try {
    await plugin.lockManager.withLock(normalizedPath, async () => {
      const file = plugin.app.vault.getFileByPath(normalizedPath)
      if (file instanceof TFile) {
        if (blockAliasedRemoteMutation(plugin, file, data.path, "NoteDelete")) return
        // #277：本地有未同步改动（内容 hash ≠ 已确认的 syncHash）时不删除，把本地内容作为新建重新上传（恢复该笔记）
        const knownHash = plugin.fileHashManager.getPathHash(normalizedPath)
        const localHash = await hashContentAsync(await plugin.app.vault.read(file))
        if (localHash !== knownHash) {
          dump(`[FastSync] Remote delete skipped, local has unsynced edits: ${normalizedPath}`)
          SyncLogManager.getInstance().addLog('receive', 'NoteDeleteSkipped', `远端已删除，但本地有未同步改动，已保留并重新上传: ${normalizedPath}`, 'cancelled', data.path)
          plugin.fileHashManager.removeFileHash(normalizedPath)
          plugin.pendingNoteModifies.delete(normalizedPath)
          plugin.localStorageManager.savePending('pendingNoteModifies', plugin.pendingNoteModifies)
          void plugin.baseStore?.delete(normalizedPath)
          restoreFile = file
          return
        }
        plugin.addIgnoredFile(normalizedPath)
        // 记录待删除路径，用于拦截本地删除事件
        plugin.lastSyncPathDeleted.add(normalizedPath)
        try {
          await plugin.app.vault.trash(file, false)
          // 服务端推送删除,从哈希表中移除
          plugin.fileHashManager.removeFileHash(normalizedPath)
          plugin.lastSyncMtime.delete(normalizedPath)
          void forgetNote(plugin, normalizedPath)
          // 清理 pending，避免已删除路径的 pending 条目泄漏
          // Clean up pending to prevent memory leak for deleted path
          plugin.pendingNoteModifies.delete(normalizedPath)
          plugin.localStorageManager.savePending('pendingNoteModifies', plugin.pendingNoteModifies)
          // 更新同步时间
          if (data.lastTime && data.lastTime > Number(plugin.localStorageManager.getMetadata("lastNoteSyncTime"))) {
            plugin.localStorageManager.setMetadata("lastNoteSyncTime", data.lastTime)
          }
        } finally {
          // 延时 500ms 清理拦截集合，确保本地事件已被处理
          window.setTimeout(() => {
            plugin.removeIgnoredFile(normalizedPath)
            plugin.lastSyncPathDeleted.delete(normalizedPath)
          }, 500);
        }
      }
    }, { maxRetries: 5, retryInterval: 100 });
    if (restoreFile) {
      // 锁释放后再走上传（上传自己要拿同一把路径锁）；已无 syncHash，服务端该笔记已删除，按新建处理
      const f: TFile = restoreFile
      window.setTimeout(() => {
        if (isAutoMerge(plugin)) void plugin.noteCore.requestUpload(f.path, { kind: "recreate" })
        else void noteModify(f, plugin, false)
      }, 100)
    }
  } catch (e) {
    dumpError(`[FastSync] Failed to receiveNoteSyncDelete: ${normalizedPath}`, e);
    SyncLogManager.getInstance().addLog('receive', 'NoteDelete', e instanceof Error ? e.message : String(e), 'error', data.path);
    plugin.noteSyncTasks.failed++
  } finally {
    complete()
  }
}

/**
 * 接收笔记同步结束通知
 */
export const receiveNoteSyncEnd = async function (data: unknown, plugin: FastSync) {
  if (plugin.settings.syncEnabled == false) return
  dump(`Receive note end:`, data)

  const syncData = data as SyncEndData
  // 更新任务统计信息，用于进度条计算 (Update task stats for progress bar)
  plugin.noteSyncTasks.needUpload = syncData.needUploadCount || 0
  plugin.noteSyncTasks.needModify = syncData.needModifyCount || 0
  plugin.noteSyncTasks.needSyncMtime = syncData.needSyncMtimeCount || 0
  plugin.noteSyncTasks.needDelete = syncData.needDeleteCount || 0

  // 无条件更新 lastNoteSyncTime，确保包含服务端本轮同步后的所有异步操作（如 SyncResourceFID）
  // Unconditionally update lastNoteSyncTime to cover all async server-side ops after this sync round (e.g., SyncResourceFID)
  plugin.localStorageManager.setMetadata("lastNoteSyncTime", syncData.lastTime)
  plugin.syncTypeCompleteCount++
}

/**
 * 接收服务端笔记重命名通知
 */
export const receiveNoteSyncRename = async function (data: { path: string, oldPath: string, contentHash: string, mtime?: number, ctime?: number, lastTime?: number, pathHash?: string, pageIndex?: number, realtime?: boolean }, plugin: FastSync) {
  if (plugin.settings.syncEnabled == false) return
  if (isPathExcluded(data.path, plugin) || isPathExcluded(data.oldPath, plugin)) {
    if (!data.realtime) plugin.recordSyncCompleted('note', data.pageIndex)
    return
  }

  dump(`Receive note rename:`, data.oldPath, "->", data.path)

  const normalizedOldPath = normalizePath(data.oldPath)
  const normalizedNewPath = normalizePath(data.path)

  let divergedRename: TFile | null = null
  try {
    // 对于重命名，我们需要确新路径不被占用。旧路径通常正在被移动，所以锁定新路径。
    await plugin.lockManager.withLock(normalizedNewPath, async () => {
      const file = plugin.app.vault.getFileByPath(normalizedOldPath)
      if (file instanceof TFile) {
        if (blockAliasedRemoteMutation(plugin, file, data.oldPath, "NoteRename")) return
        if (blockAliasedRemoteMutation(plugin, plugin.app.vault.getFileByPath(normalizedNewPath), data.path, "NoteRename")) return
        plugin.addIgnoredFile(normalizedNewPath)
        plugin.addIgnoredFile(normalizedOldPath)

        // 记录重命名后的新路径，用于拦截本地事件
        plugin.lastSyncPathRenamed.add(normalizedNewPath)

        try {
          // 如果目标路径已存在文件，先尝试删除
          const targetFile = plugin.app.vault.getFileByPath(normalizedNewPath)
          if (targetFile && targetFile !== file) {
            await plugin.app.vault.trash(targetFile, false)
          }

          await plugin.app.vault.rename(file, normalizedNewPath)

          // 更新元数据
          if (data.mtime) {
            const renamedFile = plugin.app.vault.getFileByPath(normalizedNewPath)
            if (renamedFile instanceof TFile) {
              const content = await plugin.app.vault.read(renamedFile)
              const options: { ctime?: number; mtime?: number } = {};
              if (data.ctime && data.ctime > 0) options.ctime = data.ctime;
              if (data.mtime && data.mtime > 0) options.mtime = data.mtime;
              await plugin.app.vault.modify(renamedFile, content, options);
            }
          }

          // 更新哈希表：移除旧路径，添加新路径
          const renamedFile = plugin.app.vault.getFileByPath(normalizedNewPath)
          // 本地对旧路径有未同步改动时，不能把服务端 contentHash 当作「已同步」（会把分叉伪装成一致）：沿用旧的已确认 hash
          const knownOld = plugin.fileHashManager.getPathHash(data.oldPath)
          let diverged = false
          if (isAutoMerge(plugin) && knownOld !== null && renamedFile instanceof TFile) {
            diverged = await hashContentAsync(await plugin.app.vault.read(renamedFile)) !== knownOld
          }
          plugin.fileHashManager.removeFileHash(data.oldPath)
          if (diverged && knownOld !== null) {
            plugin.fileHashManager.setFileHash(data.path, knownOld, 0, 0)
            divergedRename = renamedFile as TFile
          } else {
            plugin.fileHashManager.setFileHash(data.path, data.contentHash, data.mtime || (renamedFile instanceof TFile ? renamedFile.stat.mtime : 0), renamedFile instanceof TFile ? renamedFile.stat.size : 0)
          }
          void forgetNote(plugin, data.oldPath, data.path)

          // 更新同步时间
          if (data.lastTime && data.lastTime > Number(plugin.localStorageManager.getMetadata("lastNoteSyncTime"))) {
            plugin.localStorageManager.setMetadata("lastNoteSyncTime", data.lastTime)
          }
        } finally {
          window.setTimeout(() => {
            plugin.removeIgnoredFile(normalizedNewPath)
            plugin.removeIgnoredFile(normalizedOldPath)
            plugin.lastSyncPathRenamed.delete(normalizedNewPath)
          }, 500);
        }
      } else {
        // 找不到旧文件...
        const targetFile = plugin.app.vault.getFileByPath(normalizedNewPath)
        if (targetFile instanceof TFile) {
          const content = await plugin.app.vault.read(targetFile)
          const localContentHash = await hashContentAsync(content)
          if (localContentHash === data.contentHash) {
            dump(`Target file already exists and matches hash, skipping rename: ${data.path}`)
            plugin.fileHashManager.setFileHash(data.path, data.contentHash)
            return
          }
        }

        dump(`Local file not found for rename, requesting RePush: ${data.oldPath} -> ${data.path}`)
        const rePushData = {
          vault: plugin.settings.vault,
          path: data.path,
          pathHash: data.pathHash,
        }
        void plugin.websocket.SendMessage("NoteRePush", rePushData)
        if (targetFile instanceof TFile) {
          plugin.fileHashManager.setFileHash(data.path, data.contentHash, targetFile.stat.mtime, targetFile.stat.size)
        } else {
          plugin.fileHashManager.setFileHash(data.path, data.contentHash)
        }
      }
    }, { maxRetries: 10, retryInterval: 100 });
    if (divergedRename) {
      // 重命名后本地仍有未同步改动：锁释放后补一次上传（baseHash=沿用的旧确认值）
      const f: TFile = divergedRename
      window.setTimeout(() => { void noteModify(f, plugin, false) }, 600)
    }
  } catch (e) {
    dumpError(`[FastSync] Failed to receiveNoteSyncRename: ${normalizedOldPath} -> ${normalizedNewPath}`, e);
    if (!checkAndNotifyCaseConflict(e, data.path, plugin, 'NoteRename')) {
      SyncLogManager.getInstance().addLog('receive', 'NoteRename', e instanceof Error ? e.message : String(e), 'error', data.path);
    }
    plugin.noteSyncTasks.failed++
  } finally {
    if (!data.realtime) plugin.recordSyncCompleted('note', data.pageIndex)
  }
}

// 收到 NoteModifyAck，将 pending hash 转移到正式 hashManager 并更新 lastNoteSyncTime
// Receive NoteModifyAck, move pending hash to formal hashManager and update lastNoteSyncTime
export const receiveNoteModifyAck = function (data: { lastTime?: number; path?: string; realtime?: boolean }, plugin: FastSync) {
  // 冲突解决弹窗的上传：收到 Ack 才算解决，清冲突状态与 conflict-notes
  if (data.path && plugin.syncState.pendingResolveAcks?.delete(normalizePath(data.path))) {
    void clearConflictState(plugin, data.path)
  }
  if (isAutoMerge(plugin)) {
    // 单飞登记：Ack 对应刚发出的那份内容 → syncHash 前进、base ← 该内容；无登记的 Ack 视为迟到/重复，不动 base
    if (data.path) {
      void plugin.noteCore.onAck(normalizePath(data.path)).then((matched) => {
        if (!matched) dump(`NoteModifyAck without registered upload (late/duplicate): ${data.path}`)
      }).catch((e) => dumpError(`[FastSync] onAck failed: ${data.path}`, e))
    }
    if (data.lastTime && data.lastTime > Number(plugin.localStorageManager.getMetadata("lastNoteSyncTime"))) {
      plugin.localStorageManager.setMetadata("lastNoteSyncTime", data.lastTime)
    }
    const pushPage = data.path ? plugin.syncState.pendingNotePushPageIndex.get(data.path) : undefined
    if (data.path) plugin.syncState.pendingNotePushPageIndex.delete(data.path)
    if (!data.realtime) plugin.recordSyncCompleted('note', pushPage)
    return
  }
  // 服务端确认笔记写入成功，将 pending hash 转移到正式 hashManager
  // Server confirmed note write success, move pending hash to formal hashManager
  if (data.path) {
    const contentHash = plugin.pendingNoteModifies.get(data.path)
    if (contentHash !== undefined) {
      // 尝试获取本地文件信息以存入缓存
      const file = plugin.app.vault.getFileByPath(normalizePath(data.path))
      plugin.fileHashManager.setFileHash(data.path, contentHash, file?.stat.mtime || 0, file?.stat.size || 0)
      plugin.pendingNoteModifies.delete(data.path)
      plugin.localStorageManager.savePending('pendingNoteModifies', plugin.pendingNoteModifies)
    } else {
      dump(`NoteModifyAck received for non-pending path: ${data.path}`)
    }
  }
  if (data.lastTime && data.lastTime > Number(plugin.localStorageManager.getMetadata("lastNoteSyncTime"))) {
    plugin.localStorageManager.setMetadata("lastNoteSyncTime", data.lastTime)
  }
  if (data.path) {
    plugin.concurrencyLimiter.releaseSlot(data.path)
  }
  // 该 Ack 若对应服务端 NeedPush 驱动的上传，查表取回其所属下载页归账（供 ack 水位线推进）；
  // 查不到说明是本地用户自发编辑触发的 Ack，不属于任何页，走旧路径（现状语义不变）
  // If this Ack corresponds to a server NeedPush-driven upload, look up its owning download page
  // for correct accounting (drives the ack watermark); a miss means a local user-initiated edit
  // triggered it — doesn't belong to any page, falls back to the legacy path (unchanged semantics)
  const pushPageIndex = data.path ? plugin.syncState.pendingNotePushPageIndex.get(data.path) : undefined;
  if (data.path) plugin.syncState.pendingNotePushPageIndex.delete(data.path)
  plugin.recordSyncCompleted('note', pushPageIndex)
}

// 收到 NoteRenameAck，按 data.path 精确匹配待确认条目并更新 hashManager；老服务端不下发 path 时回退 FIFO
// Receive NoteRenameAck, match pending entry precisely by data.path and update hashManager; falls back to FIFO when legacy server omits path
export const receiveNoteRenameAck = function (data: { lastTime?: number; path?: string }, plugin: FastSync) {
  let pending: { oldPath: string; newPath: string; contentHash: string } | undefined
  if (data.path) {
    pending = plugin.pendingNoteRenames.get(data.path)
    if (pending) plugin.pendingNoteRenames.delete(data.path)
  } else {
    // 老服务端未下发 path，回退 FIFO（Map 插入顺序取首个）
    // Legacy server omits path, fall back to FIFO (first inserted entry in Map order)
    const firstKey = Array.from(plugin.pendingNoteRenames.keys())[0];
    if (firstKey !== undefined) {
      pending = plugin.pendingNoteRenames.get(firstKey)
      plugin.pendingNoteRenames.delete(firstKey)
    }
  }
  if (pending) {
    plugin.fileHashManager.removeFileHash(pending.oldPath)
    // 重命名 Ack 时，内容哈希未变，尝试获取新路径的文件信息
    const file = plugin.app.vault.getFileByPath(normalizePath(pending.newPath))
    plugin.fileHashManager.setFileHash(pending.newPath, pending.contentHash, file?.stat.mtime || 0, file?.stat.size || 0)
  }
  if (data.lastTime && data.lastTime > Number(plugin.localStorageManager.getMetadata("lastNoteSyncTime"))) {
    plugin.localStorageManager.setMetadata("lastNoteSyncTime", data.lastTime)
  }
  plugin.concurrencyLimiter.releaseFifoSlot()
}

// 收到 NoteDeleteAck，仅当路径仍在 pending set 中时才从 hashManager 移除
// Receive NoteDeleteAck; only remove from hashManager if path is still pending
export const receiveNoteDeleteAck = function (data: { lastTime?: number; path?: string }, plugin: FastSync) {
  if (data.path && plugin.pendingNoteDeleteAcks.has(data.path)) {
    plugin.fileHashManager.removeFileHash(data.path)
    plugin.pendingNoteDeleteAcks.delete(data.path)
  }
  // 释放并发槽位：与 FileDeleteAck/ConfigDeleteAck 保持一致，仅检查 data.path 是否存在
  // Release concurrency slot: consistent with FileDeleteAck/ConfigDeleteAck, only check data.path
  if (data.path) {
    plugin.concurrencyLimiter.releaseSlot(data.path)
  }
  if (data.lastTime && data.lastTime > Number(plugin.localStorageManager.getMetadata("lastNoteSyncTime"))) {
    plugin.localStorageManager.setMetadata("lastNoteSyncTime", data.lastTime)
  }
}
