import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const noop = () => {};
const module = { exports: {} };
const code = ts.transpileModule(fs.readFileSync('src/lib/sync/operator.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
vm.runInNewContext(code, { module, exports: module.exports, console, window: { setTimeout: () => 1, clearTimeout: noop },
  require: id => id === 'obsidian' ? { normalizePath: x => x, TFile: class {}, Platform: {} }
    : id.includes('helpers') ? { dump: noop }
    : id.includes('operator_file') ? { sweepStalledDownloadSessions: async () => undefined }
    : id.includes('sync_log_manager') ? { SyncLogManager: { getInstance: () => ({ addOrUpdateLog: noop }) } }
    : id.includes('i18n') ? { $: k => k } : {} });
const { isSyncStalled, SYNC_STALL_RESTART_MS, SYNC_STALL_HARD_RESTART_MS } = module.exports;

const mk = () => ({
  noteSyncTasks: { completed: 1, failed: 0 }, fileSyncTasks: { completed: 5, failed: 0 },
  folderSyncTasks: { completed: 0 }, configSyncTasks: { completed: 0 },
  uploadedChunksCount: 0, downloadedChunksCount: 0,
  progressTracker: { getOverallPct: () => 40 },
  concurrencyLimiter: { activeKeys: new Set(), queue: [] },
  fileDownloadSessions: new Map(), isSyncRequesting: false,
});
const t0 = 1_000_000;
const p = mk();
assert.equal(isSyncStalled(p, 'ctx', t0), false, 'first observation only records the baseline');
assert.equal(isSyncStalled(p, 'ctx', t0 + SYNC_STALL_RESTART_MS - 1), false);
assert.equal(isSyncStalled(p, 'ctx', t0 + SYNC_STALL_RESTART_MS + 1), true, 'idle and unchanged past the limit');

// Progress resets the clock
p.fileSyncTasks.completed++;
assert.equal(isSyncStalled(p, 'ctx', t0 + 2 * SYNC_STALL_RESTART_MS), false);
assert.equal(isSyncStalled(p, 'ctx', t0 + 2 * SYNC_STALL_RESTART_MS + 1000), false);

// Work in flight is not a (soft) stall at the idle limit...
const q = mk();
q.concurrencyLimiter.activeKeys.add('upload_x');
isSyncStalled(q, 'ctx2', t0);
assert.equal(isSyncStalled(q, 'ctx2', t0 + 5 * SYNC_STALL_RESTART_MS), false);
q.concurrencyLimiter.activeKeys.clear();
q.fileDownloadSessions.set('s', {});
assert.equal(isSyncStalled(q, 'ctx2', t0 + 5 * SYNC_STALL_RESTART_MS), false);
// ...but a frozen round with in-flight work still cannot hang forever (hard cap)
assert.equal(isSyncStalled(q, 'ctx2', t0 + SYNC_STALL_HARD_RESTART_MS + 1), true, 'hard cap restarts even with work in flight');
const h = mk();
h.concurrencyLimiter.activeKeys.add('lost-ack');
isSyncStalled(h, 'ctx3', t0);
assert.equal(isSyncStalled(h, 'ctx3', t0 + SYNC_STALL_HARD_RESTART_MS + 1), true, 'leaked slot (lost ACK) is recovered by hard cap');
h.fileSyncTasks.completed++;
assert.equal(isSyncStalled(h, 'ctx3', t0 + SYNC_STALL_HARD_RESTART_MS + 2), false, 'progress resets the hard clock too');

// A new context starts a fresh baseline
const r = mk();
isSyncStalled(r, 'a', t0);
assert.equal(isSyncStalled(r, 'b', t0 + 10 * SYNC_STALL_RESTART_MS), false);

// Exercise the full completion check: long-running active work must not be
// forced complete by the old wall-clock timeout before the idle watchdog runs.
let now = 50_000_000;
class FakeDate extends Date {
  static now() { return now; }
}
const integrationModule = { exports: {} };
const integrationCode = ts.transpileModule(fs.readFileSync('src/lib/sync/operator.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
vm.runInNewContext(integrationCode, {
  module: integrationModule,
  exports: integrationModule.exports,
  console,
  Date: FakeDate,
  WebSocket: { OPEN: 1 },
  window: { setTimeout: () => 1, clearInterval: noop },
  require: id => id === 'obsidian' ? { normalizePath: x => x, TFile: class {}, TFolder: class {} }
    : id.includes('helpers') ? { dump: noop }
    : id.includes('operator_file') ? { sweepStalledDownloadSessions: async () => undefined }
    : id.includes('sync_log_manager') ? { SyncLogManager: { getInstance: () => ({ addOrUpdateLog: noop }) } }
    : id.includes('i18n') ? { $: key => key }
    : {},
});
const { checkSyncCompletion } = integrationModule.exports;
const statusUpdates = [];
const failIfReset = () => { throw new Error('active long-running sync must not be reset'); };
const longRunning = {
  syncState: { activeSyncContext: 'long-running', progressCheckIntervalId: 1 },
  settings: { syncEnabled: true, configSyncEnabled: false, isShowNotice: false },
  noteSyncTasks: { completed: 4, failed: 0 }, fileSyncTasks: { completed: 2, failed: 0 },
  folderSyncTasks: { completed: 0, failed: 0 }, configSyncTasks: { completed: 0, failed: 0 },
  concurrencyLimiter: { activeKeys: new Set(['uploading.bin']), queue: [] },
  fileDownloadSessions: new Map(), isSyncRequesting: false, isSyncing: true,
  websocket: { ws: { readyState: 1, bufferedAmount: 0 }, isOpen: true },
  progressTracker: { getOverallPct: () => 42, getDetailText: () => '',
    isTypeFullyDone: () => false, forceComplete: failIfReset },
  syncPageStateMap: new Map(), resetSyncTasks: failIfReset,
  updateStatusBar: (...args) => statusUpdates.push(args),
};
const startedAt = now - 6 * 60 * 60 * 1000;
checkSyncCompletion(longRunning, 1, startedAt, 'long-running');
now += 6 * 60 * 60 * 1000;
longRunning.fileSyncTasks.completed++; // still making progress after six hours
checkSyncCompletion(longRunning, 1, startedAt, 'long-running');
assert.equal(longRunning.syncState.activeSyncContext, 'long-running');
assert.equal(longRunning.isSyncing, true);
assert.equal(statusUpdates.length, 2, 'ongoing transfer remains visible after six hours');

// Frozen counters with a leaked slot for > hard cap: the round must be reset, not left hanging.
let cleared = 0, resets = 0;
const frozen = {
  ...longRunning,
  syncState: { activeSyncContext: 'frozen', progressCheckIntervalId: 1,
    pendingNotePushPageIndex: new Map(), pendingFilePushPageIndex: new Map(), pendingConfigPushPageIndex: new Map() },
  concurrencyLimiter: { activeKeys: new Set(['lost-ack']), queue: [], clear: () => { cleared++; } },
  progressTracker: { ...longRunning.progressTracker, forceComplete: noop },
  resetSyncTasks: () => { resets++; },
  websocket: { ws: longRunning.websocket.ws, isOpen: false },
};
checkSyncCompletion(frozen, 1, now, 'frozen');
now += SYNC_STALL_HARD_RESTART_MS + 1000;
checkSyncCompletion(frozen, 1, now, 'frozen');
assert.equal(resets, 1, 'frozen round with leaked slot is reset');
assert.equal(cleared, 1, 'limiter cleared on restart');
assert.equal(frozen.syncState.activeSyncContext, null);
console.log('sync stall watchdog tests passed');
