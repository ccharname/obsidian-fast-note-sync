import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// #293 事件重试链去重：未认证重试按 `事件类型:path` 只保留一条，总时长 10 分钟；
// 抢锁失败的重新入队被同 key 的新事件取代后不再堆链。
// Event retry chains: auth retries are deduped per `eventName:path` (10 min cap);
// lock requeues are superseded by newer events instead of piling up.

const root = path.resolve(import.meta.dirname, "..");
const sourcePath = path.join(root, "src", "lib", "utils", "events_manager.ts");
const code = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: sourcePath,
}).outputText;

// --- 假时钟 / fake clock ---
let now = 1_000_000;
let nextId = 1;
const timers = new Map(); // id -> { at, fn }
const fakeWindow = {
  setTimeout: (fn, ms = 0) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
  clearTimeout: (id) => { timers.delete(id); },
  addEventListener: () => {}, removeEventListener: () => {},
};
class FakeDate extends Date { static now() { return now; } }
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
async function advance(ms) {
  await flush(); // 先让挂起的 promise 回调登记定时器 / let pending promise callbacks register timers first
  const end = now + ms;
  for (;;) {
    let nextT = null;
    for (const [id, t] of timers) if (t.at <= end && (!nextT || t.at < nextT.t.at)) nextT = { id, t };
    if (!nextT) break;
    timers.delete(nextT.id);
    now = Math.max(now, nextT.t.at);
    nextT.t.fn();
    await flush();
  }
  now = end;
  await flush();
}

class TAbstractFile { constructor(p) { this.path = p; } }
class TFile extends TAbstractFile {}
class TFolder extends TAbstractFile {}
const noopProxy = () => new Proxy({}, { get: () => () => undefined });
const module = { exports: {} };
vm.runInNewContext(code, {
  module, exports: module.exports, console, window: fakeWindow, Date: FakeDate,
  require: (id) => id === "obsidian"
    ? { TAbstractFile, TFile, TFolder, Platform: {}, Menu: class {}, MenuItem: class {}, normalizePath: (p) => p }
    : id.includes("i18n") ? { $: (k) => k }
    : noopProxy(),
});
const { EventManager } = module.exports;

const mkPlugin = (over = {}) => ({
  websocket: { isAuth: false },
  settings: { syncUpdateDelay: 0 },
  lockManager: { withLock: async () => null },
  ...over,
});

// === 1. 未认证：同 path 同事件 50 次 -> 只有 1 条待重试定时器 ===
{
  timers.clear();
  const plugin = mkPlugin();
  const em = new EventManager(plugin);
  for (let i = 0; i < 50; i++) em.watchModify(new TFile("a.md"));
  assert.equal(em.authRetries.size, 1, "same path+event keeps one retry entry");
  assert.equal(timers.size, 1, "same path+event keeps one live timer");

  // 不同事件类型 / 不同 path 各自独立
  em.watchDelete(new TFile("a.md"));
  em.watchModify(new TFile("b.md"));
  assert.equal(em.authRetries.size, 3);
  assert.equal(timers.size, 3);

  // 跑 5 分钟仍未认证：每个 key 仍只有 1 条定时器（不堆链）
  await advance(5 * 60 * 1000);
  assert.equal(timers.size, 3, "no timer chain growth while waiting");

  // 总时长上限 10 分钟：放弃并清空
  await advance(5 * 60 * 1000 + 2000);
  assert.equal(em.authRetries.size, 0, "dropped after 10 minutes");
  assert.equal(timers.size, 0);
  em.stop();
}

// === 2. 最新参数覆盖旧参数；起算时间沿用第一次入队 ===
{
  timers.clear();
  const plugin = mkPlugin();
  const em = new EventManager(plugin);
  const calls = [];
  em.retryWhenAuthed("modify", new TFile("n.md"), (f) => calls.push(["old", f.path]));
  await advance(5 * 60 * 1000);
  const latest = new TFile("n.md");
  em.retryWhenAuthed("modify", latest, (f) => calls.push(["latest", f === latest]));
  assert.equal(timers.size, 1);
  // 距第一次入队 > 10 分钟：即使中途有新事件也不无限续命
  await advance(5 * 60 * 1000 + 2000);
  assert.equal(em.authRetries.size, 0, "re-fired events do not extend the 10 minute budget");
  assert.deepEqual(calls, []);

  // 认证恢复后只执行最新一条，且只执行一次
  const latestR = new TFile("r.md");
  em.retryWhenAuthed("rename", new TFile("r.md"), (f) => calls.push(["old", f.path]));
  em.retryWhenAuthed("rename", latestR, (f) => calls.push(["latest", f === latestR]));
  plugin.websocket.isAuth = true;
  await advance(3000);
  assert.deepEqual(calls, [["latest", true]], "only the newest pending retry runs, once");
  assert.equal(timers.size, 0);
  em.stop();
}

// === 3. stop() 清掉所有重试链 ===
{
  timers.clear();
  const em = new EventManager(mkPlugin());
  em.watchModify(new TFile("s.md"));
  em.watchDelete(new TFile("s.md"));
  em.stop();
  assert.equal(timers.size, 0);
  assert.equal(em.authRetries.size, 0);
}

// === 4. 抢锁失败重新入队：同 key 新事件取代旧链 ===
{
  timers.clear();
  let lockCalls = 0;
  const plugin = mkPlugin({ lockManager: { withLock: async () => { lockCalls++; return null; } } });
  const em = new EventManager(plugin);
  const ran = [];
  em.runWithDelay("k", () => ran.push("A"), 0);
  em.runWithDelay("k", () => ran.push("B"), 0);
  await advance(90_000);
  // A 的链被 B 取代；B 链 = 1 次初始 + 60 次重新入队；A 只有它自己的 1 次初始尝试
  assert.equal(lockCalls, 1 + 61, "superseded chain must not requeue");
  assert.equal(timers.size, 0, "chain ends after 60 requeues");
  assert.equal(em.eventGen.size, 0);
  em.stop();
}

// === 5. 抢锁成功不重入队、清理代数 ===
{
  timers.clear();
  let lockCalls = 0;
  const ran = [];
  const plugin = mkPlugin({ lockManager: { withLock: async (_k, fn) => { lockCalls++; return fn(); } } });
  const em = new EventManager(plugin);
  em.runWithDelay("ok", () => ran.push("A"), 0);
  await advance(5000);
  assert.equal(lockCalls, 1);
  assert.deepEqual(ran, ["A"]);
  assert.equal(timers.size, 0);
  assert.equal(em.eventGen.size, 0);
  em.stop();
}

// === 6. registerEvents 未就绪重试只留一条链，stop() 可清除 ===
{
  timers.clear();
  const plugin = mkPlugin({ fileHashManager: { isReady: () => false } });
  const em = new EventManager(plugin);
  em.registerEvents();
  em.registerEvents();
  assert.equal(timers.size, 1, "repeated registerEvents keeps one retry chain");
  em.stop();
  assert.equal(timers.size, 0);
}

console.log("events-retry-dedupe.test.mjs: all scenarios passed");
