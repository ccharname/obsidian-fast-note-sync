import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.createSourceFile('operator.ts', fs.readFileSync('src/lib/sync/operator.ts', 'utf8'), ts.ScriptTarget.Latest, true);
let expression;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'settleHashWithTimeout'
      && node.getText(source).includes('plugin.app.vault.read(file)')) expression = node.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(expression, 'exercise the actual note scan deadline expression');
const helper = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'settleHashWithTimeout');
assert.ok(helper);
const code = ts.transpileModule(`${helper.getText(source)}\nmodule.exports = (${expression});`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
function run(read) {
  const timers = new Map(), module = { exports: {} };
  vm.runInNewContext(code, {
    module,
    plugin: { app: { vault: { read } } }, file: {},
    hashContentAsync: async content => `hash:${content}`,
    window: { setTimeout: fn => { timers.set(1, fn); return 1; }, clearTimeout: id => timers.delete(id) }
  });
  return { promise: module.exports, timers };
}
let finishRead, settled = false;
const blocked = run(() => new Promise(resolve => { finishRead = resolve; }));
blocked.promise.then(() => { settled = true; }, () => { settled = true; });
assert.equal(blocked.timers.size, 1, 'timeout must start before file read completes');
blocked.timers.get(1)();
for (let i = 0; i < 20; i++) await Promise.resolve();
assert.equal(settled, false, 'a deadline must not release a still-running read/hash resource');
finishRead('late note');
await assert.rejects(blocked.promise, /Hash timeout/);
assert.equal(blocked.timers.size, 0);
assert.equal(await run(async () => 'note').promise, 'hash:note');
await assert.rejects(run(async () => { throw new Error('read failed'); }).promise, /read failed/);
console.log('PASS: deadline starts before a blocked read; ownership remains until it settles; successful and failed reads retain their results');
