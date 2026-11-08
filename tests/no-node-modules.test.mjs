// 移动端（无 Node/Electron）约束：src/ 下运行时代码不得引用 Node 内建模块或 electron
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "src");
const BAD = ["fs", "path", "os", "crypto", "child_process", "stream", "util", "buffer", "zlib", "http", "https", "net", "url", "worker_threads", "electron", "@electron/remote", "vm"];
// 上游旧代码中允许的引用清单（当前为空：src/ 无任何 Node/electron 引用）
const ALLOW = new Set([]);
const hits = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name)) {
      const text = fs.readFileSync(p, "utf8");
      const re = /(?:from\s+|require\(\s*|import\(\s*|import\s+)['"]([^'"]+)['"]/g;
      let m;
      while ((m = re.exec(text))) {
        const id = m[1].replace(/^node:/, "");
        if (BAD.includes(id.split("/")[0] === "@electron" ? "@electron/remote" : id) || m[1].startsWith("node:")) {
          const key = `${path.relative(root, p)}:${m[1]}`;
          if (!ALLOW.has(key)) hits.push(key);
        }
      }
    }
  }
})(root);
assert.deepEqual(hits, [], `Node/electron imports found in src: ${hits.join(", ")}`);
console.log("no-node-modules.test.mjs: no Node/electron imports in src/");
