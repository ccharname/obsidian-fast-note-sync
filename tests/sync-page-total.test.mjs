import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const noop = () => {};
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/sync/sync_progress_tracker.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText, {
  module, exports: module.exports,
  window: { setTimeout: () => 1, clearTimeout: noop },
  require: () => ({ dump: noop })
});
const { SyncProgressTracker } = module.exports;
function start(total) {
  const tracker = new SyncProgressTracker();
  tracker.reset(['note']);
  tracker.setDownloadTotal('note', total);
  tracker.recordUploadComplete('note');
  return tracker;
}

{
  const tracker = start(2);
  tracker.recordPageProgress('note', 1, 1, true, true);
  tracker.recordCompleted('note', 1);
  assert.equal(tracker.isTypeFullyDone('note'), false, 'last page cannot shrink the SyncEnd total');
  tracker.recordPageProgress('note', 0, 1, false, true);
  assert.equal(tracker.isTypeFullyDone('note'), false, 'every registered page must be processed');
  tracker.recordCompleted('note', 0);
  assert.equal(tracker.isTypeFullyDone('note'), true, 'all declared items and contiguous pages are complete');
}
{
  const tracker = start(1);
  tracker.recordPageProgress('note', 1, 1, true, true);
  tracker.recordCompleted('note', 1);
  assert.equal(tracker.isTypeFullyDone('note'), false, 'equal item count cannot hide a missing empty page');
  tracker.recordPageProgress('note', 0, 0, false, true);
  assert.equal(tracker.isTypeFullyDone('note'), true);
}
{
  const tracker = start(1);
  tracker.recordPageProgress('note', 0, 2, true, true);
  tracker.recordCompleted('note', 0);
  tracker.recordCompleted('note', 0);
  assert.equal(tracker.isTypeFullyDone('note'), false, 'more received items do not match the authoritative total');
}
{
  const tracker = start(2);
  tracker.recordPageProgress('note', 0, 1, false, true);
  tracker.recordCompleted('note', 0);
  tracker.recordPageProgress('note', 0, 1, false, true);
  tracker.recordCompleted('note', 0);
  tracker.recordPageProgress('note', 1, 1, true, true);
  assert.equal(tracker.isTypeFullyDone('note'), false, 'duplicate pages or live completions cannot fill another page');
  tracker.recordCompleted('note');
  assert.equal(tracker.isTypeFullyDone('note'), false);
  tracker.recordCompleted('note', 1);
  assert.equal(tracker.isTypeFullyDone('note'), true);
}
{
  const tracker = start(2);
  tracker.recordPageProgress('note', 0, 1, false);
  tracker.recordCompleted('note');
  tracker.recordPageProgress('note', 1, 1, true);
  assert.equal(tracker.isTypeFullyDone('note'), false);
  tracker.recordCompleted('note');
  assert.equal(tracker.isTypeFullyDone('note'), true, 'legacy details without pageIndex still complete normally');
  tracker.reset(['note']);
  tracker.setDownloadTotal('note', 0);
  tracker.recordUploadComplete('note');
  assert.equal(tracker.isTypeFullyDone('note'), true, 'new empty round discards the previous authoritative total');
}
console.log('PASS: authoritative SyncEnd totals, contiguous pages, per-page processing and legacy completion');
