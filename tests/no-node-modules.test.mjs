// 移动端（无 Node/Electron）约束；唯一桌面例外必须位于 Platform.isDesktopApp 分支。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..", "src");
const BAD = ["fs", "path", "os", "crypto", "child_process", "stream", "util", "buffer", "zlib", "http", "https", "net", "url", "worker_threads", "electron", "@electron/remote", "vm"];
const ALLOW = new Set(["lib/utils/helpers.ts:node:timers"]);
const helperFile = path.join(root, "lib/utils/helpers.ts");
const helperAst = ts.createSourceFile(helperFile, fs.readFileSync(helperFile, "utf8"), ts.ScriptTarget.Latest, true);
let nativeTimerCalls = 0;
function checkNativeTimerGuard(node) {
  if (ts.isCallExpression(node) && node.expression.getText(helperAst) === "require"
      && node.arguments[0]?.getText(helperAst) === '"node:timers"') {
    nativeTimerCalls++;
    let guarded = false, inSleep = false;
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isIfStatement(parent) && parent.expression.getText(helperAst) === "Platform.isDesktopApp"
          && node.pos >= parent.thenStatement.pos && node.end <= parent.thenStatement.end) guarded = true;
      if (ts.isVariableDeclaration(parent) && parent.name.getText(helperAst) === "sleep") inSleep = true;
    }
    assert.ok(guarded && inSleep, "Node timers must only load inside the desktop sleep branch");
  }
  ts.forEachChild(node, checkNativeTimerGuard);
}
checkNativeTimerGuard(helperAst);
assert.equal(nativeTimerCalls, 1);
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
console.log("no-node-modules.test.mjs: only desktop-guarded sleep may load Node timers");
