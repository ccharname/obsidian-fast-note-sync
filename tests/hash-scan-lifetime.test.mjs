import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = fs.readFileSync(process.env.FNS_TEST_OPERATOR_SOURCE || path.resolve(import.meta.dirname, "../src/lib/sync/operator.ts"), "utf8");
const parsed = ts.createSourceFile("operator.ts", source, ts.ScriptTarget.Latest, true);
const needed = new Set(["scanHashPools", "getScanHashPool", "settleHashWithTimeout"]);
const declarations = parsed.statements.filter(node => {
  if (ts.isFunctionDeclaration(node)) return needed.has(node.name?.text);
  return ts.isVariableStatement(node) && node.declarationList.declarations.some(d => needed.has(d.name.getText(parsed)));
}).map(node => node.getText(parsed)).join("\n");
const begin = source.indexOf("const MAX_CONCURRENT_HASH = 6;");
const end = source.indexOf("for (const file of list)", begin);
assert(begin >= 0 && end > begin);
const scheduler = source.slice(begin, end);
const bodies = {};
function findTasks(node) {
  if (ts.isCallExpression(node) && node.expression.getText(parsed) === "scheduleHashTask" && node.arguments[0]) {
    const text = node.arguments[0].getText(parsed);
    if (text.includes("scannedNoteHashes.set")) bodies.note = text;
    if (text.includes("scannedFileHashes.set")) bodies.file = text;
  }
  ts.forEachChild(node, findTasks);
}
findTasks(parsed);
// The baseline branch uses the original deadline race so behavioral red tests run before adding the helper.
const raceStart = source.indexOf("const contentHash = await Promise.race([\n                      hashFileAsync(plugin.app, attPath),");
const baseline = raceStart >= 0 ? source.slice(raceStart, source.indexOf("]);", raceStart) + 3) : "";
const fallback = baseline ? "async function settleHashWithTimeout(work) { const plugin = { app: null }, attPath = ''; const hashFileAsync = () => work; " + baseline + " return contentHash; }" : "";
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }
function fixture() {
  const timers = new Map(); let id = 0;
  const module = { exports: {} };
  const code = declarations + "\n" + fallback + "\nfunction round(plugin, context) { " + scheduler + " return { scheduleHashTask, hashInFlight }; }\nmodule.exports = { round, settleHashWithTimeout };";
  const context = vm.createContext({
    module, exports: module.exports, isPluginUnloading: false,
    window: { setTimeout: (callback, ms) => { assert.equal(ms, 15000); timers.set(++id, callback); return id; }, clearTimeout: key => timers.delete(key) },
  });
  const compile = text => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  vm.runInContext(compile(code), context);
  return { ...module.exports, timers,
    task(kind, plugin, work) {
      Object.assign(context, { plugin, context: "old", file: {}, attPath: "test", attMtime: 1, attCtime: 1, attSize: 1,
        notePath: "test", noteMtime: 1, noteCtime: 1, noteSize: 1, files: [], notes: [],
        hashFileAsync: () => work, hashContentAsync: () => work, hashContent: () => "pathhash" });
      vm.runInContext(compile("module.exports.workTask = " + bodies[kind] + ";"), context);
      return module.exports.workTask;
    },
    fire() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); } };
}

test("a hash deadline keeps ownership until the original hash settles", async () => {
  const f = fixture(), work = deferred(); let settled = false;
  const result = f.settleHashWithTimeout(work.promise).catch(error => error.message).finally(() => { settled = true; });
  f.fire(); await flush();
  assert.equal(settled, false);
  work.resolve("late-result");
  assert.equal(await result, "Hash timeout");
});

test("hash success and rejection both clear the unused deadline", async () => {
  const f = fixture();
  assert.equal(await f.settleHashWithTimeout(Promise.resolve("hash")), "hash");
  assert.equal(f.timers.size, 0);
  assert.equal(await f.settleHashWithTimeout(Promise.reject(Error("read failed"))).catch(e => e.message), "read failed");
  assert.equal(f.timers.size, 0);
});

test("timed out hashes keep the actual six-slot scan pool occupied", async () => {
  const f = fixture(), plugin = { app: {}, syncState: { activeSyncContext: "one" } }, round = f.round(plugin, "one");
  const reads = [], jobs = [];
  const scan = (async () => { for (let i = 0; i < 7; i++) await round.scheduleHashTask(async () => { const job = deferred(); reads.push(i); jobs.push(job); await f.settleHashWithTimeout(job.promise).catch(() => {}); }); })();
  await flush(); assert.equal(reads.length, 6);
  f.fire(); await flush();
  assert.equal(reads.length, 6);
  assert.equal(round.hashInFlight.size, 6);
  jobs[0].resolve("first"); await flush(); assert.equal(reads.length, 7);
  jobs.forEach(job => job.resolve("done")); await scan; await flush();
  assert.equal(round.hashInFlight.size, 0);
});

test("disconnect/cancel and a new round share six real slots for the same app", async () => {
  const f = fixture(), app = {}, plugin = { app, syncState: { activeSyncContext: "old" } };
  const old = f.round(plugin, "old"), jobs = [];
  let started = 0;
  const launch = async round => { for (let i = 0; i < 6; i++) await round.scheduleHashTask(async () => { started++; const job = deferred(); jobs.push(job); await job.promise; }); };
  const oldScan = launch(old); await flush(); assert.equal(started, 6);
  plugin.syncState.activeSyncContext = "new";
  const current = f.round(plugin, "new"), newScan = launch(current);
  await flush(); assert.equal(started, 6);
  assert.notEqual(old.hashInFlight, current.hashInFlight, "round drain must retain its own set");
  jobs.slice().forEach(job => job.resolve()); await flush(); assert.equal(started, 12);
  jobs.forEach(job => job.resolve()); await Promise.all([oldScan, newScan]); await flush();
  assert.equal(old.hashInFlight.size + current.hashInFlight.size, 0);
});

test("separate apps retain independent six-slot pools", async () => {
  const f = fixture(), jobs = []; let started = 0;
  const launch = async () => { const plugin = { app: {}, syncState: { activeSyncContext: "ctx" } }, r = f.round(plugin, "ctx"); for (let i = 0; i < 6; i++) await r.scheduleHashTask(async () => { started++; const job = deferred(); jobs.push(job); await job.promise; }); };
  const scans = [launch(), launch()]; await flush(); assert.equal(started, 12);
  jobs.forEach(job => job.resolve()); await Promise.all(scans);
});

test("a cancelled queued round does not start another hash after capacity becomes free", async () => {
  const f = fixture(), plugin = { app: {}, syncState: { activeSyncContext: "old" } }, r = f.round(plugin, "old");
  const jobs = []; let started = 0;
  const scan = (async () => { for (let i = 0; i < 7; i++) await r.scheduleHashTask(async () => { started++; const job = deferred(); jobs.push(job); await job.promise; }); })();
  await flush(); assert.equal(started, 6);
  plugin.syncState.activeSyncContext = null;
  jobs.forEach(job => job.resolve()); await scan;
  assert.equal(started, 6);
});

for (const kind of ["note", "file"]) test("a late " + kind + " hash cannot populate the replacement round cache", async () => {
  const f = fixture(), job = deferred();
  const plugin = { syncState: { activeSyncContext: "old" }, scannedNoteHashes: new Map(), scannedFileHashes: new Map(),
    app: { vault: { read: () => job.promise } }, fileHashManager: { getPathHash: () => null } };
  const task = f.task(kind, plugin, job.promise);
  const work = task(); await flush();
  plugin.syncState.activeSyncContext = "new";
  job.resolve("hash"); await work;
  assert.equal(plugin.scannedNoteHashes.size + plugin.scannedFileHashes.size, 0);
  assert.equal(f.timers.size, 0);
});
