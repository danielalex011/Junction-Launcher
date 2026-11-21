'use strict';
// Builds the shared context every core module receives. Nothing in core/ imports
// Electron, so all of it can be tested with plain Node.
const path = require('path');
const { Settings } = require('./settings');
const { Http } = require('./http');
const { TaskManager } = require('./tasks');
const { ensureDir } = require('./util');

async function createContext(root, { crypto, fetchImpl, builtins = {} } = {}) {
  const meta = path.join(root, 'meta'); // laid out like a .minecraft folder so Forge/NeoForge installers work
  const paths = {
    root,
    meta,
    versions: path.join(meta, 'versions'),
    libraries: path.join(meta, 'libraries'),
    assets: path.join(meta, 'assets'),
    natives: path.join(meta, 'natives'),
    runtimes: path.join(root, 'runtimes'),
    instances: path.join(root, 'instances'),
    cache: path.join(root, 'cache'),
    settingsFile: path.join(root, 'settings.json'),
    accountsFile: path.join(root, 'accounts.json'),
    tasksFile: path.join(root, 'activity.json'),
  };
  for (const k of ['meta', 'versions', 'libraries', 'assets', 'natives', 'runtimes', 'instances', 'cache']) {
    await ensureDir(paths[k]);
  }
  const cryptoImpl = crypto || {
    encrypt: async (s) => `b64:${Buffer.from(s, 'utf8').toString('base64')}`,
    decrypt: async (s) => Buffer.from(String(s).replace(/^b64:/, ''), 'base64').toString('utf8'),
  };
  const settings = await new Settings(paths.settingsFile, cryptoImpl, builtins).load();
  const http = new Http({ getCurseForgeKey: () => settings.get('cfApiKey'), fetchImpl });
  const tasks = await new TaskManager({ historyFile: paths.tasksFile }).load();
  return { root, paths, settings, http, tasks, crypto: cryptoImpl };
}

module.exports = { createContext };
