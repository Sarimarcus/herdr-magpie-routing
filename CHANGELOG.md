# Changelog

## 0.6.0 (2026-11-10)

- Tab bar: a tab nobody named shows its agent's session title (e.g. `WES-378 epic`) instead of its number. A tab you renamed keeps its name. The installer patches `my-tabs` for this; re-run it.
- Quota: a per-model window reads `Fable 7d` instead of a truncated `7 days…`.
- Fix: Quota percentages are rounded (`28%`, not `28.000000000000004%`).

## 0.5.1 (2026-11-10)

- Pane header: shows the session's title instead of `Claude Code`.
- A session renamed with `/rename` is matched to its pane by that name: the panel now prefers the custom title over the AI titles Claude Code keeps writing after it.
- Fix: Quota cells no longer shrink, which made percentages wrap over neighbouring rows.

## 0.5.0 (2026-11-10)

- New pane header mod (`mod/magpie-pane`): each Herdr pane running Claude Code shows its model (orange with ⚠ on a fallback), account, context bar, running subagents and a failed last request. The installer sets it on `my-main`. It updates while the panel runs.
- Quota: click an account not signed in to switch the agent to it (`magpie accounts switch`).
- Groups: each group shows its routing; click it to cycle `order → usage → pace` (`magpie group set`). Other routings aren't clickable.
- Both actions toast their result.
- Quota: a thin line between accounts.

## 0.4.1 (2026-11-10)

- Quota: an account that reports no quota figures (agy-cli) shows its last 5 hours of requests, context and output tokens, and failures, instead of `all 0% used`.
- Token counts past a million read `1.3M` instead of `1332k`.

## 0.4.0 (2026-11-10)

- Several accounts of one agent: Quota names each by its alias, marks the one signed in (●) and shows its plan.
- Latest requests tags a request with the account that served it when its provider has several.
- A toast when a provider's requests move to another of its accounts, e.g. `claude now on pro`.
- A headless `claude -p` session leaves Sessions after 10 minutes without a request instead of 30, so an ended run's unfinished subagents no longer show as running.
- Fix: two accounts of one agent no longer share Quota row ids.

## 0.3.0 (2026-11-09)

- A line under the header shows the magpie machine's load per core, RAM in use and free disk, each with a bar, yellow and red past set thresholds (Linux only).
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
