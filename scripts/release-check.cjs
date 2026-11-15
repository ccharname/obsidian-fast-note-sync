'use strict';
// Read-only release gate. GitHub access uses the already authenticated gh CLI.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..');
const LIMIT = 32 * 1024 * 1024;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);

function parseArgs(args) {
  const result = { mode: null, assetDir: '.', outDir: 'dist' };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (['--local', '--release', '--draft'].includes(flag)) {
      assert.equal(result.mode, null, 'Choose exactly one of --local, --release TAG, --draft TAG');
      result.mode = flag.slice(2);
      if (flag !== '--local') {
        result.tag = args[++i];
        assert(version(result.tag), 'Release tag must be an exact x.y.z version');
      }
    } else if (flag === '--asset-dir' || flag === '--out-dir') {
      const value = args[++i];
      assert(value && !value.startsWith('--'), `Missing value for ${flag}`);
      result[flag === '--asset-dir' ? 'assetDir' : 'outDir'] = value;
    } else throw new Error(`Unknown argument: ${flag}`);
  }
  assert(result.mode, 'Choose --local, --release TAG, or --draft TAG');
  return result;
}

function localCheck(root, assetDir) {
  const config = json(path.join(root, 'release-check.json'));
  assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository), 'Invalid repository');
  assert(Array.isArray(config.assets) && config.assets.length >= 2, 'Missing asset list');
  assert.equal(new Set(config.assets).size, config.assets.length, 'Duplicate configured asset');
  for (const name of config.assets) assert(['main.js', 'manifest.json', 'styles.css'].includes(name), 'Invalid asset name');
  assert(config.assets.includes('main.js') && config.assets.includes('manifest.json'), 'Missing required plugin asset');
  const manifestBytes = fs.readFileSync(path.join(root, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  const pkg = json(path.join(root, 'package.json'));
  const versions = json(path.join(root, 'versions.json'));
  assert.equal(manifest.id, config.pluginId, 'Unexpected plugin id');
  assert(version(manifest.version) && version(manifest.minAppVersion), 'Invalid manifest version');
  assert.equal(pkg.version, manifest.version, 'package/manifest version mismatch');
  assert.equal(versions[manifest.version], manifest.minAppVersion, 'versions.json lacks current minimum app version');
  assert.equal(manifest.isDesktopOnly, false, 'Mobile support declaration changed');
  if (config.requireLuckyBuild) assert.equal(manifest.luckyBuild, true, 'Expected Lucky build');
  assert(fs.readFileSync(path.join(assetDir, 'manifest.json')).equals(manifestBytes), 'Asset manifest differs from source manifest');
  const assets = {};
  for (const name of config.assets) {
    const file = path.join(assetDir, name);
    assert(fs.statSync(file).isFile(), `${name} is not a file`);
    const size = fs.statSync(file).size;
    assert(size > 0 && size <= LIMIT, `${name} must be nonempty and at most 32 MiB`);
    const content = fs.readFileSync(file);
    assets[name] = { bytes: content.length, sha256: sha(content) };
  }
  return { repository: config.repository, pluginId: manifest.id, version: manifest.version,
    minAppVersion: manifest.minAppVersion, assets };
}

function ghApi(endpoint, binary = false) {
  const args = ['api', endpoint, '-H', binary ? 'Accept: application/octet-stream' : 'Accept: application/vnd.github+json'];
  try {
    const bytes = execFileSync('gh', args, { encoding: null, maxBuffer: LIMIT + 1024, timeout: 120000,
      stdio: ['ignore', 'pipe', 'pipe'] });
    return binary ? bytes : JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`GitHub read failed for ${endpoint.split('?')[0]} (exit ${error.status ?? error.code ?? 'unknown'}); check gh authentication/network`);
  }
}

function resolveTag(api, prefix, tag) {
  let object = api(`${prefix}/git/ref/tags/${encodeURIComponent(tag)}`).object;
  for (let depth = 0; depth < 6; depth++) {
    assert(object && /^[a-f0-9]{40}$/.test(object.sha), 'Invalid tag object');
    if (object.type === 'commit') return object.sha;
    assert.equal(object.type, 'tag', 'Tag does not resolve to a commit');
    object = api(`${prefix}/git/tags/${object.sha}`).object;
  }
  throw new Error('Tag nesting exceeds limit');
}

function listAssets(api, prefix, id) {
  const assets = [];
  for (let page = 1; ; page++) {
    assert(page <= 100, 'Release asset pagination exceeded limit');
    const batch = api(`${prefix}/releases/${id}/assets?per_page=100&page=${page}`);
    assert(Array.isArray(batch), 'Invalid assets response');
    assets.push(...batch);
    if (batch.length < 100) return assets;
  }
}

function verifyBuildSource(root, commit) {
  const inputs = ['src', 'tsconfig.json', 'esbuild.config.mjs', 'pnpm-lock.yaml'];
  execFileSync('git', ['diff', '--exit-code', '--quiet', '--no-ext-diff', commit, '--', ...inputs], { cwd: root, stdio: 'pipe' });
  const untracked = execFileSync('git', ['ls-files', '--others', '--', ...inputs], { cwd: root, encoding: 'utf8' });
  assert.equal(untracked.trim(), '', 'Untracked build inputs would invalidate tag provenance');
  const tagged = JSON.parse(execFileSync('git', ['show', `${commit}:package.json`], { cwd: root, encoding: 'utf8' }));
  const current = json(path.join(root, 'package.json'));
  for (const pkg of [tagged, current]) {
    delete pkg.scripts?.verify;
    delete pkg.scripts?.['verify:release'];
  }
  assert.deepEqual(current, tagged, 'Package build inputs differ from tag (only verification scripts may differ)');
  return [...inputs, 'package.json (excluding verification commands)'];
}

function releaseCheck(local, options, api = ghApi, sourceValidator) {
  assert.equal(options.tag, local.version, 'Release tag differs from candidate version');
  const prefix = `repos/${local.repository}`;
  const commit = resolveTag(api, prefix, options.tag);
  let sourceInputsVerified = [];
  if (local.pluginId === 'fast-note-sync') {
    assert.equal(typeof sourceValidator, 'function', 'FNS release requires tagged build input verification');
    sourceInputsVerified = sourceValidator(commit);
    assert(Array.isArray(sourceInputsVerified) && sourceInputsVerified.length > 0, 'FNS build input verification missing');
  }
  const release = api(`${prefix}/releases/tags/${options.tag}`);
  assert.equal(release.tag_name, options.tag, 'Release tag mismatch');
  assert.equal(release.draft, options.mode === 'draft', 'Unexpected draft/published state');
  assert.equal(release.prerelease, false, 'Expected a stable release');
  assert(Number.isSafeInteger(release.id) && release.id > 0, 'Invalid release id');
  const tagManifest = api(`${prefix}/contents/manifest.json?ref=${commit}`);
  assert.equal(tagManifest.encoding, 'base64', 'Expected a regular manifest blob');
  const tagBytes = Buffer.from(tagManifest.content, 'base64');
  assert.equal(sha(tagBytes), local.assets['manifest.json'].sha256, 'Tag manifest differs from candidate');
  // Single-file plugins must also match the actual source at the immutable tag.
  // FNS bundles main.js, so its tagged source contains manifest/styles only.
  for (const name of Object.keys(local.assets).filter(name => name !== 'manifest.json' &&
    (name !== 'main.js' || local.pluginId !== 'fast-note-sync'))) {
    const blob = api(`${prefix}/contents/${name}?ref=${commit}`);
    assert.equal(blob.encoding, 'base64', `Expected a regular tagged ${name} blob`);
    assert.equal(sha(Buffer.from(blob.content, 'base64')), local.assets[name].sha256, `Tag ${name} differs from candidate`);
  }
  const remoteAssets = listAssets(api, prefix, release.id);
  const verified = {};
  for (const [name, expected] of Object.entries(local.assets)) {
    const matches = remoteAssets.filter(asset => asset.name === name);
    assert.equal(matches.length, 1, `Missing or duplicate release asset: ${name}`);
    const asset = matches[0];
    assert(Number.isSafeInteger(asset.id) && asset.id > 0, 'Invalid asset id');
    assert.equal(asset.state, 'uploaded', `${name} upload incomplete`);
    assert.equal(asset.size, expected.bytes, `${name} remote size differs`);
    assert.equal(asset.digest, `sha256:${expected.sha256}`, `${name} API digest differs`);
    const bytes = api(`${prefix}/releases/assets/${asset.id}`, true);
    assert(Buffer.isBuffer(bytes), 'Expected binary asset');
    assert.equal(bytes.length, expected.bytes, `${name} downloaded size differs`);
    assert.equal(sha(bytes), expected.sha256, `${name} downloaded SHA differs`);
    const after = api(`${prefix}/releases/assets/${asset.id}`);
    for (const key of ['id', 'name', 'size', 'digest', 'state', 'updated_at']) {
      assert.equal(after[key], asset[key], `${name} changed during verification`);
    }
    verified[name] = { ...expected, assetId: asset.id };
  }
  // An earlier asset could be removed/replaced while a later one downloads.
  const finalAssets = listAssets(api, prefix, release.id);
  for (const name of Object.keys(local.assets)) {
    const before = remoteAssets.find(a => a.name === name);
    const matches = finalAssets.filter(a => a.name === name);
    assert.equal(matches.length, 1, `${name} disappeared or duplicated during verification`);
    for (const key of ['id', 'name', 'size', 'digest', 'state', 'updated_at']) {
      assert.equal(matches[0][key], before[key], `${name} changed during later downloads`);
    }
  }
  const afterRelease = api(`${prefix}/releases/${release.id}`);
  for (const key of ['id', 'tag_name', 'draft', 'prerelease', 'updated_at']) {
    assert.equal(afterRelease[key], release[key], 'Release changed during verification');
  }
  assert.equal(resolveTag(api, prefix, options.tag), commit, 'Tag moved during verification');
  return { passed: true, mode: options.mode, repository: local.repository, tag: options.tag,
    tagCommit: commit, sourceInputsVerified, releaseId: release.id, assets: verified };
}

function clearEvidence(root, outDir = 'dist') {
  const out = path.resolve(root, outDir);
  assert(out.startsWith(root + path.sep), 'Output must be a subdirectory of the repository');
  fs.mkdirSync(out, { recursive: true });
  assert(fs.realpathSync(out).startsWith(fs.realpathSync(root) + path.sep), 'Output symlink escapes repository');
  const files = ['checksums.json', 'SHA256SUMS', 'release-verification.json'];
  for (const name of files) fs.rmSync(path.join(out, name), { force: true });
  return out;
}

function main(args = process.argv.slice(2), root = ROOT) {
  clearEvidence(root);
  const options = parseArgs(args);
  const out = clearEvidence(root, options.outDir);
  const local = localCheck(root, path.resolve(root, options.assetDir));
  let remote;
  if (options.mode !== 'local') remote = releaseCheck(local, options, ghApi, commit => verifyBuildSource(root, commit));
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(out, 'checksums.json'), JSON.stringify({ ...local, at }, null, 2) + '\n');
  fs.writeFileSync(path.join(out, 'SHA256SUMS'), Object.entries(local.assets).map(([name, entry]) => `${entry.sha256}  ${name}\n`).join(''));
  if (remote) fs.writeFileSync(path.join(out, 'release-verification.json'), JSON.stringify({ ...remote, at }, null, 2) + '\n');
  console.log(`PASS ${local.pluginId} ${local.version}: ${Object.keys(local.assets).length} assets (${options.mode})`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(`FAIL release check: ${error.message}`); process.exitCode = 1; }
}
module.exports = { parseArgs, localCheck, releaseCheck, main, clearEvidence, sha };
