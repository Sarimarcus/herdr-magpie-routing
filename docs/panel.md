# Reading the panel

![The Magpie panel](images/panel.png)

*Mock render from real usage data, with session titles and subagent descriptions replaced and error messages shortened.*

## Header

```
Magpie [vps]                       2 active · 12 req/min
load 1.2/8 · ram 63% · disk 41G free
```

The machine being read, the number of sessions that made a request in the last 5 minutes, and the request rate averaged over those 5 minutes.

The second line is the machine's health, read every 60 seconds on a Linux magpie machine (the line is hidden elsewhere). Each figure has a bar: load per core (full at 1 per core), RAM used and disk used. Bars are green, then yellow and red past these thresholds:

- **load:** the 1-minute load average over the core count. Yellow from 1 per core, red from 1.5.
- **ram:** memory in use, from `MemAvailable`. Yellow from 80%, red from 90%.
- **disk:** free space on `/`. Yellow below 15% free, red below 5%.

## Sessions (last 30 min)

One block per Claude Code session that made a request in the last 30 minutes, newest first. A headless `claude -p` run leaves after 10 minutes without a request, with its subagents: nobody answers its prompts, so a silence that long means it has ended.

| Element | Meaning |
|---|---|
| ● green / yellow / grey | Last request under a minute ago, under 5 minutes ago, older |
| ● red | One of the session's agents failed its last request |
| Title | The session's Claude Code title (custom title, else the AI-generated one). A headless `claude -p` run, such as a cron job, has none and reads `headless · <slash command or first prompt line>` |
| ↗ | The session is open in a Herdr pane: click to focus it |
| `126k/1M` bar | Context used in the latest request against the guessed window (see Limits in the README) |
| `20s ago` | Time since the session's last request |

Under each session, one line per agent:

| Prefix | Meaning |
|---|---|
| `▸ main` | The main agent |
| `● <type> · <description>` | A running subagent |
| `✓ <type> · <description>` | A finished subagent |
| ✕ | The agent's last request failed |
| ◌ | A running subagent has been silent for 5 minutes |

Each line ends with the model that served its latest request (orange with ⚠ when that was a fallback), its failed-request count if any, its request count and its output tokens.

Only the 5 newest finished subagents get a line. Older ones fold into `✓ +N finished`, with their total requests and output tokens. A finished subagent that failed always keeps its own line.

## Quota

One bar per account window that `magpie accounts --json` reports: 5-hour, 7-day and per-model windows.

- **Bar colour:** green below 70%, yellow from 70%, red from 90%.
- **Pace:** at the window's average rate so far, `on pace` (green) when it lasts until the reset, otherwise `out in <time>` (red).
- **↻** time until the window resets.

Accounts with many per-model windows that are all unused collapse into one line.

An agent signed in to several accounts (`magpie accounts add claude`) gets one block per account, named by its alias (`magpie accounts alias`) or the part of its email before `@`. **●** marks the account signed in, **○** the others; the agent and plan sit under the name.

## Latest requests

The last 10 requests: time, the group or model asked for, the model that served it, context → output tokens, and duration.

| Tag | Meaning |
|---|---|
| `· pro` | The account that served it, when its provider has several |
| `· compact` / `· web_search` | The request kind, when it isn't an ordinary turn |
| status code | Shown after the model when it isn't 200 |
| red model | Failed. Cancelled (499) or handed-on requests are not failures |

## Errors (last hour)

The last 5 distinct errors with their message: time, group asked, model and status. Repeats of the same error show once, at their latest time, with a count (`×4`).

- **Red:** a real failure; the agent got the error.
- **Orange, `handed on`:** magpie passed the request to the group's next member, so the agent never saw it. This is what shows up as a fallback (⚠) elsewhere. A safety-filter refusal on one model, for example, often lands here.

Cancelled requests (499) aren't listed.

An agent whose requests failed also gets its latest error, in red, on a line under it in Sessions.

## Groups (last hour)

Each magpie group with its fallback chain, `first › second › third`. The member that served the group's latest request is highlighted, with ⚠ when it isn't the first.

On the right: failed requests (`N err`) if any, requests in the last hour, **cache** (the share of context read from the prompt cache) and the median **ttft** (time to first token). `idle` means no requests in the hour.

## Toasts

A toast appears when a request fails, a group falls back to its next member, or a provider's requests move to another of its accounts (`claude now on pro`). Each group and kind, and each provider's account change, toasts at most once every 10 minutes. Toasts start only after the first read, so opening the panel never replays old failures.
