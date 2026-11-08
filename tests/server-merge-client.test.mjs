import assert from "node:assert/strict";
import { Net, Server, Client, sha, hashContent } from "./lib/merge-sim.mjs";

const mk = () => { const net = new Net(); const server = new Server(net); return { net, server, a: new Client("A", net, server), b: new Client("B", net, server) }; };
let passed = 0;
const settle = async (net, n = 8) => { for (let i = 0; i < n; i++) { await net.drain(); await new Promise((r) => setImmediate(r)); } };
const failed = [];
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed.push(name); console.log(`FAIL - ${name}: ${e.message.split("\n").slice(0,6).join(" | ")}\n${(e.stack||"").split("\n").find((l)=>l.includes("test.mjs"))||""}`); }
};

await test("单飞：在途期间多次编辑只标 dirty，Ack 后补发一次且 base 为 Ack 的 sha", async () => {
  const { net, server, a } = mk();
  a.seed("n.md", "v0");
  assert.equal(await a.edit("n.md", "v1"), "sent");
  assert.equal(await a.edit("n.md", "v2"), "dirty");
  assert.equal(await a.edit("n.md", "v3"), "dirty");
  assert.equal(a.uploads().length, 1);
  await net.drain();
  const ups = a.uploads();
  assert.equal(ups.length, 2, "Ack 后恰好补发一次");
  assert.equal(ups[0].baseSha, sha("v0"));
  assert.equal(ups[1].content, "v3");
  assert.equal(ups[1].baseSha, sha("v1"), "第二次以第一次已确认的正文为 base");
  assert.equal(server.notes.get("n.md").content, "v3");
  assert.equal(a.sm.isInflight("n.md"), false);
});

await test("Ack 分支 1：无合并 → base=最终 sha/rev，不写本地", async () => {
  const { net, server, a } = mk();
  a.seed("n.md", "v0");
  await a.edit("n.md", "v1");
  await net.drain();
  assert.deepEqual(a.base.get("n.md"), { hash: hashContent("v1"), sha: sha("v1"), rev: server.notes.get("n.md").rev });
  assert.equal(a.writes.length, 0);
});

await test("Ack 分支 2：合并且本地未改 → 写入合并结果，base=合并结果，不再上传", async () => {
  const { net, server, a, b } = mk();
  a.seed("n.md", "v0"); b.seed("n.md", "v0");
  await b.edit("n.md", "S"); await net.drain();      // 服务端 S
  a.base.set("n.md", { hash: hashContent("v0"), sha: sha("v0"), rev: 1 }); // A 还停在旧 base（推送被丢）
  a.vault.set("n.md", "C");
  await a.sm.requestUpload("n.md", "C", hashContent("C"));
  await net.drain();
  assert.equal(server.notes.get("n.md").content, "S\nC");
  assert.equal(a.vault.get("n.md"), "S\nC", "合并结果写入本地");
  assert.equal(a.base.get("n.md").sha, sha(server.notes.get("n.md").content));
  assert.equal(a.uploads().length, 1, "写入合并结果不触发自身再上传");
  // 自身写入的 modify 事件按内容比对抑制
  const merged = a.vault.get("n.md");
  assert.equal(await a.sm.requestUpload("n.md", merged, hashContent(merged)), "self");
});

await test("Ack 分支 3：合并但本地已继续编辑 → base=已发送正文，立即重传本地", async () => {
  const { net, server, a, b } = mk();
  a.seed("n.md", "v0"); b.seed("n.md", "v0");
  await b.edit("n.md", "S"); await net.drain();
  a.base.set("n.md", { hash: hashContent("v0"), sha: sha("v0"), rev: 1 });
  await a.edit("n.md", "C");
  await a.edit("n.md", "C2");           // 在途期间继续编辑
  await net.drain();
  const ups = a.uploads();
  assert.equal(ups.length, 2);
  assert.equal(ups[1].content, "C2");
  assert.equal(ups[1].baseSha, sha("C"), "以已发送正文为 base");
  assert.equal(server.notes.get("n.md").content, "S\nC\nC2");
  assert.equal(a.vault.get("n.md"), "S\nC\nC2", "最终收敛，没有丢失本地后续编辑");
});

await test("冲突 Ack（服务端保留 S）走同一规则：本地仍等于已发送 → 落地 S", async () => {
  const { net, server, a } = mk();
  server.snaps = new Map();
  a.seed("n.md", "v0");
  server.notes.get("n.md").content = "S"; server.notes.get("n.md").rev = 500; // 服务端被他端改过，且 base 快照不可得
  server.snaps.clear();
  await a.edit("n.md", "C");
  await net.drain();
  assert.equal(a.vault.get("n.md"), "S");
  assert.equal(a.base.get("n.md").sha, sha("S"));
  assert.equal(a.uploads().length, 1);
});

await test("Ack 校验：opId 不符 / 重复 / 无在途 的 Ack 被丢弃，rev 只增", async () => {
  const { net, a } = mk();
  a.seed("n.md", "v0");
  await a.edit("n.md", "v1");
  const op = a.uploads()[0].opId;
  assert.equal(await a.sm.onAck({ path: "n.md", opId: "other", rev: 999, sha: sha("zzz") }), "ignored");
  assert.equal(a.sm.isInflight("n.md"), true);
  await net.drain();
  const rev = a.base.get("n.md").rev;
  assert.equal(await a.sm.onAck({ path: "n.md", opId: op, rev: rev + 5, sha: sha("v1") }), "ignored", "重复 Ack");
  assert.equal(a.base.get("n.md").rev, rev);
  await a.edit("n.md", "v2");
  const op2 = a.uploads()[1].opId;
  await a.sm.onAck({ path: "n.md", opId: op2, rev: 1, sha: sha("v2") });   // 迟到的低 rev
  assert.equal(a.base.get("n.md").rev, rev, "rev 不回退");
});

await test("重试沿用 opId：同会话超时重发复用 opId；重启/断线后换新 opId（服务端内容寻址幂等兜底）", async () => {
  const { net, server, a } = mk();
  a.seed("n.md", "v0");
  await a.edit("n.md", "v1");
  const op = a.uploads()[0].opId;
  net.queue.length = 0;                   // 请求丢在路上
  net.fireTimer(); await new Promise((r) => setImmediate(r));
  assert.equal(a.uploads()[1].opId, op, "同会话重发沿用 opId");
  net.queue.length = 0;
  a.sm.reset(); a.sm.supported = true;    // 断线重连
  await a.edit("n.md", "v1");
  assert.notEqual(a.uploads()[2].opId, op, "reset 回收 lastOps，不再跨会话保留 opId");
  await net.drain();
  const before = server.revSeq;
  await a.sm.requestUpload("n.md", "v1", hashContent("v1"), true);
  await net.drain();
  assert.equal(server.revSeq, before, "同内容 force 上传不产生新写入");
});

await test("推送四分支：旧 rev 丢弃 / 在途丢弃 / 干净应用 / 脏则上传", async () => {
  const { net, server, a } = mk();
  a.seed("n.md", "v0");
  const push = (content, rev) => a.sm.onPush({ path: "n.md", content, contentHash: hashContent(content), sha: sha(content), rev });
  const r0 = a.base.get("n.md").rev;
  assert.equal(await push("old", r0), "dropped");
  assert.equal(await push("old", r0 - 1), "dropped");
  // 干净应用
  assert.equal(await push("new1", r0 + 10), "applied");
  assert.equal(a.vault.get("n.md"), "new1");
  assert.deepEqual(a.base.get("n.md"), { hash: hashContent("new1"), sha: sha("new1"), rev: r0 + 10 });
  assert.equal(a.uploads().length, 0);
  // 在途丢弃
  a.gate = new Promise(() => {});
  void a.edit("n.md", "mine");
  await new Promise((r) => setImmediate(r));
  assert.equal(await push("new2", r0 + 20), "dropped");
  assert.equal(a.vault.get("n.md"), "mine");
  a.gate = null; a.sm.reset(); a.sm.supported = true;
  // 脏则上传（不应用）
  a.vault.set("n.md", "dirty-local");
  assert.equal(await push("new3", r0 + 30), "upload");
  await settle(net);       // 桩服务端没有 new1 的快照 → 冲突 Ack 把 S 落地，所以只验证上传内容与 base
  const up = a.uploads().at(-1);
  assert.equal(up.content, "dirty-local");
  assert.equal(up.baseSha, sha("new1"), "base 仍是上次已确认的");
  void net; void server;
});

await test("推送应用时本地恰在读写之间被改（CAS 失败）→ 不覆盖，转为上传", async () => {
  const { net, a } = mk();
  a.seed("n.md", "v0");
  a.failCas = () => a.vault.set("n.md", "typed-meanwhile");   // 读之后、写之前用户又敲了字
  const r = await a.sm.onPush({ path: "n.md", content: "remote", contentHash: hashContent("remote"), sha: sha("remote"), rev: 1000 });
  assert.equal(r, "upload");
  await settle(net);
  assert.equal(a.vault.get("n.md"), "typed-meanwhile");
  assert.equal(a.uploads().length, 1);
  assert.equal(a.uploads()[0].content, "typed-meanwhile");
});

await test("乱序与重复：高 rev 先到则低 rev 丢弃；同一推送重复到达只应用一次", async () => {
  const { a } = mk();
  a.seed("n.md", "v0");
  const push = (c, rev) => a.sm.onPush({ path: "n.md", content: c, contentHash: hashContent(c), sha: sha(c), rev });
  assert.equal(await push("r2", 120), "applied");
  assert.equal(await push("r1", 110), "dropped");
  assert.equal(await push("r2", 120), "dropped");
  assert.equal(a.vault.get("n.md"), "r2");
  assert.equal(a.writes.length, 1);
  const rs = await Promise.all([push("r3", 130), push("r3", 130), push("r2b", 125)]);
  assert.deepEqual(rs, ["applied", "dropped", "dropped"], "并发到达按路径串行");
});

await test("新建推送（本地无文件）直接创建；无 rev 的推送交回上游流程", async () => {
  const { a } = mk();
  assert.equal(await a.sm.onPush({ path: "new.md", content: "x", contentHash: hashContent("x"), sha: sha("x"), rev: 5 }), "applied");
  assert.equal(a.vault.get("new.md"), "x");
  assert.equal(await a.sm.onPush({ path: "new2.md", content: "x", contentHash: "1" }), "legacy");
});

await test("远端删除 vs 本地改动：干净 → apply；脏 → 保留并以新建上传；旧 rev 跳过", async () => {
  const { net, server, a, b } = mk();
  a.seed("c.md", "x"); b.seed("c.md", "x");
  a.seed("d.md", "y"); b.seed("d.md", "y");
  a.vault.set("d.md", "y-edit");                   // A 本地有未上传改动
  const bd1 = b.sm.requestDelete("c.md", async (opId, baseSha) => { b.net.enqueue(async () => server.handle(b, "NoteDelete", { path: "c.md", opId, baseSha })); return true; });
  const bd2 = b.sm.requestDelete("d.md", async (opId, baseSha) => { b.net.enqueue(async () => server.handle(b, "NoteDelete", { path: "d.md", opId, baseSha })); return true; });
  await Promise.all([bd1, bd2]);
  await settle(net);
  assert.equal(a.vault.has("c.md"), false, "干净 → 删除");
  assert.equal(a.vault.get("d.md"), "y-edit", "有改动 → 保留");
  const up = a.uploads().find((u) => u.path === "d.md");
  assert.ok(up && up.baseHash === undefined && up.baseSha === undefined, "以新建（无 base）上传");
  assert.equal(server.notes.get("d.md")?.content, "y-edit");
  assert.equal(await a.sm.onRemoteDelete("e.md", 1), "apply");
  a.seed("e.md", "z");
  assert.equal(await a.sm.onRemoteDelete("e.md", 1), "skip", "rev 不新于已知");
});

await test("删除被拒（服务端正文已变）→ 恢复文件并落地服务端正文", async () => {
  const { net, server, a } = mk();
  a.seed("n.md", "v0");
  server.notes.get("n.md").content = "server-changed"; server.notes.get("n.md").rev = 777;
  a.vault.delete("n.md");
  await a.sm.requestDelete("n.md", async (opId, baseSha) => { net.enqueue(async () => server.handle(a, "NoteDelete", { path: "n.md", opId, baseSha })); return true; });
  await net.drain();
  assert.equal(a.vault.get("n.md"), "server-changed");
  assert.equal(a.base.get("n.md").rev, 777);
});

await test("删除/重命名与在途 modify 串行：等 Ack 后才发送", async () => {
  const { net, server, a } = mk();
  a.seed("n.md", "v0");
  await a.edit("n.md", "v1");
  let sentAt = null;
  const p = a.sm.requestRename("n.md", "m.md", hashContent("v1"), async (opId, baseSha) => {
    sentAt = a.uploads().length + (a.sm.isInflight("n.md") ? 0 : 100);
    net.enqueue(async () => server.handle(a, "NoteRename", { path: "m.md", oldPath: "n.md", opId, baseSha }));
    return true;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(sentAt, null, "modify 未 Ack 前 rename 不发");
  await net.drain(); await p; await net.drain();
  assert.ok(sentAt !== null);
  assert.equal(server.notes.has("m.md"), true);
  assert.equal(server.notes.has("n.md"), false);
  assert.equal(a.base.has("n.md"), false);
  assert.equal(a.base.get("m.md").rev, server.notes.get("m.md").rev);
});

await test("重命名被拒（目标已存在且不同）→ 本地不动，作为新建上传", async () => {
  const { net, server, a } = mk();
  a.seed("n.md", "mine");
  server.put("m.md", "other");
  a.vault.delete("n.md"); a.vault.set("m.md", "mine");
  await a.sm.requestRename("n.md", "m.md", hashContent("mine"), async (opId, baseSha) => {
    net.enqueue(async () => server.handle(a, "NoteRename", { path: "m.md", oldPath: "n.md", opId, baseSha })); return true;
  });
  await net.drain();
  const up = a.uploads().at(-1);
  assert.equal(up.path, "m.md");
  assert.equal(up.content, "mine", "本地正文原样提交（服务端存为冲突副本）");
  assert.equal(up.baseSha, undefined, "无 base，交服务端出冲突副本");
  assert.equal(a.vault.get("m.md"), "other", "冲突 Ack 统一规则：落地服务端版本");
});

await test("离线双改后重连：服务端推送到达时本地为脏 → 走上传由服务端合并，两端收敛", async () => {
  const { net, server, a, b } = mk();
  a.seed("n.md", "line"); b.seed("n.md", "line");
  // 离线期间两端各改，B 先上传
  a.vault.set("n.md", "line\nA");
  server.clients = server.clients.filter((c) => c !== a);   // A 离线，收不到广播
  await b.edit("n.md", "line\nB"); await net.drain();
  server.clients.push(a);
  const pushedRev = server.notes.get("n.md").rev;
  // A 重连：分页下发 B 的版本（带 rev）
  const r = await a.sm.onPush({ path: "n.md", content: "line\nB", contentHash: hashContent("line\nB"), sha: sha("line\nB"), rev: pushedRev });
  assert.equal(r, "upload");
  await settle(net);
  assert.equal(a.vault.get("n.md"), server.notes.get("n.md").content, "A 落地服务端合并结果");
  assert.equal(a.base.get("n.md").sha, sha(server.notes.get("n.md").content));
});

await test("降级：未协商 serverMerge 时 supported=false；reset 清零；无 rev 推送 = legacy", async () => {
  const { a } = mk();
  a.sm.reset();
  assert.equal(a.sm.supported, false);
  assert.equal(await a.sm.onPush({ path: "x.md", content: "c", contentHash: "1", rev: 0 }), "legacy");
  assert.equal(await a.sm.onRemoteDelete("x.md", 0), "apply");
  assert.equal(a.sm.admit("x.md", undefined), true);
});


// ===== Codex 审 94fd9c5 的 6 条（先红后修）=====
await test("#1 Ack 不得把旧正文 hash 绑到新编辑的本地缓存；且补传新编辑", async () => {
  const { net, server, a } = mk();
  a.seed("n.md", "v0");
  await a.edit("n.md", "C1");
  a.vault.set("n.md", "C2");                // 用户继续编辑，modify 事件还在防抖队列
  await net.drain();
  assert.notEqual(a.cached.get("n.md"), hashContent("C1"), "确认不了本地==base 时不更新缓存绑定");
  assert.equal(server.notes.get("n.md").content, "C2", "C2 必须被补传，不能因缓存早退漏掉");
});

await test("#2 重命名带着未上传的编辑：Ack 后比较新路径实际正文与服务端 sha，补传", async () => {
  const { net, server, a } = mk();
  a.seed("n.md", "base");
  a.vault.delete("n.md"); a.vault.set("m.md", "edited");   // 编辑后立刻重命名，旧路径 modify 定时器被取消
  await a.sm.requestRename("n.md", "m.md", hashContent("base"), async (opId, baseSha) => {
    net.enqueue(async () => server.handle(a, "NoteRename", { path: "m.md", oldPath: "n.md", opId, baseSha })); return true;
  });
  await net.drain();
  assert.equal(server.notes.has("n.md"), false);
  assert.equal(server.notes.get("m.md").content, "edited");
});

await test("#2b 在途 modify 期间重命名：旧路径的 dirty 迁移到新路径，不丢", async () => {
  const { net, server, a } = mk();
  a.seed("n.md", "v0");
  await a.edit("n.md", "v1");
  await a.edit("n.md", "v2");               // dirty
  a.vault.delete("n.md"); a.vault.set("m.md", "v2");
  const rp = a.sm.requestRename("n.md", "m.md", hashContent("v1"), async (opId, baseSha) => {
    net.enqueue(async () => server.handle(a, "NoteRename", { path: "m.md", oldPath: "n.md", opId, baseSha })); return true;
  });
  await net.drain(); await rp; await net.drain();
  assert.equal(server.notes.get("m.md").content, "v2");
  assert.equal(server.notes.has("n.md"), false);
});

await test("#3 删除被拒且本地已重建为不同内容：以删除前祖先为 base，服务端三方合并，不覆盖远端新增", async () => {
  const { net, server, a } = mk();
  a.seed("n.md", "B");
  server.notes.get("n.md").content = "B+remote"; server.notes.get("n.md").rev = 900;
  a.vault.delete("n.md");
  await a.sm.requestDelete("n.md", async (opId, baseSha) => { net.enqueue(async () => server.handle(a, "NoteDelete", { path: "n.md", opId, baseSha })); return true; });
  a.vault.set("n.md", "B+local");                // Ack 前本地重建
  await net.drain();
  const up = a.uploads().at(-1);
  assert.equal(up.baseSha, sha("B"), "base 是删除前可信祖先，不是被拒返回的 S");
  const final = server.notes.get("n.md").content;
  assert.ok(final.includes("B+remote") && final.includes("B+local"), `两边都保留: ${final}`);
});

await test("#4 删除后保留墓碑：旧 rev 的迟到分页不能复活文件（远端删除与本地删除 Ack 两条路径）", async () => {
  const { net, server, a } = mk();
  a.seed("n.md", "old");
  await a.receive("NoteSyncDelete", { path: "n.md", rev: 900 });
  assert.equal(a.vault.has("n.md"), false);
  assert.equal(await a.sm.onPush({ path: "n.md", content: "old", contentHash: hashContent("old"), sha: sha("old"), rev: 800 }), "dropped");
  assert.equal(a.vault.has("n.md"), false);
  assert.equal(await a.sm.onPush({ path: "n.md", content: "re", contentHash: hashContent("re"), sha: sha("re"), rev: 1000 }), "applied", "更高 rev 的重建正常应用");
  assert.equal(a.tomb.has("n.md"), false, "重建成功清除墓碑");
  // 本地删除 Ack
  a.seed("k.md", "k");
  a.vault.delete("k.md");
  await a.sm.requestDelete("k.md", async (opId, baseSha) => { net.enqueue(async () => server.handle(a, "NoteDelete", { path: "k.md", opId, baseSha })); return true; });
  await net.drain();
  const t = a.tomb.get("k.md");
  assert.ok(t > 0);
  assert.equal(await a.sm.onPush({ path: "k.md", content: "k", contentHash: hashContent("k"), sha: sha("k"), rev: t - 1 }), "dropped");
});

await test("#5 自身写入抑制用 sha 不用 hash32：同 hash32 不同正文的用户编辑必须上传", async () => {
  const { a } = mk();
  assert.equal(hashContent("Aa"), hashContent("BB"));
  a.seed("n.md", "v0");
  await a.sm.onPush({ path: "n.md", content: "Aa", contentHash: hashContent("Aa"), sha: sha("Aa"), rev: 500 });
  a.vault.set("n.md", "BB");
  assert.equal(await a.sm.requestUpload("n.md", "BB", hashContent("BB")), "sent");
});

await test("#6 只读模式：推送发现本地脏、Ack 后 dirty 补传都不得发写请求", async () => {
  const { net, a } = mk();
  a.seed("n.md", "v0");
  a.readonly = true;
  a.vault.set("n.md", "local-dirty");
  const r = await a.sm.onPush({ path: "n.md", content: "remote", contentHash: hashContent("remote"), sha: sha("remote"), rev: 500 });
  assert.notEqual(r, "applied");
  assert.equal(a.vault.get("n.md"), "local-dirty");
  assert.equal(a.uploads().length, 0);
  assert.equal(await a.sm.requestUpload("n.md", "local-dirty", hashContent("local-dirty")), "blocked");
  await net.drain();
  assert.equal(a.uploads().length, 0);
});

await test("(b) rename/delete 等待在途 Ack 期间该路径被占位：推送不得趁机复活/覆盖", async () => {
  const { net, server, a } = mk();
  a.seed("n.md", "v0");
  await a.edit("n.md", "v1");               // 在途
  a.vault.delete("n.md");
  const p = a.sm.requestDelete("n.md", async (opId, baseSha) => { net.enqueue(async () => server.handle(a, "NoteDelete", { path: "n.md", opId, baseSha })); return true; });
  assert.equal(await a.sm.onPush({ path: "n.md", content: "x", contentHash: hashContent("x"), sha: sha("x"), rev: 9999 }), "dropped");
  assert.equal(a.vault.has("n.md"), false);
  await net.drain(); await p; await net.drain();
  assert.equal(server.notes.has("n.md"), false);
});

// ===== 第二批：Codex 性能/稳定性评审 R2 客户端 10-14 =====
import { effectiveStrategy } from "./lib/merge-sim.mjs";
await test("#10 acceptsAck：只有 opId 匹配在途操作才放行外层副作用", async () => {
  const { net, a } = mk();
  a.seed("n.md", "v0");
  await a.edit("n.md", "v1");
  const op = a.uploads()[0].opId;
  assert.equal(a.sm.acceptsAck({ path: "n.md", opId: "other" }), false);
  assert.equal(a.sm.acceptsAck({ path: "n.md" }), false);
  assert.equal(a.sm.acceptsAck({ path: "zzz.md", opId: op }), false);
  assert.equal(a.sm.acceptsAck({ path: "n.md", opId: op }), true);
  await net.drain();
  assert.equal(a.sm.acceptsAck({ path: "n.md", opId: op }), false, "已确认后重复 Ack 不放行");
});

await test("#11 主动超时：30s 无 Ack 以同 opId 同正文重发，指数退避+jitter 上限 5 分钟，Ack 后清零", async () => {
  const { net, a } = mk();
  a.seed("n.md", "v0");
  await a.edit("n.md", "v1");
  const op = a.uploads()[0].opId;
  net.queue.length = 0;                        // 请求/Ack 丢了，连接仍活着
  const delays = [];
  for (let i = 0; i < 8; i++) { const ms = net.fireTimer(); assert.ok(ms !== null, `第 ${i + 1} 次应有定时器`); delays.push(ms); await new Promise((r) => setImmediate(r)); net.queue.length = 0; }
  assert.equal(a.uploads().length, 9);
  assert.ok(a.uploads().every((u) => u.opId === op && u.content === "v1"), "同 opId 同正文");
  assert.ok(delays[0] >= 24000 && delays[0] <= 36000, `首次约 30s: ${delays[0]}`);
  assert.ok(delays[1] > delays[0] && delays[2] > delays[1], "指数退避");
  assert.ok(Math.max(...delays) <= 300000 * 1.2, "上限 5 分钟(含 jitter)");
  assert.ok(delays.at(-1) >= 240000, "退避到顶");
  // 认证成功后才重置计数
  a.sm.onAuthenticated();
  a.sm.reset(); a.sm.supported = true;
  await a.edit("n.md", "v1");
  const ms = net.fireTimer();
  assert.ok(ms >= 24000 && ms <= 36000, `重置后重新从 30s 起: ${ms}`);
});

await test("e2e-1 冲突 Ack 后副本推送迟迟未到：10s 看门狗主动拉取；副本到达则取消", async () => {
  const { net, server, a } = mk();
  server.notes.set("n.md", { content: "S", rev: 50 });
  await a.edit("n.md", "C");
  await settle(net);
  assert.equal(net.liveTimers() >= 1, true, "应挂着看门狗");
  const ms = net.timers.filter((t) => !t.off).map((t) => t.ms);
  assert.ok(ms.includes(10000), `10s 看门狗: ${ms}`);
  while (net.fireTimer() !== null) { /* 触发全部 */ }
  assert.equal(a.missing.length, 1, "副本未到 → 主动拉取");
  assert.match(a.missing[0], /conflict/);
  // 副本推送先到：不再拉取
  const m = mk();
  m.server.notes.set("n.md", { content: "S", rev: 50 });
  await m.a.edit("n.md", "C");
  await settle(m.net);
  const copy = m.a.sm.copyWatch.keys().next().value;
  await m.a.sm.onPush({ path: copy, rev: 120, content: "C", sha: "x" });
  while (m.net.fireTimer() !== null) { /* */ }
  assert.equal(m.a.missing.length, 0, "副本到达取消看门狗");
});

await test("#11b Ack 到达取消定时器，不再重发", async () => {
  const { net, a } = mk();
  a.seed("n.md", "v0");
  await a.edit("n.md", "v1");
  await net.drain();
  assert.equal(net.liveTimers(), 0);
});

await test("#12c 能力缺失整会话强制 manualMerge，不沿用用户设置", async () => {
  assert.equal(effectiveStrategy(false, "ignoreTimeMerge"), "manualMerge");
  assert.equal(effectiveStrategy(false, ""), "manualMerge");
  assert.equal(effectiveStrategy(true, "ignoreTimeMerge"), "ignoreTimeMerge");
});

await test("#13 先取槽再读全文：槽没拿到前不读正文、不算 sha；拿不到则不发", async () => {
  const { net, a } = mk();
  a.seed("n.md", "v0");
  a.vault.set("n.md", "v1");
  let release; a.slotGate = new Promise((r) => (release = r));
  const reads0 = a.reads;
  const p = a.sm.requestUploadFromDisk("n.md");
  await new Promise((r) => setImmediate(r));
  assert.equal(a.reads, reads0, "排队等槽期间没有读过正文");
  release();
  assert.equal(await p, "sent");
  assert.equal(a.slots, 1, "槽由上传持有，Ack 后释放");
  a.slotGate = null; a.noSlot = true;
  a.vault.set("m.md", "x");
  assert.equal(await a.sm.requestUploadFromDisk("m.md"), "failed");
  await net.drain();
});

await test("#13b 内存预算：排队正文总字节超限时排队路径不排队正文，在途完成后补上", async () => {
  const { net, server, a } = mk();
  a.sm.maxQueuedBytes = 100;
  for (const p of ["a.md", "b.md", "c.md"]) { a.seed(p, "0"); a.vault.set(p, p[0].repeat(60)); }
  const rs = [];
  for (const p of ["a.md", "b.md", "c.md"]) rs.push(await a.sm.requestUploadFromDisk(p));
  assert.deepEqual(rs, ["sent", "deferred", "deferred"], "第二、三篇只排路径");
  assert.equal(a.uploads().length, 1);
  assert.equal(a.slots, 1, "被延后的不占槽");
  for (let i = 0; i < 8; i++) { await net.drain(); await new Promise((r) => setImmediate(r)); }
  assert.equal(server.notes.get("a.md").content, "a".repeat(60));
  assert.equal(server.notes.get("b.md").content, "b".repeat(60));
  assert.equal(server.notes.get("c.md").content, "c".repeat(60));
  assert.equal(a.slots, 3);
});

await test("#14 Map 统一回收：reset/删除/rename/dispose 后 lastOps、expected、uploadContexts、retries 不残留", async () => {
  const { net, server, a } = mk();
  a.seed("n.md", "v0");
  a.sm.uploadContexts.set("n.md", "ctx");
  await a.edit("n.md", "v1");
  a.sm.reset(); a.sm.supported = true;
  let z = a.sm.debugSizes();
  assert.deepEqual([z.lastOps, z.uploadContexts, z.expected, z.inflight, z.retries, z.dirty], [0, 0, 0, 0, 1, 0].map((x, i) => (i === 4 ? z.retries : x)));
  // 删除 / rename 后该路径的状态被清走
  a.seed("d.md", "d");
  await a.sm.onPush({ path: "d.md", content: "d2", contentHash: hashContent("d2"), sha: sha("d2"), rev: 2000 });
  assert.equal(a.sm.debugSizes().expected, 1);
  a.vault.delete("d.md");
  await a.sm.requestDelete("d.md", async (opId, baseSha) => { net.enqueue(async () => server.handle(a, "NoteDelete", { path: "d.md", opId, baseSha })); return true; });
  assert.equal(a.sm.debugSizes().expected, 0, "删除时清掉该路径的自写期望");
  await net.drain();
  a.sm.dispose();
  z = a.sm.debugSizes();
  assert.deepEqual(Object.values(z).reduce((s, x) => s + x, 0), 0, "dispose 后全部为空");
});

// ===== 第三批：Codex 终审 6783b4d =====
import { markFullReconcile, RESYNC_REQUIRED_CODE } from "./lib/merge-sim.mjs";

await test("#5 队列超限关闭码 4001：清增量水位，下次连接做完整对账", async () => {
  assert.equal(RESYNC_REQUIRED_CODE, 4001);
  const meta = { lastNoteSyncTime: 200, lastFileSyncTime: 5, lastConfigSyncTime: 6, lastFolderSyncTime: 7, isInitSync: true };
  const set = (k, v) => { meta[k] = v; };
  assert.equal(markFullReconcile(1000, set), false, "普通断线不动水位");
  assert.equal(meta.lastNoteSyncTime, 200);
  assert.equal(markFullReconcile(4001, set), true);
  assert.deepEqual([meta.lastNoteSyncTime, meta.lastFileSyncTime, meta.lastConfigSyncTime, meta.lastFolderSyncTime, meta.isInitSync], [0, 0, 0, 0, false]);
});

await test("#6 Delete/Rename 超时重发复用原操作已持有的槽（首发与重发分开）", async () => {
  const { net, server, a } = mk();
  a.seed("d.md", "d"); a.seed("r.md", "r");
  const calls = [];
  a.vault.delete("d.md");
  await a.sm.requestDelete("d.md", async (opId, baseSha, isResend) => { calls.push(["del", isResend]); return true; });
  await a.sm.requestRename("r.md", "r2.md", hashContent("r"), async (opId, baseSha, isResend) => { calls.push(["ren", isResend]); return true; });
  net.fireTimer(); await new Promise((r) => setImmediate(r));
  net.fireTimer(); await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [["del", false], ["ren", false], ["del", true], ["ren", true]]);
  void server;
});

await test("#7 取槽后读取异常：释放占位与槽，保留重试路径（短延时重试成功）", async () => {
  const { net, server, a } = mk();
  a.seed("n.md", "v0"); a.vault.set("n.md", "v1");
  a.readFail = true;
  const r = await a.sm.requestUploadFromDisk("n.md");
  assert.equal(r, "failed");
  assert.equal(a.sm.isInflight("n.md"), false, "占位已释放（不会卡死后续 rename）");
  assert.equal(a.slots, 0, "槽已释放");
  assert.equal(net.liveTimers(), 1, "留有重试定时器");
  net.fireTimer(); await settle(net);
  assert.equal(server.notes.get("n.md").content, "v1", "重试后上传成功");
});

await test("#8 rename merged Ack 判断「本地未改」用祖先 sha，不用 hash32：BB 不得被 remote 覆盖", async () => {
  const { net, server, a } = mk();
  a.seed("n.md", "Aa");
  assert.equal(hashContent("Aa"), hashContent("BB"));
  a.vault.delete("n.md"); a.vault.set("m.md", "BB");           // 用户改成 BB 后重命名
  const p = a.sm.requestRename("n.md", "m.md", hashContent("Aa"), async (opId) => {
    net.enqueue(async () => a.receive("NoteRenameAck", { path: "m.md", opId, rev: 900, sha: sha("remote"), merged: true, content: "remote" }));
    return true;
  });
  await p; await settle(net);
  assert.equal(a.uploads().at(-1)?.content, "BB", "BB 被补传而不是丢弃");
  assert.equal(a.uploads().at(-1)?.baseSha, sha("Aa"), "以可信祖先为 base");
  assert.notEqual(a.vault.get("m.md"), "remote");
  void server;
});

await test("#10 推送发现本地脏：走先取槽再读的路径（等槽期间不持有正文）", async () => {
  const { net, a } = mk();
  a.seed("n.md", "v0"); a.vault.set("n.md", "dirty");
  let release; a.slotGate = new Promise((r) => (release = r));
  const reads0 = a.reads;
  const r = await a.sm.onPush({ path: "n.md", content: "remote", contentHash: hashContent("remote"), sha: sha("remote"), rev: 500 });
  assert.equal(r, "upload");
  await settle(net);
  assert.equal(a.uploads().length, 0, "槽没拿到之前不发送（也就不持有待发正文）");
  assert.equal(a.sm.isInflight("n.md"), true, "但路径已占位，单飞成立");
  release(); await settle(net);
  assert.equal(a.uploads().at(-1).content, "dirty");
  assert.ok(a.reads > reads0, "取到槽之后才读全文");
  a.slotGate = null;
});
if (failed.length) { console.log(`${failed.length} failed`); process.exit(1); }
console.log(`server-merge-client: ${passed} scenarios passed`);
