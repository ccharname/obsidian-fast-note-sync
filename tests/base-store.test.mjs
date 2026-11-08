import assert from "node:assert/strict";
import { loadTs, hashContent } from "./lib/load-ts.mjs";

const { BaseStore } = loadTs("src/lib/storage/base_store.ts");
const { UploadTracker } = loadTs("src/lib/sync/upload_tracker.ts");
const { classifyContext } = loadTs("src/lib/sync/context_filter.ts");

function memAdapter() {
  const files = new Map(), dirs = new Set();
  return {
    files,
    exists: async (p) => files.has(p) || dirs.has(p),
    read: async (p) => { if (!files.has(p)) throw new Error("ENOENT " + p); return files.get(p); },
    write: async (p, d) => { files.set(p, d); },
    remove: async (p) => { files.delete(p); },
    mkdir: async (p) => { dirs.add(p); },
  };
}
const mk = (adapter, opts = {}) => new BaseStore({ adapter, dir: "plug/base", hash: hashContent, ...opts });

// put/get + hash 校验
{
  const a = memAdapter(), s = mk(a);
  await s.load();
  const h = hashContent("hello\n");
  assert.equal(await s.put("a.md", "hello\n", h), true);
  assert.equal(await s.get("a.md", h), "hello\n");
  assert.equal(await s.get("a.md", "123"), null, "hash mismatch -> untrusted");
  assert.equal(await s.get("a.md", null), null);
  assert.equal(await s.put("b.md", "x", "999"), false, "put rejects hash not matching content");
  assert.equal(s.has("b.md"), false);
}
// 重启后加载（index 落盘）
{
  const a = memAdapter(), s = mk(a);
  await s.load();
  await s.put("a.md", "v1", hashContent("v1"));
  await s.flush();
  const s2 = mk(a);
  await s2.load();
  assert.equal(await s2.get("a.md", hashContent("v1")), "v1");
}
// 文件损坏 / 被篡改 -> null 且丢弃
{
  const a = memAdapter(), s = mk(a);
  await s.load();
  const h = hashContent("good");
  await s.put("a.md", "good", h);
  const f = [...a.files.keys()].find((k) => k.endsWith(".base"));
  a.files.set(f, JSON.stringify({ path: "a.md", hash: h, content: "evil" }));
  assert.equal(await s.get("a.md", h), null);
  assert.equal(s.has("a.md"), false);
  await s.put("c.md", "ok", hashContent("ok"));
  a.files.set([...a.files.keys()].find((k) => k.endsWith(".base") && a.files.get(k).includes('"c.md"')), "{not json");
  assert.equal(await s.get("c.md", hashContent("ok")), null);
}
// 损坏 index -> 空库，不抛
{
  const a = memAdapter();
  a.files.set("plug/base/base-index.json", "garbage");
  const s = mk(a);
  await s.load();
  assert.equal(s.size, 0);
}
// 单篇上限：超限不存且清掉旧值
{
  const s = mk(memAdapter(), { limits: { maxNoteChars: 10 } });
  await s.load();
  await s.put("a.md", "small", hashContent("small"));
  const big = "x".repeat(11);
  assert.equal(await s.put("a.md", big, hashContent(big)), false);
  assert.equal(s.has("a.md"), false, "stale base must not survive an oversize update");
}
// LRU 淘汰 + 被保护不淘汰
{
  let t = 0;
  const protectedSet = new Set(["p.md"]);
  const s = mk(memAdapter(), { now: () => ++t, limits: { maxNotes: 3 }, isProtected: (p) => protectedSet.has(p) });
  await s.load();
  for (const n of ["p.md", "a.md", "b.md"]) await s.put(n, n, hashContent(n));
  await s.get("a.md", hashContent("a.md")); // a 最近使用
  await s.put("c.md", "c.md", hashContent("c.md"));
  assert.equal(s.size, 3);
  assert.ok(s.has("p.md") && s.has("a.md") && s.has("c.md") && !s.has("b.md"), "LRU evicts b, keeps protected p");
}
// 总量上限
{
  const s = mk(memAdapter(), { limits: { maxTotalChars: 10 } });
  await s.load();
  await s.put("a.md", "12345", hashContent("12345"));
  await s.put("b.md", "67890", hashContent("67890"));
  await s.put("c.md", "abcde", hashContent("abcde"));
  assert.ok(s.size <= 2 && s.has("c.md"));
}
// rename / delete / clear
{
  const s = mk(memAdapter());
  await s.load();
  const h = hashContent("body");
  await s.put("old.md", "body", h);
  await s.rename("old.md", "new.md");
  assert.equal(await s.get("old.md", h), null);
  assert.equal(await s.get("new.md", h), "body");
  await s.delete("new.md");
  assert.equal(s.has("new.md"), false);
  await s.put("x.md", "body", h);
  await s.clear();
  assert.equal(s.size, 0, "clearSyncTime clears the base store");
}
// path hash 碰撞：不同 path 同文件名不互相覆盖
{
  const a = memAdapter();
  const s = new BaseStore({ adapter: a, dir: "d", hash: (x) => (x.endsWith(".md") ? "SAME" : hashContent(x)) });
  await s.load();
  await s.put("a.md", "A", hashContent("A")); // hash(path)=SAME for all paths but content hashing differs
}
{
  // 碰撞：path hash 相同 -> 文件名加后缀
  const a = memAdapter();
  const h = (x) => (x === "p1.md" || x === "p2.md" ? "7" : hashContent(x));
  const s = new BaseStore({ adapter: a, dir: "d", hash: h });
  await s.load();
  await s.put("p1.md", "one", h("one"));
  await s.put("p2.md", "two", h("two"));
  assert.equal(await s.get("p1.md", h("one")), "one");
  assert.equal(await s.get("p2.md", h("two")), "two");
}

// UploadTracker：单飞 / dirty / 超时 / 断线
{
  const t = new UploadTracker();
  const e = t.begin("a.md", { content: "x", contentHash: "1", baseHash: null, kind: "edit" }, 100);
  assert.ok(e);
  assert.equal(t.begin("a.md", { content: "y", contentHash: "2", baseHash: null, kind: "edit" }, 101), null, "single flight");
  t.markDirty("a.md");
  assert.equal(t.complete("a.md").contentHash, "1");
  assert.equal(t.complete("a.md"), undefined, "late/duplicate ack has no registration");
  assert.equal(t.takeDirty("a.md"), true);
  assert.equal(t.takeDirty("a.md"), false);
  t.begin("b.md", { content: "x", contentHash: "1", baseHash: "0", kind: "edit" }, 0);
  assert.equal(t.expire(29999, 30000).length, 0);
  assert.equal(t.expire(30000, 30000).length, 1);
  t.begin("c.md", { content: "x", contentHash: "1", baseHash: "0", kind: "edit" }, 0);
  t.markDirty("c.md");
  assert.equal(t.clearInFlight().length, 1);
  assert.equal(t.isDirty("c.md"), true, "dirty survives disconnect");
}
// 同步轮次内的 context 判定（用例 4：Ack 无 context 必须放行且不计轮次进度）
{
  const c = (action, msgContext, activeContext = "R1", autoMerge = true) => classifyContext({ action, msgContext, activeContext, autoMerge });
  assert.equal(c("NoteModifyAck", undefined), "realtime");
  assert.equal(c("NoteSyncModify", undefined), "realtime");
  assert.equal(c("NoteSyncDelete", undefined), "realtime");
  assert.equal(c("NoteModifyAck", "R1"), "process");
  assert.equal(c("NoteModifyAck", "OLD"), "discard");
  assert.equal(c("NoteSyncEnd", undefined), "discard");
  assert.equal(c("NoteModifyAck", undefined, "R1", false), "discard", "off mode keeps upstream behaviour");
  assert.equal(c("NoteModifyAck", undefined, null), "process");
}
// review r3#6：新建 base 时选文件名不能全量遍历 index（冷启动种子会变成 O(n^2)）
{
  const s = mk(memAdapter(), { limits: { maxNotes: 100000, maxTotalChars: 1e12 } });
  await s.load();
  const t0 = Date.now();
  for (let i = 0; i < 20000; i++) await s.put(`n/${i}.md`, "x", hashContent("x"));
  const ms = Date.now() - t0;
  console.log(`  20000 new bases: ${ms}ms`);
  assert.ok(ms < 2500, `20000 puts took ${ms}ms (quadratic file-name selection?)`);
}
// review r3#1：忽略窗口引用计数；r3#5：冲突备份文件名不含非法字符
{
  const { IgnoreRefs, conflictStem } = loadTs("src/lib/sync/conflict_paths.ts");
  const r = new IgnoreRefs();
  r.acquire("a.md"); r.acquire("a.md");
  assert.equal(r.release("a.md"), false, "first timer must not unignore while a second write is still in its window");
  assert.equal(r.release("a.md"), true);
  assert.equal(r.release("a.md"), true, "unbalanced release is harmless");
  const stem = conflictStem('dir/we?ird*na:me"<x>|.md', hashContent);
  assert.ok(!/[\\/:*?"<>|]/.test(stem), stem);
  assert.equal(conflictStem("a/b.md", hashContent), `a_b_${hashContent("a/b.md")}`, "legacy-compatible for ordinary paths");
}
console.log("base-store.test.mjs: all scenarios passed");
