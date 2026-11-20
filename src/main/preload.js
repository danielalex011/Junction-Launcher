'use strict';
// The only bridge between the UI and the launcher core. The page gets a small,
// fixed API — no Node, no filesystem, no arbitrary IPC.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const EVENTS = new Set(['task:update', 'inst:log', 'inst:state', 'blocked:update', 'blocked:complete', 'app:openFiles']);

contextBridge.exposeInMainWorld('junction', {
  async call(channel, ...args) {
    const r = await ipcRenderer.invoke(channel, ...args);
    if (!r.ok) {
      const e = new Error(r.error);
      e.code = r.code;
      e.manualUrl = r.manualUrl;
      throw e;
    }
    return r.data;
  },
  on(event, cb) {
    if (!EVENTS.has(event)) throw new Error(`Unknown event ${event}`);
    const fn = (_e, payload) => cb(payload);
    ipcRenderer.on(event, fn);
    return () => ipcRenderer.removeListener(event, fn);
  },
  pathForFile(file) {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  },
});
