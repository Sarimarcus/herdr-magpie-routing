# Changelog

## Unreleased

- Headless `claude -p` sessions are labelled `headless · <command or first prompt line>` instead of `folder · id`.

## 0.1.0 (2026-11-09)

First public release.

- Desktop panel for the Herdr app: Sessions with subagents, Quota, Latest requests and Groups.
- Click a session to focus its Herdr pane.
- Toasts on failed requests and group fallbacks, at most one per group and kind every 10 minutes.
- Incremental read of `usage.jsonl`: only new lines after the first read, with recovery after log rotation.
- Terminal view (`bin/view.js`) as a Herdr plugin, or standalone with `--once`.
- Windows installer that sets up the panel in a cloned layout and keeps backups.
