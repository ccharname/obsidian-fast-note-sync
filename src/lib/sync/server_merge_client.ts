/**
 * 服务端合并「瘦客户端」状态机（规格 server-merge-spec 客户端 2-6 + 修订 R1）。
 * 合并只在服务端锁内做；客户端只负责：带 base 上传、每路径单飞、按 opId 校验 Ack、按 rev 应用/丢弃推送。
 * 本文件不依赖 obsidian / node，所有 IO 经 MergeEnv 注入，便于单测。
 *
 * Thin-client state machine for server-side merge: single flight per path, opId-checked Acks,
 * rev-gated pushes. No obsidian/node imports; IO via MergeEnv.
 */

export interface MergeBase {
  /** hash32：上游兼容 hash，缓存预筛用 */
  hash: string | null;
  /** sha256 hex：身份判断；升级后首次可能为空 */
  sha: string | null;
  rev: number;
}

export interface AckInfo {
  path: string;
  opId?: string;
  rev?: number;
  sha?: string;
  merged?: boolean;
  content?: string;
  conflictCopy?: string;
  rejected?: boolean;
  rejectReason?: string;
}

export interface PushInfo {
  path: string;
  content: string;
  contentHash: string;
  sha?: string;
  rev?: number;
  /** 当前有效对账轮的分页；允许交付旧 rev 的未见正文，仍遵守精确路径 rev。 */
  reconcile?: boolean;
}

export interface ModifyOp {
  path: string;
  content: string;
  hash: string;
  sha: string;
  baseHash: string | null;
  baseSha: string | null;
  opId: string;
  /** 调用方已持有并发槽（先取槽再读正文的路径），发送时不要再取 */
  slotHeld?: boolean;
}

export interface MergeEnv {
  hash(content: string): Promise<string>;
  sha(content: string): Promise<string>;
  newOpId(): string;
  now(): number;
  readLocal(path: string): Promise<string | null>;
  /** 比较并写入：本地当前内容 === expected（null 表示文件应不存在）才写 next，返回是否写入 */
  casWrite(path: string, expected: string | null, next: string): Promise<boolean>;
  getBase(path: string): MergeBase;
  getReplayFloor?(path: string): number;
  endReconcile?(): void;
  /**
   * 提交同步 base。confirmed=true 表示已确认本地正文 == base，此时才允许把该 hash 绑定到
   * 本地文件的 mtime/size 缓存与 lastSyncMtime；false 时只动 base，不碰本地内容缓存。
   */
  setBase(path: string, base: { hash: string; sha: string; rev: number }, confirmed: boolean): void;
  /** 清 base；带 rev 时留下路径墓碑（拒绝 rev ≤ 墓碑的迟到消息） */
  clearBase(path: string, rev?: number): void;
  /** 发送边界：只读 / 同步关闭时为 false，状态机任何写请求都不发 */
  canSend?(): boolean;
  /** 发送 NoteModify（serverMerge:true）；返回 false 表示未真正发出 */
  sendModify(op: ModifyOp): Promise<boolean>;
  log?(msg: string): void;
  /** 定时器（返回取消函数）；缺省则无主动超时重发 */
  setTimer?(fn: () => void, ms: number): () => void;
  random?(): number;
  /** 上传槽：先取槽再读全文与算 sha；false = 未取到（连接重置等） */
  acquireSlot?(path: string): Promise<boolean>;
  releaseSlot?(path: string): void;
  /** 冲突副本推送迟迟未到：主动向服务端拉取该路径（现有增量对账） */
  onCopyMissing?(path: string): void;
  /** 本地文件大小（字节近似），用于读全文前的内存预算判断 */
  localSize?(path: string): number | null;
}

/** 服务端发送队列超限时用该关闭码断开：客户端下次连接必须做完整对账，不能沿用增量水位 */
export const RESYNC_REQUIRED_CODE = 4001;

/** 收到 resyncRequired 关闭码：清零所有增量水位并标记未初始化 → 下次启动同步走全量对账。返回是否触发 */
export const markFullReconcile = (code: number, setMetadata: (field: string, value: unknown) => void): boolean => {
  if (code !== RESYNC_REQUIRED_CODE) return false;
  for (const f of ["lastNoteSyncTime", "lastFileSyncTime", "lastConfigSyncTime", "lastFolderSyncTime"]) setMetadata(f, 0);
  setMetadata("isInitSync", false);
  return true;
};

/** 能力缺失时整会话强制 manualMerge，不沿用用户设置（ignoreTimeMerge 等会在旧服务端丢内容） */
export const effectiveStrategy = (supported: boolean, configured: string): string =>
  supported ? configured : "manualMerge";

export type PushResult = "applied" | "dropped" | "upload" | "legacy";
export type UploadResult = "sent" | "dirty" | "unchanged" | "self" | "failed" | "blocked" | "deferred";
export type AckResult = "ignored" | "ok" | "rejected";

type Kind = "modify" | "delete" | "rename";

interface Inflight {
  kind: Kind;
  opId: string;
  since: number;
  content: string;
  hash: string;
  sha: string;
  /** rename：源路径及其 base */
  oldPath?: string;
  baseSha?: string | null;
  /** 超时重发（同 opId 同正文）与定时器取消 */
  resend?: () => Promise<boolean>;
  cancel?: () => void;
  slotHeld?: boolean;
}

/** 主动超时：在途超过该时长无 Ack 即重发；之后指数退避，上限 5 分钟，带 jitter */
const COPY_WAIT_MS = 10000;
export const RETRY_BASE_MS = 30_000;
export const RETRY_MAX_MS = 300_000;
/** 排队正文总字节上限（超出则只排路径，等在途完成再读） */
export const MAX_QUEUED_BYTES = 32 * 1024 * 1024;

export class ServerMergeClient {
  readonly env: MergeEnv;
  private inflight = new Map<string, Inflight>();
  private dirty = new Set<string>();
  /** 自身写入的正文 sha256：对应 modify 事件到来时按内容比对抑制，而非时间窗 */
  private expected = new Map<string, string>();
  /** Ack 带 conflictCopy 后等待副本推送的看门狗：超时未到 → 主动拉取，避免静默分叉 */
  private copyWatch = new Map<string, () => void>();
  /** rename/delete 排队等待在途 Ack 期间占位：推送与上传不得介入该路径 */
  private busy = new Map<string, number>();
  /** 已发未确认的 modify：同内容重试沿用 opId（跨断线保留） */
  private lastOps = new Map<string, { opId: string; sha: string }>();
  private chains = new Map<string, Promise<unknown>>();
  private waiters = new Map<string, Array<() => void>>();
  /** 每路径连续超时重发次数；Ack 通过清该路径，认证成功清全部（反复「打开即断」不会回到 30s） */
  private retries = new Map<string, number>();
  /** 因内存预算被延后的路径（只排路径，不排正文） */
  private deferred = new Set<string>();
  maxQueuedBytes = MAX_QUEUED_BYTES;
  /** 认证响应 features 含 serverMerge；读到前不发写请求（调用方判 supported） */
  supported = false;
  /** NeedPush 驱动的上传要把 context 带回服务端：按 path 暂存，发送时取走 */
  readonly uploadContexts = new Map<string, string>();

  constructor(env: MergeEnv) {
    this.env = env;
  }

  isInflight(path: string): boolean {
    return this.inflight.has(path);
  }

  /** 断线 / 会话结束：在途与脏标记作废（opId 保留以便同内容重试沿用） */
  reset(): void {
    this.env.endReconcile?.();
    const paths = [...this.inflight.keys()];
    for (const e of this.inflight.values()) e.cancel?.();
    this.inflight.clear();
    this.dirty.clear();
    this.expected.clear();
    for (const c of this.copyWatch.values()) c();
    this.copyWatch.clear();
    this.lastOps.clear();
    this.uploadContexts.clear();
    this.deferred.clear();
    for (const p of paths) this.wake(p);
    this.supported = false;
  }

  /** 认证成功：重置退避计数 */
  onAuthenticated(): void {
    this.retries.clear();
  }

  /** 插件卸载：清空全部状态与定时器 */
  dispose(): void {
    this.reset();
    this.retries.clear();
    this.chains.clear();
    this.waiters.clear();
    this.busy.clear();
  }

  /** 路径完成 / 删除 / rename 后回收该路径的零散状态 */
  private forget(path: string): void {
    this.lastOps.delete(path);
    this.expected.delete(path);
    this.uploadContexts.delete(path);
    this.deferred.delete(path);
  }

  debugSizes(): Record<string, number> {
    return {
      inflight: this.inflight.size, dirty: this.dirty.size, expected: this.expected.size, lastOps: this.lastOps.size,
      uploadContexts: this.uploadContexts.size, retries: this.retries.size, deferred: this.deferred.size, busy: this.busy.size,
    };
  }

  /** Ack 外层副作用（清 pending / 放槽 / 记账）的前置判断：opId 必须匹配在途操作 */
  acceptsAck(a: { path?: string; opId?: string }): boolean {
    if (!a.path || !a.opId) return false;
    const e = this.inflight.get(a.path);
    return !!e && e.opId === a.opId;
  }

  private inflightBytes(): number {
    let n = 0;
    const seen = new Set<Inflight>();
    for (const e of this.inflight.values()) {
      if (seen.has(e)) continue;
      seen.add(e);
      n += e.content.length;
    }
    return n;
  }

  /** 给在途操作挂超时重发定时器：首次 30s，之后指数退避 + jitter，上限 5 分钟 */
  private arm(path: string, entry: Inflight): void {
    if (!this.env.setTimer || !entry.resend) return;
    const n = this.retries.get(path) ?? 0;
    const base = Math.min(RETRY_BASE_MS * 2 ** n, RETRY_MAX_MS);
    const jitter = 0.8 + 0.4 * (this.env.random ? this.env.random() : Math.random());
    entry.cancel?.();
    entry.cancel = this.env.setTimer(() => void this.onTimeout(path, entry), base * jitter);
  }

  private async onTimeout(path: string, entry: Inflight): Promise<void> {
    if (this.inflight.get(path) !== entry || !entry.resend) return;
    this.retries.set(path, (this.retries.get(path) ?? 0) + 1);
    this.env.log?.(`No Ack, resend same opId: ${path} ${entry.opId}`);
    try {
      if (!this.env.canSend || this.env.canSend()) await entry.resend();
    } catch (e) {
      this.env.log?.(`resend failed: ${path} ${String(e)}`);
    }
    if (this.inflight.get(path) === entry) this.arm(path, entry);
  }

  private release(path: string): void {
    const e = this.inflight.get(path);
    if (!e) return;
    e.cancel?.();
    this.inflight.delete(path);
    this.wake(path);
    if (e.oldPath && this.inflight.get(e.oldPath) === e) {
      this.inflight.delete(e.oldPath);
      this.wake(e.oldPath);
    }
    this.drainDeferred();
  }

  /** 在途释放后，补上一个因内存预算延后的路径 */
  private drainDeferred(): void {
    const next = this.deferred.values().next();
    if (next.done) return;
    this.deferred.delete(next.value);
    void this.requestUploadFromDisk(next.value);
  }

  private wake(path: string): void {
    const w = this.waiters.get(path);
    if (!w) return;
    this.waiters.delete(path);
    for (const fn of w) fn();
  }

  /** 等待该路径没有在途操作（rename/delete 等待在途 modify 的 Ack） */
  private async waitIdle(path: string): Promise<void> {
    for (;;) {
      const e = this.inflight.get(path);
      if (!e) return;
      // 在途操作靠主动超时重发 / 断线 reset 收敛，这里只排队等它结束
      await new Promise<void>((resolve) => {
        const arr = this.waiters.get(path) ?? [];
        arr.push(resolve);
        this.waiters.set(path, arr);
      });
    }
  }

  /** 每路径串行化，保证 Ack/推送/删除的「读本地→判定→写」不交叠 */
  private chain<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(path) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => undefined, () => undefined);
    this.chains.set(path, tail);
    void tail.then(() => {
      if (this.chains.get(path) === tail) this.chains.delete(path);
    });
    return run;
  }

  private async isClean(local: string, base: MergeBase): Promise<boolean> {
    const h = await this.env.hash(local);
    if (base.hash === null || h !== base.hash) return false;
    if (base.sha === null) return true;
    return (await this.env.sha(local)) === base.sha;
  }

  /**
   * 上传请求（用户修改 / NeedPush / 重连后发现的本地改动都走这里）。
   * 单飞：在途期间只标 dirty。force：NeedPush 驱动，即使与 base 相同也要发。
   */
  async requestUpload(path: string, content: string, hash: string, force = false): Promise<UploadResult> {
    if (this.env.canSend && !this.env.canSend()) return "blocked";
    if (this.inflight.has(path) || this.busy.has(path)) {
      this.dirty.add(path);
      return "dirty";
    }
    const sha = await this.env.sha(content);
    const pre = this.precheck(path, hash, sha, force);
    if (pre) return pre;
    // await 之后重新检查单飞
    if (this.inflight.has(path) || this.busy.has(path)) {
      this.dirty.add(path);
      return "dirty";
    }
    const entry: Inflight = { kind: "modify", opId: this.opIdFor(path, sha), since: this.env.now(), content, hash, sha };
    this.inflight.set(path, entry);
    return this.launch(path, entry, false);
  }

  /** 自写抑制（sha 比对，用过即删，避免残留）与「与 base 相同」判断 */
  private precheck(path: string, hash: string, sha: string, force: boolean): "self" | "unchanged" | null {
    const exp = this.expected.get(path);
    if (exp !== undefined) {
      this.expected.delete(path);
      if (exp === sha) return "self";
    }
    const base = this.env.getBase(path);
    if (!force && base.hash === hash && (base.sha === null || base.sha === sha)) return "unchanged";
    return null;
  }

  private opIdFor(path: string, sha: string): string {
    const last = this.lastOps.get(path);
    const opId = last && last.sha === sha ? last.opId : this.env.newOpId();
    this.lastOps.set(path, { opId, sha });
    return opId;
  }

  /** 发送并挂超时重发；entry 已登记为在途 */
  private async launch(path: string, entry: Inflight, slotHeld: boolean): Promise<UploadResult> {
    const base = this.env.getBase(path);
    const op: ModifyOp = { path, content: entry.content, hash: entry.hash, sha: entry.sha, baseHash: base.hash, baseSha: base.sha, opId: entry.opId };
    // 重发时槽位仍被这次操作占着
    entry.resend = () => this.env.sendModify({ ...op, slotHeld: true });
    let ok = false;
    try {
      ok = await this.env.sendModify({ ...op, slotHeld });
    } finally {
      if (!ok && this.inflight.get(path) === entry) {
        this.release(path);
        if (slotHeld) this.env.releaseSlot?.(path);
      }
    }
    if (ok && this.inflight.get(path) === entry) this.arm(path, entry);
    return ok ? "sent" : "failed";
  }

  /**
   * 从磁盘上传：先登记路径占位 → 取上传槽 → 才读全文与算 sha（等槽期间不持有正文）；
   * 排队正文总字节超过预算时只排路径（deferred），等在途完成后再读。
   */
  async requestUploadFromDisk(path: string, force = false): Promise<UploadResult> {
    if (this.env.canSend && !this.env.canSend()) return "blocked";
    if (this.inflight.has(path) || this.busy.has(path)) {
      this.dirty.add(path);
      return "dirty";
    }
    const size = this.env.localSize?.(path);
    if (size != null && this.inflight.size > 0 && this.inflightBytes() + size > this.maxQueuedBytes) {
      this.deferred.add(path);
      return "deferred";
    }
    const entry: Inflight = { kind: "modify", opId: this.env.newOpId(), since: this.env.now(), content: "", hash: "", sha: "" };
    this.inflight.set(path, entry);
    const free = (): void => {
      if (this.inflight.get(path) === entry) this.release(path);
    };
    const got = this.env.acquireSlot ? await this.env.acquireSlot(path) : true;
    if (!got) {
      free();
      return "failed";
    }
    if (this.inflight.get(path) !== entry) {
      this.env.releaseSlot?.(path); // 等槽期间被 reset
      return "failed";
    }
    let launched = false;
    try {
      const content = await this.env.readLocal(path);
      if (content === null) {
        free();
        this.env.releaseSlot?.(path);
        return "unchanged";
      }
      const hash = await this.env.hash(content);
      const sha = await this.env.sha(content);
      if (this.inflight.get(path) !== entry) {
        this.env.releaseSlot?.(path);
        return "failed";
      }
      const pre = this.precheck(path, hash, sha, force);
      if (pre) {
        free();
        this.env.releaseSlot?.(path);
        return pre;
      }
      if (this.inflight.size > 1 && this.inflightBytes() + content.length > this.maxQueuedBytes) {
        this.deferred.add(path);
        free();
        this.env.releaseSlot?.(path);
        return "deferred";
      }
      entry.content = content;
      entry.hash = hash;
      entry.sha = sha;
      entry.opId = this.opIdFor(path, sha);
      entry.since = this.env.now();
      launched = true;
      return await this.launch(path, entry, true);
    } catch (e) {
      // 读取 / hash / sha / 发送任一步异常：释放占位与槽，并保留重试路径（短延时退避重试）
      this.env.log?.(`upload failed, will retry: ${path} ${String(e)}`);
      if (this.inflight.get(path) === entry) {
        free();
        this.env.releaseSlot?.(path);
      } else if (!launched) {
        this.env.releaseSlot?.(path);
      }
      this.scheduleRetry(path, force);
      return "failed";
    }
  }

  /** 上传在取槽之后异常：短延时（5s 起指数退避，上限 5 分钟）重新走一遍 */
  private scheduleRetry(path: string, force: boolean): void {
    if (!this.env.setTimer) {
      this.dirty.add(path);
      return;
    }
    const n = this.retries.get(path) ?? 0;
    this.retries.set(path, n + 1);
    const ms = Math.min(5000 * 2 ** n, RETRY_MAX_MS);
    this.env.setTimer(() => void this.requestUploadFromDisk(path, force), ms);
  }

  private async uploadFromDisk(path: string): Promise<void> {
    await this.requestUploadFromDisk(path);
  }

  private markBusy(...paths: string[]): void {
    for (const p of paths) this.busy.set(p, (this.busy.get(p) ?? 0) + 1);
  }

  private unmarkBusy(...paths: string[]): void {
    for (const p of paths) {
      const n = (this.busy.get(p) ?? 0) - 1;
      if (n <= 0) this.busy.delete(p);
      else this.busy.set(p, n);
    }
  }

  /**
   * 删除请求：排队等该路径在途 modify 的 Ack 后发送（只占本模块的路径占位，不持全局 lockManager）。
   * send 回调拿到 opId 与 base，负责真正发消息。
   */
  async requestDelete(path: string, send: (opId: string, baseSha: string | null, isResend: boolean) => Promise<boolean>): Promise<boolean> {
    if (this.env.canSend && !this.env.canSend()) return false;
    this.markBusy(path);
    this.forget(path);
    let entry: Inflight;
    try {
      await this.waitIdle(path);
      const base = this.env.getBase(path);
      entry = { kind: "delete", opId: this.env.newOpId(), since: this.env.now(), content: "", hash: base.hash ?? "", sha: base.sha ?? "" };
      this.inflight.set(path, entry);
    } finally {
      this.unmarkBusy(path);
    }
    let ok = false;
    try {
      ok = await send(entry.opId, entry.sha || null, false);
    } finally {
      if (!ok && this.inflight.get(path) === entry) this.release(path);
    }
    if (ok) {
      entry.resend = () => send(entry.opId, entry.sha || null, true); // 重发复用首发持有的槽
      if (this.inflight.get(path) === entry) this.arm(path, entry);
    }
    return ok;
  }

  /** 重命名请求：只移动不合并；等源与目标路径在途操作结束；Ack 路径 = 新路径。源路径的 dirty 迁移到新路径 */
  async requestRename(oldPath: string, newPath: string, hash: string, send: (opId: string, baseSha: string | null, isResend: boolean) => Promise<boolean>): Promise<boolean> {
    if (this.env.canSend && !this.env.canSend()) return false;
    this.markBusy(oldPath, newPath);
    this.forget(oldPath);
    this.forget(newPath);
    let entry: Inflight;
    try {
      await this.waitIdle(oldPath);
      await this.waitIdle(newPath);
      if (this.dirty.delete(oldPath)) this.dirty.add(newPath);
      const base = this.env.getBase(oldPath);
      entry = {
        kind: "rename", opId: this.env.newOpId(), since: this.env.now(), content: "",
        hash, sha: base.sha ?? "", oldPath, baseSha: base.sha,
      };
      this.inflight.set(newPath, entry);
      this.inflight.set(oldPath, entry);
    } finally {
      this.unmarkBusy(oldPath, newPath);
    }
    let ok = false;
    try {
      ok = await send(entry.opId, entry.baseSha ?? null, false);
    } finally {
      if (!ok && this.inflight.get(newPath) === entry) this.release(newPath);
    }
    if (ok) {
      entry.resend = () => send(entry.opId, entry.baseSha ?? null, true);
      if (this.inflight.get(newPath) === entry) this.arm(newPath, entry);
    }
    return ok;
  }

  /** 处理 NoteModifyAck / NoteDeleteAck / NoteRenameAck。只接受 opId == 在途 opId。 */
  onAck(a: AckInfo): Promise<AckResult> {
    const p = a.path;
    return this.chain(p, async (): Promise<AckResult> => {
      const e = this.inflight.get(p);
      if (!e || !a.opId || e.opId !== a.opId) {
        this.env.log?.(`Ack ignored (no matching in-flight opId): ${p} ${a.opId ?? ""}`);
        return "ignored";
      }
      const rev = a.rev ?? 0;
      let result: AckResult = "ok";
      try {
        if (e.kind === "modify" && a.conflictCopy) this.watchCopy(a.conflictCopy);
        if (e.kind === "modify") await this.ackModify(p, e, a, rev);
        else if (e.kind === "delete") result = await this.ackDelete(p, e, a, rev);
        else result = await this.ackRename(p, e, a, rev);
        if (e.kind === "modify") this.lastOps.delete(p);
        this.retries.delete(p);
      } finally {
        this.release(p);
      }
      if (this.dirty.delete(p)) await this.uploadFromDisk(p);
      return result;
    });
  }

  private setBaseMax(path: string, hash: string, sha: string, rev: number, confirmed: boolean): void {
    const cur = this.env.getBase(path).rev;
    this.env.setBase(path, { hash, sha, rev: Math.max(cur, rev) }, confirmed);
  }

  private watchCopy(copy: string): void {
    if (!this.env.setTimer || !this.env.onCopyMissing) return;
    this.copyWatch.get(copy)?.();
    const cancel = this.env.setTimer(() => {
      this.copyWatch.delete(copy);
      this.env.onCopyMissing?.(copy);
    }, COPY_WAIT_MS);
    this.copyWatch.set(copy, cancel);
  }

  private async ackModify(p: string, e: Inflight, a: AckInfo, rev: number): Promise<void> {
    const local = await this.env.readLocal(p);
    if (a.merged && typeof a.content === "string") {
      if (local === e.content) {
        const hm = await this.env.hash(a.content);
        const shaM = a.sha || (await this.env.sha(a.content));
        this.expected.set(p, shaM);
        if (await this.env.casWrite(p, e.content, a.content)) {
          this.setBaseMax(p, hm, shaM, rev, true);
          return;
        }
        this.expected.delete(p);
      }
      // 本地已继续编辑（或写入时被改）：base = 已发送正文（服务端有其快照），随后重传本地
      this.setBaseMax(p, e.hash, e.sha, rev, false);
      if ((await this.env.readLocal(p)) !== null) this.dirty.add(p);
      return;
    }
    const same = local === e.content;
    this.setBaseMax(p, e.hash, a.sha || e.sha, rev, same);
    // 本地在 Ack 前又变了，但其 modify 事件可能还在防抖队列：自己补一次（幂等，hash==base 则不发）
    if (!same && local !== null) this.dirty.add(p);
  }

  private async ackDelete(p: string, e: Inflight, a: AckInfo, rev: number): Promise<AckResult> {
    if (!a.rejected) {
      this.env.clearBase(p, rev); // 留墓碑：拒绝 rev ≤ 删除 rev 的迟到分页
      return "ok";
    }
    // 被拒：服务端正文已变。恢复文件，不丢内容
    const s = a.content ?? "";
    const hs = await this.env.hash(s);
    const shaS = a.sha || (await this.env.sha(s));
    const local = await this.env.readLocal(p);
    if (local === null) {
      this.expected.set(p, shaS);
      if (await this.env.casWrite(p, null, s)) this.setBaseMax(p, hs, shaS, rev, true);
      else this.expected.delete(p);
    } else if (local === s) {
      this.setBaseMax(p, hs, shaS, rev, true);
    } else {
      // 删除后又重建且不同于返回正文：S 并未落地，不能当祖先快进。
      // base 回到删除前可信祖先（无祖先则无 base），rev 升到 Ack 的 rev，交服务端三方合并 / 冲突副本
      if (e.hash && e.sha) this.setBaseMax(p, e.hash, e.sha, rev, false);
      else this.env.clearBase(p, rev);
      this.dirty.add(p);
    }
    return "rejected";
  }

  private async ackRename(p: string, e: Inflight, a: AckInfo, rev: number): Promise<AckResult> {
    const old = e.oldPath as string;
    if (a.rejected) {
      // 目标已存在且不同 / 源不存在：本地文件保持不动，作为新建上传（无 base），由服务端处理冲突副本
      this.env.clearBase(p);
      this.dirty.add(p);
      return "rejected";
    }
    this.env.clearBase(old, rev);
    const local = await this.env.readLocal(p);
    if (a.merged && typeof a.content === "string") {
      // 源与 base 不一致：服务端回发 S。本地仍等于移动前的内容 → 落地 S，否则以旧 base 重传
      // 「本地仍是移动前的内容」只认可信祖先 sha（hash32 会碰撞，BB/Aa 同 hash32），无祖先 sha 时保守视为已改
      const baseLike = local !== null && local !== a.content && !!e.sha && (await this.env.sha(local)) === e.sha;
      const hs = await this.env.hash(a.content);
      const shaS = a.sha || (await this.env.sha(a.content));
      if (local === a.content) {
        this.setBaseMax(p, hs, shaS, rev, true);
      } else if (baseLike) {
        this.expected.set(p, shaS);
        if (await this.env.casWrite(p, local, a.content)) this.setBaseMax(p, hs, shaS, rev, true);
        else {
          this.expected.delete(p);
          this.dirty.add(p);
        }
      } else {
        if (e.hash) this.setBaseMax(p, e.hash, e.sha, rev, false);
        this.dirty.add(p);
      }
      return "ok";
    }
    // 只移动：新路径实际正文与服务端 sha 不同（移动前有未上传的编辑）→ 补传差异
    const serverSha = a.sha || e.sha;
    if (local === null) {
      this.setBaseMax(p, e.hash, serverSha, rev, false);
      return "ok";
    }
    const equal = serverSha ? (await this.env.sha(local)) === serverSha : (await this.env.hash(local)) === e.hash;
    this.setBaseMax(p, e.hash, serverSha, rev, equal);
    if (!equal) this.dirty.add(p);
    return "ok";
  }

  /** NoteSyncMtime 替代 Ack 的场景（内容相同）：只解除在途并补发 dirty */
  settle(path: string): Promise<void> {
    return this.chain(path, async () => {
      if (!this.inflight.has(path)) return;
      this.release(path);
      if (this.dirty.delete(path)) await this.uploadFromDisk(path);
    });
  }

  /** 推送（含分页下发）的 rev 门控，用于重命名等不由本模块应用的推送：true = 可应用 */
  admit(path: string, rev?: number, reconcile = false): boolean {
    const r = rev ?? 0;
    if (r <= 0) return true;
    if (!reconcile && r <= (this.env.getReplayFloor?.(path) ?? 0)) return false;
    if (r <= this.env.getBase(path).rev) return false;
    return !this.inflight.has(path) && !this.busy.has(path);
  }

  /** 他端写入的推送。按 rev 门控；rev 缺失 = 旧行为（legacy）。 */
  onPush(m: PushInfo): Promise<PushResult> {
    this.copyWatch.get(m.path)?.();
    this.copyWatch.delete(m.path);
    const rev = m.rev ?? 0;
    if (rev <= 0) return Promise.resolve("legacy");
    const p = m.path;
    return this.chain(p, async (): Promise<PushResult> => {
      const base = this.env.getBase(p);
      if (rev <= base.rev) return "dropped";
      if (!m.reconcile && rev <= (this.env.getReplayFloor?.(p) ?? 0)) return "dropped";
      if (this.inflight.has(p) || this.busy.has(p)) return "dropped";
      let local = await this.env.readLocal(p);
      const sha = m.sha || (await this.env.sha(m.content));
      if (local !== null && local === m.content) {
        this.env.setBase(p, { hash: m.contentHash, sha, rev }, true);
        return "applied";
      }
      if (local === null || (await this.isClean(local, base))) {
        this.expected.set(p, sha);
        if (await this.env.casWrite(p, local, m.content)) {
          this.env.setBase(p, { hash: m.contentHash, sha, rev }, true);
          return "applied";
        }
        this.expected.delete(p);
        local = await this.env.readLocal(p);
        if (local === null) return "dropped";
      }
      // 本地有未上传改动：不应用，立即上传（服务端三方合并）；只读 / 发送被拦时只丢弃，不发写请求。
      // 走先取槽再读全文的路径（不占着正文等槽），占位同步登记；不在 chain 里等槽，免得堵住该路径的 Ack 处理
      if (this.env.canSend && !this.env.canSend()) return "dropped";
      void this.requestUploadFromDisk(p);
      return "upload";
    });
  }

  /** 远端删除：apply = 调用方按上游流程删除本地；skip = 已处理（丢弃或保留本地并重新上传） */
  onRemoteDelete(path: string, rev?: number, reconcile = false): Promise<"apply" | "skip"> {
    const r = rev ?? 0;
    if (r <= 0) return Promise.resolve("apply");
    return this.chain(path, async (): Promise<"apply" | "skip"> => {
      const base = this.env.getBase(path);
      if (r <= base.rev) return "skip";
      if (!reconcile && r <= (this.env.getReplayFloor?.(path) ?? 0)) return "skip";
      if (this.inflight.has(path) || this.busy.has(path)) return "skip";
      const local = await this.env.readLocal(path);
      if (local === null) return "apply";
      if (await this.isClean(local, base)) return "apply";
      // 本地有改动：保留并以新建上传（无 base）
      this.env.clearBase(path, r);
      void this.requestUploadFromDisk(path, true);
      return "skip";
    });
  }
}
