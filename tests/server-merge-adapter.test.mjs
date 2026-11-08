import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// 适配层（operator_note.ts）的 serverMerge 接线：Ack 副作用时机、推送 rev 规范化、离线删除接管
const noop = () => {};
const helpers = { dump: noop, dumpError: noop, isPathExcluded: () => false, hashContent: (x) => x, hashContentAsync: async (x) => x,
  getPluginDir: () => ".plugin", checkAndNotifyCaseConflict: () => false, getSafeCtime: () => 1 };
const logs = { addLog: noop, addOrUpdateLog: noop };
function load(file) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, console, window: { setTimeout: (fn) => { fn(); return 1; }, clearTimeout: noop },
    require: (id) => id === "obsidian" ? { normalizePath: (x) => x, TFile: class {} }
      : id.includes("helpers") ? helpers : id.includes("sync_log_manager") ? { SyncLogManager: { getInstance: () => logs } } : {} });
  return module.exports;
}
const note = load(process.env.NOTE_SRC || "src/lib/sync/operator_note.ts");

function plugin(sm) {
  const calls = { released: [], fifo: 0, completed: [], saved: 0, deletedHash: [] };
  return { calls, p: {
    settings: { syncEnabled: true, readonlySyncEnabled: false, vault: "v" },
    serverMerge: sm,
    pendingNoteModifies: new Map([["a.md", "h"]]), pendingNoteRenames: new Map([["a.md", { oldPath: "o.md", newPath: "a.md", contentHash: "h" }]]),
    pendingNoteDeleteAcks: new Set(["a.md"]),
    syncState: { pendingNotePushPageIndex: new Map() },
    localStorageManager: { getMetadata: () => 0, setMetadata: noop, savePending: () => calls.saved++ },
    concurrencyLimiter: { releaseSlot: (p) => calls.released.push(p), releaseFifoSlot: () => calls.fifo++ },
    fileHashManager: { setFileHash: noop, removeFileHash: (p) => calls.deletedHash.push(p), getPathHash: () => null },
    app: { vault: { getFileByPath: () => null } },
    recordSyncCompleted: (...a) => calls.completed.push(a),
    lastSyncPathDeleted: new Set(), lockManager: { withLock: async (_, fn) => fn() }, addIgnoredFile: noop, removeIgnoredFile: noop,
    lastSyncMtime: new Map(), noteSyncTasks: { failed: 0 }, concurrencyControlEnabled: false,
  } };
}

// #10：opId 不匹配的 Ack 不得清 pending / 放槽 / 记账 / 交给状态机
for (const [name, fn, extra] of [["modify", note.receiveNoteModifyAck, (c) => c.released], ["delete", note.receiveNoteDeleteAck, (c) => c.released]]) {
  const acked = [];
  const { p, calls } = plugin({ supported: true, acceptsAck: () => false, onAck: (a) => acked.push(a) });
  await fn({ path: "a.md", opId: "wrong", lastTime: 5 }, p);
  assert.equal(p.pendingNoteModifies.has("a.md"), true, `${name}: pending 必须保留`);
  assert.equal(p.pendingNoteDeleteAcks.has("a.md"), true, `${name}: pendingDeleteAck 必须保留`);
  assert.equal(extra(calls).length, 0, `${name}: 不得释放上传槽`);
  assert.equal(calls.completed.length, 0, `${name}: 不得推进完成计数/水位`);
  assert.equal(acked.length, 0);
}
{
  const { p, calls } = plugin({ supported: true, acceptsAck: () => false, onAck: noop });
  note.receiveNoteRenameAck({ path: "a.md", opId: "wrong" }, p);
  assert.equal(p.pendingNoteRenames.has("a.md"), true, "rename: pending 必须保留");
  assert.equal(calls.fifo, 0, "rename: 不得释放 FIFO 槽");
}
{
  const acked = [];
  const { p, calls } = plugin({ supported: true, acceptsAck: () => true, onAck: (a) => acked.push(a) });
  await note.receiveNoteModifyAck({ path: "a.md", opId: "ok", lastTime: 5 }, p);
  assert.equal(p.pendingNoteModifies.has("a.md"), false);
  assert.deepEqual(calls.released, ["a.md"]);
  assert.equal(calls.completed.length, 1);
  assert.equal(acked.length, 1, "匹配的 Ack 交给状态机");
}

// #12：REST/MCP 推送只带 lastTime 时 rev ?? lastTime
assert.equal(note.pushRev({ lastTime: 5 }), 5);
assert.equal(note.pushRev({ rev: 0, lastTime: 9 }), 9, "protobuf 缺字段是 0，不能用 ??");
assert.equal(note.pushRev({ rev: 7, lastTime: 9 }), 7);
assert.equal(note.pushRev({}), 0);
// #12：离线删除接管（serverMerge 会话 → 逐个走 Delete；否则交回上游 delNotes）
{
  const del = [];
  const mk = (supported) => plugin({ supported, requestDelete: async (path, send) => { del.push(path); return true; } }).p;
  const items = [{ path: "x.md" }, { path: "y.md" }];
  assert.equal(note.dispatchOfflineNoteDeletes(items, mk(false)), false);
  assert.equal(del.length, 0);
  assert.equal(note.dispatchOfflineNoteDeletes(items, mk(true)), true);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(del, ["x.md", "y.md"], "按顺序逐个走 serverMerge Delete");
}

// #5：serverMerge 会话下，实时推送 / Ack 不得推进增量水位（只有 SyncEnd 连续确认才推进）
{
  const meta = [];
  const mkp = (sm) => { const x = plugin(sm); x.p.localStorageManager = { getMetadata: () => 0, setMetadata: (k, v) => meta.push([k, v]), savePending: noop }; x.p.app.vault.getFileByPath = () => null; return x.p; };
  await note.receiveNoteSyncModify({ path: "latest.md", lastTime: 200, rev: 200, content: "x", contentHash: "h" }, mkp({ supported: true, onPush: async () => "applied" }));
  await note.receiveNoteModifyAck({ path: "a.md", opId: "ok", lastTime: 300 }, mkp({ supported: true, acceptsAck: () => true, onAck: noop }));
  assert.deepEqual(meta, [], "supported 会话：推送 / Ack 不推进 lastNoteSyncTime");
  const legacy = [];
  const pl = plugin({ supported: false }).p;
  pl.localStorageManager = { getMetadata: () => 0, setMetadata: (k, v) => legacy.push([k, v]), savePending: noop };
  pl.app.vault.getFileByPath = () => null; pl.app.vault.createFolder = noop; pl.app.vault.getFolderByPath = () => ({}); pl.app.vault.create = async () => {};
  pl.fileHashManager.setFileHash = noop; pl.lastSyncMtime = new Map();
  await note.receiveNoteModifyAck({ path: "a.md", lastTime: 300 }, pl);
  assert.deepEqual(legacy, [["lastNoteSyncTime", 300]], "旧服务端会话行为不变");
}

// #6：Delete 超时重发不再 waitForSlot（复用首发持有的槽）
{
  let waits = 0, sends = 0;
  const x = plugin({ supported: true, requestDelete: async (path, send) => { await send("op", "sha", false); await send("op", "sha", true); return true; } });
  x.p.concurrencyLimiter.waitForSlot = async () => { waits++; return true; };
  x.p.websocket = { SendMessage: () => { sends++; } };
  assert.equal(await note.noteDeleteByPath("gone.md", x.p), undefined);
  assert.equal(waits, 1, "首发取一次槽");
  assert.equal(sends, 2, "重发照常发送");
}

// #10：删除推送的 rev 门控与墓碑登记独立于本地是否有文件
{
  const removed = [];
  const x = plugin({ supported: true, admit: (path, rev) => rev > 700, onRemoteDelete: async () => "apply" });
  x.p.fileHashManager.removeFileHash = (path, rev) => removed.push([path, rev]);
  x.p.app.vault.getFileByPath = () => null;
  await note.receiveNoteSyncDelete({ path: "gone.md", rev: 900, lastTime: 900 }, x.p);
  assert.deepEqual(removed, [["gone.md", 900]], "本地没有文件也要登记墓碑 rev");
  removed.length = 0;
  await note.receiveNoteSyncDelete({ path: "gone.md", rev: 600, lastTime: 600 }, x.p);
  assert.deepEqual(removed, [], "旧 rev 的删除推送被门控");
}
console.log("server-merge-adapter: ok");
