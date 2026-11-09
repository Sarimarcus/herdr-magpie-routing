#!/usr/bin/env node
// Live magpie routing view: reads magpie's own request logs, no gateway key needed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const CFG = process.env.MAGPIE_CONFIG_DIR || path.join(os.homedir(), '.config/magpie');
const USAGE = path.join(CFG, 'usage.jsonl');
const ROUTING_DIR = path.join(CFG, 'routing');
const MAGPIE = process.env.MAGPIE_BIN || [path.join(os.homedir(), '.local/bin/magpie'), 'magpie'].find((p) => p === 'magpie' || fs.existsSync(p));
const ONCE = process.argv.includes('--once');
const TAIL_BYTES = 512 * 1024;
const FEED = 14;

const c = (code) => (s) => `\x1b[${code}m${s}\x1b[0m`;
const dim = c('2'), bold = c('1'), red = c('31'), green = c('32'), yellow = c('33'), cyan = c('36');

function tailLines(file, bytes = TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines.filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  } catch { return []; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function groupMembers() {
  const groups = new Map(configured);
  let files = [];
  try { files = fs.readdirSync(ROUTING_DIR).filter((f) => f.endsWith('.jsonl')).sort().slice(-2); } catch {}
  for (const f of files) for (const r of tailLines(path.join(ROUTING_DIR, f))) {
    if (r.group?.ref && !configured.has(r.group.ref)) groups.set(r.group.ref, r.group);
  }
  return groups;
}

let accounts = [], accountsErr = '';
const configured = new Map();
function refreshGroups(done = () => {}) {
  execFile(MAGPIE, ['groups'], { timeout: 20000 }, (err, out) => {
    if (!err) for (const line of out.split('\n')) {
      const m = line.match(/^\s+\S+\s+(group\/\S+)\s+\S+\s+(.+)$/);
      if (m) configured.set(m[1], { ref: m[1], members: m[2].replace(/\s+←.*$/, '').split('→').map((s) => s.trim()) });
    }
    done();
  });
}

function refreshAccounts() {
  refreshGroups();
  execFile(MAGPIE, ['accounts', '--json'], { timeout: 20000 }, (err, out) => {
    if (err) { accountsErr = 'magpie accounts failed'; return; }
    try { accounts = JSON.parse(out); accountsErr = ''; } catch { accountsErr = 'magpie accounts: bad JSON'; }
  });
}

const modelOf = (m) => (m || '').split('/').pop().replace(/\[.*\]$/, '');
const hhmm = (t) => new Date(t).toTimeString().slice(0, 8);
const kTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n || 0));
const pad = (s, n) => { const v = String(s ?? ''); return v.length >= n ? v.slice(0, n - 1) + '…' : v + ' '.repeat(n - v.length); };

// Cut to `width` visible columns, keeping ANSI escapes intact.
function clip(line, width) {
  let visible = 0, out = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\x1b') {
      const m = line.slice(i).match(/^\x1b\[[0-9;?]*[A-Za-z]/);
      if (m) { out += m[0]; i += m[0].length - 1; continue; }
    }
    if (visible === width - 1 && line.slice(i).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').length > 1) return out + '…\x1b[0m';
    if (visible >= width) break;
    out += line[i];
    visible++;
  }
  return out;
}

function bar(pct, width = 20) {
  const used = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width);
  const col = pct >= 90 ? red : pct >= 70 ? yellow : green;
  return col('█'.repeat(used)) + dim('░'.repeat(width - used));
}

function resetIn(iso) {
  const ms = new Date(iso) - Date.now();
  if (!(ms > 0)) return '';
  const h = Math.floor(ms / 3.6e6), m = Math.floor((ms % 3.6e6) / 6e4);
  return h >= 24 ? `${Math.floor(h / 24)}d${h % 24}h` : `${h}h${String(m).padStart(2, '0')}m`;
}

function render() {
  const out = [];
  const now = new Date();
  out.push(bold(' magpie routing ') + dim(now.toTimeString().slice(0, 8) + (ONCE ? '' : '  · q quits')));
  out.push('');

  out.push(bold(' Quota'));
  if (accountsErr) out.push(' ' + red(accountsErr));
  for (const a of accounts) {
    const wins = (a.windows || []).filter((w) => !/·/.test(w.name) || w.used > 0);
    for (const [i, w] of wins.entries()) {
      out.push(` ${pad(i ? '' : a.agent, 8)}${pad(w.name, 9)}${bar(w.used)} ${String(w.used).padStart(3)}%  ${dim('↻ ' + resetIn(w.resetsAt))}`);
    }
    if (!wins.length) out.push(` ${pad(a.agent, 8)}${dim(a.windows?.length ? `${a.windows.length} per-model windows, all 0% used` : 'no windows reported')}`);
  }
  out.push('');

  const reqs = tailLines(USAGE);
  const groups = groupMembers();
  const hourAgo = Date.now() - 3.6e6;

  out.push(bold(' Groups') + dim('  (last hour)'));
  const byGroup = new Map();
  for (const r of reqs) {
    if (!r.req?.startsWith('group/')) continue;
    const g = byGroup.get(r.req) || { n: 0, served: new Map(), last: null, fails: 0 };
    if (new Date(r.t) >= hourAgo) {
      g.n++;
      g.served.set(r.served, (g.served.get(r.served) || 0) + 1);
      if (r.status && r.status !== 200) g.fails++;
    }
    g.last = r;
    byGroup.set(r.req, g);
  }
  const refs = [...new Set([...groups.keys(), ...byGroup.keys()])].sort();
  if (!refs.length) out.push(dim(' no group requests yet'));
  for (const ref of refs) {
    const members = groups.get(ref)?.members || [];
    const first = modelOf(members[0]);
    const g = byGroup.get(ref);
    const last = g?.last;
    const onFirst = !last || !first || modelOf(last.served) === first;
    const now = last ? (onFirst ? green(modelOf(last.served)) : yellow(modelOf(last.served) + ' ⚠ fallback')) : dim('idle');
    out.push(` ${pad(ref.replace('group/', ''), 16)}→ ${now}`);
    const mix = g ? [...g.served].map(([m, n]) => `${modelOf(m)} ${n}`).join(', ') : '';
    out.push(dim(`   ${members.map(modelOf).join(' → ') || '?'}${g?.n ? `  ·  ${g.n} req: ${mix}` : ''}`) + (g?.fails ? red(`  ${g.fails} errors`) : ''));
  }
  out.push('');

  out.push(bold(' Latest requests'));
  for (const r of reqs.slice(-FEED).reverse()) {
    const asked = (r.req || r.model || '').replace('group/', '');
    const served = modelOf(r.served || r.model);
    const ok = !r.status || r.status === 200;
    const line = ` ${dim(hhmm(r.t))} ${pad(asked, 22)}→ ${pad(served, 20)}${ok ? '' : red(String(r.status) + ' ')}` +
      dim(`${kTok(r.in + (r.cache_read || 0) + (r.cache_write || 0))} in ${kTok(r.out)} out ${((r.ms || 0) / 1000).toFixed(1)}s`);
    out.push(line);
  }
  if (!reqs.length) out.push(dim(` no requests in ${USAGE}`));

  const width = process.stdout.columns;
  const text = out.map((l) => (width ? clip(l, width) : l) + '\x1b[K').join('\n');
  if (ONCE) { process.stdout.write(text + '\n'); return; }
  process.stdout.write('\x1b[H' + text + '\x1b[J');
}

if (ONCE) {
  let pending = 2;
  const done = () => { if (--pending === 0) render(); };
  refreshGroups(done);
  execFile(MAGPIE, ['accounts', '--json'], { timeout: 20000 }, (err, out) => {
    try { accounts = JSON.parse(out); } catch { accountsErr = err ? 'magpie accounts failed' : 'bad JSON'; }
    done();
  });
} else {
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  const restore = () => { process.stdout.write('\x1b[?25h\x1b[?1049l'); process.exit(0); };
  process.on('SIGINT', restore);
  process.on('SIGTERM', restore);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.on('data', (d) => { if (d[0] === 0x71 || d[0] === 0x03) restore(); });
  }
  process.stdout.on('resize', render);
  refreshAccounts();
  setInterval(refreshAccounts, 60000);
  render();
  setInterval(render, 2000);
}
