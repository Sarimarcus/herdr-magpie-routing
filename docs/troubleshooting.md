# Troubleshooting

## "no magpie usage log on …"

The panel reads `~/.config/magpie/usage.jsonl` on the machine named by `MACHINE`. Check that:

- magpie is running on that machine and has served at least one request;
- `MACHINE` in `main.js` matches Herdr's name for the machine (Settings › Machines), not its hostname. Re-run the installer with the right `-Machine`.

## Quota and Groups are empty

They come from `magpie accounts --json` and `magpie groups`, run every 60 seconds. The panel looks for `~/.local/bin/magpie`, then `magpie` on `PATH`. A non-interactive SSH shell often has a shorter `PATH`: link magpie into `~/.local/bin`.

## A session shows `folder · id` instead of its title

Titles come from the Claude Code transcript in `~/.claude/projects/*/<session>.jsonl` on the magpie machine. A session that runs on another machine, or hasn't been given a title yet, shows its working folder and short id. With no transcript at all, for example a `claude` process that exited before writing one, it shows `no transcript · <id>`.

## A session isn't clickable

Sessions are matched to Herdr panes by terminal title. If no pane has that title, or two panes share it, there is nothing safe to focus. Renaming one of the sessions fixes the second case.

## The context bar says 200k but the session uses 1M

The window is guessed: 1M once a subagent ran on a `[1m]` model or the context passed 200k. Before either happens, a 1M session reads as 200k.

## The installer stops while copying the mod

The desktop app has the mod open. Quit herdr-app and run the installer again.

## The window is broken after an install

Press **Ctrl+Alt+Shift+Escape** to return to the default layout, then check `my-main.json` against its `.bak` copy.

## Too many toasts

Each group and kind toasts at most once per `ALERT_EVERY_MS` (10 minutes). Raise it at the top of `main.js` and re-run the installer.

## The terminal view doesn't start

It needs Node 18+. Run `sh bin/run.sh` directly to see the error; it also looks for Node installed with nvm.

## Still stuck

Open an issue with the output of `node bin/view.js --once` from the magpie machine, with anything private removed.
