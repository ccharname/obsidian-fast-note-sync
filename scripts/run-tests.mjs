// 逐个运行 tests/*.test.mjs，任一失败则非零退出
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(import.meta.dirname, "..", "tests");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).sort();
const failed = [];
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: "inherit" });
  console.log(`${r.status === 0 ? "PASS" : "FAIL"} ${f}`);
  if (r.status !== 0) failed.push(f);
}
console.log(`\n${files.length - failed.length}/${files.length} passed`);
process.exit(failed.length ? 1 : 0);
