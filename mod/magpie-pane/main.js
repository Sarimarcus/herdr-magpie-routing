// Pane header with the Claude Code session running in the pane, as the magpie-routing panel sees it:
// the model that served it (orange with ⚠ on a fallback), the account, context used, running
// subagents, and the status of a failed last request. The rest is Herdr's own pane header:
// program icon, name, folder, agent status, and split/zoom/close buttons on hover.
// The panel publishes the data to shared("magpie.panes"), so it updates only while the panel runs.
// Layout: { "pane": { "header": { "content": { "mod": "magpie-pane" } } } }

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, theme, home, shared } from "herdr";

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

// Data older than this means the panel stopped (closed, app restarted, VPS unreachable): show none.
const STALE_MS = 30 * 1000;

const kTok =(n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

function magpie(t, m) {
  const out = [div().flex_none().text_color(m.fb ? t.blocked : t.muted).child(m.model + (m.fb ? " ⚠" : ""))];
  if (m.acct) out.push(div().flex_none().text_color(t.dim).child(`· ${m.acct}`));
  if (m.win) {
    const pct = Math.min(1, m.ctx / m.win), col = pct >= 0.9 ? t.ansi1 : pct >= 0.7 ? t.ansi3 : t.ansi2;
    out.push(div().flex_none().w(36).h(4).rounded(2).bg(t.border)
      .child(div().h(4).rounded(2).bg(col).w(Math.max(1, Math.round(36 * pct)))));
    out.push(div().flex_none().text_color(t.dim).child(`${kTok(m.ctx)}/${m.win >= 1e6 ? "1M" : "200k"}`));
  } else if (m.ctx) out.push(div().flex_none().text_color(t.dim).child(kTok(m.ctx)));
  if (m.subs) out.push(div().flex_none().text_color(t.dim).child(`${m.subs} sub`));
  if (m.err) out.push(div().flex_none().text_color(t.ansi1).child(`✕ ${m.err}`));
  return out;
}

export default class MagpiePane extends View {
  init(_props, cx) {
    this.hovered = false;
    // Without the panel no shared write comes, so re-render on a clock to drop stale data.
    cx.timer.every(STALE_MS / 2, (cx) => cx.notify());
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/pane/${icon}.svg`).size(14));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    let snap = null;
    try { snap = shared("magpie.panes"); } catch {}
    const all = snap?.at > Date.now() - STALE_MS ? snap.panes : null;
    const m = all?.[pane] || all?.[p.terminal] || all?.[props()?.terminal];
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(Boolean(m?.model) && !this.hovered, (el) => el.child(h_flex().flex_none().gap(6).items_center().text_size(11).children(magpie(t, m))))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
