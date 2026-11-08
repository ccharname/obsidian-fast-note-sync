import { normalizePath, TFile } from "obsidian";

import type FastSync from "../../main";
import { hashContent, hashContentAsync, getSafeCtime, dump } from "../utils/helpers";
import { ServerMergeClient } from "./server_merge_client";
import { handleSync } from "./operator";
import type { MergeEnv } from "./server_merge_client";

const toHex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

/** 把状态机接到插件的 vault / hash 管理器 / websocket 上 */
export function createServerMerge(plugin: FastSync): ServerMergeClient {
  let client: ServerMergeClient;
  const vault = () => plugin.app.vault;
  const env: MergeEnv = {
    hash: (c) => hashContentAsync(c),
    sha: async (c) => toHex(await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(c))),
    newOpId: () => toHex(window.crypto.getRandomValues(new Uint8Array(16)).buffer),
    now: () => Date.now(),
    readLocal: async (path) => {
      const f = vault().getFileByPath(normalizePath(path));
      return f ? await vault().read(f) : null;
    },
    casWrite: async (path, expected, next) => {
      if (plugin.unloaded) return false; // 已卸载的旧实例不写盘
      const np = normalizePath(path);
      const f = vault().getFileByPath(np);
      if (expected === null) {
        if (f) return false;
        const folder = np.split("/").slice(0, -1).join("/");
        if (folder !== "" && !vault().getFolderByPath(folder)) {
          try {
            await vault().createFolder(folder);
          } catch (e) {
            if (!vault().getFolderByPath(folder)) throw e;
          }
        }
        await vault().create(np, next);
        return true;
      }
      if (!f) return false;
      let applied = false;
      await vault().process(f, (cur) => {
        if (cur !== expected) return cur;
        applied = true;
        return next;
      });
      return applied;
    },
    getBase: (path) => ({
      hash: plugin.fileHashManager.getPathHash(path),
      sha: plugin.fileHashManager.getPathSha(path),
      rev: plugin.fileHashManager.getPathRev(path),
    }),
    getReplayFloor: (path) => plugin.fileHashManager.getReplayFloor(path),
    endReconcile: () => plugin.fileHashManager.endReconcile(),
    setBase: (path, b, confirmed) => {
      if (!confirmed) {
        // 本地正文未确认等于 base：只动同步 base，不把 hash 绑到当前 mtime/size，也不设 lastSyncMtime
        plugin.fileHashManager.setSyncBase(path, b.hash, b.rev, b.sha || undefined);
        return;
      }
      const f = vault().getFileByPath(normalizePath(path));
      plugin.fileHashManager.setFileHash(path, b.hash, f?.stat.mtime || 0, f?.stat.size || 0, b.rev, b.sha || undefined);
      if (f) plugin.lastSyncMtime.set(path, f.stat.mtime);
    },
    canSend: () => plugin.settings.syncEnabled !== false && !plugin.settings.readonlySyncEnabled,
    clearBase: (path, rev) => {
      plugin.fileHashManager.removeFileHash(path, rev);
      plugin.lastSyncMtime.delete(path);
      plugin.pendingNoteModifies.delete(path);
    },
    sendModify: async (op) => {
      if (!env.canSend?.()) return false;
      const f = vault().getFileByPath(normalizePath(op.path));
      if (!(f instanceof TFile)) return false;
      const data = {
        vault: plugin.settings.vault,
        ctime: getSafeCtime(f.stat),
        mtime: f.stat.mtime,
        path: f.path,
        pathHash: hashContent(f.path),
        content: op.content,
        contentHash: op.hash,
        serverMerge: true,
        opId: op.opId,
        ...(op.baseHash !== null ? { baseHash: op.baseHash } : { baseHashMissing: true }),
        ...(op.baseSha ? { baseSha: op.baseSha } : {}),
      };
      // 等服务端 Ack 后才提交 base；pending 仅供增量过滤器 / 崩溃恢复使用
      plugin.pendingNoteDeleteAcks.delete(f.path);
      plugin.pendingNoteModifies.set(f.path, op.hash);
      plugin.localStorageManager.savePending("pendingNoteModifies", plugin.pendingNoteModifies);
      if (!op.slotHeld && !(await plugin.concurrencyLimiter.waitForSlot(f.path))) return false;
      const context = client.uploadContexts.get(f.path);
      client.uploadContexts.delete(f.path);
      void plugin.websocket.SendMessage("NoteModify", data, undefined, undefined, context);
      dump("Note modify send (serverMerge)", data.path, data.contentHash, data.opId);
      return true;
    },
    log: (m) => dump(m),
    setTimer: (fn, ms) => {
      const id = window.setTimeout(fn, ms);
      return () => window.clearTimeout(id);
    },
    random: () => Math.random(),
    acquireSlot: (path) => plugin.concurrencyLimiter.waitForSlot(normalizePath(path)),
    releaseSlot: (path) => plugin.concurrencyLimiter.releaseSlot(normalizePath(path)),
    onCopyMissing: (path) => {
      // 冲突副本推送未到：按水位做一轮笔记增量对账（pushes 不推进水位，副本 rev 必在水位之后）
      const pull = (retry: number) => {
        if (plugin.unloaded) return;
        if (plugin.isSyncing) {
          if (retry > 0) window.setTimeout(() => pull(retry - 1), 10000);
          return;
        }
        dump("Conflict copy push missing, pulling via note reconcile", path);
        void handleSync(plugin, true, "note");
      };
      pull(3);
    },
    localSize: (path) => vault().getFileByPath(normalizePath(path))?.stat.size ?? null,
  };
  client = new ServerMergeClient(env);
  return client;
}
