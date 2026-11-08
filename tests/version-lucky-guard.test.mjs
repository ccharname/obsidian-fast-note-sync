import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// luckyBuild 自维护构建：不提示上游新版本，也不允许一键升级覆盖插件文件
// Self-maintained -lucky builds never offer or perform the upstream one-click plugin upgrade.

const root = path.resolve(import.meta.dirname, "..");
const sourcePath = path.join(root, "src", "lib", "utils", "version_manager.ts");
const code = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: sourcePath,
}).outputText;

let networkCalls = 0;
let writes = 0;
// 与 helpers.isVersionNew 同语义（忽略 - 后缀的数字比较）/ same semantics as helpers.isVersionNew
const isVersionNew = (cur, latest) => {
  if (!cur || !latest) return false;
  const a = cur.split("-")[0].split(".").map(Number), b = latest.split("-")[0].split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((b[i] || 0) > (a[i] || 0)) return true;
    if ((b[i] || 0) < (a[i] || 0)) return false;
  }
  return false;
};
const module = { exports: {} };
vm.runInNewContext(code, {
  module, exports: module.exports, console,
  require: (id) => {
    if (id === "obsidian") return { requestUrl: async () => { networkCalls++; throw new Error("network must not be used"); }, normalizePath: (p) => p };
    if (id === "fflate") return { unzipSync: () => ({}) };
    if (id.includes("helpers")) return { dump: () => {}, getPluginDir: () => ".obsidian/plugins/fast-note-sync", isVersionNew, showSyncNotice: () => {} };
    if (id.includes("i18n")) return { $: (k) => k };
    return {};
  },
});
const { VersionManager } = module.exports;

const mk = (version, latest, lucky = false) => {
  const meta = { pluginVersionNewName: latest };
  return new VersionManager({
    manifest: { id: "fast-note-sync", version, ...(lucky ? { luckyBuild: true } : {}) },
    settings: { updateSource: "github" },
    localStorageManager: { getMetadata: (k) => meta[k], setMetadata: (k, v) => { meta[k] = v; } },
    app: { vault: { adapter: { writeBinary: async () => { writes++; } } } },
  });
};

// 自维护构建：上游更新的版本号也不提示
const lucky = mk("2.99.1", "3.0.0", true);
assert.equal(lucky.isLuckyBuild(), true);
assert.equal(lucky.isPluginNew(), false, "no upgrade badge for luckyBuild");
assert.equal(lucky.hasNewVersion(), false);
await assert.rejects(() => lucky.upgradePlugin(() => {}), /luckyBuild/);
assert.equal(networkCalls, 0, "upgrade refused before any download");
assert.equal(writes, 0);

// 对照：官方版本行为不变
const official = mk("2.4.0", "2.5.0");
assert.equal(official.isLuckyBuild(), false);
assert.equal(official.isPluginNew(), true, "official builds still see new versions");

console.log("version-lucky-guard.test.mjs: all scenarios passed");
