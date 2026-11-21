# Junction

**A Minecraft launcher that installs mods and modpacks from both Modrinth and CurseForge.**

Search both sites at once, mix mods from both in the same instance, build your own packs, and bring over the instances you already have from other launchers. No ads, no telemetry, and no account needed to browse.

Windows · macOS · Linux

---

## Features

- **One search for two sites.** Results from Modrinth and CurseForge appear together. A project published on both shows up once, with a badge for each site, and you choose where to install it from.
- **Mods, modpacks, resource packs and shaders.** Required dependencies are installed automatically.
- **Mix sources freely.** For example, Fabric API from CurseForge alongside Sodium from Modrinth in the same instance.
- **No duplicate mods.** Junction reads the mod ID inside each jar, so the same mod installed from both sites is caught and replaced instead of crashing the game.
- **Knows what you have.** When you browse for an instance, mods that are already installed are marked, even if they came from the other site.
- **Updates you control.** Check both sites for updates, then review them first. You can pick the exact version for each mod (not just the newest), skip any of them, and undo the whole update if something breaks. You can also pin a version so it's never offered as an update.
- **Make your own packs.** Create an instance, add what you like, and export it as a Modrinth `.mrpack` or a CurseForge `.zip`.
- **Import from other launchers.** Junction finds your instances in the Modrinth App, the CurseForge app, Prism/PolyMC, GDLauncher, ATLauncher and the official Minecraft Launcher, with their exact game and loader versions. It copies them over without re-downloading anything and leaves the originals untouched.
- **Every major loader.** Vanilla, Fabric, Quilt, Forge and NeoForge, including the new 26.x Minecraft versions.
- **Java included.** The right Java version for each Minecraft release is downloaded automatically.
- **Respects mod authors.** Some CurseForge authors only allow downloads from the CurseForge website. For those files, Junction opens the download page, watches your Downloads folder, and moves each file into place once you've downloaded it.
- **Per-instance settings.** Memory, Java, JVM arguments (with Generational ZGC and tuned G1 presets), window size, join a server on launch, and a custom picture.

## Download

Get the latest version from the [Releases page](https://github.com/danielalex011/Junction-Launcher/releases).

- **Windows:** run the installer, or unzip the portable `.zip` anywhere and start `Junction.exe`. To keep all data next to the program (for example on a USB stick), put an empty file called `portable.txt` next to `Junction.exe`.
- **macOS / Linux:** use the `.dmg` / `.AppImage`, or run from source (see below).

## Getting started

1. **Sign in.** Click the account box at the bottom of the sidebar and choose *Add Microsoft account*. You'll get a short code to enter at microsoft.com/link. You sign in on Microsoft's own page, so your password never touches Junction.
2. **Get an instance:**
   - *Library → New instance* to start from scratch,
   - *Browse → Modpacks* to install a pack, or
   - *Import → Instances from other launchers* to bring your existing ones over.
3. **Add mods** from the instance page, then press **Play**.

Junction opens on **Home**: your most recently played instances with a Play button, instances that have mod updates waiting (checked in the background every few hours), and a few popular modpacks.

Offline accounts (for singleplayer and LAN) become available after you've signed in with a Microsoft account that owns Minecraft: Java Edition.

## Everyday use

| Task | Where |
|---|---|
| Add mods, resource packs or shaders | Instance → **Add mods** (Browse locked to that instance's version and loader) |
| Pick a specific version of a mod | Click the project → **Versions** tab |
| Update mods | Instance → **Check for updates** → **Update all**, review, then confirm |
| Roll back an update | Instance → **Undo last update** |
| Stop a mod from being updated | Mod list → **⋯ → Pin this version** |
| Disable or remove a mod | Checkbox / **⋯ → Remove** in the mod list |
| Export your pack | Instance → **⋯ → Export as Modrinth pack / CurseForge pack** |
| Update an installed modpack | Instance → **⋯ → Check for modpack update** (your `config` folder is backed up first) |
| Change an instance's picture | Click its icon, or drop an image on the instance page |
| Import a pack file | Drag a `.mrpack` or CurseForge `.zip` onto the window |

## Where your data is

| OS | Folder |
|---|---|
| Windows | `%APPDATA%\Junction\data` |
| macOS | `~/Library/Application Support/Junction/data` |
| Linux | `~/.config/Junction/data` |

*Settings → Open data folder* takes you there. Each instance is a normal Minecraft folder at `instances/<name>/minecraft`.

## Privacy & security

- Junction only talks to Mojang (game files and Java), Microsoft/Xbox (sign-in), Modrinth, CurseForge and the mod loader sites (fabricmc.net, quiltmc.org, minecraftforge.net, neoforged.net). There are no ads and no analytics.
- Sign-in tokens and API keys are encrypted with your operating system's keychain.
- Every download is verified against its SHA-1/SHA-512 hash before it's used.
- Modpacks can't write files outside their instance folder.
- Mod descriptions are shown in a sandbox with scripts disabled.

## FAQ

**Why do some CurseForge mods need a manual download?**
Their authors have turned off downloads in third-party launchers. Junction respects that. It opens the file's page so you can download it from CurseForge, then installs it for you automatically.

**Does importing change my other launcher's instances?**
No. Files are copied and the originals are left exactly as they were.

**Can I use my own CurseForge API key or Azure app?**
Yes, under *Settings → Advanced*. Official builds don't need either.

## Known limitations

- Forge for Minecraft versions older than 1.13 isn't supported, because its installers can't run without a window. Fabric, Quilt and vanilla work on old versions.
- Launchers installed to a non-default folder aren't found automatically. Use *Import → Browse for a folder…* for those.
- No skin manager or instance groups yet.

---

## Building it yourself

Requires [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm start          # run in development
npm test           # run the test suite
npm run dist:win   # Windows installer + portable zip (build on Windows)
npm run dist:mac   # macOS .dmg
npm run dist:linux # Linux AppImage
```

### Sign-in and CurseForge keys for your build

Official builds include a Microsoft sign-in app ID and a CurseForge API key. Neither is in this repository. If you build Junction yourself, either:

- copy `build-config.example.json` to `build-config.json` and fill it in before building (the file is git-ignored), or
- set `JUNCTION_MS_CLIENT_ID` / `JUNCTION_CF_API_KEY` as environment variables, or
- leave them empty and enter them in *Settings* after starting the app.

To get them:

- **Microsoft sign-in:** register an app at [portal.azure.com](https://portal.azure.com) → *App registrations*:
  - Supported account types: *Personal Microsoft accounts only*
  - No redirect URI
  - Then under *Authentication*, set **Allow public client flows** to *Yes*.

  New apps must be approved by Mojang before they can sign in to Minecraft, using [this form](https://aka.ms/mce-reviewappid). If you fork Junction, please use your own app ID rather than the official one.
- **CurseForge:** request a key at [console.curseforge.com](https://console.curseforge.com/).

### Project layout

```
src/core/        launcher engine (plain Node, no Electron)
  minecraft/     versions, libraries, assets, Java runtimes, launch arguments
  loaders/       Fabric, Quilt, Forge, NeoForge
  sources/       Modrinth + CurseForge clients, unified search, CurseForge fingerprints
  content/       install/update/undo, duplicate detection, modpacks, export, import
  auth/          Microsoft device-code sign-in, offline accounts
src/main/        Electron main process and preload bridge
src/renderer/    user interface (HTML/CSS/JavaScript)
test/            automated tests against a simulated Mojang/Modrinth/CurseForge/Microsoft
```

## License

MIT. See [LICENSE](LICENSE).

Junction is not affiliated with Mojang, Microsoft, Modrinth or CurseForge. Minecraft is a trademark of Mojang Synergies AB.
