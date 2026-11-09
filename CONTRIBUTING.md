# Contributing

Issues and pull requests are welcome: bug reports, an installer for macOS or Linux desktop, support for agents other than Claude Code, or a clearer way to show something.

## Layout

| Path | What |
|---|---|
| `mod/magpie-routing/main.js` | The desktop panel: one Herdr mod, no dependencies |
| `mod/magpie-routing/gpui-kit.d.ts` | Types for the mod API (gpui-kit, gpui-base, herdr) |
| `bin/view.js` | The terminal view |
| `herdr-plugin.toml`, `bin/open.sh`, `bin/run.sh` | The Herdr plugin wrapper for the terminal view |
| `install-windows.ps1` | The desktop installer |

## How the panel reads data

Everything runs as small shell scripts through Herdr's `exec` on the magpie machine:

- `usage.jsonl` is read incrementally. The panel sends its byte offset and gets back only the new whole lines, or the last 1500 lines after a rotation.
- `magpie groups` and `magpie accounts --json` run every 60 seconds.
- Transcript titles and subagent metadata are read only for sessions active in the last 30 minutes.

`exec` has a fixed 30-second, 8 MiB limit, so keep every script's output bounded.

## Checking a change

```sh
node --check mod/magpie-routing/main.js
herdr-app check mod/magpie-routing
node bin/view.js --once
```

`herdr-app check` does not catch methods called with the wrong number of arguments: `flex_shrink()`, for example, needs a number and only fails at render time. Compare calls with `gpui-kit.d.ts`.

Then try it in the desktop app: re-run the installer, open the panel, and watch it through at least one refresh.

## Style

- Plain JavaScript, no build step, no dependencies.
- Read-only: the panel never writes to magpie's files or calls its gateway.
- Comments only where the code can't say it.
- Keep anything that identifies your machine (IPs, hostnames, emails, paths under your home) out of commits and screenshots.

## Pull requests

One change per PR, with a line in `CHANGELOG.md` under **Unreleased** and a screenshot for anything visible.
