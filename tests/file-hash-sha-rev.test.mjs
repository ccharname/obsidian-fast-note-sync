import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// 冒烟测试：移动端 localStorage 被清除后，FileHashManager 应从文件镜像恢复而非全量重建
// Smoke test: after mobile localStorage eviction, FileHashManager restores from the file mirror
// instead of rebuilding (and re-notifying) from scratch.

const root = path.resolve(import.meta.dirname, "..");

function transpile(relPath) {
  const sourcePath = path.join(root, relPath);
  const source = fs.readFileSync(sourcePath, "utf8");
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: sourcePath,
  }).outputText;
}

function loadModule(relPath, requireStub, extraGlobals = {}) {
  const module = { exports: {} };
  vm.runInNewContext(transpile(relPath), {
    require: requireStub,
    module,
    exports: module.exports,
    console,
    window: { setTimeout, clearTimeout },
    setTimeout,
    clearTimeout,
    ...extraGlobals,
  });
  return module.exports;
}

// --- 载入 helpers.ts（提供 LocalStateFileMirror / debounce 等） ---
const helpersRequireStub = (id) => {
  switch (id) {
    case "obsidian":
      return {
        Notice: class { setMessage() {} hide() {} },
        normalizePath: (p) => p,
        TFolder: class {},
        Platform: { isMobile: false },
        App: class {},
      };
    case "../../i18n/lang":
      return { $: (key) => key };
    case "../../main":
      return {};
    case "../sync/sync_log_manager":
      return { SyncLogManager: { getInstance: () => ({ addOrUpdateLog: () => undefined }) } };
    case "../helpers_obsidian_bypass":
      return {
        nativeFetch: () => undefined,
        vaultDelete: () => undefined,
        dump: () => undefined,
        dumpError: () => undefined,
        setLogEnabled: () => undefined,
        logLevel: () => undefined,
      };
    default:
      throw new Error(`Unexpected require in helpers: ${id}`);
  }
};
const helpers = loadModule("src/lib/utils/helpers.ts", helpersRequireStub, {
  activeDocument: undefined,
  crypto: { getRandomValues: (a) => a },
});

// --- 载入 file_hash_manager.ts ---
const fhmRequireStub = (id) => {
  switch (id) {
    case "../utils/helpers":
      return helpers;
    case "../../main":
      return {};
    default:
      throw new Error(`Unexpected require in file_hash_manager: ${id}`);
  }
};
const { FileHashManager } = loadModule("src/lib/storage/file_hash_manager.ts", fhmRequireStub, { btoa, atob });

// --- 假 plugin：localStorage 用 Map，vault.adapter 用 Map（内存文件系统） ---
function makeFakePlugin(localStorageMap, fileMap, { onGetFiles } = {}) {
  return {
    manifest: { id: "fast-note-sync", dir: ".obsidian/plugins/fast-note-sync" },
    settings: {},
    app: {
      loadLocalStorage: (key) => (localStorageMap.has(key) ? localStorageMap.get(key) : null),
      saveLocalStorage: (key, value) => {
        if (value === null || value === undefined) localStorageMap.delete(key);
        else localStorageMap.set(key, String(value));
      },
      vault: {
        configDir: ".obsidian",
        getName: () => "TestVault",
        getFiles: () => {
          if (onGetFiles) onGetFiles();
          return [];
        },
        adapter: {
          exists: async (p) => fileMap.has(p),
          read: async (p) => {
            if (!fileMap.has(p)) throw new Error("ENOENT: " + p);
            return fileMap.get(p);
          },
          write: async (p, data) => {
            fileMap.set(p, data);
          },
        },
      },
    },
  };
}


import crypto from "node:crypto";
const SHA_A = crypto.createHash("sha256").update("a").digest("hex");

// serverMerge：sha/rev 随 syncHashMap 同键持久化（紧凑数组 + base64 sha）；旧格式可读；hash 变而无新 sha 时旧 sha 失效
const ls = new Map();
const plugin = makeFakePlugin(ls, new Map());
const m1 = new FileHashManager(plugin);
await m1.initialize();
m1.setFileHash("a.md", "h1", 1, 1, 77, SHA_A);
m1.setFileHash("b.md", "h2", 1, 1);
m1.flush();
const stored = JSON.parse(ls.get("fns-syncHashMap"));
assert.equal(stored["b.md"], "h2", "无 sha/rev 的条目仍是纯字符串");
assert.ok(Array.isArray(stored["a.md"]) && stored["a.md"][1].length === 43 && stored["a.md"][2] === 77, "紧凑数组 + 43 字符 base64 sha");
const m2 = new FileHashManager(makeFakePlugin(ls, new Map()));
await m2.initialize();
assert.equal(m2.getPathHash("a.md"), "h1");
assert.equal(m2.getPathSha("a.md"), SHA_A, "base64 往返还原为 hex");
assert.equal(m2.getPathRev("a.md"), 77);
assert.equal(m2.getPathSha("b.md"), null);
m2.setFileHash("a.md", "h1b", 1, 1);            // 上游路径只更新 hash
assert.equal(m2.getPathSha("a.md"), null, "hash 变了旧 sha 失效");
assert.equal(m2.getPathRev("a.md"), 77, "rev 保留");
// 旧版（首个 2.99.4 提交）对象格式仍可读
ls.set("fns-syncHashMap", JSON.stringify({ "o.md": { hash: "x", sha: SHA_A, rev: 5 } }));
const m3 = new FileHashManager(makeFakePlugin(ls, new Map()));
await m3.initialize();
assert.equal(m3.getPathSha("o.md"), SHA_A);
assert.equal(m3.getPathRev("o.md"), 5);

// 红测 #1：setSyncBase 只动 base，不碰本地内容缓存（hashMap 的 mtime/size 绑定）
const m4 = new FileHashManager(makeFakePlugin(new Map(), new Map()));
await m4.initialize();
m4.setFileHash("c.md", "hOld", 100, 10);          // 缓存绑定：mtime 100/size 10 的正文 hash 是 hOld
m4.setSyncBase("c.md", "hNewBase", 9, SHA_A);
assert.equal(m4.getValidHash("c.md", 100, 10), "hOld", "未确认本地==base 时缓存绑定保持不变");
assert.equal(m4.getPathHash("c.md"), "hNewBase");

// 红测 #4：墓碑——删除留 rev，新建清除，条数封顶并随 base 持久化
const lt = new Map();
const m5 = new FileHashManager(makeFakePlugin(lt, new Map()));
await m5.initialize();
m5.setFileHash("d.md", "h", 1, 1, 50);
m5.removeFileHash("d.md", 900);
assert.equal(m5.getPathHash("d.md"), null);
assert.equal(m5.getPathRev("d.md"), 900, "删除后 rev 由墓碑保留");
m5.flush();
const m6 = new FileHashManager(makeFakePlugin(lt, new Map()));
await m6.initialize();
assert.equal(m6.getPathRev("d.md"), 900, "墓碑持久化");
m6.setFileHash("d.md", "h2", 1, 1, 1000);
assert.equal(m6.getPathRev("d.md"), 1000);
m6.flush();
assert.equal((([j]) => Array.isArray(j) ? j : j.t)([JSON.parse(lt.get("fns-syncTombstones"))]).some(([p]) => p === "d.md"), false, "新建成功清除墓碑");
for (let i = 0; i < 2600; i++) m6.removeFileHash(`t${i}.md`, 2000 + i);
assert.equal(m6.getPathRev("t0.md"), 0, "已淘汰路径不伪造精确 rev");
assert.equal(m6.getPathRev("t2599.md"), 4599, "最新的保留");
assert.equal(m6.getPathRev("never-seen.md"), 0, "完全陌生路径的精确 rev 未知");
assert.equal(m6.getReplayFloor(), 2599, "全局水位独立用于拒绝迟到广播");
m6.setFileHash("live.md", "hl", 1, 1, 100);
assert.equal(m6.getPathRev("live.md"), 100, "已有 rev 记录的活路径不受水位影响");
m6.flush();
const persisted = JSON.parse(lt.get("fns-syncTombstones"));
assert.ok(persisted.t.length <= 2000 && persisted.f === 2599, "墓碑与水位一起落盘");
const m7 = new FileHashManager(makeFakePlugin(lt, new Map()));
await m7.initialize();
assert.equal(m7.getReplayFloor(), 2599, "水位随墓碑持久化");
// 完整对账完成后回收旧墓碑，并保留广播下界。
m7.collectTombstones(3000);
assert.equal(m7.getPathRev("t100.md"), 0, "屏障已覆盖 → 墓碑回收");
assert.equal(m7.getPathRev("t2599.md"), 4599, "屏障之后的墓碑保留");
assert.equal(m7.getPathRev("never-seen.md"), 0, "广播屏障仍不冒充路径 rev");
assert.equal(m7.getReplayFloor(), 3000, "全量水位保护后续到达的旧广播");
m7.removeFileHash("plain.md");                   // 不带 rev：无墓碑，行为同上游
assert.equal(m7.getPathRev("plain.md"), 0);
console.log("file-hash-manager: serverMerge sha/rev/tombstone persistence ok");
