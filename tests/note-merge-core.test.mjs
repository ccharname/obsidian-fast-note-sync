import assert from "node:assert/strict";
import { hashContent } from "./lib/load-ts.mjs";
import { Net, Server, Client } from "./lib/sim.mjs";

const BASE = "# T\n\n## a\n- 1\n- 2\n\n## b\n- x\n\n## c\n- todo\n";
const P = "n.md";
let cases = 0;
const t = async (name, fn) => { if (process.env.ONLY && !name.includes(process.env.ONLY)) return; await fn(); cases++; console.log("  ok -", name); };
function world(n = 2) {
  const net = new Net(), server = new Server(net);
  const cs = Array.from({ length: n }, (_, i) => new Client("ABCDEF"[i], net, server));
  return { net, server, cs };
}
async function seeded(n = 2, content = BASE) {
  const w = world(n);
  await w.cs[0].seed(P, content);
  for (const c of w.cs.slice(1)) await c.seedFromServer(P);
  return w;
}
const converged = (w) => { const s = w.server.notes.get(P).content; for (const c of w.cs) assert.equal(c.vault.get(P), s, `client ${c.id} converged`); return s; };
const consistent = async (w) => { for (const c of w.cs) { assert.equal(c.sync.get(P), hashContent(c.vault.get(P)), `client ${c.id} syncHash == content hash`); assert.equal(await c.base.get(P, c.sync.get(P)), c.vault.get(P), `client ${c.id} base == content`); } };

await t("1 同时编辑不同位置：A 先到，B 收 530→diff3→CAS 上传→A 收到合并结果，无冲突", async () => {
  const { net, server, cs: [A, B] } = await seeded();
  const pa = A.edit(P, (c) => c + "- appended by A\n");
  const pb = B.edit(P, (c) => c.replace("# T", "# TT"));
  await pa; await pb; await net.settle();
  const s = converged({ server, cs: [A, B] });
  assert.ok(s.includes("# TT") && s.includes("appended by A"));
  assert.equal(A.conflicts.size + B.conflicts.size, 0);
  assert.ok(server.log.filter((l) => l[0] === "B" && l[1] === "NoteModify").length === 2, "B uploaded twice (reject then merged CAS)");
  await consistent({ server, cs: [A, B] });
});

await t("2 同一行不同修改：不写盘不上传，进冲突，真 base、serverHash 非空", async () => {
  const { net, server, cs: [A, B] } = await seeded();
  await A.edit(P, (c) => c.replace("- todo", "- A"));
  await net.settle();
  const before = B.vault.get(P);
  assert.equal(before, A.vault.get(P), "B had no local edits, fast-forwarded");
  // B 在 A 版本基础上，A 再改同一行；B 同时改同一行
  const w = await seeded();
  const [a, b] = w.cs;
  const pa = a.edit(P, (c) => c.replace("- todo", "- A-line"));
  const pb = b.edit(P, (c) => c.replace("- todo", "- B-line"));
  await pa; await pb; await w.net.settle();
  assert.equal(b.conflicts.size, 1);
  const info = b.conflicts.get(P);
  assert.equal(info.reason, "overlap");
  assert.equal(info.base, BASE, "true base, not local content");
  assert.ok(info.serverHash && info.serverHash === hashContent(w.server.notes.get(P).content));
  assert.ok(b.vault.get(P).includes("B-line"), "local content untouched");
  assert.ok(w.server.notes.get(P).content.includes("A-line") && !w.server.notes.get(P).content.includes("B-line"), "server not overwritten");
});

await t("3 #276 冲突状态下继续编辑：不发送 NoteModify，服务端不被覆盖；解冲突后才上传", async () => {
  const w = await seeded();
  const [a, b] = w.cs;
  const pa = a.edit(P, (c) => c.replace("- todo", "- A-line"));
  const pb = b.edit(P, (c) => c.replace("- todo", "- B-line"));
  await pa; await pb; await w.net.settle();
  assert.equal(b.conflicts.size, 1);
  const sentBefore = b.sent.length, serverBefore = w.server.notes.get(P).content;
  await b.edit(P, (c) => c + "- more typing\n");
  await w.net.settle();
  assert.equal(b.sent.length, sentBefore, "no NoteModify while in conflict");
  assert.equal(w.server.notes.get(P).content, serverBefore);
  // 用户手动把冲突行改回 base 文案 → 下一次拉取重试合并成功，才上传
  b.vault.set(P, b.vault.get(P).replace("- B-line", "- todo"));
  w.net.now = Date.now() + 10000; // 越过重新拉取的节流间隔
  await b.edit(P, (c) => c);
  await w.net.settle();
  assert.equal(b.conflicts.size, 0, "conflict cleared after successful merge");
  const s = w.server.notes.get(P).content;
  assert.ok(s.includes("A-line") && s.includes("more typing"));
  converged(w);
});

await t("4 Ack 对应登记请求：syncHash 前进、base←请求内容、tracker 清空；迟到/重复 Ack 不动 base", async () => {
  const { net, server, cs: [A] } = await seeded(1);
  await A.edit(P, (c) => c + "- v2\n");
  assert.ok(A.core.tracker.has(P));
  await net.settle();
  assert.equal(A.core.tracker.has(P), false);
  await consistent({ server, cs: [A] });
  const h = A.sync.get(P);
  assert.equal(await A.core.onAck(P), false, "duplicate ack ignored");
  assert.equal(A.sync.get(P), h);
});

await t("5 同路径连续三次快速编辑：只一个在途，Ack 后读盘重发一次，最终=最后一次编辑", async () => {
  const { net, server, cs: [A, B] } = await seeded();
  await A.edit(P, (c) => c + "- e1\n");   // 已发出，Ack 未到
  const p2 = A.edit(P, (c) => c + "- e2\n");
  const p3 = A.edit(P, (c) => c + "- e3\n");
  await Promise.all([p2, p3]); await net.settle();
  assert.equal(A.sent.length, 2, "1 in flight + 1 resend after ack");
  assert.ok(server.notes.get(P).content.endsWith("- e1\n- e2\n- e3\n"));
  converged({ server, cs: [A, B] });
  await consistent({ server, cs: [A, B] });
});

await t("6 启动场景：关闭期间外部改了文件，他端已改同篇另一处 → NeedPush→530→持久 base 合并→CAS", async () => {
  const { net, server, cs: [A, B] } = await seeded();
  A.vault.set(P, BASE.replace("- 1", "- 1\n- external write"));           // 关闭期间外部工具写入
  await B.edit(P, (c) => c.replace("- 2", "- 2\n- B calendar"));           // 他端同时已更新
  await net.settle();
  // A 重启：syncHash 仍是关闭前确认值；服务端发 NeedPush → requestUpload(needpush)
  assert.equal(await A.core.requestUpload(P, { kind: "needpush" }), "sent");
  await net.settle();
  const s = converged({ server, cs: [A, B] });
  assert.ok(s.includes("external write") && s.includes("B calendar"));
  assert.equal(A.conflicts.size, 0);
});

await t("7 启动场景但 base 缺失（升级前已分叉）：不自动合并，进冲突 UI 并标明无 base", async () => {
  const { net, server, cs: [A, B] } = await seeded();
  await A.base.clear();
  A.vault.set(P, BASE.replace("- 1", "- 1\n- external write"));
  await B.edit(P, (c) => c.replace("- 2", "- 2\n- B calendar"));
  await net.settle();
  await A.core.requestUpload(P, { kind: "needpush" });
  await net.settle();
  assert.equal(A.conflicts.get(P)?.reason, "no-base");
  assert.ok(A.logs.some((l) => l[0] === "NoteMergeNoBase"));
  assert.ok(!server.notes.get(P).content.includes("external write"));
});

await t("8 合并写盘瞬间用户又输入（CAS 失败）：不覆盖、不弹窗、不上传旧合并稿，稍后重试成功", async () => {
  const { net, server, cs: [A, B] } = await seeded();
  B.failCas = 1; // B 合并写盘时用户恰好又输入了
  const pa = A.edit(P, (c) => c + "- A tail\n");
  const pb = B.edit(P, (c) => c.replace("# T", "# TT"));
  await pa; await pb; await net.settle();
  assert.equal(B.sent.length, 2, "old merge result not uploaded while cas failed; one merged upload after retry");
  assert.equal(B.conflicts.size, 0, "no dialog");
  assert.ok(B.casAttempts >= 2, "retried after cas failure");
  const s = converged({ server, cs: [A, B] });
  assert.ok(s.includes("# TT") && s.includes("A tail"));
});

await t("9 530 的 baseContent 是 serverContent 的复制（hash≠请求 baseHash）：忽略，无本地 base 转 UI", async () => {
  const { net, server, cs: [A, B] } = await seeded();
  await B.base.clear();
  const pa = A.edit(P, (c) => c.replace("- todo", "- A"));
  const pb = B.edit(P, (c) => c.replace("# T", "# TT"));
  await pa; await pb; await net.settle();
  assert.equal(B.conflicts.get(P)?.reason, "no-base", "server baseContent copy must not be used as base");
  assert.ok(!server.notes.get(P).content.includes("# TT"));
});

await t("10a 本地 base 的 hash 与 syncHash 不一致：base 不可信，不参与合并", async () => {
  const { net, server, cs: [A, B] } = await seeded();
  await B.base.put(P, "stale base content", hashContent("stale base content"));  // base.hash ≠ syncHash
  const pa = A.edit(P, (c) => c.replace("- todo", "- A"));
  const pb = B.edit(P, (c) => c.replace("# T", "# TT"));
  await pa; await pb; await net.settle();
  assert.equal(B.conflicts.get(P)?.reason, "no-base");
  assert.ok(B.vault.get(P).includes("# TT"));
});

await t("localStorage 丢失（syncHash 被按本地内容重建）：base 文件与 syncHash 不一致 → 不当作「已一致」覆盖本地，转人工", async () => {
  const { net, server, cs: [A, B] } = await seeded();
  await A.edit(P, (c) => c.replace("- todo", "- A-remote"));
  await net.settle();
  B.vault.set(P, BASE.replace("# T", "# TT"));
  B.sync.set(P, hashContent(B.vault.get(P)));   // 重建
  const before = B.vault.get(P);
  await B.core.onRemote({ path: P, content: A.vault.get(P), contentHash: hashContent(A.vault.get(P)) });
  await net.settle();
  assert.equal(B.vault.get(P), before, "local edit not overwritten");
  assert.equal(B.conflicts.get(P)?.reason, "no-base");
});

await t("CAS 非原子窗口：两端同时通过 CAS（不同位置）；Ack 窗口内收到他端推送 → 按真分叉 diff3 合并，双方改动都保留并收敛", async () => {
  const { net, server, cs: [A, B] } = await seeded();
  server.atomic = false;
  const pa = A.edit(P, (c) => c.replace("- 1", "- A-edit"));
  const pb = B.edit(P, (c) => c.replace("- todo", "- B-edit"));
  await pa; await pb; await net.settle();
  const s = converged({ server, cs: [A, B] });
  assert.ok(s.includes("A-edit") && s.includes("B-edit"), "both edits kept");
  assert.equal(A.conflicts.size + B.conflicts.size, 0);
  await consistent({ server, cs: [A, B] });
});

await t("P0 非原子窗口 + 同行并发编辑：两端各自 Ack 后互相收到对方推送，不得静默互换内容（至少一端进冲突或两端一致）", async () => {
  const { net, server, cs: [A, B] } = await seeded();
  server.atomic = false;
  const pa = A.edit(P, (c) => c.replace("- todo", "- newmac"));
  const pb = B.edit(P, (c) => c.replace("- todo", "- oldmac"));
  await pa; await pb; await net.settle();
  const a = A.vault.get(P), b = B.vault.get(P);
  const flagged = A.conflicts.has(P) || B.conflicts.has(P);
  assert.ok(a === b || flagged, `silent divergence: A=${JSON.stringify(a.slice(-12))} B=${JSON.stringify(b.slice(-12))}`);
  if (a === b) assert.equal(a, server.notes.get(P).content);
  // 无论怎样，两段文本都不能丢（要么在文件里，要么在冲突信息 / lost 副本里）
  const all = [a, b, ...[A, B].flatMap((c) => [c.conflicts.get(P)?.local, c.conflicts.get(P)?.remote, ...c.lost.map((l) => l.content)])].join("\n");
  assert.ok(all.includes("newmac") && all.includes("oldmac"), "no text lost");
});

await t("远端推送在本机上传在途时被推迟，Ack 后再处理（不改写在途 base）", async () => {
  const { net, server, cs: [A, B] } = await seeded();
  const pa = A.edit(P, (c) => c.replace("- 1", "- A1"));
  const pb = B.edit(P, (c) => c.replace("- todo", "- B1"));
  await pa; await pb; await net.settle();
  const s = converged({ server, cs: [A, B] });
  assert.ok(s.includes("A1") && s.includes("B1"));
  await consistent({ server, cs: [A, B] });
});

await t("两端同时在文件末尾各追加一行：保留双方（本地在前远端在后），无冲突", async () => {
  const { net, server, cs: [A, B] } = await seeded();
  const pa = A.edit(P, (c) => c + "- A tail\n");
  const pb = B.edit(P, (c) => c + "- B tail\n");
  await pa; await pb; await net.settle();
  const s = converged({ server, cs: [A, B] });
  assert.ok(s.includes("- A tail\n") && s.includes("- B tail\n"));
  assert.equal(s.split("- A tail").length, 2); assert.equal(s.split("- B tail").length, 2);
  assert.equal(A.conflicts.size + B.conflicts.size, 0);
});

await t("三台设备同时改不同位置：全部收敛且各改动都在", async () => {
  const { net, server, cs } = await seeded(3);
  const ps = [
    cs[0].edit(P, (c) => c.replace("# T", "# TA")),
    cs[1].edit(P, (c) => c.replace("- x", "- xB")),
    cs[2].edit(P, (c) => c + "- C tail\n"),
  ];
  await Promise.all(ps); await net.settle();
  const s = converged({ server, cs });
  assert.ok(s.includes("# TA") && s.includes("- xB") && s.includes("- C tail"));
  assert.ok(cs.every((c) => c.conflicts.size === 0));
  await consistent({ server, cs });
});

await t("连续多轮并发（随机不相交编辑）：始终收敛，不丢任何一行", async () => {
  const { net, server, cs } = await seeded(3, Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n");
  let seed = 7;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  const expected = [];
  for (let round = 0; round < 12; round++) {
    const ps = cs.map((c, i) => {
      const tag = `R${round}C${i}`;
      expected.push(tag);
      // 每台改自己负责的行区（i*10..i*10+9），保证不相交
      return c.edit(P, (txt) => { const ls = txt.split("\n"); ls.splice(i * 10 + rnd(8), 0, tag); return ls.join("\n"); });
    });
    await Promise.all(ps); await net.settle();
    converged({ server, cs });
  }
  const s = server.notes.get(P).content;
  for (const tag of expected) assert.ok(s.includes(tag + "\n"), `lost ${tag}`);
  assert.ok(cs.every((c) => c.conflicts.size === 0));
  await consistent({ server, cs });
});

await t("530 重试超过 5 次转人工 UI", async () => {
  const { net, server, cs: [A] } = await seeded(1);
  A.vault.set(P, BASE.replace("# T", "# TT"));
  // 服务端每次都在 A 重试前再前进：模拟持续竞争
  let n = 0;
  const orig = server.handle.bind(server);
  server.handle = (from, action, data) => {
    if (action === "NoteModify" && n < 10) { n++; server.put(P, server.notes.get(P).content + `- other ${n}\n`); }
    return orig(from, action, data);
  };
  await A.core.requestUpload(P, { kind: "edit" });
  await net.settle();
  assert.equal(A.conflicts.get(P)?.reason, "retries");
});

await t("远端内容 hash 与内容不符：分叉时转 UI，不合并", async () => {
  const { net, cs: [A] } = await seeded(1);
  A.vault.set(P, BASE.replace("# T", "# TT"));
  await A.core.onRemote({ path: P, content: "evil", contentHash: "123" });
  assert.equal(A.conflicts.get(P)?.reason, "hash-mismatch");
});

await t("sweep：在途上传超时后释放（迟到 Ack 视为无登记）", async () => {
  const { net, cs: [A] } = await seeded(1);
  net.now = 1000;
  A.edit(P, (c) => c + "- x\n");
  await new Promise((r) => setImmediate(r));
  assert.ok(A.core.tracker.has(P));
  net.now = 1000 + 31000;
  A.core.sweep();
  assert.equal(A.core.tracker.has(P), false);
});

// ---------------- 二审（qwen3.7-max）逐条回归 ----------------
await t("review r1#1 base 与 syncHash 不一致且本地恰等于 syncHash：不得判 nochange 跳过上传", async () => {
  const { net, server, cs: [B] } = await seeded(1);
  B.vault.set(P, BASE.replace("# T", "# TT"));
  B.sync.set(P, hashContent(B.vault.get(P)));                    // localStorage 丢失后按本地重建
  assert.equal(await B.core.requestUpload(P, { kind: "edit" }), "sent", "must upload instead of silently skipping");
  await net.settle();
  assert.ok(B.sent.length >= 1);
  assert.ok(!server.notes.get(P).content.includes("# TT"), "CAS must not let it overwrite (server differs from rebuilt hash)");
  assert.equal(B.conflicts.get(P)?.reason, "no-base", "falls to manual flow rather than staying silently unsynced");
});

await t("review r1#2 远端内容 hash 不符且本地无文件：落地内容但不死锁，后续编辑可正常上传", async () => {
  const { net, server, cs: [A] } = world(1);
  server.put(P, "server text");
  server.notes.get(P).hash = "999";                              // 服务端存的 hash 与内容不符
  await A.core.onRemote({ path: P, content: "server text", contentHash: "999" });
  assert.equal(A.vault.get(P), "server text");
  await A.edit(P, (c) => c + " more"); await net.settle();
  assert.equal(server.notes.get(P).content, "server text more", "upload with claimed hash as baseHash passes CAS: self-heals");
});

await t("review r1#3 首次上传（无 base）Ack 后收到他端基于它的推送：不产生冗余 lost 副本", async () => {
  const { net, server, cs: [A, B] } = world(2);
  const NN = "new note\n";
  A.vault.set("new.md", NN);
  await A.core.requestUpload("new.md", { kind: "edit" }); await net.settle();
  assert.equal(B.vault.get("new.md"), NN, "B received the new note via broadcast");
  await B.edit("new.md", (c) => c + "more\n"); await net.settle();
  assert.equal(A.vault.get("new.md"), NN + "more\n");
  assert.equal(A.lost.length, 0, "legit descendant must not be saved as lost");
});

await t("review r1#5 超时释放后迟到的 Ack：仍对应该请求，syncHash/base 前进", async () => {
  const { net, server, cs: [A] } = await seeded(1);
  net.now = 1000;
  await A.edit(P, (c) => c + "- late\n");
  net.now = 1000 + 31000;
  A.core.sweep();
  assert.equal(A.core.tracker.has(P), false);
  await net.settle();
  await consistent({ server, cs: [A] });
});

await t("review r3#2 等待并发槽位期间笔记被删除：不得再发 NoteModify（否则服务端复活幽灵文件）", async () => {
  const { net, server, cs: [A] } = await seeded(1);
  let open; A.gate = new Promise((r) => (open = r));
  const p = A.edit(P, (c) => c + "- x\n");
  await new Promise((r) => setImmediate(r));
  A.vault.delete(P); A.core.forget(P);                             // 删除 → forgetNote → core.forget
  open(); await p; await net.settle();
  assert.equal(A.sent.length, 0, "no NoteModify after delete");
});

await t("review r4#2 自动合并抛异常：降级为人工冲突（写冲突记录、本地不动），不能直接放弃", async () => {
  const { net, server, cs: [A, B] } = await seeded();
  B.throwCas = true;
  const pa = A.edit(P, (c) => c + "- A tail\n");
  const pb = B.edit(P, (c) => c.replace("# T", "# TT"));
  await pa; await pb; await net.settle();
  const info = B.conflicts.get(P);
  assert.ok(info, "conflict registered via manual flow");
  assert.equal(info.reason, "error");
  assert.equal(info.remote, A.vault.get(P), "remote content preserved for the dialog");
  assert.ok(info.serverHash);
  assert.ok(B.vault.get(P).includes("# TT"), "local untouched");
});

console.log(`note-merge-core.test.mjs: ${cases} scenarios passed`);
