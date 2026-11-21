# Junction: a Minecraft launcher for Modrinth *and* CurseForge

Junction is a desktop Minecraft launcher (Windows, macOS, Linux) that lets you:

- **Search Modrinth and CurseForge at the same time.** A mod that's on both sites shows up once, with a badge for each, and you choose which site to install from.
- **Install mods, modpacks, resource packs and shaders from either site.** Required dependencies are installed too.
- **Mix sources freely in one instance.** For example, Fabric API from CurseForge plus Sodium from Modrinth.
- **Build your own pack.** Create an instance, add whatever you want, then export it as a Modrinth `.mrpack` or a CurseForge `.zip`.
- **Bring your instances over** from the CurseForge app, Modrinth App or Prism/MultiMC without re-downloading anything.
- **Play** vanilla, Fabric, Quilt, Forge and NeoForge. The right Java version (8/17/21/25) is downloaded for you.

No ads, no telemetry, no account needed to browse.

---

## What it fixes compared with the two official apps

| Problem | CurseForge app | Modrinth App | Junction |
|---|---|---|---|
| Content from the other site | ✗ | ✗ | ✓ unified search, mixed instances |
| Ads | Ads in the free app | Ads unless you pay for Modrinth+ | None |
| Telemetry / account wall | Overwolf, login for many actions | Account for some features | None, and the source is right here |
| Same mod installed twice (once from each site) | n/a | n/a | Detected via the jar's own mod id; replaced automatically or flagged |
| CurseForge mods with third-party downloads disabled | ✓ | ✗ | Opens the file page, watches your Downloads folder and moves the file into place automatically (no workaround that ignores the author's choice) |
| Updating hand-added or imported jars | ✗ | Partly | Recognises jars by hash on Modrinth and by fingerprint on CurseForge, so they become updatable |
| Pinning a version (e.g. after a bad Fabric API release) | ✗ | ✗ | "Pin this version" makes updates skip it |
| Export a pack for the *other* platform | ✗ | ✗ | Export both formats. Files are linked where the target site has them and bundled otherwise |
| Weight | Overwolf-based | Tauri | Electron (about 140 MB zipped). Not the smallest, but nothing runs in the background |

---

## Getting started

### Option A: Windows build
Unzip `Junction-<version>-win-x64.zip` anywhere and run `Junction.exe`.
To keep all data next to the exe (e.g. on a USB stick), create an empty file called `portable.txt` beside `Junction.exe`.

### Option B: run from source (any OS)
```bash
npm install
npm start
```
Requires Node.js 20+.

### One-time setup (Settings page)

**1. CurseForge API key** (for CurseForge search and downloads)
Get a free key at <https://console.curseforge.com/> and paste it in Settings → CurseForge. Since July 2026 CurseForge requires the key on CDN downloads too, so Junction sends it with every CurseForge request and nowhere else. The key is stored encrypted with your OS keychain.
Without a key Junction still works fully with Modrinth.

**2. Microsoft sign-in (Azure app ID)**
Microsoft requires every launcher to sign in through its own registered app, and Mojang must approve new ones. This is free and is a one-time step:

1. Go to <https://portal.azure.com> → *App registrations* → *New registration*.
   - Name: anything (e.g. "Junction personal")
   - Supported account types: **Personal Microsoft accounts only**
   - Redirect URI: leave empty
2. Open the app → *Authentication* → *Advanced settings* → set **Allow public client flows** to **Yes** → Save.
3. Copy the **Application (client) ID** from the Overview page.
4. Submit the Minecraft API access form: <https://aka.ms/mce-reviewappid>. Until Mojang approves it, sign-in stops with *"Mojang refused this app (403)"*.
5. Paste the client ID into Settings → Microsoft sign-in, then go to Accounts → *Add Microsoft account*.

Sign-in uses Microsoft's device-code page, so your password never touches the launcher. Tokens are encrypted with the OS keychain.
Offline accounts (for singleplayer/LAN) unlock once you've added a Microsoft account that owns the game.

---

## Everyday use

- **Library → New instance**: pick a loader, Minecraft version and loader version. Junction suggests names like "Fabric 26.1.2".
- **Instance → Add mods**: opens Browse locked to that instance's version and loader. **Install** picks the newest compatible release. Open a project to choose a specific version, or to switch between its Modrinth and CurseForge pages.
- **Check for updates → Update all**: checks both sites (pinned files are skipped), then opens a review window. Each mod shows current → new version, and you can pick any newer compatible version per mod or untick it to skip it. You can also set whether the default is the newest release, release-or-beta, or anything. Replaced jars are backed up, and **Undo last update** puts them back.
- **⋯ → Export**: choose which folders to include (mods, config, kubejs, options.txt…).
- **Import**: drop a `.mrpack` or CurseForge `.zip` onto the window, or use *Import → Instances from other launchers*. Junction finds your instances automatically in:
  - Modrinth App (it reads Modrinth App's own database for the exact version and loader)
  - the CurseForge app
  - Prism / PolyMC, GDLauncher and ATLauncher
  - the official Minecraft Launcher's profiles

  Tick the ones you want and import them in one go. If you moved a launcher's folder, use *Browse for a folder…*. Originals are copied, never modified.
- **Settings tab of an instance**: memory, Java path, JVM arguments (with Generational ZGC and tuned G1 presets), window size, and *Join server on launch*.
- **Modpack instances**: *⋯ → Check for modpack update*. Mods the pack installed are replaced, mods you added yourself are kept, and `config/` is backed up to `backups/` first.

## Where data lives
- Windows: `%APPDATA%\Junction\data`
- macOS: `~/Library/Application Support/Junction/data`
- Linux: `~/.config/Junction/data`

Settings → *Open data folder* opens it. Each instance is `instances/<id>/minecraft` (a normal game folder), plus `content.json`, which records where every file came from.

## Network & privacy
Junction only talks to Mojang (game files, Java), Microsoft/Xbox (sign-in), Modrinth, CurseForge, and the loader sites (fabricmc.net, quiltmc.org, minecraftforge.net, neoforged.net). Mod icons load from those sites' CDNs. Nothing else, no analytics.

Security details:
- Every download is SHA-1/SHA-512 verified before it's moved into place.
- Modpack paths are checked so a malicious pack can't write outside the instance.
- Project descriptions render in a sandboxed frame with scripts disabled.
- The UI has no Node.js access.

## Building installers
```bash
npm run dist:win     # NSIS installer + zip (run on Windows; on Linux the installer step needs Wine)
npm run dist:mac
npm run dist:linux   # AppImage
```

## Tests
```bash
npm test
```
43 tests run against a fake Mojang/Fabric/Modrinth/CurseForge/Microsoft. They cover the full install → launch path (spawning a stand-in Java), dependencies across sites, duplicate detection, blocked-download pickup, modpack import/export round trips, path-traversal rejection, the Forge/NeoForge headless installer and Microsoft sign-in.

## Known limitations
- **Forge for Minecraft older than 1.13** uses legacy installers that can't run headless, so it isn't supported. Fabric/Quilt/vanilla work for old versions.
- Launchers installed to a non-default folder aren't found automatically. Use *Browse for a folder…* for those.
- The test suite runs against recorded API shapes, not the live services. If a site changes its API, the first real run is where that shows up. Errors are shown in the task panel bottom-left.
- No skin manager or instance groups yet.

## Project layout
```
src/core/        launcher engine (plain Node, no Electron)
  minecraft/     versions, libraries, assets, Java runtimes, launch arguments
  loaders/       Fabric, Quilt, Forge, NeoForge
  sources/       Modrinth + CurseForge clients, unified search, CF fingerprints
  content/       install/update/dedupe, modpacks, export, import, blocked downloads
  auth/          Microsoft device-code sign-in, offline accounts
src/main/        Electron main process + preload bridge
src/renderer/    UI (HTML/CSS/vanilla JS)
test/            node:test suites with a fake network
```

MIT licensed. Junction is not affiliated with Mojang, Microsoft, Modrinth or CurseForge.
