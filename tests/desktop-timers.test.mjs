import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const helperSource = fs.readFileSync(path.join(root, "src/lib/utils/helpers.ts"), "utf8");
const parsed = ts.createSourceFile("helpers.ts", helperSource, ts.ScriptTarget.Latest, true);
const names = new Set(["sleep", "hashContentAsync", "computeRollingHash"]);
const fragment = parsed.statements.filter(node => {
  if (ts.isFunctionDeclaration(node)) return names.has(node.name?.text);
  return ts.isVariableStatement(node) && node.declarationList.declarations.some(d => names.has(d.name.getText(parsed)));
}).map(node => node.getText(parsed)).join("\n");

function fixture(desktop) {
  const native = [], window = [], module = { exports: {} };
  const enqueue = (list, callback, delay) => { list.push(delay); queueMicrotask(callback); return list.length; };
  const code = ts.transpileModule(fragment + "\nmodule.exports.rolling = computeRollingHash;", {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports, Uint8Array,
    Platform: { isDesktopApp: desktop },
    require(id) {
      assert.equal(desktop, true, "mobile must never load a Node builtin");
      assert.equal(id, "node:timers");
      return { setTimeout: (callback, delay) => enqueue(native, callback, delay) };
    },
    window: { setTimeout: (callback, delay) => enqueue(window, callback, delay) },
  });
  return { ...module.exports, native, window };
}

test("desktop sleep preserves 0/2/10ms pacing through native timers", async () => {
  const f = fixture(true);
  for (const delay of [0, 2, 10]) await f.sleep(delay);
  assert.deepEqual(f.native, [0, 2, 10]);
  assert.deepEqual(f.window, []);
});

test("mobile sleep keeps window timers and never requires Node", async () => {
  const f = fixture(false);
  for (const delay of [0, 2, 10]) await f.sleep(delay);
  assert.deepEqual(f.window, [0, 2, 10]);
  assert.deepEqual(f.native, []);
});

test("desktop string hash bypasses window timer chains without changing its value", async () => {
  const f = fixture(true);
  const value = "abcdef".repeat(100000);
  let expected = 0;
  for (let i = 0; i < value.length; i++) expected = ((expected << 5) - expected + value.charCodeAt(i)) | 0;
  assert.equal(await f.hashContentAsync(value), String(expected));
  assert.deepEqual(f.native, [0, 0]);
  assert.deepEqual(f.window, []);
});

test("desktop binary hash bypasses window timer chains without changing its value", async () => {
  const f = fixture(true);
  const value = new Uint8Array(1024 * 1024 + 1).fill(37);
  let expected = 0;
  for (const byte of value) expected = ((expected << 5) - expected + byte) | 0;
  assert.equal(await f.rolling(value), String(expected));
  assert.deepEqual(f.native, [0, 0]);
  assert.deepEqual(f.window, []);
});

test("mobile hashing preserves window scheduling and identical hash values", async () => {
  const f = fixture(false);
  const value = new Uint8Array(512 * 1024 + 1).fill(0);
  assert.equal(await f.rolling(value), "0");
  assert.deepEqual(f.window, [0]);
  assert.deepEqual(f.native, []);
});

test("WebSocket drain uses shared sleep with its original 50ms pacing", async () => {
  const file = fs.readFileSync(path.join(root, "src/lib/sync/websocket_client.ts"), "utf8");
  const ast = ts.createSourceFile("client.ts", file, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "WebSocketClient");
  const method = declaration.members.find(node => node.name?.getText(ast) === "waitForBufferDrain").getText(ast);
  const code = ts.transpileModule("class Drain { " + method + " }\nmodule.exports = Drain;", {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const calls = [], windowCalls = [], module = { exports: {} };
  let client;
  vm.runInNewContext(code, {
    module, exports: module.exports, WebSocket: { OPEN: 1 },
    sleep: async delay => { calls.push(delay); client.ws.bufferedAmount = 0; },
    window: { setTimeout: callback => { windowCalls.push(true); client.ws.bufferedAmount = 0; queueMicrotask(callback); } },
  });
  client = new module.exports();
  client.ws = { readyState: 1, bufferedAmount: 6 * 1024 * 1024 };
  await client.waitForBufferDrain();
  assert.deepEqual(calls, [50]);
  assert.deepEqual(windowCalls, []);
  client.ws.bufferedAmount = 0;
  await client.waitForBufferDrain();
  assert.deepEqual(calls, [50]);
});
