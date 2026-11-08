import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const noop = () => {};
class MockFile {}
const helpers = { dump: noop, dumpError: noop, isPathExcluded: () => false,
  hashContent: x => x, hashContentAsync: async x => x, getPluginDir: () => '.plugin',
  checkAndNotifyCaseConflict: () => false };
const logs = { addLog: noop, addOrUpdateLog: noop, logReceivedMessage: noop };
function load(file, extra = {}, globals = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, console,
    window: { setTimeout: fn => { fn(); return 1; }, clearTimeout: noop },
    ...globals,
    require: id => id === 'obsidian' ? { normalizePath: x => x, TFile: MockFile, Platform: { isMobile: false } }
      : id.includes('helpers') ? helpers
      : id.includes('sync_log_manager') ? { SyncLogManager: { getInstance: () => logs } }
      : extra[id] || {} });
  return module.exports;
}

{
  const { SyncProgressTracker } = load('src/lib/sync/sync_progress_tracker.ts', {}, {
    window: { setTimeout: () => 1, clearTimeout: noop }
  });
  const tracker = new SyncProgressTracker();
  tracker.reset(['file']);
  tracker.recordPageProgress('file', 0, 2, true, true);
  tracker.recordUploadComplete('file');
  for (let i=0; i<10; i++) tracker.recordCompleted('file');
  assert.equal(tracker.isTypeFullyDone('file'), false, 'live ACKs cannot complete unfinished negotiated pages');
  tracker.recordCompleted('file', 0);
  assert.equal(tracker.isTypeFullyDone('file'), false);
  tracker.recordCompleted('file', 0);
  assert.equal(tracker.isTypeFullyDone('file'), true);
}

console.log('PASS: negotiated page completion');

const note = load('src/lib/sync/operator_note.ts');
{
  let cursor = 100;
  const p = {
    settings: { syncEnabled: true }, serverMerge: { supported: true },
    syncState: { activeSyncContext: 'round' }, noteSyncTasks: {},
    localStorageManager: { setMetadata: (_, value) => { cursor = value; } },
    syncTypeCompleteCount: 0,
  };
  await note.receiveNoteSyncEnd({ lastTime: 200, needModifyCount: 2 }, p);
  assert.equal(cursor, 100, 'End before pages must not advance the persisted cursor');
}
{
  const { checkSyncCompletion } = load('src/lib/sync/operator.ts', {
    './operator_note': note,
    '../../i18n/lang': { $: key => key },
    './operator_file': { sweepStalledDownloadSessions: async () => undefined }
  }, { WebSocket: { OPEN: 1 } });
  for (const failed of [0, 1]) {
    const metadata = new Map();
    const stats = () => ({ needUpload: 0, needModify: 0, needSyncMtime: 0, needDelete: 0, failed: 0 });
    const p = {
      syncState: { activeSyncContext: 'current', newConflictedPathsThisRound: new Set(), offlineGuardSkippedThisRound: false },
      settings: { syncEnabled: true, configSyncEnabled: true },
      websocket: { ws: { readyState: 1, bufferedAmount: 0 } },
      progressTracker: { isTypeFullyDone: () => true, getOverallPct: () => 100, forceComplete: noop },
      fileDownloadSessions: new Map(), syncPageStateMap: new Map(),
      noteSyncTasks: stats(), fileSyncTasks: { ...stats(), failed }, configSyncTasks: stats(), folderSyncTasks: stats(),
      resetSyncTasks: noop, updateStatusBar: noop, statusBarManager: { updateConflictBadge: noop },
      expectedSyncCount: 4, localStorageManager: { getMetadata: key => metadata.get(key), setMetadata: (key,value) => metadata.set(key,value) }
    };
    checkSyncCompletion(p);
    assert.equal(metadata.has('isInitSync'), failed === 0);
    assert.equal(metadata.has('lastSyncSuccessTime'), failed === 0);
  }
}
console.log('PASS: failed rounds preserve success metadata; successful rounds still update it');

for (const outcome of ['success', 'partial', 'failed', 'disconnected', 'old-context', 'guard', 'incremental']) {
  let cursor = 100;
  const collected = [];
  const p = {
    settings: { syncEnabled: true }, serverMerge: { supported: true },
    syncState: { activeSyncContext: 'round', offlineGuardSkippedThisRound: false },
    noteSyncTasks: { completed: 0, failed: 0 }, syncTypeCompleteCount: 0,
    progressTracker: { isTypeFullyDone: () => true },
    localStorageManager: { setMetadata: (_, value) => { cursor = value; } },
    fileHashManager: { collectTombstones: value => collected.push(value) },
  };
  note.beginNoteSyncRound(p, outcome !== 'incremental');
  await note.receiveNoteSyncEnd({ lastTime: 200, needModifyCount: 1, needDeleteCount: 1 }, p);
  assert.equal(cursor, 100);
  p.noteSyncTasks.completed = outcome === 'partial' ? 1 : 2;
  if (outcome === 'failed') p.noteSyncTasks.failed = 1;
  if (outcome === 'disconnected') p.syncState.activeSyncContext = null;
  if (outcome === 'old-context') p.syncState.activeSyncContext = 'new-round';
  if (outcome === 'guard') p.syncState.offlineGuardSkippedThisRound = true;
  note.commitNoteSyncRound(p);
  const success = ['success', 'incremental'].includes(outcome);
  assert.equal(cursor, success ? 200 : 100, outcome);
  assert.deepEqual(collected, outcome === 'success' ? [200] : [], outcome);
}

{
  let finish;
  const applying = new Promise(resolve => { finish = resolve; });
  let completed = 0;
  const p = {
    serverMerge: { supported: true, acceptsAck: () => true, onAck: () => applying },
    pendingNoteModifies: new Map([['a.md', 'h']]),
    localStorageManager: { savePending: noop }, concurrencyLimiter: { releaseSlot: noop },
    syncState: { pendingNotePushPageIndex: new Map([['a.md', 0]]) },
    recordSyncCompleted: () => completed++, noteSyncTasks: { failed: 0 },
  };
  const ack = note.receiveNoteModifyAck({ path: 'a.md', opId: 'op' }, p);
  assert.equal(completed, 0, 'NeedPush page stays incomplete while final ACK content is applying');
  finish();
  await ack;
  assert.equal(completed, 1);
}
console.log('PASS: cursor commits only at successful round barrier after ACK application');
