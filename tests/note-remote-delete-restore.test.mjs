// #277 与路径锁抢不到时的推送重试（off 模式 = 上游路径）
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const noop = () => {};
class TFile { constructor(path) { this.path = path; this.stat = { mtime: 1, size: 1 }; } }
const helpers = new Proxy({ isPathExcluded: () => false, hashContentAsync: async (s) => "h:" + s, hashContent: (s) => "h:" + s, dump: noop, dumpError: noop,
  checkAndNotifyCaseConflict: () => false }, { get: (t, k) => t[k] ?? (() => undefined) });
let timers = [];
function load(file) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, console, window: { setTimeout: (fn) => { timers.push(fn); return 1; } },
    require: (id) => id === "obsidian" ? { TFile, normalizePath: (x) => x }
      : id.includes("note_core_deps") ? { isAutoMerge: () => false, forgetNote: async () => {}, clearConflictState: async () => {} }
      : id.includes("helpers") ? helpers
      : id.includes("remote_path_guard") ? { blockAliasedRemoteMutation: () => false }
      : id.includes("sync_log_manager") ? { SyncLogManager: { getInstance: () => ({ addLog: noop }) } } : {} });
  return module.exports;
}
const note = load("src/lib/sync/operator_note.ts");

function fixture(localContent, known, lockFails = 0) {
  const file = new TFile("a.md");
  const trashed = [], removed = [], completed = [];
  let failsLeft = lockFails;
  const p = {
    settings: { syncEnabled: true },
    app: { vault: { getFileByPath: () => file, read: async () => localContent, trash: async (f) => trashed.push(f.path),
      modify: async () => {}, create: async () => {}, getFolderByPath: () => ({}) } },
    lockManager: { withLock: async (_, fn) => { if (failsLeft-- > 0) return null; return fn(); } },
    addIgnoredFile: noop, removeIgnoredFile: noop, lastSyncPathDeleted: new Set(), lastSyncMtime: new Map(),
    pendingNoteModifies: new Map(), pendingNoteDeleteAcks: new Set(), syncState: { conflictedPaths: new Set() },
    fileHashManager: { getPathHash: () => known, removeFileHash: (x) => removed.push(x), setFileHash: noop },
    localStorageManager: { savePending: noop, getMetadata: () => 0, setMetadata: noop },
    noteSyncTasks: { failed: 0 }, recordSyncCompleted: (...a) => completed.push(a),
  };
  return { p, trashed, removed, completed };
}

// 本地有未同步改动：远端删除不执行，保留并重新上传
{
  timers = [];
  const f = fixture("edited locally", "h:synced version");
  await note.receiveNoteSyncDelete({ path: "a.md", pageIndex: 1 }, f.p);
  assert.deepEqual(f.trashed, [], "must not delete a note with unsynced local edits");
  assert.deepEqual(f.removed, ["a.md"], "syncHash dropped so the re-upload is a fresh create (baseHashMissing)");
  assert.equal(timers.length, 1, "re-upload scheduled");
  assert.deepEqual(f.completed, [["note", 1]]);
}
// 本地未分叉：照常删除
{
  timers = [];
  const f = fixture("synced version", "h:synced version");
  await note.receiveNoteSyncDelete({ path: "a.md", pageIndex: 1 }, f.p);
  assert.deepEqual(f.trashed, ["a.md"]);
}
// 从未同步过（syncHash 为空）的本地笔记也不能被远端删除吃掉
{
  timers = [];
  const f = fixture("brand new local", null);
  await note.receiveNoteSyncDelete({ path: "a.md" }, f.p);
  assert.deepEqual(f.trashed, []);
}
// 抢不到路径锁：不丢弃，稍后重试；只在最终处理后记一次完成
{
  timers = [];
  const f = fixture("same", "h:same", 1);
  let writes = 0;
  f.p.app.vault.modify = async () => { writes++; };
  const data = { path: "a.md", content: "remote", contentHash: "h:remote", mtime: 5, ctime: 1, pageIndex: 2 };
  await note.receiveNoteSyncModify(data, f.p);
  assert.equal(writes, 0);
  assert.equal(f.completed.length, 0, "not accounted while retry pending");
  assert.equal(timers.length, 1);
  timers.shift()(); await new Promise((r) => setImmediate(r));
  assert.equal(writes, 1, "retried push applied");
  assert.deepEqual(f.completed, [["note", 2]]);
}
// realtime 标记：放行的无 context 推送不计入轮次进度
{
  timers = [];
  const f = fixture("same", "h:same");
  await note.receiveNoteSyncModify({ path: "a.md", content: "remote", contentHash: "h:remote", mtime: 5, ctime: 1, realtime: true }, f.p);
  assert.equal(f.completed.length, 0);
}
console.log("note-remote-delete-restore.test.mjs: all scenarios passed");
