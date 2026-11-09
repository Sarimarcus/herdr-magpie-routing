import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import { spaces, focused, exec, theme, settings, machines } from "herdr";

// The Herdr machine magpie runs on. undefined follows the shown space, as Changes does.
const MACHINE = "vps";
const FEED = 20;

const READ = `M="$HOME/.local/bin/magpie"; [ -x "$M" ] || M=magpie
echo "@@groups"; "$M" groups 2>/dev/null
U=$(tail -n 1500 "$HOME/.config/magpie/usage.jsonl" 2>/dev/null)
echo "@@usage"; printf '%s\\n' "$U"
echo "@@sessions"; printf '%s\\n' "$U" | grep -o '"session":"[^"]*"' | sort -u | cut -d'"' -f4 | while read -r s; do
  f=$(ls "$HOME"/.claude/projects/*/"$s".jsonl 2>/dev/null | head -n 1)
  [ -n "$f" ] && echo "$s $(grep -m 1 -o '"cwd":"[^"]*"' "$f" | cut -d'"' -f4)"
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
const kTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n || 0));

function resetIn(iso) {
  const ms = new Date(iso) - Date.now();
  if (!(ms > 0)) return "";
  const h = Math.floor(ms / 3.6e6), m = Math.floor((ms % 3.6e6) / 6e4);
  return h >= 24 ? `${Math.floor(h / 24)}d${h % 24}h` : `${h}h${String(m).padStart(2, "0")}m`;
}

function parse(stdout) {
  const groups = new Map(), reqs = [], cwds = new Map();
  let section = "";
  for (const line of stdout.split("\n")) {
    if (line.startsWith("@@")) { section = line.slice(2); continue; }
    if (section === "groups") {
      const m = line.match(/^\s+\S+\s+(group\/\S+)\s+(\S+)\s+(.+)$/);
      if (m) groups.set(m[1], { routing: m[2], members: m[3].replace(/\s+←.*$/, "").split("→").map((s) => s.trim()) });
    } else if (section === "usage" && line) {
      try { reqs.push(JSON.parse(line)); } catch {}
    } else if (section === "sessions" && line) {
      const i = line.indexOf(" ");
      if (i > 0) cwds.set(line.slice(0, i), line.slice(i + 1));
    }
  }
  return { groups, reqs, cwds };
}

export default class MagpieRouting extends View {
  init(_props, cx) {
    this.groups = new Map();
    this.reqs = [];
    this.cwds = new Map();
    this.accounts = [];
    this.accountsError = null;
    this.accountsSeq = 0;
    this.error = null;
    this.loading = true;
    this.on = machine();
    cx.timer.every(3000, (cx) => this.refresh(cx));
    cx.timer.every(60000, (cx) => this.refreshAccounts(cx));
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
          const { groups, reqs, cwds } = parse(r.stdout);
          this.groups = groups;
          this.reqs = reqs;
          this.cwds = cwds;
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

  section(t, title, extra) {
    return h_flex().px(14).pt(12).pb(4).gap(6).items_center()
      .child(div().font_semibold().child(title))
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
        const col = pct >= 90 ? t.ansi1 : pct >= 70 ? t.ansi3 : t.ansi2;
        rows.push(h_flex().id(`q-${a.agent}-${i}`).px(14).h(22).gap(8).items_center()
          .child(div().w(56).text_color(i ? t.dim : t.foreground).child(i ? "" : a.agent))
          .child(div().w(58).text_color(t.muted).truncate().child(w.name))
          .child(div().flex_1().min_w(40).h(8).rounded(4).bg(t.raised).overflow_hidden()
            .child(div().h_full().rounded(4).bg(col).w(`${pct}%`)))
          .child(div().w(34).text_size(12).child(`${pct}%`))
          .child(div().w(52).text_size(11).text_color(t.dim).child(`↻ ${resetIn(w.resetsAt)}`)));
      });
    }
    return rows;
  }

  groupRows(t) {
    const hourAgo = Date.now() - 3.6e6, byGroup = new Map();
    for (const r of this.reqs) {
      if (!r.req?.startsWith("group/")) continue;
      const g = byGroup.get(r.req) || { n: 0, served: new Map(), last: null, fails: 0 };
      if (new Date(r.t) >= hourAgo) {
        g.n++;
        g.served.set(modelOf(r.served), (g.served.get(modelOf(r.served)) || 0) + 1);
        if (r.status && r.status !== 200) g.fails++;
      }
      g.last = r;
      byGroup.set(r.req, g);
    }
    const refs = [...new Set([...this.groups.keys(), ...byGroup.keys()])].sort();
    return refs.map((ref) => {
      const members = (this.groups.get(ref)?.members || []).map(modelOf);
      const g = byGroup.get(ref), last = g?.last;
      const fallback = last && members[0] && modelOf(last.served) !== members[0];
      const mix = g?.n ? [...g.served].map(([m, n]) => `${m} ${n}`).join(", ") : "";
      return v_flex().id(`g-${ref}`).px(14).py(4).gap(1)
        .child(h_flex().gap(8).items_center()
          .child(div().w(110).flex_none().truncate().child(ref.replace("group/", "")))
          .child(div().text_color(t.dim).child("→"))
          .child(div().flex_1().min_w(0).truncate()
            .text_color(!last ? t.dim : fallback ? t.blocked : t.ansi2)
            .child(!last ? "idle" : modelOf(last.served) + (fallback ? "  ⚠ fallback" : "")))
          .when(Boolean(g?.fails), (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`${g.fails} errors`))))
        .child(div().text_size(11).text_color(t.dim).truncate()
          .child((members.join(" → ") || "?") + (mix ? `  ·  ${g.n} req: ${mix}` : "")));
    });
  }

  sessionRows(t) {
    const since = Date.now() - SESSION_WINDOW_MS, bySession = new Map();
    for (const r of this.reqs) {
      if (!r.session || new Date(r.t) < since) continue;
      const s = bySession.get(r.session) || { n: 0, out: 0, fails: 0, served: new Map(), last: null };
      s.n++;
      s.out += r.out || 0;
      if (r.status && r.status !== 200) s.fails++;
      s.served.set(modelOf(r.served || r.model), (s.served.get(modelOf(r.served || r.model)) || 0) + 1);
      s.last = r;
      bySession.set(r.session, s);
    }
    if (!bySession.size) return [div().px(14).h(22).text_color(t.dim).child("no session active in the last 30 min")];
    const ago = (iso) => { const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`; };
    return [...bySession].sort((a, b) => new Date(b[1].last.t) - new Date(a[1].last.t)).map(([sid, s]) => {
      const last = s.last, served = modelOf(last.served || last.model);
      const first = modelOf((this.groups.get(last.req)?.members || [])[0]);
      const fallback = last.req?.startsWith("group/") && first && served !== first;
      const live = Date.now() - new Date(last.t) < 60_000;
      const cwd = this.cwds.get(sid) || "", parent = cwd.match(/\/([0-9a-f]{8})-[0-9a-f-]{27}\/scratchpad$/);
      const where = parent ? `↳ ${parent[1]}` : cwd.split("/").filter(Boolean).pop() || "?";
      const mix = [...s.served].map(([m, n]) => `${m} ${n}`).join(", ");
      return v_flex().id(`s-${sid}`).px(14).py(4).gap(1)
        .child(h_flex().gap(8).items_center()
          .child(div().w(8).h(8).rounded(4).flex_none().bg(live ? t.ansi2 : t.raised))
          .child(div().w(150).flex_none().truncate().child(`${where} · ${sid.slice(0, 8)}`))
          .child(div().flex_1().min_w(0).truncate().text_color(fallback ? t.blocked : t.ansi2)
            .child(served + (fallback ? "  ⚠ fallback" : "")))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(`${ago(last.t)} ago`)))
        .child(div().text_size(11).text_color(t.dim).truncate()
          .child(`${(last.req || "").replace("group/", "")} · ${s.n} req · ${kTok(s.out)} out · ${mix}`)
          .when(Boolean(s.fails), (e) => e.child(div().text_color(t.ansi1).child(` · ${s.fails} errors`))));
    });
  }

  feedRows(t) {
    return this.reqs.slice(-FEED).reverse().map((r, i) => {
      const ok = !r.status || r.status === 200;
      const tok = (r.in || 0) + (r.cache_read || 0) + (r.cache_write || 0);
      return h_flex().id(`r-${i}`).px(14).h(20).gap(8).items_center().text_size(11)
        .child(div().w(56).flex_none().text_color(t.dim).child(hhmm(r.t)))
        .child(div().w(100).flex_none().truncate().child((r.req || r.model || "").replace("group/", "")))
        .child(div().flex_1().min_w(0).truncate().text_color(ok ? t.foreground : t.ansi1)
          .child(modelOf(r.served || r.model) + (ok ? "" : `  ${r.status}`)))
        .child(div().flex_none().text_color(t.dim).child(`${kTok(tok)} in · ${kTok(r.out)} out · ${((r.ms || 0) / 1000).toFixed(1)}s`));
    });
  }

  render(_cx) {
    const t = theme();
    const body = this.error
      ? [div().p(14).text_color(t.ansi1).child(this.error)]
      : this.loading
        ? [div().p(14).text_color(t.dim).child("Loading magpie…")]
        : [
            this.section(t, "Sessions", "last 30 min"), ...this.sessionRows(t),
            this.section(t, "Quota"), ...this.quotaRows(t),
            this.section(t, "Groups", "last hour"), ...this.groupRows(t),
            this.section(t, "Latest requests"), ...this.feedRows(t),
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
        .child(div().text_size(11).text_color(t.dim).child(`${this.reqs.length} recent`)))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("magpie-body").absolute().inset_0().overflow_y_scroll().children(body))
        .child(Scrollbar.vertical("magpie-body").absolute().inset_0()));
  }
}
