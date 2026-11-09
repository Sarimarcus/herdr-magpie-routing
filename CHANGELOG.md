# Changelog

## Unreleased

- The header shows the magpie machine's load per core, RAM in use and free disk, yellow and red past set thresholds (Linux only).
- A session lists its 5 newest finished subagents; the rest fold into one `✓ +N finished` line with their requests and output tokens. A finished subagent that failed is always listed.

## 0.2.1 (2026-11-09)

- A session with no transcript reads `no transcript · <id>` instead of `? · <id>`.

## 0.2.0 (2026-11-09)

- Headless `claude -p` sessions are labelled `headless · <command or first prompt line>` instead of `folder · id`.
- Errors section: the hour's last 5 distinct errors with their message and a repeat count, handed-on ones marked as such.
- An agent with failed requests shows its latest error message under it.

## 0.1.0 (2026-11-09)

First public release.

- Desktop panel for the Herdr app: Sessions with subagents, Quota, Latest requests and Groups.
- Click a session to focus its Herdr pane.
- Toasts on failed requests and group fallbacks, at most one per group and kind every 10 minutes.
- Incremental read of `usage.jsonl`: only new lines after the first read, with recovery after log rotation.
- Terminal view (`bin/view.js`) as a Herdr plugin, or standalone with `--once`.
- Windows installer that sets up the panel in a cloned layout and keeps backups.
