'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { tmpDir, makeCtx } = require('./helpers');
const { parseNbt, readWorldVersion, compareWorld, inspectSource, planCopy, copyFrom } = require('../src/core/content/worldcopy');

// ---- a tiny NBT writer, enough for a level.dat
const str = (s) => { const b = Buffer.from(s); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); };
const tag = (type, name, payload) => Buffer.concat([Buffer.from([type]), str(name), payload]);
const int = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const compound = (children) => Buffer.concat([...children, Buffer.from([0])]);
function levelDat({ name, id, snapshot = false, levelName = 'World' } = {}) {
  const data = [tag(8, 'LevelName', str(levelName)), tag(3, 'DataVersion', int(id || 0))];
  if (name) data.push(tag(10, 'Version', compound([tag(3, 'Id', int(id || 0)), tag(8, 'Name', str(name)), tag(1, 'Snapshot', Buffer.from([snapshot ? 1 : 0]))])));
  return zlib.gzipSync(tag(10, '', compound([tag(10, 'Data', compound(data))])));
}

function write(p, data = 'x') { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); }
function world(gameDir, folder, opts) { write(path.join(gameDir, 'saves', folder, 'level.dat'), levelDat(opts)); write(path.join(gameDir, 'saves', folder, 'region', 'r.0.0.mca'), 'region-' + folder); write(path.join(gameDir, 'saves', folder, 'session.lock'), 'lock'); }

test('reads a world version from level.dat', async () => {
  const dir = tmpDir();
  world(dir, 'W', { name: '1.20.1', id: 3465, levelName: 'My Base' });
  assert.deepEqual(await readWorldVersion(path.join(dir, 'saves', 'W')), { name: '1.20.1', id: 3465, snapshot: false });
  assert.equal(parseNbt(zlib.gunzipSync(levelDat({ name: '1.20.1', levelName: 'My Base' }))).Data.LevelName, 'My Base');
});

test('level.dat without a version, or broken, gives null', async () => {
  const dir = tmpDir();
  world(dir, 'Old', {});
  assert.equal(await readWorldVersion(path.join(dir, 'saves', 'Old')), null);
  write(path.join(dir, 'saves', 'Bad', 'level.dat'), 'not nbt at all');
  assert.equal(await readWorldVersion(path.join(dir, 'saves', 'Bad')), null);
  assert.equal(await readWorldVersion(path.join(dir, 'saves', 'Missing')), null);
});

test('world version check: newer is blocked, older warns, same is fine, unknown is flagged', () => {
  const v = (name, snapshot = false) => ({ name, id: 1, snapshot });
  assert.equal(compareWorld(v('1.20.1'), '1.20.1'), 'same');
  assert.equal(compareWorld(v('1.20'), '1.20.0'), 'same');
  assert.equal(compareWorld(v('1.19.4'), '1.20.1'), 'older');
  assert.equal(compareWorld(v('1.20.4'), '1.20.1'), 'newer');
  assert.equal(compareWorld(v('1.21.10'), '1.21.9'), 'newer');
  assert.equal(compareWorld(v('1.21.11'), '26.1'), 'older');
  assert.equal(compareWorld(v('26.1'), '1.21.11'), 'newer');
  assert.equal(compareWorld(v('24w14a', true), '1.21'), 'unknown');
  assert.equal(compareWorld(v('1.20.1'), '24w14a'), 'unknown');
  assert.equal(compareWorld(null, '1.20.1'), 'unknown');
});

function sampleSource() {
  const src = tmpDir('src-');
  world(src, 'Survival', { name: '1.20.1', id: 3465, levelName: 'Survival Base' });
  world(src, 'Creative', { name: '1.19.4', id: 3337 });
  world(src, 'FromTheFuture', { name: '1.21.4', id: 4189 });
  write(path.join(src, 'saves', 'not-a-world', 'readme.txt'));
  write(path.join(src, 'options.txt'), 'key_key.jump:key.keyboard.j\n');
  write(path.join(src, 'servers.dat'), 'servers');
  write(path.join(src, 'xaero', 'minimap', 'waypoints.txt'), 'wp');
  write(path.join(src, 'journeymap', 'data', 'x.json'), '{}');
  write(path.join(src, 'schematics', 'house.litematic'), 'schem');
  return src;
}

test('inspects a source: worlds with versions and sizes, and the items found', async () => {
  const src = sampleSource();
  const r = await inspectSource(src);
  assert.deepEqual(r.worlds.map((w) => w.folder).sort(), ['Creative', 'FromTheFuture', 'Survival']);
  const s = r.worlds.find((w) => w.folder === 'Survival');
  assert.equal(s.name, 'Survival Base');
  assert.equal(s.version.name, '1.20.1');
  assert.ok(s.size > 0);
  assert.deepEqual(r.items.map((i) => i.id).sort(), ['minimap', 'options', 'schematics', 'servers']);
  assert.ok(r.items.every((i) => i.size > 0));
});

test('plan: newer world is blocked, older world is an upgrade, existing files are overwrites', async () => {
  const src = sampleSource();
  const dst = tmpDir('dst-');
  write(path.join(dst, 'options.txt'), 'mine');
  const plan = await planCopy({ sourceDir: src, targetDir: dst, targetMc: '1.20.1', choices: { worlds: ['Survival', 'Creative', 'FromTheFuture'], items: ['options'] } });
  assert.deepEqual(plan.blocked.map((b) => b.folder), ['FromTheFuture']);
  assert.deepEqual(plan.upgrades.map((b) => b.folder), ['Creative']);
  assert.deepEqual(plan.unknown, []);
  assert.equal(plan.overwrites.length, 1);
  assert.match(plan.overwrites[0], /options\.txt/);
});

test('copy refuses a world from a newer Minecraft and copies nothing', async () => {
  const ctx = await makeCtx();
  const src = sampleSource();
  const dst = tmpDir('dst-');
  await assert.rejects(copyFrom({ ctx, sourceDir: src, targetDir: dst, backupRoot: path.join(dst, '..', 'bk'), targetMc: '1.20.1', choices: { worlds: ['Survival', 'FromTheFuture'] }, confirmed: true }),
    /newer than this instance/);
  assert.equal(fs.existsSync(path.join(dst, 'saves')), false);
});

test('copies worlds and settings; the source is left exactly as it was', async () => {
  const ctx = await makeCtx();
  const src = sampleSource();
  const dst = tmpDir('dst-');
  const before = JSON.stringify(await listAll(src));
  const r = await copyFrom({ ctx, sourceDir: src, targetDir: dst, backupRoot: path.join(dst, '..', 'bk'), targetMc: '1.20.1',
    choices: { worlds: ['Survival'], items: ['options', 'servers', 'minimap', 'schematics'] } });
  assert.equal(fs.readFileSync(path.join(dst, 'saves', 'Survival', 'region', 'r.0.0.mca'), 'utf8'), 'region-Survival');
  assert.equal(fs.existsSync(path.join(dst, 'saves', 'Survival', 'session.lock')), false); // the lock isn't copied
  assert.equal(fs.existsSync(path.join(dst, 'saves', 'Creative')), false); // not picked
  assert.equal(fs.readFileSync(path.join(dst, 'options.txt'), 'utf8'), 'key_key.jump:key.keyboard.j\n');
  assert.equal(fs.readFileSync(path.join(dst, 'servers.dat'), 'utf8'), 'servers');
  assert.equal(fs.readFileSync(path.join(dst, 'xaero', 'minimap', 'waypoints.txt'), 'utf8'), 'wp');
  assert.equal(fs.readFileSync(path.join(dst, 'journeymap', 'data', 'x.json'), 'utf8'), '{}');
  assert.equal(fs.readFileSync(path.join(dst, 'schematics', 'house.litematic'), 'utf8'), 'schem');
  assert.equal(r.backupDir, null);
  assert.equal(JSON.stringify(await listAll(src)), before);
});

test('copy asks before replacing, then backs up what it replaced', async () => {
  const ctx = await makeCtx();
  const src = sampleSource();
  const dst = tmpDir('dst-');
  const bk = path.join(tmpDir('bk-'), 'backups');
  write(path.join(dst, 'options.txt'), 'my old options');
  write(path.join(dst, 'saves', 'Survival', 'level.dat'), 'my old world');
  const args = { ctx, sourceDir: src, targetDir: dst, backupRoot: bk, targetMc: '1.20.1', choices: { worlds: ['Survival'], items: ['options'] } };
  await assert.rejects(copyFrom(args), /confirm/);
  assert.equal(fs.readFileSync(path.join(dst, 'options.txt'), 'utf8'), 'my old options'); // untouched until confirmed
  const r = await copyFrom({ ...args, confirmed: true });
  assert.equal(fs.readFileSync(path.join(dst, 'options.txt'), 'utf8'), 'key_key.jump:key.keyboard.j\n');
  assert.ok(r.backupDir.startsWith(bk));
  assert.equal(fs.readFileSync(path.join(r.backupDir, 'options.txt'), 'utf8'), 'my old options');
  assert.equal(fs.readFileSync(path.join(r.backupDir, 'saves', 'Survival', 'level.dat'), 'utf8'), 'my old world');
  assert.equal(fs.existsSync(path.join(dst, 'saves', 'Survival', 'region', 'r.0.0.mca')), true);
});

test('copying an older world needs confirmation too (it is upgraded when opened)', async () => {
  const ctx = await makeCtx();
  const src = sampleSource();
  const dst = tmpDir('dst-');
  const args = { ctx, sourceDir: src, targetDir: dst, backupRoot: path.join(dst, '..', 'bk'), targetMc: '1.20.1', choices: { worlds: ['Creative'] } };
  await assert.rejects(copyFrom(args), /confirm/);
  assert.equal(fs.existsSync(path.join(dst, 'saves', 'Creative')), false);
  await copyFrom({ ...args, confirmed: true });
  assert.equal(fs.existsSync(path.join(dst, 'saves', 'Creative', 'level.dat')), true);
});

test('copy rejects the same folder, an empty choice and a world that is not there', async () => {
  const ctx = await makeCtx();
  const src = sampleSource();
  const base = { ctx, backupRoot: path.join(src, '..', 'bk'), targetMc: '1.20.1' };
  await assert.rejects(copyFrom({ ...base, sourceDir: src, targetDir: src, choices: { items: ['options'] } }), /same instance/);
  await assert.rejects(copyFrom({ ...base, sourceDir: src, targetDir: tmpDir(), choices: {} }), /Nothing to copy/);
  await assert.rejects(copyFrom({ ...base, sourceDir: src, targetDir: tmpDir(), choices: { worlds: ['../etc'] } }), /isn't in the source/);
});

async function listAll(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...(await listAll(dir, r)));
    else out.push([r, fs.statSync(path.join(dir, r)).size, fs.statSync(path.join(dir, r)).mtimeMs]);
  }
  return out;
}
