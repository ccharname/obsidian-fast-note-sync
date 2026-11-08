// 把 src 下互相只依赖相对路径的纯 TS 模块转译成 CommonJS 并在 vm 里加载（无 obsidian 依赖的模块用）
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..", "..");
const cache = new Map();

export function loadTs(rel) {
  const file = path.join(root, rel);
  if (cache.has(file)) return cache.get(file);
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: file,
  }).outputText;
  const module = { exports: {} };
  cache.set(file, module.exports);
  vm.runInNewContext(code, {
    module, exports: module.exports, console, setTimeout, clearTimeout, TextEncoder,
    require: (id) => {
      if (!id.startsWith(".")) throw new Error(`unexpected import ${id}`);
      const target = path.relative(root, path.resolve(path.dirname(file), id)) + ".ts";
      return loadTs(target);
    },
  });
  cache.set(file, module.exports);
  return module.exports;
}

// Java 式 32 位 hash，与 helpers.hashContent / 服务端 EncodeHash32 一致
export const hashContent = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h &= h;
  }
  return String(h);
};
