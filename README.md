# herdr-magpie-routing

A live view of magpie model routing inside Herdr. It shows which coding-agent sessions are running, what each agent and subagent is doing, which model served them, and how much quota is left.

It reads magpie's own files on the machine where magpie runs. It needs no gateway key and changes nothing.

There are two parts:

- **Desktop panel** (`mod/magpie-routing`): a Herdr desktop-app mod. A **Magpie** button sits next to Files and Changes in the right-hand panel.
- **Terminal view** (`bin/view.js`): a Herdr plugin that opens the same data in a terminal tab.

## What the panel shows

| Section | Contents |
|---|---|
| **Sessions** (last 30 min) | One row per Claude Code session, with its title, how full its context window is and when it last made a request. Under each session, one line per agent: the main agent, then running subagents, then finished ones, each with its model, request count and output tokens. ✕ means the agent's last request failed. ◌ means a running subagent has been silent for 5 minutes. Click a session to focus its Herdr pane. |
| **Quota** | One usage bar per account window (5 hours, 7 days, per model). Each bar shows the reset time and the pace: "on pace", or when the window runs out at the current rate. |
| **Latest requests** | The last 10 requests: the group or model asked for, the model that served it, context → output tokens, and duration. |
| **Groups** (last hour) | Each group's fallback chain with the model that served last highlighted (⚠ when it was not the first member), plus request count, cache-hit share and median time to first token. |

The header shows how many sessions were active in the last 5 minutes and the request rate, averaged over 5 minutes.

The panel also raises a toast when a request fails or a group falls back to its next member, at most once per group and kind every 10 minutes. A request that is cancelled (499) or handed on to the group's next member does not count as a failure.

## Data sources

All of these are read on the magpie machine:

- `~/.config/magpie/usage.jsonl`: one line per request. After the first read, the panel fetches only the lines added since its last read.
- `magpie groups` and `magpie accounts --json`, every 60 s.
- Claude Code transcripts in `~/.claude/projects/*/<session>.jsonl`, for each session's title and working directory, and `<session>/subagents/agent-*.meta.json`, for each subagent's type, description and whether it has finished. Only sessions active in the last 30 minutes are read.

## Install

### Desktop panel (Windows, magpie on a remote machine)

Herdr must already know the remote machine (Settings › Machines). Copy the installer from the remote machine and run it:

```powershell
scp you@your-vps:dev/tools/herdr-magpie-routing/install-windows.ps1 .
powershell -ExecutionPolicy Bypass -File install-windows.ps1 -Vps you@your-vps [-Machine vps]
```

The installer:

1. copies the mod into the app's `mods` folder and sets `MACHINE` in `main.js` to `-Machine`;
2. clones the read-only `main` layout and `tabs` mod to `my-main` and `my-tabs`, if they don't exist yet;
3. adds the panel block to `my-main.json` and the **Magpie** button to `my-tabs`, keeping `.bak` copies of both;
4. checks both mods with `herdr-app check` and switches to the `my-main` layout.

To pick up a new version, run it again. If the copy fails because the app has the mod open, quit herdr-app and run it again. If the window breaks, Ctrl+Alt+Shift+Escape returns to the default layout.

### Terminal view (Linux, macOS)

```sh
herdr plugin link ~/dev/tools/herdr-magpie-routing
```

Then run the **Open magpie routing tab** action. To see it outside Herdr, run `node bin/view.js`, or `node bin/view.js --once` to print it once. It needs Node 18 or later. `bin/run.sh` also finds Node installed by nvm.

## Configuration

| Setting | Where | Default |
|---|---|---|
| Machine magpie runs on | `MACHINE` in `mod/magpie-routing/main.js` (the installer sets it) | `"vps"`. `undefined` follows the space being shown. |
| magpie binary | `~/.local/bin/magpie`, else `magpie` on `PATH`. The terminal view also reads `MAGPIE_BIN`. | |
| magpie config folder (terminal view) | `MAGPIE_CONFIG_DIR` | `~/.config/magpie` |

The thresholds are constants at the top of `main.js`: `FEED`, `ACTIVE_MS`, `QUIET_MS`, `SESSION_WINDOW_MS` and `ALERT_EVERY_MS`.

## Development

`mod/magpie-routing/gpui-kit.d.ts` holds the mod API types. Check a change with:

```sh
node --check mod/magpie-routing/main.js
herdr-app check mod/magpie-routing
```

`herdr-app check` does not catch methods called with the wrong number of arguments: `flex_shrink()`, for example, needs a number and only fails at render time.

## Limits

- The context bar guesses each session's window: 1M if a subagent ran on a `[1m]` model or the context has passed 200k, else 200k. Non-Claude models show a token count without a bar.
- Sessions are matched to Herdr panes by terminal title. A session whose title is shared with another pane is not clickable.
- Group chains are parsed from the text output of `magpie groups`, which has no JSON option.
