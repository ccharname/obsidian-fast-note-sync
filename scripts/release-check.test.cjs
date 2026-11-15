'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs, localCheck, releaseCheck, main, sha } = require('./release-check.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-gate-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, value) => fs.writeFileSync(path.join(root, name), typeof value === 'string' ? value : JSON.stringify(value));
  write('release-check.json', { repository: 'owner/plugin', pluginId: 'test-plugin', assets: ['main.js', 'manifest.json', 'styles.css'] });
  write('manifest.json', { id: 'test-plugin', version: '1.2.3', minAppVersion: '1.5.8', isDesktopOnly: false });
  write('package.json', { version: '1.2.3' });
  write('versions.json', { '1.2.3': '1.5.8' });
  write('main.js', 'module.exports = class Plugin {};\n');
  write('styles.css', '.plugin { color: inherit; }\n');
  const local = localCheck(root, root);
  const commit = 'a'.repeat(40), release = { id: 10, tag_name: '1.2.3', draft: false, prerelease: false, updated_at: 'now' };
  const assets = Object.entries(local.assets).map(([name, entry], i) => ({ id: i + 1, name, size: entry.bytes,
    digest: 'sha256:' + entry.sha256, state: 'uploaded', updated_at: 'now' }));
  const calls = [];
  function api(endpoint, binary) {
    calls.push({ endpoint, binary });
    if (endpoint.includes('/git/ref/tags/')) return { object: { type: 'commit', sha: commit } };
    if (endpoint.includes('/contents/')) {
      const name = endpoint.split('/contents/')[1].split('?')[0];
      return { encoding: 'base64', content: fs.readFileSync(path.join(root, name)).toString('base64') };
    }
    if (endpoint.includes('/assets?')) return assets;
    const match = endpoint.match(/\/releases\/assets\/(\d+)$/);
    if (match) {
      const asset = assets.find(a => a.id === +match[1]);
      return binary ? fs.readFileSync(path.join(root, asset.name)) : { ...asset };
    }
    if (endpoint.includes('/releases/')) return { ...release };
    throw new Error('Unexpected API route');
  }
  return { root, write, local, release, assets, api, calls, options: { mode: 'release', tag: '1.2.3' } };
}

test('complete release verifies downloaded bytes and emits provenance', t => {
  const f = fixture(t), result = releaseCheck(f.local, f.options, f.api);
  assert.equal(result.passed, true);
  assert.equal(Object.keys(result.assets).length, 3);
  assert.equal(f.calls.filter(c => c.binary).length, 3);
});
test('manifest/package disagreement blocks local verification', t => {
  const f = fixture(t); f.write('package.json', { version: '1.2.2' });
  assert.throws(() => localCheck(f.root, f.root), /version mismatch/);
});
test('missing current versions mapping blocks local verification', t => {
  const f = fixture(t); f.write('versions.json', {});
  assert.throws(() => localCheck(f.root, f.root), /versions.json/);
});
test('mobile-only drift and wrong plugin id block local verification', t => {
  const f = fixture(t), p = path.join(f.root, 'manifest.json'), m = JSON.parse(fs.readFileSync(p));
  f.write('manifest.json', { ...m, isDesktopOnly: true });
  assert.throws(() => localCheck(f.root, f.root), /Mobile/);
  f.write('manifest.json', { ...m, id: 'other' });
  assert.throws(() => localCheck(f.root, f.root), /plugin id/);
});
test('missing or empty candidate binary blocks local verification', t => {
  const f = fixture(t); f.write('main.js', '');
  assert.throws(() => localCheck(f.root, f.root), /nonempty/);
  fs.rmSync(path.join(f.root, 'main.js'));
  assert.throws(() => localCheck(f.root, f.root), /ENOENT/);
});
test('copied bundle manifest must match source byte for byte', t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.root, 'bundle'));
  fs.writeFileSync(path.join(f.root, 'bundle/manifest.json'), '{}');
  assert.throws(() => localCheck(f.root, path.join(f.root, 'bundle')), /Asset manifest differs/);
});
test('missing or duplicate required release asset blocks verification', t => {
  const f = fixture(t); const first = f.assets.shift();
  assert.throws(() => releaseCheck(f.local, f.options, f.api), /Missing or duplicate/);
  f.assets.unshift(first, first);
  assert.throws(() => releaseCheck(f.local, f.options, f.api), /Missing or duplicate/);
});
test('wrong digest, size, or incomplete upload cannot pass', t => {
  const f = fixture(t), item = f.assets[0], original = { ...item };
  for (const [key, value, error] of [['digest', 'sha256:' + '0'.repeat(64), /digest/], ['size', 99, /size/], ['state', 'new', /upload incomplete/]]) {
    Object.assign(item, original, { [key]: value });
    assert.throws(() => releaseCheck(f.local, f.options, f.api), error);
  }
});
test('matching API digest cannot conceal corrupted actual download', t => {
  const f = fixture(t);
  assert.throws(() => releaseCheck(f.local, f.options, (endpoint, binary) => {
    const result = f.api(endpoint, binary);
    if (!binary) return result;
    const changed = Buffer.from(result); changed[0] ^= 1; return changed;
  }), /downloaded SHA/);
});
test('tag with different main.js fails even when manifest and release match', t => {
  const f = fixture(t);
  assert.throws(() => releaseCheck(f.local, f.options, (endpoint, binary) => endpoint.includes('/contents/main.js?')
    ? { encoding: 'base64', content: Buffer.from('other source').toString('base64') } : f.api(endpoint, binary)), /Tag main.js differs/);
});
test('tag manifest disagreement blocks release verification', t => {
  const f = fixture(t);
  assert.throws(() => releaseCheck(f.local, f.options, (endpoint, binary) => endpoint.includes('/contents/manifest.json?')
    ? { encoding: 'base64', content: Buffer.from('{}').toString('base64') } : f.api(endpoint, binary)), /Tag manifest differs/);
});
test('asset replacement or tag movement during verification fails', t => {
  const f = fixture(t); let tagReads = 0;
  assert.throws(() => releaseCheck(f.local, f.options, (endpoint, binary) => {
    const result = f.api(endpoint, binary);
    if (/\/releases\/assets\/1$/.test(endpoint) && !binary) result.updated_at = 'changed';
    return result;
  }), /changed during/);
  assert.throws(() => releaseCheck(f.local, f.options, (endpoint, binary) => {
    if (endpoint.includes('/git/ref/tags/') && ++tagReads > 1) return { object: { type: 'commit', sha: 'b'.repeat(40) } };
    return f.api(endpoint, binary);
  }), /Tag moved/);
});
test('draft, prerelease, and wrong version do not pass published gate', t => {
  const f = fixture(t); f.release.draft = true;
  assert.throws(() => releaseCheck(f.local, f.options, f.api), /draft/);
  assert.equal(releaseCheck(f.local, { ...f.options, mode: 'draft' }, f.api).passed, true);
  f.release.draft = false; f.release.prerelease = true;
  assert.throws(() => releaseCheck(f.local, f.options, f.api), /stable release/);
  assert.throws(() => releaseCheck(f.local, { ...f.options, tag: '1.2.4' }, f.api), /candidate version/);
});
test('all release asset pages are searched', t => {
  const f = fixture(t), requested = [];
  const result = releaseCheck(f.local, f.options, (endpoint, binary) => {
    if (endpoint.includes('/assets?')) {
      const page = Number(new URLSearchParams(endpoint.split('?')[1]).get('page')); requested.push(page);
      return page === 1 ? Array.from({ length: 100 }, (_, i) => ({ name: 'extra-' + i })) : f.assets;
    }
    return f.api(endpoint, binary);
  });
  assert.equal(result.passed, true); assert.deepEqual(requested, [1, 2, 1, 2]);
});
test('earlier asset deletion during later download cannot pass final inventory', t => {
  const f = fixture(t); let deleted = false;
  assert.throws(() => releaseCheck(f.local, f.options, (endpoint, binary) => {
    const result = f.api(endpoint, binary);
    if (binary && endpoint.endsWith('/2')) deleted = true;
    if (endpoint.includes('/assets?') && deleted) return f.assets.filter(a => a.id !== 1);
    return result;
  }), /disappeared/);
});
test('FNS bundle gate requires independent tagged build input verification', t => {
  const f = fixture(t); f.local.pluginId = 'fast-note-sync';
  assert.throws(() => releaseCheck(f.local, f.options, f.api), /tagged build input/);
  assert.throws(() => releaseCheck(f.local, f.options, f.api, () => { throw new Error('source differs'); }), /source differs/);
  assert.equal(releaseCheck(f.local, f.options, f.api, () => ['src']).passed, true);
});
test('network/API errors propagate rather than silently skip', t => {
  const f = fixture(t);
  assert.throws(() => releaseCheck(f.local, f.options, () => { throw new Error('network down'); }), /network down/);
});
test('bad arguments and conflicting modes are rejected', () => {
  for (const args of [[], ['--release'], ['--local', '--draft', '1.2.3'], ['--wat'], ['--release', '$(echo bad)'], ['--local', '--asset-dir']]) {
    assert.throws(() => parseArgs(args));
  }
});
test('failed rerun removes previous success evidence, including argument failure', t => {
  const f = fixture(t); main(['--local'], f.root);
  const files = ['checksums.json', 'SHA256SUMS', 'release-verification.json'];
  const seed = () => files.forEach(name => fs.writeFileSync(path.join(f.root, 'dist', name), 'old success'));
  seed(); f.write('main.js', ''); assert.throws(() => main(['--local'], f.root));
  for (const name of files) assert.equal(fs.existsSync(path.join(f.root, 'dist', name)), false);
  seed(); assert.throws(() => main(['--bad'], f.root));
  for (const name of files) assert.equal(fs.existsSync(path.join(f.root, 'dist', name)), false);
});
test('local success writes verifiable SHA files', t => {
  const f = fixture(t); main(['--local'], f.root);
  const result = JSON.parse(fs.readFileSync(path.join(f.root, 'dist/checksums.json')));
  assert.equal(result.assets['main.js'].sha256, sha(fs.readFileSync(path.join(f.root, 'main.js'))));
  assert.match(fs.readFileSync(path.join(f.root, 'dist/SHA256SUMS'), 'utf8'), /  manifest.json\n/);
});
