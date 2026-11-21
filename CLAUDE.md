# CLAUDE.md — working on Junction

Junction is an Electron Minecraft launcher that installs mods/modpacks from **both Modrinth and CurseForge**. Plain JavaScript (CommonJS), no framework, no TypeScript, no bundler. The maintainer develops on **Windows** and commits with GitHub Desktop.

## Commands

```bash
npm install          # once
npm start            # run the app from source
npm test             # node:test suites in test/*.test.js — must pass before every commit
npm run dist:win     # dist/Junction-<version>-win-x64.zip + NSIS installer (run on Windows)
```

- `npm test` uses a simulated network, never the real APIs. When you change something that talks to Modrinth, CurseForge, Mojang, Fabric/Quilt/Forge/NeoForge or Microsoft, **also try it for real with `npm start`**. The test fixtures reflect API shapes as of late 2026; if a real response differs, fix the code *and* update the fixture.
- To test a build, the maintainer unzips `dist/Junction-<version>-win-x64.zip` into a separate folder outside the repo. His instances live in `%APPDATA%\Junction\data`, not in that folder.

## Layout

```
src/core/            engine — plain Node, must NEVER require('electron') (keeps it testable)
  context.js         builds ctx { paths, settings, http, tasks, crypto } passed to everything
  http.js            fetch wrapper; download() hashes while streaming, verifies, then renames
  settings.js        settings.json; secrets encrypted; built-in defaults from build-config.js
  build-config.js    official-build sign-in ID + CurseForge key (build-config.json / env vars)
  instances.js       instance folders, content.json index, listContent(), icons
  minecraft/         versions (inheritsFrom merge), install (libs/natives/assets), java (Mojang runtimes), launch args
  loaders/           Fabric/Quilt (meta JSON) and Forge/NeoForge (headless official installer)
  sources/           modrinth.js, curseforge.js (normalised shapes), index.js (merged search), fingerprint.js
  content/           manager.js (install/deps/dedupe/updates/undo), modpacks.js, export.js, importer.js, blocked.js, metadata.js
  auth/accounts.js   Microsoft device-code → Xbox → XSTS → Minecraft; offline accounts
src/main/main.js     Electron main: IPC handlers (`handle('area:action', fn)`), tasks, protocol, windows
src/main/preload.js  the ONLY bridge: window.junction.call(channel, ...args) / on(event, cb)
src/renderer/        index.html, app.js (all UI), styles.css
test/                *.test.js + helpers.js (makeCtx with fake fetch, fabricJar/forgeJar builders)
tools/               mock-network.js + seed-demo.js for offline UI work
```

Data flow for a feature: core function → `handle('x:y', …)` in main.js → `call('x:y', …)` in app.js. Long jobs go through `ctx.tasks.run(title, (t) => …)` so they show in the sidebar task panel.

## Shared data shapes

- **Project** (search hit / details): `{ source: 'modrinth'|'curseforge', id, slug, title, summary, icon, url, type: 'mod'|'modpack'|'resourcepack'|'shader', ... }`. Merged hits add `alsoOn: [{source, id, slug, url}]`.
- **Version**: `{ source, id, projectId, versionNumber, gameVersions, loaders, releaseType: 'release'|'beta'|'alpha', date, files: [{url, filename, sha1, sha512?, size, primary}], deps: [{source, projectId, versionId?, type}] }`. CurseForge file IDs are numbers, Modrinth IDs are strings, so compare with `String(a) === String(b)`.
- **content.json** (per instance): `files["mods/x.jar"] = { source, projectId, versionId, title, versionName, icon, projectUrl, fileUrl, sha1, meta: {modId, name, version, loader}, pinned?, fromPack? }`.

## Rules — don't break these

**Security**
- Paths from modpacks, zips or other launchers go through `util.safeJoin()`. Never `path.join` untrusted relative paths.
- Downloads are verified with sha1/sha512 whenever the API gives one.
- The CurseForge key is only sent to `api.curseforge.com` / `*.forgecdn.net` (see `http.headersFor`).
- Never log the Minecraft access token: `launch.js` redacts it, so keep it that way.
- Never commit `build-config.json`.
- UI: put API text in the DOM via the `h()` helper (textContent), never `innerHTML`. Project descriptions only render inside the sandboxed iframe (no scripts).
- The renderer has no Node access; add new capabilities as IPC handlers.

**Respect the platforms**
- If a CurseForge file has `downloadUrl: null`, the author disabled third-party downloads. Use the blocked-download flow (open the page, watch the Downloads folder). Never build `edge.forgecdn.net` URLs to get around it.
- Modrinth needs a descriptive User-Agent (already set in http.js).

**Other launchers' data is read-only**
- The importer copies instance folders, never moves or edits them.
- Modrinth App's `app.db` is read from a temp copy (plus its `-wal` file) with `node:sqlite`; sql.js is the fallback.

**UI gotchas**
- In `h()`, write conditional children as `cond ? el : null`. A shim in app.js drops null/false from `append`/`replaceChildren`. Keep the shim.
- CSS order matters: generic rules like `.list { overflow: hidden }` and `.item { grid-template-columns }` come later in styles.css than some specific ones. Use compound selectors (`.list.upd-list`, `.item.upd-row`) for overrides.
- Local instance pictures are served through the `junction-icon://<instance-id>/` protocol (allowed in the CSP).

## Conventions

- Every change set that ships: bump `version` in package.json (patch: 0.1.7 → 0.1.8) and add/adjust tests.
- Commit message format (the maintainer pastes this into GitHub Desktop):
  ```
  Summary:  vX.Y.Z: <short description, under ~70 chars>

  Added
  - ...
  Fixed
  - ...
  Changed
  - ...
  ```
- README.md is for players/visitors. Don't put personal setup notes in it; developer setup goes in its "Building it yourself" section.
- Plain, friendly wording in the UI. Error messages say what to do next.

## Known gaps

- Forge for Minecraft < 1.13 isn't supported (legacy installers have no headless mode).
- If Microsoft sign-in fails with `APP_NOT_APPROVED` (403 from login_with_xbox), Mojang hasn't approved the Azure app ID yet. That's not a code bug.
- Never verified live yet: game launch, Forge/NeoForge installer runs, Microsoft sign-in, CurseForge modpack install. Expect a few real-world fixes there.
- No skin manager or instance groups yet.

## Offline UI work / screenshots

```bash
node tools/seed-demo.js C:\tmp\junction-demo
set JUNCTION_DATA=C:\tmp\junction-demo
set JUNCTION_FETCH_MOCK=%CD%\tools\mock-network.js
npm start
```

`JUNCTION_SCREENSHOT=<png>` (plus optional `JUNCTION_SCREENSHOT_JS="go('settings')"` and `JUNCTION_SCREENSHOT_WAIT=1500`) makes the app run the snippet, save a screenshot and quit. It's handy for checking UI changes.
