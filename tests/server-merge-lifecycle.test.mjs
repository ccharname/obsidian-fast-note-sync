import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// e2e 缺陷回归：同步轮期间的空 context 副本推送必须落地；onunload 后旧实例不得处理推送 / 重连
const noopModule = (o = {}) => new Proxy(o, { get: (t, k) => (k in t ? t[k] : () => undefined) });
function loadManager(handlers) {
  const file = "src/lib/sync/websocket_manager.ts";
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  const WSAction = new Proxy({}, { get: (_, k) => String(k) });
  const stub = (id) => {
    if (id === "obsidian") return { moment: Object.assign(() => ({ format: () => "" }), { locale: () => "" }), Platform: {}, normalizePath: (p) => p };
    if (id === "./websocket_action") return WSAction;
    if (id === "./operator") return noopModule({ receiveOperators: handlers });
    if (id === "./sync_log_manager") return { SyncLogManager: { getInstance: () => ({ logReceivedMessage() {}, addLog() {} }) } };
    if (id === "../../i18n/lang") return { $: (k) => k };
    if (id === "./server_merge_client") return { effectiveStrategy: () => "manualMerge", markFullReconcile: () => false };
    return noopModule({ safeStringify: JSON.stringify });
  };
  vm.runInNewContext(code, { require: stub, module, exports: module.exports, console, TextDecoder, setTimeout, clearTimeout, window: { setTimeout, clearTimeout } });
  return module.exports.WebSocketManager;
}
function mkMgr(plugin, handlers) {
  const M = loadManager(handlers);
  const m = Object.create(M.prototype);
  m.plugin = plugin;
  m.client = noopModule();
  m.isStructuredMessageData = (d) => typeof d === "object" && d !== null;
  return m;
}
const basePlugin = (over = {}) => ({ settings: { vault: "v" }, syncState: { activeSyncContext: "UUID-1" }, pendingNoteModifies: new Map(), serverMerge: { supported: true }, currentSyncType: "", ...over });

// e2e-1：同步轮 (activeSyncContext=UUID) 中，服务端广播的冲突副本 NoteSyncModify 信封 context 为空
{
  const got = [];
  const handlers = new Map([["NoteSyncModify", (d) => got.push(d)], ["NoteSyncDelete", (d) => got.push(d)]]);
  const m = mkMgr(basePlugin(), handlers);
  m.handleStructuredMessage("NoteSyncModify", { vault: "v", context: "", data: { path: "n.conflict.md", rev: 120, content: "C" } });
  assert.equal(got.length, 1, "带 rev 的空 context 推送在同步轮里必须落地");
  m.handleStructuredMessage("NoteSyncModify", { vault: "v", context: "OTHER", data: { path: "x.md", rev: 120 } });
  assert.equal(got.length, 1, "context 非空且不匹配仍丢弃");
  m.handleStructuredMessage("NoteSyncModify", { vault: "v", context: "", data: { path: "x.md" } });
  assert.equal(got.length, 1, "无 rev 的空 context 仍丢弃（旧行为）");
  const legacy = mkMgr(basePlugin({ serverMerge: { supported: false } }), handlers);
  legacy.handleStructuredMessage("NoteSyncModify", { vault: "v", context: "", data: { path: "n.md", rev: 120 } });
  assert.equal(got.length, 1, "非 serverMerge 会话保持上游过滤");
}

// e2e-2：已卸载的旧实例收到推送不得处理（更不得写盘）
{
  const got = [];
  const handlers = new Map([["NoteSyncModify", (d) => got.push(d)]]);
  const m = mkMgr(basePlugin({ unloaded: true, syncState: { activeSyncContext: null } }), handlers);
  m.handleStructuredMessage("NoteSyncModify", { vault: "v", data: { path: "n.md", rev: 120, content: "x" } });
  assert.equal(got.length, 0, "unloaded 后不得处理推送");
}

// e2e-2：已卸载的旧实例不得建连 / 重连；casWrite 不写盘
{
  const code = ts.transpileModule(fs.readFileSync("src/lib/sync/websocket_client.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = { exports: {} };
  let created = 0;
  class FakeWS { constructor() { created++; } }
  FakeWS.CLOSED = 3; FakeWS.OPEN = 1; FakeWS.CONNECTING = 0;
  const win = { setTimeout: () => { created += 100; return 1; }, clearTimeout() {} };
  vm.runInNewContext(code, { require: () => noopModule(), module, exports: module.exports, console, WebSocket: FakeWS, window: win });
  const C = module.exports.WebSocketClient;
  const c = Object.create(C.prototype);
  c.plugin = { unloaded: true, app: { vault: { getName: () => "v" } } };
  c.ws = null;
  await c.register();
  c.checkReconnect();
  assert.equal(created, 0, "unloaded 后 register/checkReconnect 不建连、不排重连定时器");
}
{
  const code = ts.transpileModule(fs.readFileSync("src/lib/sync/server_merge_env.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = { exports: {} };
  const req = (id) => id === "obsidian" ? { normalizePath: (p) => p, TFile: class {} }
    : id === "./server_merge_client" ? { ServerMergeClient: class { constructor(e) { this.env = e; } } } : noopModule();
  vm.runInNewContext(code, { require: req, module, exports: module.exports, console, window: {} });
  const sm = module.exports.createServerMerge({ unloaded: true, app: { vault: { getFileByPath: () => { throw new Error("不得碰 vault"); } } } });
  assert.equal(await sm.env.casWrite("a.md", "x", "y"), false, "unloaded 后 casWrite 不写盘");
}
console.log("server-merge-lifecycle: ok");
