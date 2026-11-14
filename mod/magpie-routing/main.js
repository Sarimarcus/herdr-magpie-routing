import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, focused, exec, theme, settings, machines, agents as herdrAgents, run, notify, setShared } from "herdr";

// The Herdr machine magpie runs on. undefined follows the shown space, as Changes does.
const MACHINE = "vps";
const FEED = 10;
const ERRORS = 5;                        // rows in the Errors section
const SYS_WARN = { load: [1, 1.5], ram: [0.8, 0.9], disk: [0.15, 0.05] };  // header: yellow, red
const FINISHED = 3;                     // finished subagents listed per session before the rest fold
const KEEP = 1500;                       // log lines kept in memory
const ACTIVE_MS = 5 * 60 * 1000;         // "active" and req/min in the header
const QUIET_MS = 5 * 60 * 1000;          // a running subagent silent this long is flagged
const SESSION_WINDOW_MS = 30 * 60 * 1000;
const ROUTINGS = ["order", "usage", "pace"];  // what a click on a group's routing cycles through
const PUBLISH_EVERY_MS = 10 * 1000;           // pane-header data rewritten at least this often
const HEADLESS_IDLE_MS =10 * 60 * 1000;  // a headless run (claude -p) this long without a request has ended
const ALERT_EVERY_MS = 10 * 60 * 1000;   // at most one toast per group and kind in this window
const SCRATCH = /\/([0-9a-f-]{36})\/scratchpad$/;

const SH_MAGPIE = `M="$HOME/.local/bin/magpie"; [ -x "$M" ] || M=magpie`;
const SH_TX = `tx() { ls "$HOME"/.claude/projects/*/"$1".jsonl 2>/dev/null | head -n 1; }`;
// $1: bytes of usage.jsonl already read (0 starts over), then the active session ids.
// Sends whole lines only: while the last line is still being written it sends "wait".
const READ = `${SH_TX}
F="$HOME/.config/magpie/usage.jsonl"; off=$1; shift
[ -f "$F" ] || { echo "@@nolog"; exit 0; }
S=$(wc -c < "$F" | tr -d ' ')
if [ "$S" -gt 0 ] && [ "$(tail -c +"$S" "$F" | head -c 1 | od -An -c | tr -d ' ')" != '\\n' ]; then echo "@@usage wait"
else
  # "more" only when the offset still ends a line: else the log rotated and grew past it.
  if [ "$off" -gt 0 ] && [ "$S" -ge "$off" ] && [ "$(tail -c +"$off" "$F" | head -c 1 | od -An -c | tr -d ' ')" = '\\n' ]; then start=$off; echo "@@usage $S more"
  else start=$(( S > 3000000 ? S - 3000000 : 0 )); echo "@@usage $S all"; fi
  tail -c +$((start + 1)) "$F" | head -c $((S - start)) | tail -n ${KEEP}
fi
echo "@@sessions"
for s in "$@"; do
  f=$(tx "$s"); [ -n "$f" ] || continue
  echo "$s $(grep -m 1 -o '"cwd":"[^"]*"' "$f" | cut -d'"' -f4)"
  ls -t "\${f%.jsonl}"/subagents/*.meta.json 2>/dev/null | head -n 80 | xargs -r awk -v s="$s" '
    FNR == 1 { if (NR > 1) print ""; n = FILENAME; sub(/.*\\/agent-/, "", n); sub(/\\.meta\\.json$/, "", n); printf "@agent %s %s ", s, n }
    { printf "%s", $0 } END { if (NR) print "" }'
done`;
// Session titles: the latest custom title in each transcript (what /rename set, and the terminal shows),
// else the latest AI title, as its JSON field. Claude Code keeps writing AI titles after a rename. Ids come in as "$@".
// A headless run (claude -p) has none: its first prompt comes back as "headless" instead.
const TITLES = `${SH_TX}
for s in "$@"; do
  f=$(tx "$s")
  [ -n "$f" ] || continue
  t=$(tac "$f" | grep -m 1 -o '"customTitle":"\\([^"\\\\]\\|\\\\.\\)*"')
  [ -n "$t" ] || t=$(tac "$f" | grep -m 1 -o '"aiTitle":"\\([^"\\\\]\\|\\\\.\\)*"')
  if [ -z "$t" ] && head -n 50 "$f" | grep -q '"entrypoint":"sdk-cli"'; then
    t=$(grep -m 1 -o '"role":"user","content":"\\([^"\\\\]\\|\\\\.\\)*"' "$f" | sed 's/^"role":"user","content"/"headless"/')
    t=\${t:-'"headless":""'}
  fi
  printf '%s\\t%s\\n' "$s" "$t"
done`;
// A slash command reads as "/cmd args", any other prompt as its first line.
function headlessLabel(prompt) {
  const cmd = prompt.match(/<command-name>([^<]*)<\/command-name>/);
  const args = prompt.match(/<command-args>([^<]*)<\/command-args>/);
  return `headless · ${cmd ? `${cmd[1]} ${args?.[1] ?? ""}`.trim() : prompt.trim().split("\n")[0] || "claude -p"}`;
}
const ACCOUNTS = `${SH_MAGPIE}
echo "@@sys $(cut -d' ' -f1 /proc/loadavg 2>/dev/null) $(nproc 2>/dev/null) $(awk '/^MemTotal/{t=$2}/^MemAvailable/{a=$2}END{print t, a}' /proc/meminfo 2>/dev/null) $(df -Pk / 2>/dev/null | awk 'NR==2{print $2, $4}')"
echo "@@groups"; "$M" groups 2>/dev/null
echo "@@accounts"; "$M" accounts --json 2>/dev/null`;

const machineNames = () => machines().map((m) => m.name).filter(Boolean);
const knownMachines = () => machineNames().join(", ") || "none";

// The name shown in Settings can differ from the one exec takes: match loosely,
// else use the only remote machine.
function pinned() {
  const names = machineNames();
  if (names.includes(MACHINE)) return MACHINE;
  const want = String(MACHINE).toLowerCase();
  return names.find((n) => n.toLowerCase().includes(want)) ?? (names.length === 1 ? names[0] : MACHINE);
}

function machine() {
  if (MACHINE !== undefined) return pinned();
  const f = focused(), space = spaces().find((s) => s.active);
  if (f?.pane === null) return f.terminal?.includes("/") ? f.terminal.split("/")[0] : null;
  return space?.machine ?? null;
}

// exec has a fixed 30 s / 8 MiB limit.
const sh = (script, on, args = []) => exec("sh", ["-c", script, "sh", ...args], { on });

const modelOf = (m) => (m || "").split("/").pop().replace(/\[.*\]$/, "");
const servedOf = (r) => modelOf(r.served || r.model);
const groupName = (ref) => ref.replace(/^group\//, "").replace(/^csf-/, "");
const askedOf = (r) => groupName(r.req || r.model || "?");
const shortModel = (m) => (m || "").replace(/^claude-/, "");
const hhmm = (t) => new Date(t).toTimeString().slice(0, 8);
const ago = (ms) => { const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 10 ? "now" : s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`; };
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const ctxOf = (r) => (r.in || 0) + (r.cache_read || 0) + (r.cache_write || 0);
const kTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n || 0));
const median = (xs) => { const v = xs.filter((x) => x > 0).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : 0; };
function dur(ms) {
  const m = Math.max(0, Math.round(ms / 6e4));
  if (m >= 1440) return `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h`;
  if (m >= 60) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
  return `${m}m`;
}

// Lines are written when a request finishes; `t` is when it started. parse() sets _end.
const sinceEnd = (r) => Date.now() - r._end;
const later = (a, b) => (!a || b._end >= a._end ? b : a);
const canceled = (r) => r.status === 499 || r.err_type === "agent_canceled";
// A non-200 the group handed on to its next member ends as a fallback, not a failure.
const failed = (r) => Boolean(r.status && r.status !== 200 && !r.handed_on && !canceled(r));
const statusTag = (r) => (r.status && r.status !== 200 ? `  ${r.status}` : "");
// Served after more than one try, or by a member other than the group's first.
function fellBack(groups, r) {
  if (!r.req?.startsWith("group/")) return false;
  if (r.tries > 1) return true;
  const first = modelOf((groups.get(r.req)?.members || [])[0]);
  return Boolean(first && servedOf(r) !== first);
}

// Quota windows are named "5 hours" / "7 days": their length, to project when they run out.
function windowMs(name) {
  const m = String(name).match(/^(\d+)\s*(hour|day)/);
  return m ? Number(m[1]) * (m[2] === "hour" ? 3.6e6 : 864e5) : 0;
}

// At the window's average rate so far: "on pace" when it lasts until the reset, else when it runs out.
function pace(w) {
  const len = windowMs(w.name), left = new Date(w.resetsAt) - Date.now();
  if (!len || !(left > 0) || !(w.used > 0)) return null;
  if (w.used >= 100) return { ok: false, text: "used up" };
  const elapsed = len - left;
  if (elapsed < len * 0.05) return null;
  const toFull = ((100 - w.used) * elapsed) / w.used;
  return toFull >= left ? { ok: true, text: "on pace" } : { ok: false, text: `out in ${dur(toFull)}` };
}

function resetIn(iso) {
  const ms = new Date(iso) - Date.now();
  return ms > 0 ? dur(ms) : "";
}

// An account's alias, else its email's part before @: the full address would end up in screenshots.
const acctName = (a) => a.alias || String(a.user || "?").split("@")[0];

const level = (t, pct, warn, base) => (pct >= 90 ? t.ansi1 : pct >= warn ? t.ansi3 : base);
const bar = (t, pct, col, h) => div().h(h).rounded(h / 2).bg(t.raised).overflow_hidden()
  .child(div().h_full().rounded(h / 2).bg(col).w(`${pct}%`));
const row = (id) => h_flex().id(id).px(14).h(22).gap(8).items_center();
const note = (col, text) => div().px(14).h(22).text_color(col).truncate().child(text);
// An error message without the model name it repeats, cut to a few lines.
function errText(r) {
  const m = String(r.err || "no message").replace(/\s+/g, " ").replace(`${servedOf(r)} `, "");
  return m.length > 200 ? `${m.slice(0, 199)}…` : m;
}
// The latest failure's status, model and message, on its own line.
const errLine = (t, r, pl) => div().pl(pl).h(16).text_size(10).text_color(t.ansi1).truncate()
  .child(`${hhmm(r.t)} ${r.status} ${shortModel(servedOf(r))}: ${errText(r)}`);

function parseRead(stdout) {
  const out = { nolog: false, mode: null, size: 0, rows: [], cwds: new Map(), agents: new Map() };
  let section = "";
  for (const line of stdout.split("\n")) {
    if (line.startsWith("@@")) {
      const [name, size, mode] = line.slice(2).split(" ");
      section = name;
      if (name === "nolog") out.nolog = true;
      if (name === "usage") { out.mode = size === "wait" ? "wait" : mode; out.size = Number(size) || 0; }
    } else if (!line) {
      continue;
    } else if (section === "usage") {
      try {
        const r = JSON.parse(line);
        r._t = Date.parse(r.t);
        r._end = r._t + (r.ms || 0);
        if (Number.isFinite(r._t) && r.kind !== "provider_test") out.rows.push(r);
      } catch {}
    } else if (section === "sessions" && line.startsWith("@agent ")) {
      const [, sid, id, ...json] = line.split(" ");
      try { out.agents.set(`${sid}/${id}`, JSON.parse(json.join(" "))); } catch {}
    } else if (section === "sessions") {
      const i = line.indexOf(" ");
      if (i > 0) out.cwds.set(line.slice(0, i), line.slice(i + 1));
    }
  }
  return out;
}

// Load average, cores, memory and root disk of the magpie machine, from Linux's /proc and df. null elsewhere.
function parseSys(text) {
  const [load, cores, memTotal, memAvail, diskTotal, diskFree] = (text.match(/^@@sys (.*)$/m)?.[1] || "").split(" ").map(Number);
  if (!(cores > 0 && memTotal > 0 && diskTotal > 0)) return null;
  return { load, cores, ram: 1 - memAvail / memTotal, diskFree, diskShare: diskFree / diskTotal };
}

function parseGroups(text) {
  const groups = new Map();
  for (const line of text.split("\n")) {
    const m = line.match(/^\s+\S+\s+(group\/\S+)\s+(\S+)\s+(.+)$/);
    if (m) groups.set(m[1], { routing: m[2], members: m[3].replace(/\s+←.*$/, "").split("→").map((s) => s.trim()) });
  }
  return groups;
}

// Per session and agent, over the last 30 minutes; most recent session first.
function sessionsOf(reqs) {
  const since = Date.now() - SESSION_WINDOW_MS, bySession = new Map();
  for (const r of reqs) {
    if (!r.session || r._end < since) continue;
    const s = bySession.get(r.session) || { last: null, agents: new Map() };
    const key = r.subagent || "";
    const g = s.agents.get(key) || { n: 0, out: 0, fails: 0, last: null, lastCtx: null, maxCtx: 0 };
    g.n++; g.out += r.out || 0; g.maxCtx = Math.max(g.maxCtx, ctxOf(r));
    g.last = later(g.last, r);
    if (ctxOf(r) > 0) g.lastCtx = later(g.lastCtx, r);
    if (failed(r)) { g.fails++; g.lastFail = later(g.lastFail, r); }
    s.agents.set(key, g);
    s.last = later(s.last, r);
    bySession.set(r.session, s);
  }
  return [...bySession].sort((a, b) => b[1].last._end - a[1].last._end);
}

// Per group: requests in the last hour and the latest one. Side calls (compact, web search) stay out of cache and ttft.
function groupStatsOf(reqs) {
  const since = Date.now() - 3.6e6, byGroup = new Map();
  for (const r of reqs) {
    if (!r.req?.startsWith("group/")) continue;
    const g = byGroup.get(r.req) || { n: 0, fails: 0, last: null, ctx: 0, cached: 0, ttft: [] };
    if (r._end >= since) {
      g.n++;
      if (failed(r)) g.fails++;
      if (!r.kind) { g.ctx += ctxOf(r); g.cached += r.cache_read || 0; g.ttft.push(r.ttft_ms || 0); }
    }
    g.last = later(g.last, r);
    byGroup.set(r.req, g);
  }
  for (const g of byGroup.values()) g.ttft = median(g.ttft);
  return byGroup;
}

export default class MagpieRouting extends View {
  init(_props, cx) {
    this.titles = new Map();
    this.alerted = new Map();
    this.accountsSeq = 0;
    this.error = null;
    this.loading = true;
    this.on = machine();
    this.reset();
    cx.timer.every(3000, (cx) => this.refresh(cx));
    cx.timer.every(60000, (cx) => this.refreshAccounts(cx));
    cx.timer.every(30000, (cx) => this.refreshTitles(cx));
    this.refresh(cx);
    this.refreshAccounts(cx);
  }

  // Everything read from one machine.
  reset() {
    this.reqs = [];
    this.offset = 0;
    this.cwds = new Map();
    this.agents = new Map();
    this.oneM = new Set();
    this.looked = new Set();
    this.sessions = [];
    this.groupStats = new Map();
    this.perMin = 0;
    this.held = [];
    this.groups = new Map();
    this.accounts = [];
    this.accountsError = null;
    this.sys = null;
    this.lastAcct = new Map();
  }

  // The name of the account that served r, when its provider has more than one; else null.
  acctOf(r) {
    if (!r.providerAccount) return null;
    const same = this.accounts.filter((a) => a.agent === r.provider);
    const a = same.length > 1 && same.find((x) => x.user === r.providerAccount);
    return a ? acctName(a) : null;
  }

  toast(key, n) {
    if (Date.now() - (this.alerted.get(key) || 0) < ALERT_EVERY_MS) return;
    this.alerted.set(key, Date.now());
    try { notify(n); } catch {}
  }

  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    const on = machine();
    if (on !== this.on) { this.on = on; this.reset(); this.loading = true; this.error = null; this.refreshAccounts(cx); }
    const asked = this.sessions.map(([sid]) => sid);
    cx.spawn(async (cx) => {
      const where = on ?? "this computer";
      let again = false;
      try {
        const r = await sh(READ, on, [String(this.offset), ...asked]);
        if (on === this.on) {
          const read = parseRead(r.stdout);
          this.error = read.nolog ? `no magpie usage log on ${where}` : null;
          again = this.take(read, asked);
          this.publish();
          if (this.titleIds().some((sid) => !this.titles.has(sid))) this.refreshTitles(cx);
        }
      } catch (e) {
        const msg = String(e?.message ?? e);
        if (on === this.on) this.error = /unknown machine/.test(msg)
          ? `Herdr has no machine "${where}". Known machines: ${knownMachines()}. Set MACHINE in main.js to one of them.`
          : `can't run sh on ${where}: ${msg}`;
      }
      this.loading = false;
      this.busy = false;
      cx.notify();
      if (again) this.refresh(cx);
    });
  }

  // Adds a read to the state and derives what render shows. True when a newly active session still
  // needs its transcript details, so the caller reads again at once.
  take(read, asked) {
    if (read.mode === "more" || read.mode === "all") {
      this.reqs = (this.offset > 0 ? this.reqs.concat(read.rows) : read.rows).slice(-KEEP);
      // Only the first read sets the baseline; a later full read is a rotated log, whose rows are new.
      if (this.offset > 0) this.alert(read.rows);
      else for (const r of read.rows) if (r.providerAccount && r.status === 200) this.lastAcct.set(r.provider, r.providerAccount);
      this.offset = read.size;
    }
    for (const [sid, cwd] of read.cwds) this.cwds.set(sid, cwd);
    for (const sid of asked) this.looked.add(sid);
    this.agents = read.agents;
    this.oneM = new Set([...read.agents].filter(([, m]) => /\[1m\]$/.test(m.pickedEffortModel || "")).map(([k]) => k.split("/")[0]));
    this.sessions = sessionsOf(this.reqs);
    this.groupStats = groupStatsOf(this.reqs);
    this.perMin = this.reqs.filter((r) => sinceEnd(r) < ACTIVE_MS).length / 5;
    return this.sessions.some(([sid]) => !this.looked.has(sid));
  }

  // Toasts for new requests that failed, fell back, or moved to another account of their provider.
  // Held until the groups and accounts are known: a fallback is judged against the group's first member.
  alert(rows) {
    if (!this.groups.size) { this.held = this.held.concat(rows).slice(-KEEP); return; }
    for (const r of rows) {
      if (r.providerAccount && r.status === 200) {
        const prev = this.lastAcct.get(r.provider);
        this.lastAcct.set(r.provider, r.providerAccount);
        const now = this.acctOf(r), was = this.acctOf({ ...r, providerAccount: prev });
        if (prev && prev !== r.providerAccount && now && was) {
          this.toast(`${r.provider}|account`, { title: `magpie: ${r.provider} now on ${now}`, body: `was on ${was}`, level: "warning", timeout: 8000 });
        }
      }
      const kind = failed(r) ? "error" : fellBack(this.groups, r) ? "fallback" : null;
      if (!kind) continue;
      this.toast(`${r.req}|${kind}`, kind === "error"
        ? { title: `magpie: ${askedOf(r)} request failed (${r.status})`, body: `${servedOf(r)} via ${r.provider || "?"}`, level: "error", timeout: 10000 }
        : { title: `magpie: ${askedOf(r)} fell back`, body: `served by ${servedOf(r)}`, level: "warning", timeout: 8000 });
    }
  }

  refreshAccounts(cx) {
    const on = machine(), seq = ++this.accountsSeq;
    cx.spawn(async (cx) => {
      let accounts = [], groups = null, error = null, sys = null;
      try {
        const out = (await sh(ACCOUNTS, on)).stdout;
        const i = out.indexOf("@@accounts\n");
        groups = parseGroups(i < 0 ? out : out.slice(0, i));
        sys = parseSys(out);
        const json = i < 0 ? "" : out.slice(i + 11).trim();
        if (!json) error = "magpie accounts failed";
        else accounts = JSON.parse(json);
      } catch (e) { error = `magpie accounts failed: ${e?.message ?? e}`; }
      if (seq !== this.accountsSeq) return;
      this.accounts = accounts;
      this.accountsError = error;
      if (groups) this.groups = groups;
      this.sys = sys;
      if (this.groups.size && this.held.length) this.alert(this.held.splice(0));
      cx.notify();
    });
  }

  // Active sessions plus the sessions their scratchpad subagents belong to.
  titleIds() {
    const active = this.sessions.map(([sid]) => sid);
    const parents = active.map((sid) => this.cwds.get(sid)?.match(SCRATCH)?.[1]).filter(Boolean);
    return [...new Set([...active, ...parents])].filter((sid) => /^[0-9a-f-]{36}$/.test(sid));
  }

  refreshTitles(cx) {
    const ids = this.titleIds();
    if (this.titling || !ids.length) return;
    this.titling = true;
    // Marked as tried, so a session without a title does not re-trigger a read every refresh.
    for (const sid of ids) if (!this.titles.has(sid)) this.titles.set(sid, "");
    const on = this.on;
    cx.spawn(async (cx) => {
      try {
        const r = await sh(TITLES, on, ids);
        for (const line of r.stdout.split("\n")) {
          const [sid, field] = line.split("\t");
          if (!sid) continue;
          let title = "";
          try {
            const [k, v] = Object.entries(JSON.parse(`{${field}}`))[0] ?? [];
            title = k === "headless" ? headlessLabel(String(v)) : String(v ?? "");
          } catch {}
          this.titles.set(sid, title);
        }
      } catch {}
      this.titling = false;
      this.publish();
      cx.notify();
    });
  }

  // Each session's live state, keyed by the Herdr pane it runs in, for the magpie-pane header.
  // Written when it changes, else every PUBLISH_EVERY_MS so headers can tell the panel still runs:
  // every mod re-renders on a shared write.
  publish() {
    const byTitle = this.agentsByTitle(), out = {};
    for (const [sid, s] of this.sessions) {
      const agent = this.agentFor(sid, byTitle);
      const g = s.agents.get("") || s.agents.get(s.last.subagent || "");
      if (!agent || !g?.last) continue;
      const r = g.lastCtx, oneM = g.maxCtx > 200_000 || this.oneM.has(sid);
      const info = {
        title: this.titles.get(sid) || null,
        model: shortModel(servedOf(g.last)),
        fb: fellBack(this.groups, g.last),
        acct: this.acctOf(g.last),
        ctx: r ? ctxOf(r) : 0,
        win: r && /^claude-/.test(servedOf(r)) ? (oneM ? 1_000_000 : 200_000) : 0,
        err: failed(g.last) ? String(g.last.status) : null,
        subs: [...s.agents.keys()].filter((id) => id && this.agents.has(`${sid}/${id}`) && !this.agents.get(`${sid}/${id}`).finished).length,
      };
      // Keyed by pane and by terminal: the header looks up either. Sessions come newest first, so the newest wins.
      if (agent.pane && !out[agent.pane]) out[agent.pane] = info;
      if (agent.address && !out[agent.address]) out[agent.address] = info;
    }
    const json = JSON.stringify(out), now = Date.now();
    if (json === this.published && now - this.publishedAt < PUBLISH_EVERY_MS) return;
    this.published = json;
    this.publishedAt = now;
    try { setShared("magpie.panes", { at: now, panes: out }); } catch {}
  }

  // Runs one magpie command on the magpie machine, toasts how it went, then re-reads accounts and groups.
  act(cx, args, done) {
    const on = this.on;
    cx.spawn(async (cx) => {
      let ok = false, msg = "";
      try {
        const r = await sh(`${SH_MAGPIE}; "$M" "$@" 2>&1`, on, args);
        ok = r.code === 0;
        msg = String(r.stdout || r.stderr || "").trim().split("\n").pop() || "";
      } catch (e) { msg = String(e?.message ?? e); }
      try {
        notify(ok ? { title: `magpie: ${done}`, body: msg.slice(0, 200), level: "success", timeout: 6000 }
          : { title: `magpie: ${args.slice(0, 3).join(" ")} failed`, body: msg.slice(0, 300), level: "error", timeout: 10000 });
      } catch {}
      this.refreshAccounts(cx);
    });
  }

  // Each section after the first opens with a full-width rule and a tinted title bar.
  section(t, title, extra, first = false) {
    return h_flex().mt(first ? 0 : 10).px(14).py(6).gap(6).items_center().bg(t.raised)
      .when(!first, (e) => e.border_t(1).border_color(t.border))
      .child(div().font_semibold().child(title.toUpperCase()))
      .when(extra, (e) => e.child(div().text_size(11).text_color(t.dim).child(extra)));
  }

  quotaRows(t) {
    const rows = [];
    if (this.accountsError) rows.push(note(t.ansi1, this.accountsError));
    this.accounts.forEach((a, ai) => {
      // An agent with several accounts: each one by name, ● for the one signed in, agent and plan under it.
      const many = this.accounts.filter((x) => x.agent === a.agent).length > 1;
      const label = (i) => (!many ? div().w(80).flex_none().child(i ? "" : a.agent)
        // Clicking an account not signed in signs the agent in to it.
        : i === 0 ? div().id(`qa-${ai}`).w(80).flex_none().truncate().text_color(a.active ? t.ansi2 : t.foreground).child(`${a.active ? "●" : "○"} ${acctName(a)}`)
          .when(!a.active, (e) => e.cursor_pointer().hover((s) => s.text_color(t.ansi2)).on_click((_e, cx) => this.act(cx,
            ["accounts", "switch", a.agent, a.alias || String(a.user).split(" · ")[0]], `${a.agent} switched to ${acctName(a)}`)))
        : div().w(80).flex_none().truncate().text_size(11).text_color(t.dim).child(i === 1 ? `${[a.agent, a.plan].filter(Boolean).join(" ")}` : ""));
      if (ai) rows.push(div().px(14).py(3).child(div().h(1).bg(t.border)));
      const wins = (a.windows || []).filter((w) => !/·/.test(w.name) || w.used > 0);
      // No quota figures (an API-key plugin such as agy-cli reports every window at 0%): its traffic from the log instead.
      if (!wins.length) {
        const since = Date.now() - 18e6;
        const mine = this.reqs.filter((r) => r.provider === a.agent && r._end >= since && !canceled(r)
          && (!many || r.providerAccount === a.user));
        const errs = mine.filter(failed).length;
        rows.push(row(`q-${ai}`).child(label(0))
          .child(div().w(58).flex_none().text_color(t.muted).child("5 hours"))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(mine.length ? t.foreground : t.dim).child(!mine.length ? "no requests"
            : `${mine.length} req · ${kTok(mine.reduce((s, r) => s + ctxOf(r), 0))} in · ${kTok(mine.reduce((s, r) => s + (r.out || 0), 0))} out`))
          .when(errs, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`${errs} err`)))
          .child(div().flex_none().text_size(11).text_color(t.dim).child("no quota reported")));
        return;
      }
      wins.forEach((w, i) => {
        const pct = Math.min(100, Math.max(0, Math.round(w.used))), pc = pace(w);
        rows.push(row(`q-${ai}-${i}`)
          .child(label(i))
          .child(div().w(58).flex_none().text_color(t.muted).truncate().child(w.name.replace(/^(\d+) ([hd])\w* · (.+)$/, "$3 $1$2")))
          .child(bar(t, pct, level(t, pct, 70, t.ansi2), 8).flex_1().min_w(40))
          .child(div().w(34).flex_none().whitespace_nowrap().text_size(12).child(`${pct}%`))
          .child(div().w(84).flex_none().text_size(11).whitespace_nowrap().truncate()
            .text_color(!pc ? t.dim : pc.ok ? t.ansi2 : t.ansi1).child(pc ? pc.text : ""))
          .child(div().w(52).flex_none().text_size(11).text_color(t.dim).child(`↻ ${resetIn(w.resetsAt)}`)));
      });
    });
    return rows;
  }

  groupRows(t) {
    const refs = [...new Set([...this.groups.keys(), ...this.groupStats.keys()])].sort();
    return refs.map((ref) => {
      const members = (this.groups.get(ref)?.members || []).map(modelOf);
      const g = this.groupStats.get(ref), served = g?.last ? servedOf(g.last) : null;
      const chain = members.length ? members : served ? [served] : [];
      // Clicking the routing cycles it through ROUTINGS. Any other routing (smart, weight, manual…)
      // is shown but not clickable: one click would lose it, and the cycle never comes back to it.
      const routing = this.groups.get(ref)?.routing;
      const cycles = ROUTINGS.includes(routing);
      const next = ROUTINGS[(ROUTINGS.indexOf(routing) + 1) % ROUTINGS.length];
      return v_flex().id(`g-${ref}`).px(14).py(3).gap(1)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_shrink_1().min_w(0).truncate().child(groupName(ref)))
          .when(routing, (e) => e.child(div().id(`gr-${ref}`).flex_none().px(4).rounded(4).text_size(11).text_color(t.dim).child(routing)
            .when(cycles, (c) => c.cursor_pointer().hover((s) => s.bg(t.raised).text_color(t.foreground))
              .on_click((_e, cx) => this.act(cx, ["group", "set", ref.replace(/^group\//, ""), `routing=${next}`], `${groupName(ref)} routing ${routing} → ${next}`)))))
          .child(div().flex_1())
          .when(g?.fails, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`${g.fails} err`)))
          .child(div().flex_none().text_size(11).text_color(t.dim).whitespace_nowrap().child(!g?.n ? "idle"
            : `${g.n} req · cache ${g.ctx ? Math.round((100 * g.cached) / g.ctx) : 0}% · ttft ${(g.ttft / 1000).toFixed(1)}s`)))
        .child(h_flex().gap(4).items_center().overflow_hidden().text_size(11)
          .children(chain.flatMap((m, i) => {
            const on = m === served, col = !on ? t.dim : i === 0 ? t.ansi2 : t.blocked;
            const chip = div().flex_none().text_color(col).when(on, (e) => e.font_semibold()).child(shortModel(m) + (on && i > 0 ? " ⚠" : ""));
            return i ? [div().flex_none().text_color(t.dim).child("›"), chip] : [chip];
          })));
    });
  }

  sessionLabel(sid) {
    const cwd = this.cwds.get(sid) || "", parent = cwd.match(SCRATCH);
    if (parent) return `↳ ${this.titles.get(parent[1]) || parent[1].slice(0, 8)}`;
    return this.titles.get(sid) || `${cwd.split("/").filter(Boolean).pop() || "no transcript"} · ${sid.slice(0, 8)}`;
  }

  // Herdr agents by normalised terminal title (Claude Code titles its terminal with the session title).
  // A title shared by two agents maps to null: clicking must never focus the wrong one.
  agentsByTitle() {
    const map = new Map();
    let list = [];
    try { list = herdrAgents(); } catch {}
    for (const a of list) {
      const k = norm(a.title);
      if (k) map.set(k, map.has(k) ? null : a);
    }
    return map;
  }

  agentFor(sid, byTitle) {
    const title = norm(this.titles.get(sid));
    return title.length >= 4 ? byTitle.get(title) ?? null : null;
  }

  // Context the session's main agent (else its latest one) last sent. The window is 1M when a subagent was
  // started on a [1m] model or the session went past 200k; non-Claude models get no bar.
  contextCell(t, sid, s) {
    const g = s.agents.get("") || s.agents.get(s.last.subagent || "");
    const r = g?.lastCtx;
    if (!r) return div();
    const ctx = ctxOf(r), served = servedOf(r);
    if (!/^claude-/.test(served)) return div().flex_none().text_size(11).text_color(t.muted).child(kTok(ctx));
    const oneM = g.maxCtx > 200_000 || this.oneM.has(sid);
    const pct = Math.min(100, Math.round((100 * ctx) / (oneM ? 1_000_000 : 200_000)));
    const col = level(t, pct, 75, t.muted);
    return h_flex().flex_none().gap(4).items_center().text_size(11)
      .child(bar(t, pct, col, 5).w(36))
      .child(div().text_color(col).whitespace_nowrap().child(`${kTok(ctx)}/${oneM ? "1M" : "200k"}`));
  }

  sessionRows(t, sessions) {
    if (!sessions.length) return [note(t.dim, "no session active in the last 30 min")];
    const byTitle = this.agentsByTitle();
    return sessions.map(([sid, s]) => {
      const age = sinceEnd(s.last);
      const broken = [...s.agents.values()].some((g) => failed(g.last));
      const dot = broken ? t.ansi1 : age < 60_000 ? t.ansi2 : age < ACTIVE_MS ? t.ansi3 : t.raised;
      const agent = this.agentFor(sid, byTitle);
      return v_flex().id(`s-${sid}`).px(14).py(4).gap(1)
        .when(agent, (e) => e.cursor_pointer().on_click(() => { try { run("agent.focus", { terminal: agent.address }); } catch {} }))
        .child(h_flex().gap(8).items_center()
          .child(div().w(8).h(8).rounded(4).flex_none().bg(dot))
          .child(div().flex_1().min_w(0).truncate().font_semibold().child(this.sessionLabel(sid) + (agent ? "  ↗" : "")))
          .child(this.contextCell(t, sid, s))
          .child(div().w(52).flex_none().text_size(11).text_color(t.dim).child(ago(s.last._end))))
        .children(this.agentLines(t, sid, s.agents));
    });
  }

  // One line per agent in a session: the main agent first, then running subagents, then finished ones.
  // A running subagent silent for QUIET_MS, or any agent whose last request failed, is flagged.
  agentLines(t, sid, agents) {
    const rows = [...agents].map(([id, g]) => ({ id, g, meta: id ? this.agents.get(`${sid}/${id}`) : null }));
    // No meta: it is older than the newest meta files read, so it folds as finished.
    const rank = (r) => (!r.id ? 0 : !r.meta || r.meta.finished ? 2 : 1);
    rows.sort((a, b) => rank(a) - rank(b) || b.g.last._end - a.g.last._end);
    // Finished subagents past the newest FINISHED fold into one line; one that failed always stays.
    let shown = 0;
    const folded = [];
    const kept = rows.filter((r) => {
      if (rank(r) < 2 || r.g.fails || shown++ < FINISHED) return true;
      folded.push(r.g);
      return false;
    });
    const lines = kept.map(({ id, g, meta }) => {
      const fallback = fellBack(this.groups, g.last);
      // A subagent with no meta read has an unknown state, so it is never flagged as quiet.
      const live = Boolean(meta && !meta.finished);
      const running = !id || live;
      const quietFor = sinceEnd(g.last);
      const quiet = live && quietFor > QUIET_MS;
      const broke = failed(g.last);
      const name = !id ? "main"
        : !meta ? `subagent ${id.slice(0, 7)}`
        : [meta.agentType || "agent", meta.description].filter(Boolean).join(" · ");
      const flag = broke ? `last call ${g.last.status}` : quiet ? `quiet ${dur(quietFor)}` : "";
      const icon = !id ? "▸" : broke ? "✕" : quiet ? "◌" : running ? "●" : meta ? "✓" : "·";
      const iconCol = broke ? t.ansi1 : quiet ? t.ansi3 : running ? t.ansi2 : t.dim;
      const line = h_flex().pl(16).h(20).gap(6).items_center().overflow_hidden().whitespace_nowrap().text_size(11)
        .child(div().w(10).flex_none().text_color(iconCol).child(icon))
        .child(div().flex_1().min_w(0).truncate().text_color(running ? t.foreground : t.dim).child(name))
        .when(flag, (e) => e.child(div().flex_none().text_color(broke ? t.ansi1 : t.ansi3).child(flag)))
        .child(div().flex_shrink_1().min_w(0).truncate().text_color(fallback ? t.blocked : t.muted)
          .child(`${shortModel(servedOf(g.last))}${fallback ? " ⚠" : ""}`))
        .when(g.fails && !broke, (e) => e.child(div().flex_none().text_color(t.ansi1).child(`${g.fails} err`)))
        .child(div().flex_none().whitespace_nowrap().text_color(t.dim).child(`${g.n} req · ${kTok(g.out)}`));
      return g.fails ? v_flex().child(line).child(errLine(t, g.lastFail, 32)) : line;
    });
    if (!folded.length) return lines;
    const n = folded.reduce((s, g) => s + g.n, 0), out = folded.reduce((s, g) => s + g.out, 0);
    return lines.concat(h_flex().pl(16).h(20).gap(6).items_center().overflow_hidden().whitespace_nowrap().text_size(11).text_color(t.dim)
      .child(div().w(10).flex_none().child("✓"))
      .child(div().flex_1().min_w(0).truncate().child(`+${folded.length} finished`))
      .child(div().flex_none().child(`${n} req · ${kTok(out)}`)));
  }

  // Yellow and red past SYS_WARN's thresholds: load per core, RAM used, disk share free.
  // Bars fill with load per core (full at 1 per core), RAM used and disk used.
  sysStats(t) {
    const { load, cores, ram, diskFree, diskShare } = this.sys;
    const perCore = load / cores;
    const stat = (text, fill, bad, worse) => {
      const c = worse ? t.ansi1 : bad ? t.ansi3 : t.ansi2;
      return h_flex().flex_1().min_w(0).gap(6).items_center()
        .child(div().flex_none().text_color(bad || worse ? c : t.dim).child(text))
        .child(bar(t, Math.min(100, Math.round(fill * 100)), c, 5).flex_1().min_w(24));
    };
    return h_flex().w_full().gap(16).items_center().text_size(11).whitespace_nowrap()
      .child(stat(`load ${load.toFixed(1)}/${cores}`, perCore, perCore >= SYS_WARN.load[0], perCore >= SYS_WARN.load[1]))
      .child(stat(`ram ${Math.round(ram * 100)}%`, ram, ram >= SYS_WARN.ram[0], ram >= SYS_WARN.ram[1]))
      .child(stat(`disk ${Math.round(diskFree / 1048576)}G free`, 1 - diskShare, diskShare <= SYS_WARN.disk[0], diskShare <= SYS_WARN.disk[1]));
  }

  feedRows(t) {
    return this.reqs.slice(-FEED).reverse().map((r, i) => h_flex().id(`r-${i}`).px(14).h(20).gap(8).items_center().text_size(11)
      .child(div().w(56).flex_none().text_color(t.dim).child(hhmm(r.t)))
      .child(div().w(80).flex_none().truncate().text_color(t.muted).child(askedOf(r)))
      .child(div().flex_1().min_w(0).truncate().text_color(failed(r) ? t.ansi1 : t.foreground)
        .child(shortModel(servedOf(r)) + (this.acctOf(r) ? ` · ${this.acctOf(r)}` : "") + (r.kind ? ` · ${r.kind}` : "") + statusTag(r)))
      .child(div().flex_none().text_color(t.dim).child(`${kTok(ctxOf(r))} → ${kTok(r.out)} · ${((r.ms || 0) / 1000).toFixed(1)}s`)));
  }

  errorRows(t) {
    const since = Date.now() - 3.6e6;
    // Newest first; repeats of the same error collapse into its latest occurrence with a count.
    const byKey = new Map();
    for (const r of this.reqs) {
      if (r._end < since || !r.status || r.status === 200 || canceled(r)) continue;
      const key = [askedOf(r), servedOf(r), r.status, Boolean(r.handed_on), errText(r)].join("|");
      byKey.set(key, { r, n: (byKey.get(key)?.n || 0) + 1 });
    }
    const errs = [...byKey.values()].sort((a, b) => b.r._end - a.r._end).slice(0, ERRORS);
    if (!errs.length) return [note(t.dim, "no error in the last hour")];
    return errs.map(({ r, n }, i) => v_flex().id(`e-${i}`).px(14).py(2).text_size(11)
      .child(h_flex().gap(8).items_center()
        .child(div().w(56).flex_none().text_color(t.dim).child(hhmm(r.t)))
        .child(div().w(80).flex_none().truncate().text_color(t.muted).child(askedOf(r)))
        .child(div().flex_1().min_w(0).truncate().text_color(r.handed_on ? t.blocked : t.ansi1)
          .child(`${shortModel(servedOf(r))}  ${r.status}${r.handed_on ? " · handed on" : ""}${n > 1 ? `  ×${n}` : ""}`)))
      .child(div().pl(64).text_color(t.muted).child(errText(r))));
  }

  render(_cx) {
    const t = theme();
    // No one waits on a headless run's prompt, so a long silence means it has ended: drop it and its subagents.
    const sessions = this.loading || this.error ? [] : this.sessions.filter(([sid, s]) =>
      !(this.titles.get(sid) || "").startsWith("headless") || sinceEnd(s.last) < HEADLESS_IDLE_MS);
    const active = sessions.filter(([, s]) => sinceEnd(s.last) < ACTIVE_MS).length;
    const body = this.error
      ? [div().p(14).text_color(t.ansi1).child(this.error)]
      : this.loading
        ? [div().p(14).text_color(t.dim).child("Loading magpie…")]
        : [
            this.section(t, "Sessions", "last 30 min", true), ...this.sessionRows(t, sessions),
            this.section(t, "Quota"), ...this.quotaRows(t),
            this.section(t, "Latest requests", "context → output tokens"), ...this.feedRows(t),
            this.section(t, "Errors", "last hour · handed on = next group member retried it"), ...this.errorRows(t),
            this.section(t, "Groups", "last hour · ⚠ fallback · cache = context read from cache"), ...this.groupRows(t),
            div().h(12),
          ];
    // 5-minute average: a 60 s window reads 0 between bursts of a working session.
    const perMin = this.perMin < 10 ? this.perMin.toFixed(1) : Math.round(this.perMin);
    return v_flex().id("magpie-routing").size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .font_family(settings().font_family ?? "JetBrains Mono")
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Magpie"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted)
          .child(this.on ?? "local"))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(`${active} active · ${perMin} req/min`)))
      .when(this.sys, (e) => e.child(h_flex().h(24).flex_none().px(14).items_center().border_b(1).border_color(t.border)
        .child(this.sysStats(t))))
      .child(v_flex().id("magpie-body").flex_1().min_h(0).overflow_y_scrollbar().children(body));
  }
}
