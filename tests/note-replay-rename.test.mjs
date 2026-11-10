import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';

const noop = () => {};
const hash = text => 'h:' + text;
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
class TFolder {}
class TFile {
  constructor(path, content) { this.path = path; this.content = content; this.extension = path.split('.').pop(); this.stat = { mtime: 1, ctime: 1, size: Buffer.byteLength(content) }; }
}
const helpers = { dump: noop, dumpError: noop, isPathExcluded: (path, p) => p.settings.excludedPaths?.has(path) ?? false,
  hashContent: hash, hashContentAsync: async text => hash(text), getSafeCtime: () => 1,
  checkAndNotifyCaseConflict: () => false, debounce: () => noop,
  generateUUID: () => crypto.randomUUID(), getPluginDir: () => '.obsidian/plugins/test',
  getConfigSyncCustomDirs: () => [], yieldToMain: async () => {}, isFolderSyncPathExcluded: () => false,
  LocalStateFileMirror: class { flush() {} scheduleWrite() {} } };
function load(file, extra = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, console, btoa, atob, TextEncoder, sleep: async () => {}, WebSocket: { OPEN: 1 },
    window: { crypto: crypto.webcrypto, setTimeout: () => 1, clearTimeout: noop, setInterval: () => 1, clearInterval: noop },
    require: id => extra[id] || (id === 'obsidian' ? { TFile, TFolder, normalizePath: x => x }
      : id.includes('remote_path_guard') ? { blockAliasedRemoteMutation: () => false }
      : id.includes('helpers') ? helpers
      : id.includes('sync_log_manager') ? { SyncLogManager: { getInstance: () => ({ addLog: noop, addOrUpdateLog: noop }) } }
      : {}) });
  return module.exports;
}
const { FileHashManager } = load('src/lib/storage/file_hash_manager.ts');
const merge = load('src/lib/sync/server_merge_client.ts');
const { createServerMerge } = load('src/lib/sync/server_merge_env.ts', { './server_merge_client': merge });
const note = load('src/lib/sync/operator_note.ts');
const operator = load('src/lib/sync/operator.ts', {
  './operator_note': note,
  './websocket_action': new Proxy({}, { get: (_, key) => key }),
  '../../i18n/lang': { $: key => key },
  './sync_batch_sender': { settleBatchSendSessionOnSyncEnd: noop },
  './operator_file': { sweepStalledDownloadSessions: async () => {} },
});
function fixture() {
  const files = new Map(), metadata = new Map(), storage = new Map(), sent = [], trashed = [];
  const vault = {
    adapter: { exists: async () => false }, configDir: '.obsidian',
    getAllLoadedFiles: () => [...files.values()],
    getFileByPath: path => files.get(path) ?? null,
    getAbstractFileByPath: path => files.get(path) ?? null,
    getFolderByPath: () => ({}),
    read: async file => file.content,
    create: async (path, content) => { assert.equal(files.has(path), false); const file = new TFile(path, content); files.set(path, file); return file; },
    process: async (file, transform) => { file.content = transform(file.content); file.stat.size = Buffer.byteLength(file.content); },
    modify: async (file, content, options = {}) => { file.content = content; file.stat.size = Buffer.byteLength(content); Object.assign(file.stat, options); },
    rename: async (file, path) => { assert.equal(files.has(path), false); files.delete(file.path); file.path = path; files.set(path, file); },
    trash: async file => { trashed.push(file.content); files.delete(file.path); },
  };
  const p = {
    app: { vault, loadLocalStorage: key => storage.get(key), saveLocalStorage: (key, value) => storage.set(key, value) },
    settings: { syncEnabled: true, readonlySyncEnabled: false, vault: 'test' },
    getClientName: () => 'test device',
    syncState: { activeSyncContext: 'round', pendingNotePushPageIndex: new Map(), pendingFilePushPageIndex: new Map(), pendingConfigPushPageIndex: new Map(),
      conflictedPaths: new Set(), newConflictedPathsThisRound: new Set(), syncUpChunkNum: 200, pipelineWindowUp: 0 },
    noteSyncTasks: { completed: 0, failed: 0 }, syncTypeCompleteCount: 0,
    progressTracker: { isTypeFullyDone: () => true },
    recordSyncCompleted: () => p.noteSyncTasks.completed++,
    localStorageManager: { setMetadata: (key, value) => metadata.set(key, value), getMetadata: key => metadata.get(key),
      savePending: (key, values) => storage.set(key, JSON.stringify(Object.fromEntries(values))),
      loadPending: key => new Map(Object.entries(JSON.parse(storage.get(key) ?? '{}'))),
      clearPending: key => storage.delete(key) },
    lockManager: { withLock: async (_, fn) => fn() }, addIgnoredFile: noop, removeIgnoredFile: noop, isIgnoredFile: () => false,
    lastSyncPathDeleted: new Set(), lastSyncPathRenamed: new Set(), lastSyncMtime: new Map(),
    pendingNoteModifies: new Map(), pendingNoteDeleteAcks: new Set(),
    concurrencyLimiter: { waitForSlot: async () => true, releaseSlot: noop },
    websocket: { SendMessage: (action, data, _cb, sentCb) => { sent.push({ action, data }); sentCb?.(); } },
    menuManager: { ribbonIconStatus: true }, updateStatusBar: noop, syncPageStateMap: new Map(),
    pendingDeleteNotePaths: new Set(), pendingDeleteFilePaths: new Set(), pendingDeleteFolderPaths: new Set(), pendingDeleteConfigPaths: new Set(),
    pendingFileDeleteAcks: new Set(), pendingConfigDeleteAcks: new Set(),
    pendingConfigModifies: new Map(), pendingUploadHashes: new Map(),
    folderSnapshotManager: { setFolderMtimes: noop, isReady: () => false },
    scannedNoteHashes: new Map(), scannedFileHashes: new Map(),
    resetSyncTasks: () => Object.assign(p.noteSyncTasks, { completed: 0, failed: 0, needUpload: 0, needModify: 0, needSyncMtime: 0, needDelete: 0 }),
  };
  p.fileHashManager = new FileHashManager(p);
  p.serverMerge = createServerMerge(p); p.serverMerge.supported = true;
  const put = (path, content, rev) => {
    files.set(path, new TFile(path, content));
    if (rev) p.fileHashManager.setFileHash(path, hash(content), 1, Buffer.byteLength(content), rev, sha(content));
  };
  return { p, files, metadata, storage, sent, trashed, put };
}
async function finish(p, lastTime, counts) {
  await note.receiveNoteSyncEnd({ lastTime, ...counts }, p);
  note.commitNoteSyncRound(p);
}
const failures = [];
async function test(name, run) {
  try { await run(); console.log('ok - ' + name); }
  catch (error) { failures.push(name); console.error('FAIL - ' + name + ': ' + error.message); }
}

await test('H3: full reconcile applies an unseen old rev despite evicted tombstones', async () => {
  const { p, files, metadata } = fixture();
  for (let i = 0; i <= 2000; i++) p.fileHashManager.removeFileHash('gone-' + i + '.md', 100 + i);
  note.beginNoteSyncRound(p, true);
  await note.receiveNoteSyncModify({ path: 'unseen.md', content: 'complete old body', contentHash: hash('complete old body'), rev: 90, pageIndex: 0 }, p);
  await finish(p, 3000, { needModifyCount: 1 });
  assert.equal(files.get('unseen.md')?.content, 'complete old body');
  assert.equal(metadata.get('lastNoteSyncTime'), 3000);
});

await test('H4: full GC retains a persistent barrier against another channel late modify', async () => {
  const { p, files, storage } = fixture();
  p.fileHashManager.removeFileHash('x.md', 200);
  note.beginNoteSyncRound(p, true);
  await finish(p, 3000, {});
  await note.receiveNoteSyncModify({ path: 'x.md', content: 'stale', contentHash: hash('stale'), rev: 100 }, p);
  assert.equal(files.has('x.md'), false, 'late broadcast must not resurrect the deleted file');
  p.fileHashManager.flush();
  const recovered = new FileHashManager(p);
  recovered.loadTombstones();
  assert.ok(recovered.getReplayFloor() >= 3000, 'the barrier must survive plugin restart');
  assert.ok(JSON.parse(storage.get('fns-syncTombstones')).t.length <= 2000);
});

await test('H3/H4: >2000 full-round deletes do not starve unseen rows or revive evicted paths', async () => {
  const { p, files, metadata } = fixture();
  note.beginNoteSyncRound(p, true);
  for (let i = 0; i <= 2000; i++) {
    await note.receiveNoteSyncDelete({ path: 'deleted-' + i + '.md', rev: 100 + i, pageIndex: 0 }, p);
  }
  await note.receiveNoteSyncModify({ path: 'deleted-0.md', content: 'stale', contentHash: hash('stale'), rev: 90, pageIndex: 0 }, p);
  await note.receiveNoteSyncModify({ path: 'unseen.md', content: 'kept', contentHash: hash('kept'), rev: 80, pageIndex: 0 }, p);
  await finish(p, 3000, { needDeleteCount: 2001, needModifyCount: 2 });
  assert.equal(files.has('deleted-0.md'), false);
  assert.equal(files.get('unseen.md')?.content, 'kept');
  assert.equal(p.noteSyncTasks.failed, 0);
  assert.equal(metadata.get('lastNoteSyncTime'), 3000, 'a large valid round can finish');
  assert.equal(p.fileHashManager.getPathRev('deleted-0.md'), 0, 'round-only exact tombstones are released');
  await note.receiveNoteSyncModify({ path: 'deleted-0.md', content: 'stale', contentHash: hash('stale'), rev: 90 }, p);
  assert.equal(files.has('deleted-0.md'), false, 'broadcast barrier replaces the released temporary tombstone');
});

await test('trusted incremental missing-file pages can recover old revs under the broadcast floor', async () => {
  const { p, files } = fixture();
  p.fileHashManager.collectTombstones(3000);
  note.beginNoteSyncRound(p, false);
  await note.receiveNoteSyncModify({ path: 'missing.md', content: 'old current body', contentHash: hash('old current body'), rev: 90, pageIndex: 0 }, p);
  assert.equal(files.get('missing.md')?.content, 'old current body');
  note.abortNoteSyncRound(p);
});

await test('tombstone eviction alone does not discard a legitimate update to a known live path', async () => {
  const { p, put, files } = fixture();
  put('live.md', 'before', 50);
  for (let i = 0; i <= 2000; i++) p.fileHashManager.removeFileHash('gone-' + i + '.md', 100 + i);
  await note.receiveNoteSyncModify({ path: 'live.md', content: 'legitimate update', contentHash: hash('legitimate update'), rev: 90 }, p);
  assert.equal(files.get('live.md')?.content, 'legitimate update');
});

await test('failed/cancelled/disconnected rounds release temporary tombstones without committing or GC', async () => {
  for (const end of ['failed', 'cancelled', 'disconnected']) {
    const { p, metadata } = fixture();
    note.beginNoteSyncRound(p, true);
    for (let i = 0; i <= 2000; i++) p.fileHashManager.removeFileHash('temporary-' + i + '.md', 100 + i);
    assert.equal(p.fileHashManager.getPathRev('temporary-0.md'), 100);
    if (end === 'failed') {
      p.noteSyncTasks.failed = 1;
      await finish(p, 3000, {});
    } else if (end === 'cancelled') note.abortNoteSyncRound(p);
    else p.serverMerge.reset();
    assert.equal(p.fileHashManager.getPathRev('temporary-0.md'), 0, end);
    assert.equal(p.fileHashManager.getReplayFloor(), 100, end + ': no successful full barrier was installed');
    assert.equal(metadata.has('lastNoteSyncTime'), false, end);
  }
});

await test('broadcast delete/rename also obey the persistent full barrier', async () => {
  const { p, put, files } = fixture();
  put('old.md', 'still current', 50);
  p.fileHashManager.collectTombstones(3000);
  await note.receiveNoteSyncDelete({ path: 'old.md', rev: 200 }, p);
  await note.receiveNoteSyncRename({ oldPath: 'old.md', path: 'new.md', contentHash: hash('still current'), rev: 200 }, p);
  assert.equal(files.get('old.md')?.content, 'still current');
  assert.equal(files.has('new.md'), false);
});

await test('H5: remote rename preserves target draft in an uploaded ordinary conflict note', async () => {
  const { p, put, files, sent, trashed } = fixture();
  put('old.md', 'synced source', 50); put('new.md', 'complete unuploaded draft\n正文\n');
  await note.receiveNoteSyncRename({ oldPath: 'old.md', path: 'new.md', contentHash: hash('synced source'), rev: 100, sha: sha('synced source') }, p);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(files.get('new.md')?.content, 'synced source');
  assert.equal(trashed.length, 0, 'draft must not be silently trashed');
  const copies = [...files.values()].filter(file => file.path !== 'new.md');
  assert.equal(copies.length, 1);
  assert.equal(copies[0].content, 'complete unuploaded draft\n正文\n');
  assert.equal(copies[0].path, 'new.conflict-testdevice-' + sha(copies[0].content).slice(0, 8) + '.md');
  const uploads = sent.filter(({ action, data }) => action === 'NoteModify' && data.path === copies[0].path && data.content === copies[0].content);
  assert.equal(uploads.length, 1, 'the full draft is explicitly uploaded once');
  const other = fixture();
  const upload = sent.find(({ action }) => action === 'NoteModify').data;
  await note.receiveNoteSyncModify({ ...upload, rev: 101 }, other.p);
  assert.equal(other.files.get(copies[0].path)?.content, copies[0].content, 'normal broadcast makes the complete copy visible on another client');
});

await test('H5: copy/upload failures retain every draft byte and do not replace the source', async () => {
  for (const failure of ['rename', 'upload']) {
    const { p, put, files, sent, trashed } = fixture();
    put('old.md', 'source', 50); put('new.md', 'draft with no trusted base\n正文');
    if (failure === 'rename') p.app.vault.rename = async () => { throw new Error('rename denied'); };
    else p.settings.readonlySyncEnabled = true;
    await note.receiveNoteSyncRename({ oldPath: 'old.md', path: 'new.md', contentHash: hash('source'), rev: 100 }, p);
    assert.equal(files.get('old.md')?.content, 'source', failure);
    assert.ok([...files.values()].some(file => file.content === 'draft with no trusted base\n正文'), failure);
    assert.equal(trashed.length, 0, failure);
    assert.equal(sent.length, 0, failure);
    assert.equal(p.noteSyncTasks.failed, 1, failure);
  }
});

await test('H5: an existing conflict copy is kept, and the new complete draft uses a suffix', async () => {
  const { p, put, files, sent } = fixture();
  put('old.md', 'source', 50); put('new.md', 'draft');
  const stem = 'new.conflict-testdevice-' + sha('draft').slice(0, 8);
  put(stem + '.md', 'existing copy');
  await note.receiveNoteSyncRename({ oldPath: 'old.md', path: 'new.md', contentHash: hash('source'), rev: 100 }, p);
  assert.equal(files.get(stem + '.md')?.content, 'existing copy');
  assert.equal(files.get(stem + '-2.md')?.content, 'draft');
  assert.equal(sent.filter(({ action, data }) => action === 'NoteModify' && data.path === stem + '-2.md' && data.content === 'draft' && data.baseHashMissing).length, 1);
});

await test('remote rename with mtime uploads unsent source edits at the new path without a false hash cache', async () => {
  for (const withTargetDraft of [false, true]) {
    const { p, put, files, sent, trashed } = fixture();
    put('old.md', 'source', 50);
    const source = files.get('old.md');
    source.content = 'UNSENT SOURCE EDIT\n完整新稿';
    source.stat = { ...source.stat, mtime: 70, size: Buffer.byteLength(source.content) };
    if (withTargetDraft) put('new.md', 'TARGET DRAFT\n独立草稿');
    await note.receiveNoteSyncRename({ oldPath: 'old.md', path: 'new.md', contentHash: hash('source'),
      sha: sha('source'), rev: 100, mtime: 80, ctime: 10 }, p);
    const moved = files.get('new.md');
    assert.equal(moved?.content, 'UNSENT SOURCE EDIT\n完整新稿');
    assert.equal(moved.stat.mtime, 80, 'exercise the real remote mtime branch');
    assert.equal(trashed.length, 0);
    assert.notEqual(p.fileHashManager.getValidHash('new.md', moved.stat.mtime, moved.stat.size), hash('source'), 'remote old hash must not be attached to dirty current bytes');
    const uploads = sent.filter(({ action }) => action === 'NoteModify');
    assert.equal(uploads.length, withTargetDraft ? 2 : 1);
    const sourceUpload = uploads.find(({ data }) => data.path === 'new.md')?.data;
    assert.equal(sourceUpload?.content, moved.content, 'explicit upload survives cancellation of the old-path debounce');
    assert.equal(sourceUpload.baseSha, sha('source'));
    assert.equal(sourceUpload.baseHash, hash('source'));
    assert.equal(p.noteSyncTasks.failed, 0);
    if (withTargetDraft) {
      assert.equal(uploads.filter(({ data }) => data.path !== 'new.md' && data.content === 'TARGET DRAFT\n独立草稿').length, 1);
    }
    const other = fixture();
    await note.receiveNoteSyncModify({ ...sourceUpload, rev: 101 }, other.p);
    assert.equal(other.files.get('new.md')?.content, moved.content, 'the full source edit reaches another client through the ordinary upload/broadcast path');
  }
});

await test('renamed dirty source stays retryable when its explicit upload cannot acquire a slot', async () => {
  const { p, put, files, sent } = fixture();
  put('old.md', 'source', 50);
  const source = files.get('old.md');
  source.content = 'retained complete source draft'; source.stat.size = Buffer.byteLength(source.content); source.stat.mtime = 70;
  p.concurrencyLimiter.waitForSlot = async () => false;
  await note.receiveNoteSyncRename({ oldPath: 'old.md', path: 'new.md', contentHash: hash('source'), sha: sha('source'), rev: 100, mtime: 80 }, p);
  assert.equal(files.get('new.md')?.content, 'retained complete source draft');
  assert.equal(p.noteSyncTasks.failed, 1);
  assert.equal(p.fileHashManager.getValidHash('new.md', 80, source.stat.size), null);
  assert.equal(sent.length, 0);
  p.concurrencyLimiter.waitForSlot = async () => true;
  await note.noteModify(files.get('new.md'), p, true);
  assert.equal(sent.filter(({ action, data }) => action === 'NoteModify' && data.path === 'new.md' && data.content === 'retained complete source draft').length, 1);
});

await test('remote rename of a clean source remains receive-only in readonly mode', async () => {
  const { p, put, files, sent } = fixture();
  put('old.md', 'source', 50);
  p.settings.readonlySyncEnabled = true;
  await note.receiveNoteSyncRename({ oldPath: 'old.md', path: 'new.md', contentHash: hash('source'), sha: sha('source'), rev: 100, mtime: 80 }, p);
  assert.equal(files.get('new.md')?.content, 'source');
  assert.equal(p.noteSyncTasks.failed, 0);
  assert.equal(sent.length, 0);
});

await test('forked rename retains REMOTE and LOCAL using the actual source ancestor, including unchanged local', async () => {
  const base = 'first base\nseparator one\nseparator two\nlast base\n';
  const remote = base.replace('first base', 'REMOTE');
  for (const local of [base.replace('last base', 'LOCAL'), base]) {
    const { p, put, files, sent } = fixture();
    put('old.md', base, 50);
    put('new.md', 'TARGET complete draft\n独立目标草稿\n');
    files.get('old.md').content = local;
    files.get('old.md').stat = { mtime: 70, ctime: 1, size: Buffer.byteLength(local) };
    await note.receiveNoteSyncRename({ oldPath: 'old.md', path: 'new.md', contentHash: hash(remote),
      sha: sha(remote), rev: 100, mtime: 80 }, p);
    const uploads = sent.filter(({ action, data }) => action === 'NoteModify' && data.path === 'new.md');
    assert.equal(uploads.length, 1, 'rename must force a submission even when local still equals its old base');
    const upload = uploads[0].data;
    // Model the server contract: claimed current ancestor fast-forwards; a known
    // older snapshot permits a three-way merge. Only disjoint line edits here.
    let final = upload.content;
    if (upload.baseSha === sha(base)) {
      const b = base.split('\n'), s = remote.split('\n'), c = upload.content.split('\n');
      final = b.map((line, i) => c[i] === line ? s[i] : s[i] === line || s[i] === c[i] ? c[i]
        : assert.fail('fixture must contain only disjoint edits')).join('\n');
    }
    assert.ok(final.includes('REMOTE'), 'claiming unseen remote SHA must not fast-forward away REMOTE');
    if (local !== base) assert.ok(final.includes('LOCAL'));
    assert.equal(upload.baseSha, sha(base));
    assert.equal(upload.baseHash, hash(base));
    assert.notEqual(upload.baseSha, sha(remote));
    assert.equal(p.fileHashManager.getPathRev('new.md'), 100, 'rename rev still gates late messages');
    await p.serverMerge.onAck({ path: 'new.md', opId: upload.opId, rev: 101, merged: true, content: final, sha: sha(final) });
    const other = fixture();
    await note.receiveNoteSyncModify({ path: 'new.md', content: final, contentHash: hash(final), sha: sha(final), rev: 101 }, other.p);
    const copyUpload = sent.find(({ action, data }) => action === 'NoteModify' && data.path !== 'new.md')?.data;
    assert.equal(copyUpload?.content, 'TARGET complete draft\n独立目标草稿\n');
    await note.receiveNoteSyncModify({ ...copyUpload, sha: sha(copyUpload.content), rev: 102 }, other.p);
    assert.equal(files.get('new.md')?.content, final, 'actual merged ACK applies the combined complete body');
    assert.equal(other.files.get('new.md')?.content, final, 'ordinary broadcast converges the second client');
    assert.equal(files.get(copyUpload.path)?.content, copyUpload.content);
    assert.equal(other.files.get(copyUpload.path)?.content, copyUpload.content, 'the complete target draft also reaches the second client');
    assert.equal(files.has('old.md'), false);
  }
});

await test('rename with no trusted source base requests safe conflict preservation without claiming remote ancestry', async () => {
  const { p, put, files, sent } = fixture();
  const remote = 'REMOTE complete body\n', local = 'LOCAL complete draft\n';
  put('old.md', local);
  await note.receiveNoteSyncRename({ oldPath: 'old.md', path: 'new.md', contentHash: hash(remote),
    sha: sha(remote), rev: 100, mtime: 80 }, p);
  const upload = sent.find(({ action, data }) => action === 'NoteModify' && data.path === 'new.md')?.data;
  assert.equal(upload?.content, local);
  assert.equal(upload.baseHashMissing, true);
  assert.equal(upload.baseHash, undefined);
  assert.equal(upload.baseSha, undefined);
  assert.equal(p.fileHashManager.getPathRev('new.md'), 100);
  // Server's no-base contract keeps REMOTE at main and broadcasts full LOCAL in
  // a normal conflict note; exercise those real receive paths on both clients.
  const copy = 'new.conflict-testdevice-' + sha(local).slice(0, 8) + '.md';
  await p.serverMerge.onAck({ path: 'new.md', opId: upload.opId, rev: 101, merged: true,
    content: remote, sha: sha(remote), conflictCopy: copy });
  const other = fixture();
  for (const client of [p, other.p]) {
    await note.receiveNoteSyncModify({ path: copy, content: local, contentHash: hash(local), sha: sha(local), rev: 102 }, client);
  }
  await note.receiveNoteSyncModify({ path: 'new.md', content: remote, contentHash: hash(remote), sha: sha(remote), rev: 101 }, other.p);
  assert.equal(files.get('new.md')?.content, remote);
  assert.equal(files.get(copy)?.content, local);
  assert.equal(other.files.get('new.md')?.content, remote);
  assert.equal(other.files.get(copy)?.content, local);
});

await test('rename older than the source identity cannot move that newer source or its target draft', async () => {
  const { p, put, files, sent } = fixture();
  put('old.md', 'newer source identity', 110);
  put('new.md', 'target draft');
  await note.receiveNoteSyncRename({ oldPath: 'old.md', path: 'new.md', contentHash: hash('old identity'),
    sha: sha('old identity'), rev: 100, mtime: 80 }, p);
  assert.equal(files.get('old.md')?.content, 'newer source identity');
  assert.equal(files.get('new.md')?.content, 'target draft');
  assert.equal(files.size, 2);
  assert.equal(sent.length, 0);
});

await test('real tracker: deferred 13 MiB forced rename behind 20 MiB upload must fetch REMOTE before success', async () => {
  const { p, put, files, sent, metadata } = fixture();
  const { SyncProgressTracker } = load('src/lib/sync/sync_progress_tracker.ts');
  p.progressTracker = new SyncProgressTracker(); p.progressTracker.reset(['note']);
  p.recordSyncCompleted = (type, pageIndex) => {
    p.noteSyncTasks.completed++; p.progressTracker.recordCompleted(type, pageIndex);
  };
  const base = 'b'.repeat(13 * 1024 * 1024), remote = base.slice(0, -6) + 'REMOTE';
  put('old.md', base, 50); put('other.md', 'o'.repeat(20 * 1024 * 1024));
  await p.serverMerge.requestUploadFromDisk('other.md');
  note.beginNoteSyncRound(p, false);
  await note.receiveNoteSyncRename({ oldPath: 'old.md', path: 'new.md', contentHash: hash(remote),
    sha: sha(remote), rev: 100, mtime: 80 }, p);
  assert.equal(p.serverMerge.debugSizes().deferred, 1);
  const drained = [], upload = p.serverMerge.requestUploadFromDisk.bind(p.serverMerge);
  p.serverMerge.requestUploadFromDisk = (path, force) => {
    const promise = upload(path, force); drained.push({ path, force, promise }); return promise;
  };
  const other = sent.find(({ data }) => data.path === 'other.md').data;
  await note.receiveNoteModifyAck({ path: 'other.md', opId: other.opId, rev: 101, sha: sha(other.content) }, p);
  for (const entry of drained) await entry.promise;
  const renamed = sent.filter(({ action, data }) => action === 'NoteModify' && data.path === 'new.md');
  assert.equal(renamed.length, 1, 'budget drain must send the forced unchanged ancestor');
  assert.equal(drained[0].force, true);
  assert.equal(renamed[0].data.baseSha, sha(base));
  assert.equal(renamed[0].data.content, base);
  await note.receiveNoteModifyAck({ path: 'new.md', opId: renamed[0].data.opId, rev: 102,
    merged: true, content: remote, sha: sha(remote) }, p);
  await note.receiveNoteSyncEnd({ lastTime: 200, needModifyCount: 1 }, p);
  p.progressTracker.setDownloadTotal('note', 1);
  p.progressTracker.recordUploadComplete('note', p.noteSyncTasks.completed);
  p.progressTracker.recordPageProgress('note', 0, 1, true, true);
  await note.receiveNoteSyncModify({ path: 'new.md', content: remote, contentHash: hash(remote),
    sha: sha(remote), rev: 100, mtime: 80, pageIndex: 0 }, p);
  assert.equal(p.progressTracker.isTypeFullyDone('note'), true);
  note.commitNoteSyncRound(p);
  assert.equal(metadata.get('lastNoteSyncTime'), 200);
  assert.equal(files.get('new.md')?.content, remote, 'successful cursor must include REMOTE, not leave the old ancestor');
  assert.equal(p.serverMerge.debugSizes().inflight, 0);
  assert.equal(p.serverMerge.debugSizes().deferred, 0);
});

await test('forced dirty requests survive ordinary coalescing and both ACK and mtime settle', async () => {
  for (const entry of ['disk', 'content']) for (const finish of ['ack', 'settle']) {
    const { p, put, sent } = fixture();
    put('same.md', 'same', 50);
    await p.serverMerge.requestUploadFromDisk('same.md', true);
    const request = force => entry === 'disk' ? p.serverMerge.requestUploadFromDisk('same.md', force)
      : p.serverMerge.requestUpload('same.md', 'same', hash('same'), force);
    assert.equal(await request(true), 'dirty');
    assert.equal(await request(false), 'dirty', 'ordinary edits must not downgrade queued force');
    if (finish === 'ack') await p.serverMerge.onAck({ path: 'same.md', opId: sent[0].data.opId, rev: 51, sha: sha('same') });
    else await p.serverMerge.settle('same.md');
    assert.equal(sent.length, 2, entry + '/' + finish + ': forced clean content must still be sent');
    await p.serverMerge.onAck({ path: 'same.md', opId: sent[1].data.opId, rev: 52, sha: sha('same') });
    assert.equal(sent.length, 2, 'force is consumed once, without an endless resend loop');
    assert.equal(p.serverMerge.debugSizes().dirty, 0);
  }
});

await test('force arriving after async content hashing survives the second single-flight check', async () => {
  const { p, put, sent } = fixture(); put('same.md', 'same', 50);
  const original = p.serverMerge.env.sha; let unblock;
  p.serverMerge.env.sha = () => new Promise(resolve => { unblock = resolve; });
  const queued = p.serverMerge.requestUpload('same.md', 'same', hash('same'), true);
  p.serverMerge.env.sha = original;
  await p.serverMerge.requestUploadFromDisk('same.md', true);
  unblock(sha('same'));
  assert.equal(await queued, 'dirty');
  await p.serverMerge.onAck({ path: 'same.md', opId: sent[0].data.opId, rev: 51, sha: sha('same') });
  assert.equal(sent.length, 2);
});

await test('busy rename migrates forced old-path dirty work to the new path', async () => {
  const { p, put, files, sent } = fixture(); put('old.md', 'same', 50);
  await p.serverMerge.requestUploadFromDisk('old.md', true);
  await p.app.vault.rename(files.get('old.md'), 'new.md');
  let renameId;
  const renamed = p.serverMerge.requestRename('old.md', 'new.md', hash('same'), async id => { renameId = id; return true; });
  assert.equal(await p.serverMerge.requestUploadFromDisk('old.md', true), 'dirty');
  assert.equal(await p.serverMerge.requestUpload('new.md', 'same', hash('same'), false), 'dirty');
  await p.serverMerge.onAck({ path: 'old.md', opId: sent[0].data.opId, rev: 51, sha: sha('same') });
  await renamed;
  await p.serverMerge.onAck({ path: 'new.md', opId: renameId, rev: 52, sha: sha('same') });
  const uploads = sent.filter(({ data }) => data.path === 'new.md');
  assert.equal(uploads.length, 1, 'force must follow the renamed path even when its body equals base');
  assert.equal(uploads[0].data.content, 'same');
});

await test('forced upload bypasses the self-write marker and retry fallback retains force', async () => {
  const { p, put, files, sent } = fixture(); put('same.md', 'same', 50);
  await p.serverMerge.onPush({ path: 'same.md', content: 'remote', contentHash: hash('remote'), sha: sha('remote'), rev: 51 });
  assert.equal(await p.serverMerge.requestUploadFromDisk('same.md', true), 'sent', 'explicit force overrides expected self marker');
  await p.serverMerge.onAck({ path: 'same.md', opId: sent[0].data.opId, rev: 52, sha: sha('remote') });
  p.serverMerge.env.setTimer = undefined;
  const read = p.serverMerge.env.readLocal;
  p.serverMerge.env.readLocal = async () => { throw Error('read failed'); };
  assert.equal(await p.serverMerge.requestUploadFromDisk('same.md', true), 'failed');
  p.serverMerge.env.readLocal = read;
  files.get('same.md').content = 'next';
  await p.serverMerge.requestUploadFromDisk('same.md');
  await p.serverMerge.onAck({ path: 'same.md', opId: sent[1].data.opId, rev: 53, sha: sha('next') });
  assert.equal(sent.length, 3, 'fallback dirty force must survive a later ordinary upload/ACK');
});

await test('both budget checks retain force across ordinary requests without repeatedly draining themselves', async () => {
  for (const knownSize of [true, false]) {
    const { p, put, sent } = fixture();
    p.serverMerge.maxQueuedBytes = 10;
    put('other.md', '12345678'); put('same.md', 'same', 50);
    if (!knownSize) p.serverMerge.env.localSize = undefined;
    await p.serverMerge.requestUploadFromDisk('other.md');
    const drained = [], upload = p.serverMerge.requestUploadFromDisk.bind(p.serverMerge);
    p.serverMerge.requestUploadFromDisk = (...args) => { const result = upload(...args); drained.push(result); return result; };
    assert.equal(await p.serverMerge.requestUploadFromDisk('same.md', true), 'deferred');
    await p.serverMerge.requestUploadFromDisk('same.md', false);
    for (const result of drained) await result;
    assert.equal(p.serverMerge.debugSizes().deferred, 1);
    await p.serverMerge.onAck({ path: 'other.md', opId: sent[0].data.opId, rev: 51, sha: sha('12345678') });
    for (const result of drained) await result;
    assert.equal(sent.filter(({ data }) => data.path === 'same.md').length, 1, 'force survives ' + (knownSize ? 'pre-read' : 'post-read') + ' budget gate');
    assert.equal(p.serverMerge.debugSizes().deferred, 0);
  }
});

await test('a rename carries deferred force to the new path; deletion cancels the deferred upload', async () => {
  for (const operation of ['rename', 'delete']) {
    const { p, put, files, sent } = fixture();
    p.serverMerge.maxQueuedBytes = 10;
    put('other.md', '12345678'); put('old.md', 'same', 50);
    await p.serverMerge.requestUploadFromDisk('other.md');
    assert.equal(await p.serverMerge.requestUploadFromDisk('old.md', true), 'deferred');
    let id;
    if (operation === 'rename') {
      await p.app.vault.rename(files.get('old.md'), 'new.md');
      await p.serverMerge.requestRename('old.md', 'new.md', hash('same'), async opId => { id = opId; return true; });
      await p.serverMerge.onAck({ path: 'new.md', opId: id, rev: 51, sha: sha('same') });
    } else {
      files.delete('old.md');
      await p.serverMerge.requestDelete('old.md', async opId => { id = opId; return true; });
      await p.serverMerge.onAck({ path: 'old.md', opId: id, rev: 51 });
    }
    const drained = [], upload = p.serverMerge.requestUploadFromDisk.bind(p.serverMerge);
    p.serverMerge.requestUploadFromDisk = (...args) => { const result = upload(...args); drained.push(result); return result; };
    await p.serverMerge.onAck({ path: 'other.md', opId: sent[0].data.opId, rev: 52, sha: sha('12345678') });
    await Promise.all(drained);
    assert.equal(sent.filter(({ data }) => data.path === 'new.md').length, operation === 'rename' ? 1 : 0);
    assert.equal(sent.filter(({ data }) => data.path === 'old.md').length, 0);
    assert.equal(p.serverMerge.debugSizes().deferred, 0);
    assert.equal(p.serverMerge.debugSizes().dirty, 0);
  }
});

await test('reset/dispose discard queued force without contaminating the next session', async () => {
  for (const operation of ['reset', 'dispose']) {
    const { p, put, sent } = fixture();
    p.serverMerge.maxQueuedBytes = 10;
    put('other.md', '12345678'); put('same.md', 'same', 50);
    await p.serverMerge.requestUploadFromDisk('other.md');
    await p.serverMerge.requestUploadFromDisk('other.md', true);
    await p.serverMerge.requestUploadFromDisk('same.md', true);
    p.serverMerge[operation]();
    assert.equal(p.serverMerge.debugSizes().inflight, 0);
    assert.equal(p.serverMerge.debugSizes().dirty, 0);
    assert.equal(p.serverMerge.debugSizes().deferred, 0);
    assert.equal(await p.serverMerge.requestUploadFromDisk('same.md'), 'unchanged');
    assert.equal(sent.length, 1, 'old force must not leak into a new session');
  }
});

await test('End and same-rev page before forced rename ACK cannot commit a successful cursor', async () => {
  const { p, put, metadata } = fixture();
  const { SyncProgressTracker } = load('src/lib/sync/sync_progress_tracker.ts');
  p.progressTracker = new SyncProgressTracker(); p.progressTracker.reset(['note']);
  p.recordSyncCompleted = (type, page) => { p.noteSyncTasks.completed++; p.progressTracker.recordCompleted(type, page); };
  p.serverMerge.maxQueuedBytes = 10;
  metadata.set('lastNoteSyncTime', 60);
  put('old.md', 'base', 50); put('other.md', '12345678');
  await p.serverMerge.requestUploadFromDisk('other.md');
  note.beginNoteSyncRound(p, false);
  await note.receiveNoteSyncRename({ oldPath: 'old.md', path: 'new.md', contentHash: hash('REMOTE'),
    sha: sha('REMOTE'), rev: 100, mtime: 80 }, p);
  await note.receiveNoteSyncEnd({ lastTime: 200, needModifyCount: 1 }, p);
  p.progressTracker.setDownloadTotal('note', 1);
  p.progressTracker.recordUploadComplete('note', p.noteSyncTasks.completed);
  p.progressTracker.recordPageProgress('note', 0, 1, true, true);
  await note.receiveNoteSyncModify({ path: 'new.md', content: 'REMOTE', contentHash: hash('REMOTE'), sha: sha('REMOTE'), rev: 100, pageIndex: 0 }, p);
  assert.equal(p.progressTracker.isTypeFullyDone('note'), true, 'transport pages alone are complete');
  note.commitNoteSyncRound(p);
  assert.equal(metadata.get('lastNoteSyncTime'), 60, 'unconfirmed forced upload must retain the previous successful cursor');
  assert.equal(p.pendingNoteModifies.has('new.md'), true, 'recovery intent must exist before the first send');
  assert.equal(p.localStorageManager.loadPending('pendingNoteModifies').has('new.md'), true);
});


await test('unchanged NoteSync inventories do not register uploads waiting for ACKs that never arrive', async () => {
  const { p, put, metadata } = fixture();
  put('same.md', 'same', 50);
  note.beginNoteSyncRound(p, false);
  await operator.handleRequestSend(p, 'note', {
    lastTime: 60, notes: [{ path: 'same.md', contentHash: hash('same'), mtime: 1 }], delNotes: [], missingNotes: []
  }, { files: [], delFiles: [], missingFiles: [] }, { configs: [], delConfigs: [], missingConfigs: [] },
  { folders: [], delFolders: [], missingFolders: [] });
  assert.equal(p.pendingNoteModifies.size, 0, 'a hash-only inventory does not imply a NoteModify was sent');
  await finish(p, 200, {});
  assert.equal(metadata.get('lastNoteSyncTime'), 200, 'an unchanged round still commits');
});

for (const reload of [false, true]) await test('End-before-ACK recovery survives ' + (reload ? 'plugin reload' : 'ordinary reset') + ' and resubmits old-mtime renamed content', async () => {
  const { p, put, files, sent, metadata } = fixture();
  const { SyncProgressTracker } = load('src/lib/sync/sync_progress_tracker.ts');
  p.progressTracker = new SyncProgressTracker(); p.progressTracker.reset(['note']);
  p.recordSyncCompleted = (type, page) => { p.noteSyncTasks.completed++; p.progressTracker.recordCompleted(type, page); };
  p.serverMerge.maxQueuedBytes = 10;
  metadata.set('lastNoteSyncTime', 90);
  put('old.md', 'base', 50); put('other.md', '12345678');
  await p.serverMerge.requestUploadFromDisk('other.md');
  note.beginNoteSyncRound(p, false);
  await note.receiveNoteSyncRename({ oldPath: 'old.md', path: 'new.md', contentHash: hash('REMOTE'),
    sha: sha('REMOTE'), rev: 100, mtime: 80 }, p);
  await note.receiveNoteSyncEnd({ lastTime: 200, needModifyCount: 1 }, p);
  p.progressTracker.setDownloadTotal('note', 1);
  p.progressTracker.recordUploadComplete('note', p.noteSyncTasks.completed);
  p.progressTracker.recordPageProgress('note', 0, 1, true, true);
  await note.receiveNoteSyncModify({ path: 'new.md', content: 'REMOTE', contentHash: hash('REMOTE'), sha: sha('REMOTE'), rev: 100, pageIndex: 0 }, p);
  assert.equal(p.progressTracker.isTypeFullyDone('note'), true);
  note.commitNoteSyncRound(p);
  assert.equal(metadata.get('lastNoteSyncTime'), 90, 'End is not successful before the queued upload ACK');
  assert.equal(p.localStorageManager.loadPending('pendingNoteModifies').has('new.md'), true);
  if (reload) {
    p.serverMerge.dispose();
    operator.cancelSync(p);
    p.pendingNoteModifies = p.localStorageManager.loadPending('pendingNoteModifies');
    p.fileHashManager = new FileHashManager(p);
    await p.fileHashManager.initialize();
    p.serverMerge = createServerMerge(p);
  } else {
    p.serverMerge.reset();
    p.isSyncing = false;
  }
  p.serverMerge.supported = true;
  await operator.handleSync(p, true, 'note');
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
  for (const { action, data } of [...sent]) if (action === 'NoteModify' && data.path === 'other.md' && p.serverMerge.acceptsAck(data)) {
    await note.receiveNoteModifyAck({ path: data.path, opId: data.opId, rev: 102, sha: sha(data.content) }, p);
  }
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
  const uploads = sent.filter(({ action, data }) => action === 'NoteModify' && data.path === 'new.md');
  assert.equal(uploads.length, 1, 'incremental scan explicitly retries the pending old-mtime body');
  assert.equal(uploads[0].data.baseSha, sha('base'), 'restart preserves the actual old ancestor');
  assert.equal(uploads[0].data.content, 'base');
  await note.receiveNoteModifyAck({ path: 'new.md', opId: uploads[0].data.opId, rev: 101,
    merged: true, content: 'REMOTE', sha: sha('REMOTE') }, p);
  for (const { action, data } of [...sent]) if (action === 'NoteModify' && data.path === 'other.md' && p.serverMerge.acceptsAck(data)) {
    await note.receiveNoteModifyAck({ path: data.path, opId: data.opId, rev: 102, sha: sha(data.content) }, p);
  }
  assert.equal(files.get('new.md').content, 'REMOTE');
  assert.equal(p.pendingNoteModifies.size, 0, 'only settled uploads are cleared');
  await note.receiveNoteSyncEnd({ lastTime: 300 }, p);
  p.progressTracker.setDownloadTotal('note', 0);
  p.progressTracker.recordUploadComplete('note', p.noteSyncTasks.completed);
  note.commitNoteSyncRound(p);
  assert.equal(metadata.get('lastNoteSyncTime'), 300, 'recovered round can subsequently finish');
});


await test('inventory Mtime cannot settle an unrelated in-flight serverMerge upload or erase its recovery intent', async () => {
  const { p, put, sent, files } = fixture();
  put('same.md', 'base', 50);
  files.get('same.md').content = 'LOCAL';
  await p.serverMerge.requestUploadFromDisk('same.md', true);
  const op = sent.find(({ action }) => action === 'NoteModify').data;
  await note.receiveNoteSyncMtime({ path: 'same.md', mtime: 80, ctime: 1 }, p);
  for (let i = 0; i < 2; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.serverMerge.acceptsAck(op), true, 'Mtime has no matching opId and cannot release the upload');
  assert.equal(p.pendingNoteModifies.has('same.md'), true);
  await note.receiveNoteModifyAck({ path: 'same.md', opId: op.opId, rev: 100, sha: sha('LOCAL') }, p);
  assert.equal(p.pendingNoteModifies.size, 0, 'the actual ACK settles and clears the recovery marker');
});

await test('rename metadata failure after moving source never attaches the previous target ancestor to it', async () => {
  const { p, put, files, sent } = fixture();
  const base = 'base\nmiddle\nsource old\n', local = 'LOCAL\nmiddle\nsource old\n', remote = 'base\nmiddle\nREMOTE\n';
  put('old.md', base, 50); files.get('old.md').content = local;
  put('new.md', remote, 60); files.get('new.md').content = 'TARGET complete draft';
  const modify = p.app.vault.modify;
  p.app.vault.modify = async () => { throw new Error('metadata IO failed after source move'); };
  await note.receiveNoteSyncRename({ oldPath: 'old.md', path: 'new.md', contentHash: hash(remote), sha: sha(remote), rev: 100, mtime: 80 }, p);
  assert.equal(p.noteSyncTasks.failed, 1);
  assert.equal(files.get('new.md').content, local);
  p.app.vault.modify = modify;
  p.serverMerge.reset(); p.serverMerge.supported = true;
  await p.serverMerge.requestUploadFromDisk('new.md', true);
  const upload = sent.filter(({ action, data }) => action === 'NoteModify' && data.path === 'new.md').at(-1).data;
  assert.equal(upload.baseSha, sha(base), 'retry must use the actual moved source ancestor');
  assert.notEqual(upload.baseSha, sha(remote), 'the historical target ancestor must not fast-forward over REMOTE');
  assert.ok([...files.values()].some(file => file.content === 'TARGET complete draft'));
});


await test('source rename IO failure before the move does not block same-rev remote recovery or leave missing-path pending', async () => {
  const { p, put, files, metadata } = fixture();
  put('old.md', 'base', 50);
  const rename = p.app.vault.rename;
  p.app.vault.rename = async () => { throw new Error('rename failed before moving source'); };
  await note.receiveNoteSyncRename({ oldPath: 'old.md', path: 'new.md', contentHash: hash('REMOTE'), sha: sha('REMOTE'), rev: 100, mtime: 80 }, p);
  assert.equal(files.has('old.md'), true);
  assert.equal(files.has('new.md'), false);
  p.app.vault.rename = rename;
  p.serverMerge.reset(); p.serverMerge.supported = true;
  await note.receiveNoteSyncModify({ path: 'new.md', content: 'REMOTE', contentHash: hash('REMOTE'), sha: sha('REMOTE'), rev: 100 }, p);
  assert.equal(files.get('new.md')?.content, 'REMOTE', 'the unprocessed remote revision must still be recoverable');
  assert.equal(p.pendingNoteModifies.has('new.md'), false);
  p.pendingNoteModifies.set('phantom.md', '');
  await operator.handleSync(p, true, 'note');
  assert.equal(p.pendingNoteModifies.has('phantom.md'), false, 'ordinary retry drops markers for files that never moved');
});


// CC review regressions: real handler/state machine/progress tracker, with only vault/transport IO mocked.
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
function trackedRound(p) {
  const { SyncProgressTracker } = load('src/lib/sync/sync_progress_tracker.ts');
  p.progressTracker = new SyncProgressTracker(); p.progressTracker.reset(['note']);
  p.recordSyncCompleted = (type, page) => { p.noteSyncTasks.completed++; p.progressTracker.recordCompleted(type, page); };
  note.beginNoteSyncRound(p, false);
}
async function declareEnd(p, lastTime, count = 0) {
  await note.receiveNoteSyncEnd({ lastTime, needModifyCount: count }, p);
  p.progressTracker.setDownloadTotal('note', count);
  p.progressTracker.recordUploadComplete('note', 0);
  if (count) p.progressTracker.recordPageProgress('note', 0, count, true, true);
}
async function reconnect(p, reload) {
  if (reload) {
    p.serverMerge.dispose(); operator.cancelSync(p);
    p.pendingNoteModifies = p.localStorageManager.loadPending('pendingNoteModifies');
    p.fileHashManager = new FileHashManager(p); await p.fileHashManager.initialize();
    p.serverMerge = createServerMerge(p);
  } else { p.serverMerge.reset(); p.isSyncing = false; }
  p.serverMerge.supported = true;
}

for (const failure of ['source move', 'target upload']) for (const dirty of [false, true]) {
  await test('M1: ' + (dirty ? 'dirty' : 'clean') + ' source before ' + failure + ' failure survives reset/reload without spurious old-name upload', async () => {
    for (const reload of [false, true]) {
      const { p, put, files, sent, metadata } = fixture();
      trackedRound(p); put('old.md', 'base', 50); metadata.set('lastNoteSyncTime', 90);
      if (dirty) files.get('old.md').content = 'LOCAL complete draft\n正文';
      const rename = p.app.vault.rename;
      if (failure === 'source move') p.app.vault.rename = async () => { throw Error('source move denied'); };
      else { put('new.md', 'TARGET complete draft'); p.concurrencyLimiter.waitForSlot = async () => false; }
      await note.receiveNoteSyncRename({ oldPath: 'old.md', path: 'new.md', contentHash: hash('REMOTE'), sha: sha('REMOTE'), rev: 100 }, p);
      assert.equal(files.get('old.md')?.content, dirty ? 'LOCAL complete draft\n正文' : 'base');
      assert.equal(p.pendingNoteModifies.has('old.md'), dirty, 'only a real local edit needs the old-name recovery intent');
      if (failure === 'target upload') assert.ok([...files.values()].some(file => file.content === 'TARGET complete draft'));
      p.app.vault.rename = rename; p.concurrencyLimiter.waitForSlot = async () => true;
      p.fileHashManager.flush();
      await reconnect(p, reload);
      await operator.handleSync(p, true, 'note'); await tick();
      const oldUploads = sent.filter(({ action, data }) => action === 'NoteModify' && data.path === 'old.md');
      assert.equal(oldUploads.length, dirty ? 1 : 0, 'a clean old path must not be recreated on the server after failed rename');
      if (dirty) {
        assert.equal(oldUploads[0].data.content, 'LOCAL complete draft\n正文');
        assert.equal(oldUploads[0].data.baseSha, sha('base'));
      }
    }
  });
}

for (const remote of ['delete', 'rename', 'modify']) await test('M2: readonly remote ' + remote + ' preserves paused draft and resumes after reset/reload', async () => {
  for (const reload of [false, true]) {
    const { p, put, files, sent, metadata } = fixture();
    put('old.md', 'base', 50); files.get('old.md').content = 'LOCAL complete draft\n正文';
    p.settings.readonlySyncEnabled = true;
    trackedRound(p); await declareEnd(p, 200, 1);
    if (remote === 'delete') await note.receiveNoteSyncDelete({ path: 'old.md', rev: 100, pageIndex: 0 }, p);
    else if (remote === 'rename') await note.receiveNoteSyncRename({ oldPath: 'old.md', path: 'new.md', contentHash: hash('REMOTE'), sha: sha('REMOTE'), rev: 100, pageIndex: 0 }, p);
    else await note.receiveNoteSyncModify({ path: 'old.md', content: 'REMOTE', contentHash: hash('REMOTE'), sha: sha('REMOTE'), rev: 100, pageIndex: 0 }, p);
    await tick();
    assert.equal(p.progressTracker.isTypeFullyDone('note'), true);
    assert.equal(p.noteSyncTasks.failed, 0, 'readonly is a pause, not an IO failure');
    assert.equal(note.hasPendingNoteUploads(p), false, 'paused intents must not block the current round');
    note.commitNoteSyncRound(p);
    assert.equal(metadata.get('lastNoteSyncTime'), 200);
    assert.equal(sent.filter(({ action }) => action === 'NoteModify').length, 0);
    const path = remote === 'rename' ? 'new.md' : 'old.md';
    assert.equal(files.get(path)?.content, 'LOCAL complete draft\n正文');
    assert.equal(p.localStorageManager.loadPending('pendingNoteModifies').has(path), true, 'draft needs a persistent resume intent despite the advanced cursor');
    await reconnect(p, reload);
    await operator.handleSync(p, true, 'note'); await tick();
    assert.equal(sent.filter(({ action }) => action === 'NoteModify').length, 0, 'a readonly rescan sends no writes');
    p.settings.readonlySyncEnabled = false;
    await reconnect(p, reload);
    await operator.handleSync(p, true, 'note'); await tick();
    const uploads = sent.filter(({ action, data }) => action === 'NoteModify' && data.path === path);
    assert.equal(uploads.length, 1, 'reenabling writes resumes the persisted old-mtime intent');
    assert.equal(uploads[0].data.content, 'LOCAL complete draft\n正文');
    if (remote !== 'delete') assert.equal(uploads[0].data.baseSha, sha('base'));
    await note.receiveNoteModifyAck({ path, opId: uploads[0].data.opId, rev: 201, sha: sha(uploads[0].data.content) }, p);
    assert.equal(p.pendingNoteModifies.size, 0);
  }
});

for (const pause of ['readonly', 'excluded']) for (const queued of ['inflight', 'deferred']) {
  await test('M2: ' + pause + ' after ' + queued + ' pauses completion and retries while retaining reload recovery', async () => {
    const { p, put, files, sent, metadata } = fixture();
    put('same.md', 'base', 50); files.get('same.md').content = 'LOCAL';
    if (queued === 'deferred') { p.serverMerge.maxQueuedBytes = 10; put('other.md', '12345678'); await p.serverMerge.requestUploadFromDisk('other.md'); }
    await p.serverMerge.requestUploadFromDisk('same.md', true);
    if (pause === 'readonly') p.settings.readonlySyncEnabled = true;
    else p.settings.excludedPaths = new Set(['same.md']);
    const before = sent.filter(({ action, data }) => action === 'NoteModify' && data.path === 'same.md').length;
    if (queued === 'deferred') {
      const other = sent.find(({ data }) => data.path === 'other.md').data;
      await note.receiveNoteModifyAck({ path: 'other.md', opId: other.opId, rev: 80, sha: sha(other.content) }, p); await tick();
    } else {
      // Exercise the actual resend boundary as well as a fresh explicit force.
      const entry = p.serverMerge.inflight.get('same.md');
      await p.serverMerge.onTimeout('same.md', entry);
      await p.serverMerge.requestUploadFromDisk('same.md', true);
    }
    assert.equal(sent.filter(({ action, data }) => action === 'NoteModify' && data.path === 'same.md').length, before, 'paused in-flight retries and deferred drains must not write');
    trackedRound(p); await declareEnd(p, 200);
    assert.equal(note.hasPendingNoteUploads(p), false);
    note.commitNoteSyncRound(p); assert.equal(metadata.get('lastNoteSyncTime'), 200);
    assert.equal(p.localStorageManager.loadPending('pendingNoteModifies').has('same.md'), true);
    p.fileHashManager.flush(); await reconnect(p, true);
    await operator.handleSync(p, true, 'note'); await tick();
    assert.equal(sent.filter(({ action, data }) => action === 'NoteModify' && data.path === 'same.md').length, before);
    p.settings.readonlySyncEnabled = false; p.settings.excludedPaths?.clear();
    await reconnect(p, false); await operator.handleSync(p, true, 'note'); await tick();
    const op = sent.filter(({ action, data }) => action === 'NoteModify' && data.path === 'same.md').at(-1).data;
    assert.equal(sent.filter(({ action, data }) => action === 'NoteModify' && data.path === 'same.md').length, before + 1);
    assert.equal(op.content, 'LOCAL'); assert.equal(op.baseSha, sha('base'));
    await note.receiveNoteModifyAck({ path: 'same.md', opId: op.opId, rev: 201, sha: sha('LOCAL') }, p);
    assert.equal(p.pendingNoteModifies.has('same.md'), false);
  });
}

await test('L1/L2: same-rev page does not duplicate in-flight force and late ACK commits the retained round', async () => {
  const { p, put, files, sent, metadata } = fixture();
  put('same.md', 'base', 50); files.get('same.md').content = 'LOCAL';
  trackedRound(p); await p.serverMerge.requestUploadFromDisk('same.md', true);
  await declareEnd(p, 200, 1);
  await note.receiveNoteSyncModify({ path: 'same.md', content: 'REMOTE', contentHash: hash('REMOTE'), sha: sha('REMOTE'), rev: 50, pageIndex: 0 }, p);
  note.commitNoteSyncRound(p);
  assert.equal(metadata.has('lastNoteSyncTime'), false, 'L1: the round must wait for the actual ACK');
  const op = sent[0].data;
  await note.receiveNoteModifyAck({ path: 'same.md', opId: op.opId, rev: 201, merged: true, content: 'LOCAL + REMOTE', sha: sha('LOCAL + REMOTE') }, p);
  assert.equal(sent.filter(({ action }) => action === 'NoteModify').length, 1, 'L2: a duplicate page is not a new local edit');
  assert.equal(files.get('same.md').content, 'LOCAL + REMOTE');
  assert.equal(note.hasPendingNoteUploads(p), false);
  note.commitNoteSyncRound(p);
  assert.equal(metadata.get('lastNoteSyncTime'), 200, 'L1: retaining the round allows its cursor to commit after the late ACK');
});

await test('L3: legacy cancelled clean pending does not create a false conflict; genuine dirty pending survives', async () => {
  for (const dirty of [false, true]) {
    const { p, put, files } = fixture();
    trackedRound(p); put('same.md', 'base', 0); p.fileHashManager.setFileHash('same.md', hash('base'), 1, 4);
    if (dirty) files.get('same.md').content = 'LOCAL';
    p.serverMerge.supported = false;
    p.pendingNoteModifies.set('same.md', hash(dirty ? 'LOCAL' : 'base'));
    p.localStorageManager.savePending('pendingNoteModifies', p.pendingNoteModifies);
    const backups = new Map();
    Object.assign(p.app.vault.adapter, { mkdir: async () => {}, write: async (path, body) => backups.set(path, body), read: async path => backups.get(path) });
    operator.cancelSync(p);
    await note.receiveNoteSyncModify({ path: 'same.md', content: 'REMOTE', contentHash: hash('REMOTE'), mtime: 100 }, p);
    assert.equal(files.get('same.md').content, dirty ? 'LOCAL' : 'REMOTE');
    assert.equal([...backups.keys()].some(path => path.endsWith('.remote.md')), dirty, 'only a real local edit should require legacy conflict preservation');
    assert.equal(p.pendingNoteModifies.has('same.md'), dirty);
  }
});


for (const pause of ['readonly', 'excluded']) await test('M2: ACK during ' + pause + ' cannot erase the intent for a newer old-mtime edit', async () => {
  const { p, put, files, sent, metadata } = fixture();
  trackedRound(p); put('same.md', 'base', 50); files.get('same.md').content = 'FIRST';
  await p.serverMerge.requestUploadFromDisk('same.md', true);
  const op = sent[0].data;
  if (pause === 'readonly') p.settings.readonlySyncEnabled = true;
  else p.settings.excludedPaths = new Set(['same.md']);
  files.get('same.md').content = 'SECOND complete draft';
  await declareEnd(p, 200);
  note.commitNoteSyncRound(p); assert.equal(metadata.get('lastNoteSyncTime'), 200);
  await note.receiveNoteModifyAck({ path: 'same.md', opId: op.opId, rev: 100, sha: sha('FIRST') }, p); await tick();
  assert.equal(files.get('same.md').content, 'SECOND complete draft');
  assert.equal(p.pendingNoteModifies.has('same.md'), true, 'a paused dirty flush is not confirmation of the newer local body');
  assert.equal(sent.length, 1);
  await reconnect(p, true);
  p.settings.readonlySyncEnabled = false; p.settings.excludedPaths?.clear();
  await operator.handleSync(p, true, 'note'); await tick();
  const retry = sent.filter(({ action, data }) => action === 'NoteModify' && data.path === 'same.md').at(-1).data;
  assert.equal(retry.content, 'SECOND complete draft'); assert.equal(retry.baseSha, sha('FIRST'));
});

await test('L2: same-rev persisted force upgrades an ordinary request still waiting for its slot', async () => {
  const { p, put, sent } = fixture();
  put('same.md', 'base', 50); p.serverMerge.env.markUploadPending('same.md');
  let grant;
  p.concurrencyLimiter.waitForSlot = () => new Promise(resolve => { grant = resolve; });
  const ordinary = p.serverMerge.requestUploadFromDisk('same.md');
  await note.receiveNoteSyncModify({ path: 'same.md', content: 'REMOTE', contentHash: hash('REMOTE'), sha: sha('REMOTE'), rev: 50 }, p);
  grant(true); await ordinary; await tick();
  assert.equal(sent.length, 1, 'queued no-op must retain the persisted force, without adding a second upload');
  const op = sent[0].data;
  await note.receiveNoteModifyAck({ path: 'same.md', opId: op.opId, rev: 100, merged: true, content: 'REMOTE', sha: sha('REMOTE') }, p);
  assert.equal(sent.length, 1); assert.equal(p.pendingNoteModifies.size, 0);
});

await test('M2: toggling exclusion while acquiring a content-upload slot blocks the actual send and releases it', async () => {
  const { p, put, files, sent } = fixture();
  put('same.md', 'base', 50); files.get('same.md').content = 'LOCAL';
  let grant, releases = 0;
  p.concurrencyLimiter.waitForSlot = () => new Promise(resolve => { grant = resolve; });
  p.concurrencyLimiter.releaseSlot = () => { releases++; };
  const upload = p.serverMerge.requestUpload('same.md', 'LOCAL', hash('LOCAL'), true);
  await tick(); p.settings.excludedPaths = new Set(['same.md']); grant(true);
  assert.equal(await upload, 'failed'); assert.equal(sent.length, 0); assert.equal(releases, 1);
  assert.equal(p.pendingNoteModifies.has('same.md'), true);
});

await test('L3: known SHA prevents legacy cancellation cleanup from mistaking a hash32 collision for a clean draft', async () => {
  const { p, put, files } = fixture();
  trackedRound(p); put('same.md', 'base', 50); files.get('same.md').content = 'LOCAL';
  // Model hash32(base) == hash32(LOCAL), while trusted SHA still distinguishes the complete bodies.
  p.fileHashManager.setFileHash('same.md', hash('LOCAL'), 1, 4, 50, sha('base'));
  p.serverMerge.supported = false; p.pendingNoteModifies.set('same.md', hash('LOCAL'));
  const backups = new Map();
  Object.assign(p.app.vault.adapter, { mkdir: async () => {}, write: async (path, body) => backups.set(path, body), read: async path => backups.get(path) });
  operator.cancelSync(p);
  await note.receiveNoteSyncModify({ path: 'same.md', content: 'REMOTE', contentHash: hash('REMOTE'), mtime: 100 }, p);
  assert.equal(files.get('same.md').content, 'LOCAL'); assert.equal(p.pendingNoteModifies.has('same.md'), true);
  assert.ok([...backups.values()].includes('REMOTE'));
});

assert.equal(failures.length, 0, failures.join(', '));
