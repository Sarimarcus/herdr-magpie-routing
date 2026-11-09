import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import { spaces, focused, exec, theme, settings, machines, agents as herdrAgents, run, notify } from "herdr";

// The Herdr machine magpie runs on. undefined follows the shown space, as Changes does.
const MACHINE = "vps";
const FEED = 10;
const QUIET_MS = 5 * 60 * 1000;          // a running subagent silent this long is flagged
const ALERT_EVERY_MS = 10 * 60 * 1000;   // at most one toast per group and kind in this window

const READ = `M="$HOME/.local/bin/magpie"; [ -x "$M" ] || M=magpie
echo "@@groups"; "$M" groups 2>/dev/null
U=$(tail -n 1500 "$HOME/.config/magpie/usage.jsonl" 2>/dev/null)
echo "@@usage"; printf '%s\\n' "$U"
echo "@@sessions"; printf '%s\\n' "$U" | grep -o '"session":"[^"]*"' | sort -u | cut -d'"' -f4 | while read -r s; do
  f=$(ls "$HOME"/.claude/projects/*/"$s".jsonl 2>/dev/null | head -n 1)
  [ -n "$f" ] || continue
  echo "$s $(grep -m 1 -o '"cwd":"[^"]*"' "$f" | cut -d'"' -f4)"
  for m in $(ls -t "\${f%.jsonl}"/subagents/*.meta.json 2>/dev/null | head -n 80); do
    a=\${m##*/agent-}; echo "@agent $s \${a%.meta.json} $(head -c 2000 "$m")"
  done
done`;
// Session titles: the latest custom or AI title in each transcript. Ids come in as "$@".
const TITLES = `for s in "$@"; do
  f=$(ls "$HOME"/.claude/projects/*/"$s".jsonl 2>/dev/null | head -n 1)
  [ -n "$f" ] && printf '%s\\t%s\\n' "$s" "$(tac "$f" | grep -m 1 -o '"customTitle":"[^"]*"\\|"aiTitle":"[^"]*"' | cut -d'"' -f4)"
done`;
const SESSION_WINDOW_MS = 30 * 60 * 1000;
const ACCOUNTS = `M="$HOME/.local/bin/magpie"; [ -x "$M" ] || M=magpie; "$M" accounts --json 2>/dev/null`;

// The name shown in Settings can differ from the one exec takes: match loosely,
// else use the only remote machine.
function pinned() {
  const names = machines().map((m) => m.name).filter(Boolean);
  if (names.includes(MACHINE)) return MACHINE;
  const want = String(MACHINE).toLowerCase();
  const loose = names.find((n) => n.toLowerCase() === want || n.toLowerCase().includes(want));
  if (loose) return loose;
  return names.length === 1 ? names[0] : MACHINE;
}

const knownMachines = () => machines().map((m) => m.name).filter(Boolean).join(", ") || "none";

function machine() {
  if (MACHINE !== undefined) return pinned();
  const f = focused(), space = spaces().find((s) => s.active);
  if (f?.pane === null) return f.terminal?.includes("/") ? f.terminal.split("/")[0] : null;
  return space?.machine ?? null;
}

const modelOf = (m) => (m || "").split("/").pop().replace(/\[.*\]$/, "");
const hhmm = (t) => new Date(t).toTimeString().slice(0, 8);
const groupName = (ref) => ref.replace(/^group\//, "").replace(/^csf-/, "");
const shortModel = (m) => (m || "").replace(/^claude-/, "");
const ago = (ms) => { const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 10 ? "now" : s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`; };
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const ctxOf = (r) => (r.in || 0) + (r.cache_read || 0) + (r.cache_write || 0);
// 499 is magpie's agent_canceled: the user pressed Esc or Claude Code stopped an agent. Not a failure.
const failed = (r) => Boolean(r.status && r.status !== 200 && r.status !== 499);
// Lines are written when a request finishes; `t` is when it started. Parsed once in parse().
const startOf = (r) => r._t;
const endOf = (r) => r._t + (r.ms || 0);
const reqKey = (r) => r.rid || r.route_id || `${r.session}|${r.t}`;
const dur = (ms) => {
  const m = Math.max(0, Math.round(ms / 6e4));
  return m >= 1440 ? `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : `${m}m`;
};
const median = (xs) => { const v = xs.filter((x) => x > 0).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : 0; };
// First group member, or null outside a group: anything else served means a fallback.
const fellBack = (groups, r) => {
  const first = modelOf((groups.get(r.req)?.members || [])[0]);
  return Boolean(r.req?.startsWith("group/") && first && modelOf(r.served || r.model) !== first);
};

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

const kTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n || 0));

function resetIn(iso) {
  const ms = new Date(iso) - Date.now();
  return ms > 0 ? dur(ms) : "";
}

function parse(stdout) {
  const groups = new Map(), reqs = [], cwds = new Map(), agents = new Map();
  let section = "";
  for (const line of stdout.split("\n")) {
    if (line.startsWith("@@")) { section = line.slice(2); continue; }
    if (section === "groups") {
      const m = line.match(/^\s+\S+\s+(group\/\S+)\s+(\S+)\s+(.+)$/);
      if (m) groups.set(m[1], { routing: m[2], members: m[3].replace(/\s+←.*$/, "").split("→").map((s) => s.trim()) });
    } else if (section === "usage" && line) {
      try {
        const r = JSON.parse(line);
        r._t = Date.parse(r.t);
        if (Number.isFinite(r._t)) reqs.push(r);
      } catch {}
    } else if (section === "sessions" && line.startsWith("@agent ")) {
      const [, sid, id, ...json] = line.split(" ");
      try { agents.set(`${sid}/${id}`, JSON.parse(json.join(" "))); } catch {}
    } else if (section === "sessions" && line) {
      const i = line.indexOf(" ");
      if (i > 0) cwds.set(line.slice(0, i), line.slice(i + 1));
    }
  }
  return { groups, reqs, cwds, agents };
}

export default class MagpieRouting extends View {
  init(_props, cx) {
    this.groups = new Map();
    this.reqs = [];
    this.cwds = new Map();
    this.titles = new Map();
    this.agents = new Map();
    this.accounts = [];
    this.seen = null;
    this.alerted = new Map();
    this.accountsError = null;
    this.accountsSeq = 0;
    this.error = null;
    this.loading = true;
    this.on = machine();
    cx.timer.every(3000, (cx) => this.refresh(cx));
    cx.timer.every(60000, (cx) => this.refreshAccounts(cx));
    cx.timer.every(30000, (cx) => this.refreshTitles(cx));
    this.refresh(cx);
    this.refreshAccounts(cx);
  }

  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    const on = machine();
    if (on !== this.on) { this.on = on; this.refreshAccounts(cx); }
    cx.spawn(async (cx) => {
      const where = on ?? "this computer";
      try {
        const r = await exec("sh", ["-c", READ], { on, timeout: 20000 });
        if (on === this.on) {
          const { groups, reqs, cwds, agents } = parse(r.stdout);
          this.agents = agents;
          this.groups = groups;
          this.reqs = reqs;
          this.cwds = cwds;
          this.alert(reqs, groups);
          if ([...cwds.keys()].some((sid) => !this.titles.has(sid))) this.refreshTitles(cx);
          this.error = groups.size || reqs.length ? null : `magpie not found on ${where}`;
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
    });
  }

  // Toasts for requests that failed or fell back since the last refresh. Keyed by request id, not time:
  // the log is in completion order. The first read with groups only records what is already there.
  alert(reqs, groups) {
    if (!groups.size) return;
    const fresh = this.seen !== null;
    const seen = new Set();
    for (const r of reqs) {
      const id = reqKey(r);
      seen.add(id);
      if (!fresh || this.seen.has(id)) continue;
      const kind = failed(r) ? "error" : fellBack(groups, r) ? "fallback" : null;
      if (!kind) continue;
      const key = `${r.req}|${kind}`;
      if (Date.now() - (this.alerted.get(key) || 0) < ALERT_EVERY_MS) continue;
      this.alerted.set(key, Date.now());
      const group = groupName(r.req || r.model || "?");
      try {
        notify(kind === "error"
          ? { title: `magpie: ${group} request failed (${r.status})`, body: `${modelOf(r.served || r.model)} via ${r.provider || "?"}`, level: "error", timeout: 10000 }
          : { title: `magpie: ${group} fell back`, body: `served by ${modelOf(r.served)}`, level: "warning", timeout: 8000 });
      } catch {}
    }
    this.seen = seen;
  }

  refreshAccounts(cx) {
    const on = machine(), seq = ++this.accountsSeq;
    cx.spawn(async (cx) => {
      let accounts = [], error = null;
      try {
        const r = await exec("sh", ["-c", ACCOUNTS], { on, timeout: 30000 });
        if (r.code !== 0) error = `magpie accounts exited ${r.code}`;
        else accounts = JSON.parse(r.stdout);
      } catch (e) { error = `magpie accounts failed: ${e?.message ?? e}`; }
      if (seq !== this.accountsSeq) return;
      this.accounts = accounts;
      this.accountsError = error;
      cx.notify();
    });
  }

  refreshTitles(cx) {
    const ids = [...this.cwds.keys()].filter((sid) => /^[0-9a-f-]{36}$/.test(sid));
    if (this.titling || !ids.length) return;
    this.titling = true;
    const on = this.on;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", TITLES, "sh", ...ids], { on, timeout: 20000 });
        for (const line of r.stdout.split("\n")) {
          const [sid, title] = line.split("\t");
          if (sid) this.titles.set(sid, title || "");
        }
      } catch {}
      this.titling = false;
      cx.notify();
    });
  }

  // Each section after the first opens with a full-width rule and a tinted title bar.
  section(t, title, extra, first = false) {
    return h_flex().mt(first ? 0 : 10).px(14).py(6).gap(6).items_center().bg(t.raised)
      .when(!first, (e) => e.border_t(1).border_color(t.border))
      .child(div().font_semibold().child(title.toUpperCase()))
      .when(Boolean(extra), (e) => e.child(div().text_size(11).text_color(t.dim).child(extra)));
  }

  quotaRows(t) {
    const idleNote = (ws) => ws?.length ? `${ws.length} per-model windows, all 0% used` : "no windows reported";
    const rows = [];
    if (this.accountsError) rows.push(div().px(14).h(22).text_color(t.ansi1).truncate().child(this.accountsError));
    for (const a of this.accounts) {
      const wins = (a.windows || []).filter((w) => !/·/.test(w.name) || w.used > 0);
      if (!wins.length) {
        rows.push(h_flex().id(`q-${a.agent}`).px(14).h(22).gap(8).items_center()
          .child(div().w(56).child(a.agent)).child(div().text_color(t.dim).child(idleNote(a.windows))));
        continue;
      }
      wins.forEach((w, i) => {
        const pct = Math.min(100, Math.max(0, w.used));
        const col = pct >= 90 ? t.ansi1 : pct >= 70 ? t.ansi3 : t.ansi2, pc = pace(w);
        rows.push(h_flex().id(`q-${a.agent}-${i}`).px(14).h(22).gap(8).items_center()
          .child(div().w(56).text_color(i ? t.dim : t.foreground).child(i ? "" : a.agent))
          .child(div().w(58).text_color(t.muted).truncate().child(w.name))
          .child(div().flex_1().min_w(40).h(8).rounded(4).bg(t.raised).overflow_hidden()
            .child(div().h_full().rounded(4).bg(col).w(`${pct}%`)))
          .child(div().w(34).text_size(12).child(`${pct}%`))
          .child(div().w(84).flex_none().text_size(11).whitespace_nowrap().truncate()
            .text_color(!pc ? t.dim : pc.ok ? t.ansi2 : t.ansi1).child(pc ? pc.text : ""))
          .child(div().w(52).flex_none().text_size(11).text_color(t.dim).child(`↻ ${resetIn(w.resetsAt)}`)));
      });
    }
    return rows;
  }

  // Per group: requests in the last hour, which member served last, and how often each did.
  groupStats(since) {
    const byGroup = new Map();
    for (const r of this.reqs) {
      if (!r.req?.startsWith("group/")) continue;
      const g = byGroup.get(r.req) || { n: 0, fails: 0, last: null, ctx: 0, cached: 0, ttft: [] };
      if (endOf(r) >= since) {
        g.n++;
        if (failed(r)) g.fails++;
        g.ctx += ctxOf(r); g.cached += r.cache_read || 0; g.ttft.push(r.ttft_ms || 0);
      }
      g.last = r;
      byGroup.set(r.req, g);
    }
    return byGroup;
  }

  groupRows(t) {
    const byGroup = this.groupStats(Date.now() - 3.6e6);
    const refs = [...new Set([...this.groups.keys(), ...byGroup.keys()])].sort();
    return refs.map((ref) => {
      const members = (this.groups.get(ref)?.members || []).map(modelOf);
      const g = byGroup.get(ref), served = g?.last ? modelOf(g.last.served) : null;
      const chain = members.length ? members : served ? [served] : [];
      return v_flex().id(`g-${ref}`).px(14).py(3).gap(1)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().child(groupName(ref)))
          .when(Boolean(g?.fails), (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`${g.fails} err`)))
          .child(div().flex_none().text_size(11).text_color(t.dim).whitespace_nowrap().child(!g?.n ? "idle"
            : `${g.n} req · cache ${g.ctx ? Math.round((100 * g.cached) / g.ctx) : 0}% · ttft ${(median(g.ttft) / 1000).toFixed(1)}s`)))
        .child(h_flex().gap(4).items_center().overflow_hidden().text_size(11)
          .children(chain.flatMap((m, i) => {
            const on = m === served, col = !on ? t.dim : i === 0 ? t.ansi2 : t.blocked;
            const chip = div().flex_none().text_color(col).when(on, (e) => e.font_semibold()).child(shortModel(m) + (on && i > 0 ? " ⚠" : ""));
            return i ? [div().flex_none().text_color(t.dim).child("›"), chip] : [chip];
          })));
    });
  }

  sessionLabel(sid) {
    const cwd = this.cwds.get(sid) || "", parent = cwd.match(/\/([0-9a-f-]{36})\/scratchpad$/);
    if (parent) return `↳ ${this.titles.get(parent[1]) || parent[1].slice(0, 8)}`;
    return this.titles.get(sid) || `${cwd.split("/").filter(Boolean).pop() || "?"} · ${sid.slice(0, 8)}`;
  }

  activeSessions() {
    const since = Date.now() - SESSION_WINDOW_MS, bySession = new Map();
    for (const r of this.reqs) {
      if (!r.session || endOf(r) < since) continue;
      const s = bySession.get(r.session) || { last: null, agents: new Map() };
      const key = r.subagent || "";
      const g = s.agents.get(key) || { n: 0, out: 0, fails: 0, last: null, lastCtx: null, maxCtx: 0 };
      g.n++; g.out += r.out || 0; g.maxCtx = Math.max(g.maxCtx, ctxOf(r));
      if (!g.last || endOf(r) >= endOf(g.last)) g.last = r;
      if (ctxOf(r) > 0 && (!g.lastCtx || endOf(r) >= endOf(g.lastCtx))) g.lastCtx = r;
      if (failed(r)) g.fails++;
      s.agents.set(key, g);
      if (!s.last || endOf(r) >= endOf(s.last)) s.last = r;
      bySession.set(r.session, s);
    }
    return [...bySession].sort((a, b) => endOf(b[1].last) - endOf(a[1].last));
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

  // Context the session's most recent agent last sent. The window is 1M when a subagent was started
  // on a [1m] model or the session went past 200k; non-Claude models get no bar.
  contextCell(t, sid, s) {
    const g = s.agents.get("") || [...s.agents.values()].sort((a, b) => endOf(b.last) - endOf(a.last))[0];
    const r = g.lastCtx;
    if (!r) return div();
    const ctx = ctxOf(r), served = modelOf(r.served || r.model);
    if (!/^claude-/.test(served)) return div().flex_none().text_size(11).text_color(t.muted).child(kTok(ctx));
    const oneM = g.maxCtx > 200_000 || [...this.agents].some(([k, m]) => k.startsWith(`${sid}/`) && /\[1m\]$/.test(m.pickedEffortModel || ""));
    const limit = oneM ? 1_000_000 : 200_000;
    const pct = Math.min(100, Math.round((100 * ctx) / limit));
    const col = pct >= 90 ? t.ansi1 : pct >= 75 ? t.ansi3 : t.muted;
    return h_flex().flex_none().gap(4).items_center().text_size(11)
      .child(div().w(36).h(5).rounded(3).bg(t.raised).overflow_hidden().child(div().h_full().bg(col).w(`${pct}%`)))
      .child(div().text_color(col).whitespace_nowrap().child(`${kTok(ctx)}/${oneM ? "1M" : "200k"}`));
  }

  sessionRows(t, sessions) {
    if (!sessions.length) return [div().px(14).h(22).text_color(t.dim).child("no session active in the last 30 min")];
    const byTitle = this.agentsByTitle();
    return sessions.map(([sid, s]) => {
      const age = Date.now() - endOf(s.last);
      const broken = [...s.agents.values()].some((g) => failed(g.last));
      const dot = broken ? t.ansi1 : age < 60_000 ? t.ansi2 : age < 300_000 ? t.ansi3 : t.raised;
      const agent = this.agentFor(sid, byTitle);
      return v_flex().id(`s-${sid}`).px(14).py(4).gap(1)
        .when(Boolean(agent), (e) => e.cursor_pointer().on_click(() => { try { run("agent.focus", { terminal: agent.address }); } catch {} }))
        .child(h_flex().gap(8).items_center()
          .child(div().w(8).h(8).rounded(4).flex_none().bg(dot))
          .child(div().flex_1().min_w(0).truncate().font_semibold().child(this.sessionLabel(sid) + (agent ? "  ↗" : "")))
          .child(this.contextCell(t, sid, s))
          .child(div().w(52).flex_none().text_size(11).text_color(t.dim).child(ago(endOf(s.last)))))
        .children(this.agentLines(t, sid, s.agents));
    });
  }

  // One line per agent in a session: the main agent first, then running subagents, then finished ones.
  // A running subagent silent for QUIET_MS, or any agent whose last request failed, is flagged.
  agentLines(t, sid, agents) {
    const rows = [...agents].map(([id, g]) => ({ id, g, meta: id ? this.agents.get(`${sid}/${id}`) : null }));
    const rank = (r) => (!r.id ? 0 : r.meta?.finished ? 2 : 1);
    rows.sort((a, b) => rank(a) - rank(b) || endOf(b.g.last) - endOf(a.g.last));
    return rows.map(({ id, g, meta }) => {
      const served = modelOf(g.last.served || g.last.model);
      const fallback = fellBack(this.groups, g.last);
      // No meta read: state unknown, so never flagged as quiet.
      const running = !id || (meta && !meta.finished);
      const quietFor = Date.now() - endOf(g.last);
      const quiet = Boolean(id) && running && quietFor > QUIET_MS;
      const broke = failed(g.last);
      const name = !id ? "main" : meta ? `${meta.agentType || "agent"}${meta.description ? ` · ${meta.description}` : ""}` : `subagent ${id.slice(0, 7)}`;
      const flag = broke ? `last call ${g.last.status}` : quiet ? `quiet ${dur(quietFor)}` : "";
      const icon = !id ? "▸" : broke ? "✕" : quiet ? "◌" : running ? "●" : meta ? "✓" : "·";
      const iconCol = broke ? t.ansi1 : quiet ? t.ansi3 : running ? t.ansi2 : t.dim;
      return h_flex().pl(16).h(20).gap(6).items_center().overflow_hidden().whitespace_nowrap().text_size(11)
        .child(div().w(10).flex_none().text_color(iconCol).child(icon))
        .child(div().flex_1().min_w(0).truncate().text_color(running ? t.foreground : t.dim).child(name))
        .when(Boolean(flag), (e) => e.child(div().flex_none().text_color(broke ? t.ansi1 : t.ansi3).child(flag)))
        .child(div().flex_shrink_1().min_w(0).truncate().text_color(fallback ? t.blocked : t.muted)
          .child(`${shortModel(served)}${fallback ? " ⚠" : ""}`))
        .when(Boolean(g.fails) && !broke, (e) => e.child(div().flex_none().text_color(t.ansi1).child(`${g.fails} err`)))
        .child(div().flex_none().whitespace_nowrap().text_color(t.dim).child(`${g.n} req · ${kTok(g.out)}`));
    });
  }

  feedRows(t) {
    return this.reqs.slice(-FEED).reverse().map((r, i) => {
      const ok = !failed(r);
      const tok = ctxOf(r);
      return h_flex().id(`r-${i}`).px(14).h(20).gap(8).items_center().text_size(11)
        .child(div().w(56).flex_none().text_color(t.dim).child(hhmm(r.t)))
        .child(div().w(80).flex_none().truncate().text_color(t.muted).child(groupName(r.req || r.model || "")))
        .child(div().flex_1().min_w(0).truncate().text_color(ok ? t.foreground : t.ansi1)
          .child(shortModel(modelOf(r.served || r.model)) + (r.status && r.status !== 200 ? `  ${r.status}` : "")))
        .child(div().flex_none().text_color(t.dim).child(`${kTok(tok)} → ${kTok(r.out)} · ${((r.ms || 0) / 1000).toFixed(1)}s`));
    });
  }

  render(_cx) {
    const t = theme();
    const sessions = this.loading || this.error ? [] : this.activeSessions();
    // 5-minute average: a 60 s window reads 0 between bursts of a working session.
    const perMin = this.reqs.filter((r) => Date.now() - endOf(r) < 300_000).length / 5;
    const active = sessions.filter(([, s]) => Date.now() - endOf(s.last) < 300_000).length;
    const body = this.error
      ? [div().p(14).text_color(t.ansi1).child(this.error)]
      : this.loading
        ? [div().p(14).text_color(t.dim).child("Loading magpie…")]
        : [
            this.section(t, "Sessions", "last 30 min", true), ...this.sessionRows(t, sessions),
            this.section(t, "Quota"), ...this.quotaRows(t),
            this.section(t, "Latest requests", "context → output tokens"), ...this.feedRows(t),
            this.section(t, "Groups", "last hour · ⚠ fallback · cache = context read from cache"), ...this.groupRows(t),
            div().h(12),
          ];
    return v_flex().id("magpie-routing").size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .font_family(settings().font_family ?? "JetBrains Mono")
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Magpie"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted)
          .child(this.on ?? "local"))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(`${active} active · ${perMin < 10 ? perMin.toFixed(1) : Math.round(perMin)} req/min`)))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("magpie-body").absolute().inset_0().overflow_y_scroll().children(body))
        .child(Scrollbar.vertical("magpie-body").absolute().inset_0()));
  }
}
