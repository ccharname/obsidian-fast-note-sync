import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const sourcePath = path.join(root, "src", "lib", "sync", "websocket_manager.ts");
const source = fs.readFileSync(sourcePath, "utf8");

const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true,
  },
  fileName: sourcePath,
}).outputText;

const module = { exports: {} };
// websocket_manager.ts 现位于 src/lib/sync/；formatAuthorizationError 只依赖 safeStringify，其余依赖用 noop 代理
// websocket_manager.ts now lives in src/lib/sync/; formatAuthorizationError only needs safeStringify, other deps are noop proxies
const noopModule = (overrides = {}) =>
  new Proxy(overrides, { get: (t, k) => (k in t ? t[k] : () => undefined) });
const requireStub = (id) => {
  switch (id) {
    case "obsidian":
      return { moment: Object.assign(() => ({ format: () => "" }), { locale: () => "zh-cn" }), Platform: {}, normalizePath: (p) => p };
    case "../utils/helpers":
      return noopModule({ safeStringify: (v) => (typeof v === "string" ? v : JSON.stringify(v)) });
    case "../../i18n/lang":
      return { $: (key) => key };
    default:
      return noopModule();
  }
};

vm.runInNewContext(transpiled, {
  require: requireStub,
  module,
  exports: module.exports,
  console,
  TextDecoder,
  setTimeout,
  clearTimeout,
}, { filename: sourcePath });

const { formatAuthorizationError } = module.exports;

assert.equal(typeof formatAuthorizationError, "function");

const missingMessage = formatAuthorizationError({ code: 308 });
assert.match(missingMessage, /Code=308/);
assert.match(missingMessage, /Session expired or token has been revoked/);
assert.match(missingMessage, /Please re-import the API configuration/);
assert.doesNotMatch(missingMessage, /undefined/);

const rotated = formatAuthorizationError({ code: 308, details: ["Token has been rotated"] });
assert.match(rotated, /Details=Token has been rotated/);
assert.match(rotated, /Please re-import the API configuration/);

const scopeRestricted = formatAuthorizationError({ code: 315, message: undefined, details: "Permission denied: Handshake" });
assert.match(scopeRestricted, /Authorization token scope is restricted/);
assert.match(scopeRestricted, /Details=Permission denied: Handshake/);
assert.doesNotMatch(scopeRestricted, /Please re-import/);
assert.doesNotMatch(scopeRestricted, /undefined/);
