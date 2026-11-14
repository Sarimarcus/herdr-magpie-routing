# Install

There are two parts. Install either or both.

| Part | Where it runs | What you get |
|---|---|---|
| Desktop panel (`mod/magpie-routing`) | Herdr desktop app | A **Magpie** button in the right-hand panel, next to Files and Changes |
| Terminal view (`bin/view.js`) | Herdr terminal (plugin) or any shell | The same data in a terminal tab |

Both read magpie's files on the machine where magpie runs. The desktop panel reaches it through Herdr's machine connection, so magpie can live on a remote server.

## Requirements

- [Herdr](https://herdr.dev/) 0.9.0 or later
- [magpie](https://usemagpie.ai/) routing your coding agents, with its usage log at `~/.config/magpie/usage.jsonl`
- On the magpie machine: `sh`, `tail`, `grep`, and Node 18+ for the terminal view
- Claude Code, for session titles and subagents (other agents still show up in requests and groups)

## Desktop panel (Windows)

1. In Herdr, add the machine magpie runs on (Settings › Machines) and note its name, for example `vps`.
2. Clone this repo on that machine:
   ```sh
   git clone https://github.com/Sarimarcus/herdr-magpie-routing ~/dev/tools/herdr-magpie-routing
   ```
3. On Windows, copy the installer and run it:
   ```powershell
   scp you@your-vps:dev/tools/herdr-magpie-routing/install-windows.ps1 .
   powershell -ExecutionPolicy Bypass -File install-windows.ps1 -Vps you@your-vps -Machine vps
   ```

| Parameter | Meaning |
|---|---|
| `-Vps` | SSH target the installer copies the mod from |
| `-Machine` | Herdr's name for the magpie machine (default `vps`) |
| `-AppHome` | The desktop app's config folder, if it isn't found automatically |

The installer:

1. copies both mods (`magpie-routing`, `magpie-pane`) into the app's `mods` folder and sets `MACHINE` in the panel's `main.js` to `-Machine`;
2. clones the read-only `main` layout and `tabs` mod to `my-main` and `my-tabs`, if they don't exist yet;
3. adds the panel block to `my-main.json`, sets its pane header to `magpie-pane`, adds the **Magpie** button to `my-tabs`, and makes `my-tabs` label a tab nobody named with its session title, keeping `.bak` copies of both;
4. checks the mods with `herdr-app check` and switches to the `my-main` layout.

**Update:** `git pull` on the magpie machine, then run the installer again.

**Uninstall:** switch back to the `main` layout, then delete `mods/magpie-routing` and `mods/magpie-pane` from the app's config folder. Restore `my-main.json` and `my-tabs` from their `.bak` copies if you want to keep those layouts.

### Other desktop platforms

The installer is Windows-only, but the mod is plain JavaScript. On macOS or Linux, copy `mod/magpie-routing` into the desktop app's `mods` folder, set `MACHINE` in `main.js`, and add a panel block for it to a layout you own, the way step 3 above does. Pull requests for a shell installer are welcome.

## Terminal view (Linux, macOS)

```sh
herdr plugin link ~/dev/tools/herdr-magpie-routing
```

Then run the **Open magpie routing tab** action from Herdr's command palette.

Outside Herdr:

```sh
node bin/view.js          # live, refreshes in place
node bin/view.js --once   # print once and exit
```

`bin/run.sh` also finds a Node installed with nvm.

## Configuration

| Setting | Where | Default |
|---|---|---|
| Machine magpie runs on | `MACHINE` in `mod/magpie-routing/main.js` (the installer sets it) | `"vps"`. `undefined` follows the space being shown. |
| magpie binary | `~/.local/bin/magpie`, else `magpie` on `PATH`. The terminal view also reads `MAGPIE_BIN`. | |
| magpie config folder (terminal view) | `MAGPIE_CONFIG_DIR` | `~/.config/magpie` |

Thresholds are constants at the top of `main.js`:

| Constant | Default | Controls |
|---|---|---|
| `FEED` | 10 | Rows in Latest requests |
| `KEEP` | 1500 | Log lines held in memory |
| `ACTIVE_MS` | 5 min | "Active" sessions and req/min in the header |
| `QUIET_MS` | 5 min | When a running subagent is flagged as silent (◌) |
| `FINISHED` | 3 | Finished subagents listed per session before the rest fold into one line |
| `SYS_WARN` | load 1 / 1.5 per core, RAM 80% / 90%, disk 15% / 5% free | Yellow and red thresholds of the health line |
| `SESSION_WINDOW_MS` | 30 min | How far back Sessions looks |
| `HEADLESS_IDLE_MS` | 10 min | When a silent headless (`claude -p`) session leaves Sessions |
| `ALERT_EVERY_MS` | 10 min | Minimum gap between toasts for the same group and kind |
