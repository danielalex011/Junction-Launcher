'use strict';
// Values baked into official builds so players don't have to configure anything:
// the Microsoft (Azure) app ID used for sign-in and the CurseForge API key.
// They come from build-config.json (not committed — see build-config.example.json)
// or from environment variables. A value set in Settings always wins.
const fs = require('fs');
const path = require('path');

function loadBuildConfig({ appRoot } = {}) {
  const out = {
    msClientId: process.env.JUNCTION_MS_CLIENT_ID || '',
    cfApiKey: process.env.JUNCTION_CF_API_KEY || '',
  };
  const file = appRoot ? path.join(appRoot, 'build-config.json') : null;
  if (file) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      out.msClientId = out.msClientId || String(j.msClientId || '').trim();
      out.cfApiKey = out.cfApiKey || String(j.cfApiKey || '').trim();
    } catch { /* no build config: everything comes from Settings */ }
  }
  return out;
}

module.exports = { loadBuildConfig };
