// 协议级桩：服务端实现 manualMerge 的 baseHash CAS（530 带 serverContent/serverHash），
// 多个 NoteMergeCore 客户端经可控队列接到同一服务端，用来复现 Ack 迟到、并发写、CAS 非原子窗口等时序
import { loadTs, hashContent } from "./load-ts.mjs";

const { NoteMergeCore } = loadTs("src/lib/sync/note_merge_core.ts");
const { BaseStore } = loadTs("src/lib/storage/base_store.ts");

export function memAdapter() {
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

export class Net {
  queue = []; timers = [];
  enqueue(fn) { this.queue.push(fn); }
  async drain() { while (this.queue.length) await this.queue.shift()(); }
  async settle() {
    for (let i = 0; i < 60; i++) {
      await this.drain();
      await new Promise((r) => setImmediate(r));
      if (this.queue.length) continue;
      if (!this.timers.length) return;
      const t = this.timers.splice(0);
      for (const fn of t) fn();
    }
    throw new Error("net did not settle");
  }
}

export class Server {
  notes = new Map(); clients = []; log = []; atomic = true; strategy = "manualMerge";
  constructor(net) { this.net = net; }
  put(path, content) { this.notes.set(path, { content, hash: hashContent(content) }); }
  reply(c, action, data) { this.net.enqueue(async () => c.receive(action, data)); }
  handle(from, action, data) {
    this.log.push([from.id, action, data.path]);
    if (action === "NoteRePush") {
      const n = this.notes.get(data.path);
      if (n) this.reply(from, "NoteSyncModify", { path: data.path, content: n.content, contentHash: n.hash });
      else this.reply(from, "NoteSyncDelete", { path: data.path });
      return;
    }
    if (action !== "NoteModify") return;
    const n = this.notes.get(data.path);
    if (n && n.hash === data.contentHash) return this.reply(from, "NoteModifyAck", { path: data.path });
    if (n && !data.isConflictResolved && (n.hash !== data.baseHash || data.baseHashMissing)) {
      return this.reply(from, "530", { path: data.path, serverContent: n.content, serverHash: n.hash, baseContent: n.content });
    }
    const commit = () => {
      this.put(data.path, data.content);
      this.reply(from, "NoteModifyAck", { path: data.path });
      for (const c of this.clients) if (c !== from) this.reply(c, "NoteSyncModify", { path: data.path, content: data.content, contentHash: hashContent(data.content) });
    };
    if (this.atomic) commit();
    else this.net.enqueue(async () => commit());
  }
}

export class Client {
  vault = new Map(); sync = new Map(); conflicts = new Map(); sent = []; lost = []; logs = []; failCas = 0; casAttempts = 0; locks = new Map();
  constructor(id, net, server) {
    this.id = id; this.net = net; this.server = server;
    this.adapter = memAdapter();
    this.base = new BaseStore({ adapter: this.adapter, dir: "base", hash: hashContent });
    const self = this;
    this.core = new NoteMergeCore({
      hash: hashContent, now: () => net.now ?? Date.now(), baseStore: this.base,
      async locked(path, fn) {
        const prev = self.locks.get(path) ?? Promise.resolve();
        let release; const next = new Promise((r) => (release = r));
        self.locks.set(path, prev.then(() => next));
        await prev;
        try { return await fn(); } finally { release(); }
      },
      readNote: async (p) => self.vault.get(p) ?? null,
      casWrite: async (p, expected, next) => {
        self.casAttempts++;
        if (self.failCas > 0) { self.failCas--; return false; }
        if (self.vault.get(p) !== expected) return false;
        self.vault.set(p, next); return true;
      },
      createNote: async (p, c) => { self.vault.set(p, c); },
      statNote: (p) => (self.vault.has(p) ? { mtime: 1, ctime: 1, size: self.vault.get(p).length } : null),
      getSyncHash: (p) => self.sync.get(p) ?? null,
      setSyncHash: (p, h) => self.sync.set(p, h),
      removeSyncHash: (p) => self.sync.delete(p),
      isConflicted: (p) => self.conflicts.has(p),
      registerConflict: async (p, info) => { self.conflicts.set(p, info); },
      clearConflict: async (p) => { self.conflicts.delete(p); },
      sendUpload: async (p, e) => {
        const data = { path: p, content: e.content, contentHash: e.contentHash, ...(e.baseHash !== null ? { baseHash: e.baseHash } : { baseHashMissing: true }), ...(e.kind === "resolved" ? { isConflictResolved: true } : {}) };
        self.sent.push(data); net.enqueue(async () => server.handle(self, "NoteModify", data)); return true;
      },
      sendRePush: (p) => net.enqueue(async () => server.handle(self, "NoteRePush", { path: p })),
      releaseSlot() {}, setPending() {}, clearPending() {},
      saveLost: async (p, c, why) => { self.lost.push({ path: p, content: c, why }); },
      log: (action, message) => self.logs.push([action, message]),
      schedule: (fn) => net.timers.push(fn),
    });
    server.clients.push(this);
  }
  async receive(action, data) {
    if (action === "NoteModifyAck") return this.core.onAck(data.path);
    if (action === "NoteSyncModify") return this.core.onRemote(data);
    if (action === "530") return this.core.onConflict(data);
  }
  /** 与服务端已确认一致的初始状态（含 base） */
  async seed(path, content) {
    this.server.put(path, content);
    this.vault.set(path, content); this.sync.set(path, hashContent(content));
    await this.base.put(path, content, hashContent(content));
  }
  async seedFromServer(path) {
    const n = this.server.notes.get(path);
    this.vault.set(path, n.content); this.sync.set(path, n.hash);
    await this.base.put(path, n.content, n.hash);
  }
  /** 用户编辑（本地写盘 + modify 事件触发上传） */
  edit(path, fn) { this.vault.set(path, fn(this.vault.get(path))); return this.core.requestUpload(path, { kind: "edit" }); }
  noteModifies() { return this.sent.length; }
}
