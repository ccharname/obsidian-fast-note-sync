// 协议级桩：按 server-merge-protocol.md（含 R1）实现服务端锁内语义的最小子集，
// 多个客户端经可控队列接到同一服务端，复现 Ack 迟到 / 乱序 / 重复 / 离线双改等时序。
// 合并本身由注入的 mergeFn 决定（真实 diff3 在服务端 Go 里测）。
import crypto from "node:crypto";
import { loadTs, hashContent } from "./load-ts.mjs";

const { ServerMergeClient, effectiveStrategy, markFullReconcile, RESYNC_REQUIRED_CODE } = loadTs("src/lib/sync/server_merge_client.ts");
export { effectiveStrategy, markFullReconcile, RESYNC_REQUIRED_CODE };
export const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
export { hashContent };

export class Net {
  queue = []; timers = [];
  addTimer(fn, ms) { const t = { fn, ms, off: false }; this.timers.push(t); return () => { t.off = true; }; }
  /** 触发最早的未取消定时器，返回其延迟 */
  fireTimer() { const i = this.timers.findIndex((t) => !t.off); if (i < 0) return null; const [t] = this.timers.splice(i, 1); t.off = true; t.fn(); return t.ms; }
  liveTimers() { return this.timers.filter((t) => !t.off).length; }
  enqueue(fn) { this.queue.push(fn); }
  async drain() { while (this.queue.length) await this.queue.shift()(); }
}

export class Server {
  notes = new Map(); // path -> {content, rev}
  clients = []; ops = new Map(); revSeq = 100; net; log = [];
  /** (base|null, S, C) -> {kind:"merged", content} | {kind:"conflict"} */
  mergeFn = (base, s, c) => (base === s ? { kind: "ff", content: c } : { kind: "merged", content: `${s}\n${c}` });
  constructor(net) { this.net = net; }
  nextRev() { return ++this.revSeq; }
  put(path, content) { const rev = this.nextRev(); this.notes.set(path, { content, rev }); return rev; }
  /** 有序发送：Ack 与广播入各连接队列 */
  send(c, action, data) { this.net.enqueue(async () => c.receive(action, data)); }
  broadcast(from, action, data) { for (const c of this.clients) if (c !== from) this.send(c, action, data); }
  handle(from, action, d) {
    this.log.push([from.id, action, d.path, d]);
    if (this.ops.has(d.opId)) return this.send(from, this.ops.get(d.opId).action, this.ops.get(d.opId).ack);
    const reply = (act, ack) => { if (d.opId) this.ops.set(d.opId, { action: act, ack }); this.send(from, act, ack); };
    if (action === "NoteModify") {
      const s = this.notes.get(d.path);
      let ack;
      if (!s) {
        const rev = this.put(d.path, d.content);
        ack = { path: d.path, opId: d.opId, rev, sha: sha(d.content), merged: false };
        this.broadcast(from, "NoteSyncModify", { path: d.path, content: d.content, contentHash: hashContent(d.content), sha: sha(d.content), rev });
      } else if (s.content === d.content) {
        ack = { path: d.path, opId: d.opId, rev: s.rev, sha: sha(s.content), merged: false };
      } else {
        const baseOk = d.baseSha ? sha(s.content) === d.baseSha : d.baseHash === hashContent(s.content);
        const base = baseOk ? s.content : (d.baseSha ? this.snaps?.get(d.baseSha) ?? null : null);
        const r = baseOk ? { kind: "ff", content: d.content } : base === null ? { kind: "conflict" } : this.mergeFn(base, s.content, d.content);
        if (r.kind === "conflict") {
          ack = { path: d.path, opId: d.opId, rev: s.rev, sha: sha(s.content), merged: true, content: s.content, conflictCopy: `${d.path}.conflict-x.md` };
        } else {
          const rev = this.put(d.path, r.content);
          const m = r.content !== d.content;
          ack = { path: d.path, opId: d.opId, rev, sha: sha(r.content), merged: m, ...(m ? { content: r.content } : {}) };
          this.broadcast(from, "NoteSyncModify", { path: d.path, content: r.content, contentHash: hashContent(r.content), sha: sha(r.content), rev });
        }
      }
      (this.snaps ??= new Map()).set(sha(d.content), d.content);
      reply("NoteModifyAck", ack);
    } else if (action === "NoteDelete") {
      const s = this.notes.get(d.path);
      if (!s) return reply("NoteDeleteAck", { path: d.path, opId: d.opId, rev: this.revSeq });
      if (sha(s.content) !== d.baseSha) return reply("NoteDeleteAck", { path: d.path, opId: d.opId, rev: s.rev, rejected: true, rejectReason: "contentChanged", content: s.content, sha: sha(s.content) });
      this.notes.delete(d.path);
      const rev = this.nextRev();
      reply("NoteDeleteAck", { path: d.path, opId: d.opId, rev });
      this.broadcast(from, "NoteSyncDelete", { path: d.path, rev });
    } else if (action === "NoteRename") {
      const s = this.notes.get(d.oldPath);
      if (!s) return reply("NoteRenameAck", { path: d.path, opId: d.opId, rev: this.revSeq, rejected: true, rejectReason: "sourceMissing" });
      const t = this.notes.get(d.path);
      if (t && t.content !== s.content) return reply("NoteRenameAck", { path: d.path, opId: d.opId, rev: t.rev, rejected: true, rejectReason: "targetExists", content: t.content, sha: sha(t.content) });
      this.notes.delete(d.oldPath);
      const rev = this.put(d.path, s.content);
      reply("NoteRenameAck", { path: d.path, opId: d.opId, rev, sha: sha(s.content), merged: false });
    }
  }
}

export class Client {
  vault = new Map(); base = new Map(); // path -> {hash, sha, rev}
  tomb = new Map(); cached = new Map(); readonly = false; // 墓碑 rev / 「本地内容缓存」绑定的 hash（仅确认本地==base 时更新）
  sent = []; writes = []; id; locks = new Set(); slots = 0; reads = 0; noSlot = false; missing = [];
  constructor(id, net, server) {
    this.id = id; this.net = net; this.server = server;
    let n = 0;
    const self = this;
    this.sm = new ServerMergeClient({
      hash: async (c) => hashContent(c),
      sha: async (c) => sha(c),
      newOpId: () => `${id}-op${++n}`,
      now: () => net.now ?? Date.now(),
      readLocal: async (p) => { self.reads++; if (self.readFail) { self.readFail = false; throw new Error("ENOENT"); } return self.vault.get(p) ?? null; },
      setTimer: (fn, ms) => net.addTimer(fn, ms),
      random: () => 0.5,
      onCopyMissing: (p) => self.missing.push(p),
      acquireSlot: async () => { if (self.slotGate) await self.slotGate; if (self.noSlot) return false; self.slots++; return true; },
      releaseSlot: () => { self.slots--; },
      localSize: (p) => (self.vault.get(p) ?? "").length,
      casWrite: async (p, expected, next) => {
        if (self.failCas) { const f = self.failCas; self.failCas = null; f(); return false; }
        const cur = self.vault.get(p) ?? null;
        if (cur !== expected) return false;
        self.vault.set(p, next); self.writes.push([p, next]); return true;
      },
      canSend: () => !self.readonly,
      getBase: (p) => { const b = self.base.get(p); const t = self.tomb.get(p) || 0; return b ? { hash: b.hash, sha: b.sha || null, rev: Math.max(b.rev || 0, t) } : { hash: null, sha: null, rev: t }; },
      setBase: (p, b, confirmed) => { self.base.set(p, { ...b }); self.tomb.delete(p); if (confirmed) self.cached.set(p, b.hash); },
      clearBase: (p, rev) => { self.base.delete(p); self.cached.delete(p); if (rev) self.tomb.set(p, Math.max(rev, self.tomb.get(p) || 0)); },
      sendModify: async (op) => {
        if (self.gate) await self.gate;
        if (!op.slotHeld) self.slots++;
        const d = { path: op.path, content: op.content, contentHash: op.hash, opId: op.opId, serverMerge: true, ...(op.baseHash !== null ? { baseHash: op.baseHash } : {}), ...(op.baseSha ? { baseSha: op.baseSha } : {}) };
        self.sent.push(["NoteModify", d]);
        net.enqueue(async () => server.handle(self, "NoteModify", d));
        return true;
      },
    });
    this.sm.supported = true;
    server.clients.push(this);
  }
  async receive(action, d) {
    if (action === "NoteModifyAck" || action === "NoteDeleteAck" || action === "NoteRenameAck") return this.sm.onAck(d);
    if (action === "NoteSyncModify") return this.sm.onPush({ path: d.path, content: d.content, contentHash: d.contentHash, sha: d.sha, rev: d.rev });
    if (action === "NoteSyncDelete") {
      if ((await this.sm.onRemoteDelete(d.path, d.rev)) === "apply") { this.vault.delete(d.path); this.sm.env.clearBase(d.path, d.rev); }
    }
  }
  /** 已与服务端一致的初始状态 */
  seed(path, content) {
    const rev = this.server.notes.has(path) ? this.server.notes.get(path).rev : this.server.put(path, content);
    this.vault.set(path, content);
    this.base.set(path, { hash: hashContent(content), sha: sha(content), rev });
    (this.server.snaps ??= new Map()).set(sha(content), content);
  }
  /** 用户编辑 + modify 事件 */
  async edit(path, content) {
    this.vault.set(path, content);
    return this.sm.requestUpload(path, content, hashContent(content));
  }
  uploads() { return this.sent.filter(([a]) => a === "NoteModify").map(([, d]) => d); }
}
