export type UploadResult = 'acknowledged' | 'duplicate' | 'failed' | 'cancelled';
export type UploadTicket = {
  path: string; key: string; cancelled: boolean; acked: boolean;
  generation?: number; slotAcquired?: boolean;
  work: (ticket: UploadTicket) => Promise<boolean>;
  done: Promise<UploadResult>; settle: (result: UploadResult) => void;
  ack: Promise<void>; signalAck: () => void;
};

export class FileUploadBodyGate {
  active = 0;
  readonly pending: { ticket: UploadTicket; settle: (allowed: boolean) => void }[] = [];
  constructor(private readonly capacity: () => number) {}
  acquire(ticket: UploadTicket): Promise<boolean> {
    if (ticket.cancelled) return Promise.resolve(false);
    const result = new Promise<boolean>(settle => { this.pending.push({ ticket, settle }); });
    this.refresh();
    return result;
  }
  release(): void {
    if (this.active <= 0) throw new Error('FileUpload body admission released twice');
    this.active--;
    this.refresh();
  }
  refresh(): void {
    while (this.pending.length && this.active < this.capacity()) {
      const next = this.pending.shift()!;
      if (next.ticket.cancelled) { next.settle(false); continue; }
      this.active++;
      next.settle(true);
    }
  }
  cancelTicket(ticket: UploadTicket): void {
    const index = this.pending.findIndex(next => next.ticket === ticket);
    if (index >= 0) this.pending.splice(index, 1)[0].settle(false);
  }
  cancelPending(): void { for (const next of this.pending.splice(0)) next.settle(false); }
}

/** Path/session metadata remains until ACK; body admission starts after the shared limiter. */
export class FileUploadCoordinator {
  readonly active = new Map<string, UploadTicket>();
  readonly pending: UploadTicket[] = [];
  readonly sessions = new Map<string, UploadTicket>();
  readonly completed = new Map<string, true>();
  readonly buffers: FileUploadBodyGate;

  constructor(
    capacity: () => number,
    private readonly onCancelPath: (path: string) => void = () => {},
    private readonly completedLimit = 256,
  ) { this.buffers = new FileUploadBodyGate(capacity); }

  run(path: string, sessionId: string, work: UploadTicket['work']): Promise<UploadResult> {
    const key = path + '\0' + sessionId;
    if (this.completed.has(key)) return Promise.resolve('duplicate');
    const existing = this.sessions.get(key);
    if (existing && !existing.cancelled) return existing.done;
    let settle!: UploadTicket['settle'];
    let signalAck!: UploadTicket['signalAck'];
    const done = new Promise<UploadResult>(resolve => { settle = resolve; });
    const ack = new Promise<void>(resolve => { signalAck = resolve; });
    const ticket: UploadTicket = { path, key, work, done, settle, ack, signalAck, cancelled: false, acked: false };
    this.sessions.set(key, ticket);
    this.pending.push(ticket);
    this.refresh();
    return done;
  }

  acknowledge(path: string): void {
    const ticket = this.active.get(path);
    if (ticket && !ticket.cancelled) {
      ticket.acked = true;
      ticket.signalAck();
    }
  }

  cancel(path: string): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const ticket = this.pending[i];
      if (ticket.path !== path) continue;
      this.pending.splice(i, 1);
      ticket.cancelled = true;
      this.sessions.delete(ticket.key);
      ticket.settle('cancelled');
    }
    const ticket = this.active.get(path);
    if (ticket) {
      ticket.cancelled = true;
      this.onCancelPath(path);
      this.buffers.cancelTicket(ticket);
      ticket.signalAck();
    }
  }

  sessionTicket(sessionId: string): UploadTicket | undefined {
    const suffix = '\0' + sessionId;
    for (const ticket of this.sessions.values()) if (ticket.key.endsWith(suffix)) return ticket;
    return undefined;
  }

  sessionPath(sessionId: string): string | undefined {
    const suffix = '\0' + sessionId;
    for (const ticket of this.sessions.values()) if (ticket.key.endsWith(suffix)) return ticket.path;
    return undefined;
  }

  cancelSession(sessionId: string): void {
    const suffix = '\0' + sessionId;
    for (const ticket of this.sessions.values()) {
      if (!ticket.key.endsWith(suffix)) continue;
      ticket.cancelled = true;
      if (this.active.get(ticket.path) === ticket) {
        this.onCancelPath(ticket.path);
        this.buffers.cancelTicket(ticket);
        ticket.signalAck();
      } else {
        const index = this.pending.indexOf(ticket);
        if (index >= 0) this.pending.splice(index, 1);
        this.sessions.delete(ticket.key);
        ticket.settle('cancelled');
      }
    }
  }

  cancelAll(): void {
    for (const ticket of this.pending.splice(0)) {
      ticket.cancelled = true;
      this.sessions.delete(ticket.key);
      ticket.settle('cancelled');
    }
    for (const ticket of this.active.values()) {
      ticket.cancelled = true;
      this.onCancelPath(ticket.path);
      ticket.signalAck();
    }
    this.buffers.cancelPending();
    // Native readBinary cannot be cancelled: its finally block releases body admission.
  }

  refresh(): void {
    // Waiting for the shared limiter must not consume a body admission.
    while (true) {
      // Preserve FIFO among eligible paths; a busy path cannot block unrelated paths.
      const index = this.pending.findIndex(ticket => !this.active.has(ticket.path));
      if (index < 0) return;
      const [ticket] = this.pending.splice(index, 1);
      this.active.set(ticket.path, ticket);
      void this.execute(ticket);
    }
  }

  private async execute(ticket: UploadTicket): Promise<void> {
    let result: UploadResult = 'failed';
    try {
      const sent = !ticket.cancelled && await ticket.work(ticket);
      if (sent && !ticket.cancelled) await ticket.ack;
      if (ticket.cancelled) result = 'cancelled';
      else if (sent && ticket.acked) {
        result = 'acknowledged';
        this.completed.set(ticket.key, true);
        while (this.completed.size > this.completedLimit) this.completed.delete(this.completed.keys().next().value!);
      }
    } catch {
      result = ticket.cancelled ? 'cancelled' : 'failed';
    } finally {
      if (this.active.get(ticket.path) === ticket) this.active.delete(ticket.path);
      if (this.sessions.get(ticket.key) === ticket) this.sessions.delete(ticket.key);
      ticket.settle(result);
      this.refresh();
    }
  }
}

type PluginLike = { settings: { concurrencyControlEnabled: boolean; maxConcurrentUploads: number } };
const coordinators = new WeakMap<object, FileUploadCoordinator>();
export function getFileUploadCoordinator(plugin: PluginLike, cancelPath?: (path: string) => void): FileUploadCoordinator {
  let coordinator = coordinators.get(plugin);
  if (!coordinator) {
    coordinator = new FileUploadCoordinator(
      () => plugin.settings.concurrencyControlEnabled ? Math.max(1, plugin.settings.maxConcurrentUploads) : Infinity,
      cancelPath,
    );
    coordinators.set(plugin, coordinator);
  }
  return coordinator;
}
export function cancelFileUploadJobs(plugin: object): void { coordinators.get(plugin)?.cancelAll(); }
export function acknowledgeFileUpload(plugin: object, path: string): void { coordinators.get(plugin)?.acknowledge(path); }
export function cancelFileUploadPath(plugin: object, path: string): void { coordinators.get(plugin)?.cancel(path); }

export function getFileUploadSessionPath(plugin: object, sessionId: string): string | undefined { return coordinators.get(plugin)?.sessionPath(sessionId); }
export function cancelFileUploadSession(plugin: object, sessionId: string): void { coordinators.get(plugin)?.cancelSession(sessionId); }

export function acquireFileUploadBuffer(plugin: PluginLike, ticket: UploadTicket): Promise<boolean> { return getFileUploadCoordinator(plugin).buffers.acquire(ticket); }
export function releaseFileUploadBuffer(plugin: PluginLike): void { getFileUploadCoordinator(plugin).buffers.release(); }

export function getFileUploadSessionTicket(plugin: object, sessionId: string): UploadTicket | undefined { return coordinators.get(plugin)?.sessionTicket(sessionId); }
