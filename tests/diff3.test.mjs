import assert from "node:assert/strict";
import { loadTs } from "./lib/load-ts.mjs";

const { diff3Merge, splitLines } = loadTs("src/lib/sync/diff3.ts");
const merge = (l, b, r) => diff3Merge(l, b, r);
const ok = (l, b, r, expected, label) => {
  const res = merge(l, b, r);
  assert.equal(res.ok, true, `${label}: should merge cleanly, got ${JSON.stringify(res)}`);
  assert.equal(res.merged, expected, label);
  return res;
};
const conflict = (l, b, r, label) => assert.equal(merge(l, b, r).ok, false, `${label}: should conflict`);

const BASE = "# T\n\n## a\n- 1\n- 2\n\n## b\n- x\n\n## c\n- todo\n";

// 仅一侧修改 / 两侧一致
ok(BASE, BASE, BASE + "tail\n", BASE + "tail\n", "only remote changed");
ok(BASE + "tail\n", BASE, BASE, BASE + "tail\n", "only local changed");
ok("same", BASE, "same", "same", "both made identical whole-file change");
ok(BASE, BASE, BASE, BASE, "nothing changed");

// 不重叠的两处修改
{
  const local = BASE.replace("- 2\n", "- 2\n- local line\n");
  const remote = BASE.replace("- todo\n", "- todo\n- remote line\n");
  const r = ok(local, BASE, remote, BASE.replace("- 2\n", "- 2\n- local line\n").replace("- todo\n", "- todo\n- remote line\n"), "disjoint inserts");
  assert.equal(r.notes.length, 0);
}
// 一侧开头改一行、一侧末尾追加（设计用例 1）
ok(BASE.replace("# T", "# TT"), BASE, BASE + "- appended\n", BASE.replace("# T", "# TT") + "- appended\n", "edit head + append tail");
// 相同修改只保留一份
{
  const both = BASE.replace("- 1", "- one");
  ok(both, BASE, both + "", both, "identical edit kept once");
  const l = BASE.replace("- 1", "- one").replace("- x", "- LX");
  const r = BASE.replace("- 1", "- one").replace("- todo", "- RT");
  ok(l, BASE, r, BASE.replace("- 1", "- one").replace("- x", "- LX").replace("- todo", "- RT"), "identical edit + different others");
}
// 同点纯插入且内容不同：本地在前远端在后，任何位置，记 notes
{
  const l = BASE.replace("- 1\n", "- 1\n- L\n");
  const r = BASE.replace("- 1\n", "- 1\n- R\n");
  const res = ok(l, BASE, r, BASE.replace("- 1\n", "- 1\n- L\n- R\n"), "same-point inserts middle");
  assert.equal(res.notes.length, 1);
  const res2 = ok(BASE + "- L\n", BASE, BASE + "- R\n", BASE + "- L\n- R\n", "same-point inserts at EOF");
  assert.equal(res2.notes.length, 1);
  ok("- L\n" + BASE, BASE, "- R\n" + BASE, "- L\n- R\n" + BASE, "same-point inserts at BOF");
}
// 同点插入内容完全相同 → 一份
{
  const both = BASE.replace("- 1\n", "- 1\n- same\n");
  const res = ok(both, BASE, both, both, "identical insert");
  assert.equal(res.notes.length, 0);
}
// 重叠修改 → 冲突
conflict(BASE.replace("- todo", "- L"), BASE, BASE.replace("- todo", "- R"), "same line different edits");
conflict(BASE.replace("- 1\n- 2\n", "- X\n"), BASE, BASE.replace("- 2", "- two"), "range replace vs inner edit");
conflict(BASE.replace("- x\n", ""), BASE, BASE.replace("- x", "- xx"), "delete vs modify");
conflict("totally different\ncontent\n", BASE, BASE.replace("- todo", "- R"), "whole-file replace vs edit");
// 相邻不重叠 → 不冲突
ok(BASE.replace("- 1\n", "- one\n"), BASE, BASE.replace("- 2\n", "- two\n"), BASE.replace("- 1\n", "- one\n").replace("- 2\n", "- two\n"), "adjacent edits");
// 删除 vs 删除同一行：相同
ok(BASE.replace("- x\n", ""), BASE, BASE.replace("- x\n", ""), BASE.replace("- x\n", ""), "both delete same");
// 一侧删除、另一侧改别处
ok(BASE.replace("- x\n", ""), BASE, BASE.replace("- todo", "- t2"), BASE.replace("- x\n", "").replace("- todo", "- t2"), "delete + other edit");

// 空文件
ok("", "", "hello\n", "hello\n", "empty local, empty base");
ok("hello\n", "", "", "hello\n", "empty remote, empty base");
ok("L", "", "R", "L\nR", "empty base both insert (no trailing newline)");
ok("L\n", "", "R\n", "L\nR\n", "empty base both insert (trailing newline)");
ok("", "abc\n", "abc\n", "", "local cleared, remote untouched");
conflict("", "abc\n", "abd\n", "cleared vs edited");
// 无末尾换行
ok("a\nb\nc", "a\nb", "a\nb\nd", "a\nb\nc\nd", "no trailing newline appends at EOF");
ok("a\nbx", "a\nb", "a\nb\nd", "a\nbx\nd", "append to last line vs append line");
// CRLF 保持
{
  const b = "a\r\nb\r\nc\r\n";
  const res = ok("a\r\nB\r\nc\r\n", b, b + "d\r\n", "a\r\nB\r\nc\r\nd\r\n", "CRLF preserved");
  assert.ok(!res.merged.includes("\n\n"), "no stray LF");
  assert.equal(res.merged.split("\r\n").length, 5);
  // 混合换行：不归一化
  ok("a\r\nb\nX\n", "a\r\nb\n", "a\r\nb\nY\n".replace("Y", "b2"), "a\r\nb\nX\nb2\n", "mixed endings kept verbatim (both inserted after b)");
}
// emoji / 非 ASCII
ok("😀 一\n二\n", "一\n二\n", "一\n二\n三 😀\n", "😀 一\n二\n三 😀\n", "unicode lines");

// 整篇替换（base 与 local 全不同，remote 未改）→ 取 local
ok("brand new\ndoc\n", BASE, BASE, "brand new\ndoc\n", "whole replace one side only");

// 性能：5000 行、散布修改
{
  const lines = Array.from({ length: 5000 }, (_, i) => `line ${i} ${"x".repeat(i % 7)}`);
  const base = lines.join("\n") + "\n";
  const l = [...lines], r = [...lines];
  for (let i = 0; i < 5000; i += 100) l[i] = `L ${l[i]}`;
  for (let i = 50; i < 5000; i += 100) r[i] = `R ${r[i]}`;
  r.splice(2500, 0, "remote inserted");
  l.push("local appended");
  const t = Date.now();
  const res = diff3Merge(l.join("\n") + "\n", base, r.join("\n") + "\n");
  const ms = Date.now() - t;
  assert.equal(res.ok, true);
  assert.ok(res.merged.includes("remote inserted") && res.merged.includes("local appended"));
  assert.equal(res.merged.split("\n").filter((x) => x.startsWith("L ")).length, 50);
  assert.equal(res.merged.split("\n").filter((x) => x.startsWith("R ")).length, 50);
  assert.ok(ms < 3000, `5000-line merge took ${ms}ms`);
  console.log(`  5000-line scattered merge: ${ms}ms`);
}
// 性能：两侧都整篇重写 5000 行（差异超限退化为整块）→ 冲突而不是卡死/丢数据
{
  const base = Array.from({ length: 5000 }, (_, i) => `b${i}`).join("\n");
  const l = Array.from({ length: 5000 }, (_, i) => `l${i}`).join("\n");
  const r = Array.from({ length: 5000 }, (_, i) => `r${i}`).join("\n");
  const t = Date.now();
  const res = diff3Merge(l, base, r);
  const ms = Date.now() - t;
  assert.equal(res.ok, false);
  assert.ok(ms < 5000, `full rewrite took ${ms}ms`);
  console.log(`  5000-line full rewrite vs rewrite -> conflict: ${ms}ms`);
}

// 随机对拍：合并结果必须保留双方的非冲突改动；hunk 抽取自洽（应用 hunks 复现任一侧）
{
  let seed = 12345;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  let merged = 0, conflicts = 0;
  for (let iter = 0; iter < 400; iter++) {
    const n = 5 + rnd(25);
    const base = Array.from({ length: n }, (_, i) => `b${i}`);
    const edit = (arr, tag) => {
      const out = [...arr];
      const k = 1 + rnd(3);
      for (let j = 0; j < k; j++) {
        const pos = rnd(out.length + 1), kind = rnd(3);
        if (kind === 0) out.splice(pos, 0, `${tag}${iter}-${j}`);
        else if (kind === 1 && out.length > 1) out.splice(Math.min(pos, out.length - 1), 1);
        else out[Math.min(pos, out.length - 1)] = `${tag}${iter}-${j}m`;
      }
      return out;
    };
    const l = edit(base, "L"), r = edit(base, "R");
    const res = diff3Merge(l.join("\n") + "\n", base.join("\n") + "\n", r.join("\n") + "\n");
    if (res.ok) {
      merged++;
      const lines = splitLines(res.merged);
      // 每个本地/远端新增行（不在 base 中）都应出现在结果里
      for (const x of [...l, ...r]) if (!base.includes(x)) assert.ok(lines.includes(x), `iter ${iter}: lost ${x}`);
      // base 中两侧都没删的行仍在
      for (const x of base) if (l.includes(x) && r.includes(x)) assert.ok(lines.includes(x), `iter ${iter}: dropped untouched ${x}`);
    } else conflicts++;
    // 单侧：与 base 比只有一侧不同时必须等于该侧
    assert.equal(diff3Merge(l.join("\n"), base.join("\n"), base.join("\n")).merged, l.join("\n"));
  }
  console.log(`  fuzz: ${merged} merged, ${conflicts} conflicts`);
  assert.ok(merged > 50);
}
// 同点插入：一侧插入块已完整包含另一侧 → 只保留一份（对端已合并过我这份时不得重复追加）
ok("a\nX\n", "a\n", "a\nY\nX\n", "a\nY\nX\n", "same-point insert: remote block contains local");
ok("a\nY\nX\n", "a\n", "a\nX\n", "a\nY\nX\n", "same-point insert: local block contains remote");
ok("a\nX\n", "a\n", "a\nY\n", "a\nX\nY\n", "same-point insert: unrelated keeps both, local first");
console.log("diff3.test.mjs: all scenarios passed");
