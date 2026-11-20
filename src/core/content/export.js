'use strict';
// Export an instance as a Modrinth .mrpack or a CurseForge .zip.
// Files that exist on the target platform are referenced (small pack, author gets the download);
// everything else is bundled in overrides/.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const AdmZip = require('adm-zip');
const { hashFile, exists } = require('../util');
const { curseFingerprintFile } = require('../sources/fingerprint');

const MR_HOSTS = ['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com'];
const SKIP = new Set(['logs', 'crash-reports', 'screenshots', '.fabric', '.mixin.out', 'natives', 'usercache.json', 'usernamecache.json', 'command_history.txt']);

/** What the export dialog offers: top-level files/folders of the game dir. */
async function exportableEntries(gameDir) {
  const out = [];
  for (const e of await fsp.readdir(gameDir, { withFileTypes: true }).catch(() => [])) {
    if (SKIP.has(e.name)) continue;
    const defaultOn = ['mods', 'config', 'resourcepacks', 'shaderpacks', 'kubejs', 'defaultconfigs', 'options.txt', 'servers.dat'].includes(e.name);
    out.push({ name: e.name, dir: e.isDirectory(), defaultOn });
  }
  return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

async function walk(base, rel, out) {
  const full = path.join(base, rel);
  const st = await fsp.stat(full).catch(() => null);
  if (!st) return;
  if (st.isDirectory()) {
    for (const name of await fsp.readdir(full)) await walk(base, rel ? `${rel}/${name}` : name, out);
  } else if (st.isFile()) {
    out.push(rel.replace(/\\/g, '/'));
  }
}

function isContentFile(rel) {
  return /^(mods\/[^/]+\.jar|resourcepacks\/[^/]+\.zip|shaderpacks\/[^/]+\.zip)$/i.test(rel);
}

async function collect(gameDir, include) {
  const files = [];
  for (const top of include) await walk(gameDir, top, files);
  return files.filter((f) => !f.endsWith('.disabled') && !f.includes('.part-'));
}

function loaderDepKey(type) {
  return { fabric: 'fabric-loader', quilt: 'quilt-loader', forge: 'forge', neoforge: 'neoforge' }[type];
}

async function exportMrpack({ instances, sources }, instId, outPath, { name, version = '1.0.0', summary = '', include }) {
  const inst = await instances.get(instId);
  const gameDir = instances.gameDir(instId);
  const idx = await instances.readIndex(instId);
  const files = await collect(gameDir, include);
  const entries = [];
  const overrides = [];
  const lookup = [];
  for (const rel of files) {
    if (!isContentFile(rel)) { overrides.push(rel); continue; }
    const e = idx.files[rel] || {};
    const full = path.join(gameDir, rel);
    const sha1 = await hashFile(full, 'sha1');
    let url = null;
    if (e.source === 'modrinth' && e.fileUrl && MR_HOSTS.includes(new URL(e.fileUrl).hostname) && (!e.sha1 || e.sha1 === sha1)) url = e.fileUrl;
    if (url) entries.push({ rel, sha1, url });
    else lookup.push({ rel, sha1 });
  }
  // Maybe the jar is on Modrinth even though it was installed from CurseForge or by hand.
  if (lookup.length) {
    try {
      const found = await sources.modrinth.versionsByHash(lookup.map((l) => l.sha1));
      for (const l of lookup) {
        const v = found[l.sha1];
        const f = v?.files.find((x) => x.sha1 === l.sha1);
        if (f) entries.push({ rel: l.rel, sha1: l.sha1, url: f.url }); else overrides.push(l.rel);
      }
    } catch {
      overrides.push(...lookup.map((l) => l.rel));
    }
  }
  const index = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: version,
    name: name || inst.name,
    summary,
    files: [],
    dependencies: { minecraft: inst.mcVersion },
  };
  const lk = loaderDepKey(inst.loader?.type);
  if (lk) index.dependencies[lk] = inst.loader.version;
  for (const e of entries) {
    const full = path.join(gameDir, e.rel);
    const st = await fsp.stat(full);
    const side = idx.files[e.rel]?.meta?.environment;
    index.files.push({
      path: e.rel,
      hashes: { sha1: e.sha1, sha512: await hashFile(full, 'sha512') },
      env: { client: 'required', server: side === 'client' ? 'unsupported' : 'required' },
      downloads: [e.url],
      fileSize: st.size,
    });
  }
  const zip = new AdmZip();
  zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify(index, null, 2)));
  for (const rel of overrides) zip.addFile(`overrides/${rel}`, await fsp.readFile(path.join(gameDir, rel)));
  zip.writeZip(outPath);
  const bundledContent = overrides.filter(isContentFile);
  return { path: outPath, referenced: entries.length, bundled: overrides.length, bundledContent };
}

async function exportCurseForge({ instances, sources }, instId, outPath, { name, version = '1.0.0', author = '', include }) {
  const inst = await instances.get(instId);
  const gameDir = instances.gameDir(instId);
  const idx = await instances.readIndex(instId);
  const files = await collect(gameDir, include);
  const refs = [];
  const overrides = [];
  const lookup = [];
  for (const rel of files) {
    if (!isContentFile(rel)) { overrides.push(rel); continue; }
    const e = idx.files[rel] || {};
    if (e.source === 'curseforge' && e.projectId && e.versionId) refs.push({ rel, projectID: Number(e.projectId), fileID: Number(e.versionId), title: e.title });
    else lookup.push(rel);
  }
  if (lookup.length && sources.curseforge.configured()) {
    try {
      const fps = {};
      for (const rel of lookup) fps[rel] = await curseFingerprintFile(path.join(gameDir, rel));
      const found = await sources.curseforge.byFingerprint(Object.values(fps));
      for (const rel of lookup) {
        const m = found[fps[rel]];
        if (m) refs.push({ rel, projectID: Number(m.projectId), fileID: Number(m.version.id), title: m.version.name }); else overrides.push(rel);
      }
    } catch {
      overrides.push(...lookup);
    }
  } else {
    overrides.push(...lookup);
  }
  const loaderId = inst.loader?.type && inst.loader.type !== 'vanilla' ? `${inst.loader.type}-${inst.loader.version}` : null;
  const manifest = {
    minecraft: { version: inst.mcVersion, modLoaders: loaderId ? [{ id: loaderId, primary: true }] : [] },
    manifestType: 'minecraftModpack',
    manifestVersion: 1,
    name: name || inst.name,
    version,
    author,
    files: refs.map((r) => ({ projectID: r.projectID, fileID: r.fileID, required: true })),
    overrides: 'overrides',
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const modlist = `<ul>\n${refs.map((r) => `<li>${esc(r.title || r.rel)}</li>`).join('\n')}\n</ul>\n`;
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
  zip.addFile('modlist.html', Buffer.from(modlist));
  for (const rel of overrides) zip.addFile(`overrides/${rel}`, await fsp.readFile(path.join(gameDir, rel)));
  zip.writeZip(outPath);
  return { path: outPath, referenced: refs.length, bundled: overrides.length, bundledContent: overrides.filter(isContentFile) };
}

module.exports = { exportMrpack, exportCurseForge, exportableEntries, isContentFile, exists };
