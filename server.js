/* DRAGON KINGDOM RAIDERS: game server. Serves index.html (or else the newest DRAGONKINGDOMRAIDERS_v*.html) next to it and runs the shared world. */
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000;

function newestGame() {
  if (fs.existsSync(path.join(__dirname, 'index.html'))) return 'index.html';
  const f = fs.readdirSync(__dirname).filter(n => /^DRAGONKINGDOMRAIDERS_v[\d.]+\.html$/.test(n));
  const key = n => n.match(/_v([\d.]+)\.html$/)[1].split('.').map(Number);
  f.sort((a, b) => { const x = key(a), y = key(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; });
  return f.length ? f[f.length - 1] : null;
}
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  const g = newestGame();
  if (!g) { res.writeHead(404); res.end('Put the DRAGONKINGDOMRAIDERS html file next to server.js'); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  fs.createReadStream(path.join(__dirname, g)).pipe(res);
});
const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });

/* ---------- the people ---------- */
let nextId = 1, nextTeam = 1, nextRun = 1;
const RUNS = new Map();              // trips to the MAP: { id, members, min, tin, ready:Set, bonus, started, endsAt, fired, timers }
const LOOT = new Map();              // pile number -> { left, t } (only piles that have been touched)
let HOST = 0;                        // the player who runs the animals and monsters for everyone on the MAP
const NTIN = 7, LOOT_BACK_MS = 10 * 60 * 1000, BLEED_MS = 60000;
const P = new Map();                 // id -> { id, ws, name, look, zone, x, y, z, yaw, mv, room, team, lastChat }
const TEAMS = new Map();             // id -> { id, members: [playerId, playerId] }
const INVITES = new Map();           // "from>to" -> time
const send = (p, m) => { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(m)); };
const all = m => { const s = JSON.stringify(m); for (const p of P.values()) if (p.ws.readyState === 1) p.ws.send(s); };
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

function rosterMsg() {
  return { t: 'roster', players: [...P.values()].map(p => ({ id: p.id, name: p.name, zone: p.zone, team: p.team || 0 })) };
}
const sendRoster = () => all(rosterMsg());
function teamMsg(teamId) {
  const t = TEAMS.get(teamId); return { t: 'team', team: t ? { id: t.id, members: t.members.map(id => { const q = P.get(id); return { id, name: q ? q.name : '?' }; }) } : null };
}
function pushTeam(teamId, members) { for (const id of members) { const q = P.get(id); if (q) send(q, teamMsg(q.team || 0)); } }
function leaveTeam(p) {
  const t = TEAMS.get(p.team); if (!t) { p.team = 0; return; }
  t.members = t.members.filter(i => i !== p.id); p.team = 0; send(p, { t: 'team', team: null });
  if (t.members.length < 2) { for (const id of t.members) { const q = P.get(id); if (q) { q.team = 0; send(q, { t: 'team', team: null }); send(q, { t: 'note', text: p.name + ' LEFT THE TEAM' }); } } TEAMS.delete(t.id); }
  else pushTeam(t.id, t.members);
}


/* ---------- trips to the MAP ---------- */
const onMap = () => [...P.values()].filter(q => q.joined && q.zone === 'map');
const toMap = (m, except) => { const s = JSON.stringify(m); for (const q of onMap()) if (q !== except && q.ws.readyState === 1) q.ws.send(s); };
function runLeft(run) { return run && run.started ? Math.max(0, (run.endsAt - Date.now()) / 1000) : -1; }
function beginRun(run) {
  if (run.started || !RUNS.has(run.id)) return; run.started = true; clearTimeout(run.timers.start);
  run.endsAt = Date.now() + (run.min * 60 + run.bonus) * 1000;
  for (const id of run.members) { const q = P.get(id); if (q) send(q, { t: 'go', left: runLeft(run) }); }
  run.timers.end = setTimeout(() => fireRun(run), run.endsAt - Date.now());
}
function fireRun(run) {
  if (!RUNS.has(run.id) || run.fired) return; run.fired = true;
  for (const id of run.members) { const q = P.get(id); if (q && q.zone === 'map') send(q, { t: 'dragon' }); }
}
function leaveRun(p) {
  const run = RUNS.get(p.run); p.run = 0; if (!run) return;
  run.members = run.members.filter(i => i !== p.id); run.ready.delete(p.id);
  if (!run.members.length) { clearTimeout(run.timers.start); clearTimeout(run.timers.end); RUNS.delete(run.id); }
  else if (!run.started && [...run.ready].length >= run.members.length) beginRun(run);
}
function recomputeHost() {
  const m = onMap().map(q => q.id).sort((a, b) => a - b), h = m.length ? m[0] : 0;
  if (h !== HOST) { HOST = h; toMap({ t: 'host', id: HOST }); }
}
function setDown(p, on) {
  if (on && !p.down) { p.down = true; clearTimeout(p.bleed); p.bleed = setTimeout(() => { if (p.down) { p.down = false; send(p, { t: 'dead' }); relayHp(p); } }, BLEED_MS); }
  else if (!on && p.down) { p.down = false; clearTimeout(p.bleed); }
}
function relayHp(p) { const t = TEAMS.get(p.team); if (!t) return; for (const id of t.members) { const q = P.get(id); if (q && q !== p) send(q, { t: 'hp', id: p.id, hp: p.hp, max: p.max, down: p.down }); } }

wss.on('connection', ws => {
  const p = { id: nextId++, ws, name: 'RAIDER', look: null, zone: 'under', x: 0, y: 0, z: 26, yaw: 0, mv: 0, room: 0, team: 0, lastChat: 0, joined: false, run: 0, hp: 3, max: 3, down: false, bleed: null };
  P.set(p.id, p);
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    switch (m.t) {
      case 'hello': {
        p.name = clean(m.name, 14).toUpperCase() || 'RAIDER'; p.look = m.look && typeof m.look === 'object' ? m.look : null; p.joined = true;
        send(p, { t: 'welcome', id: p.id });
        for (const q of P.values()) if (q.joined) send(p, { t: 'look', id: q.id, name: q.name, look: q.look });
        all({ t: 'look', id: p.id, name: p.name, look: p.look }); sendRoster(); break;
      }
      case 'pos': {
        if (!p.joined) return;
        p.x = num(m.x, p.x); p.y = num(m.y, p.y); p.z = num(m.z, p.z); p.yaw = num(m.yaw, p.yaw); p.mv = Math.max(0, Math.min(1.2, num(m.mv, 0)));
        const z = m.zone === 'map' ? 'map' : 'under'; if (z !== p.zone) { p.zone = z; sendRoster(); recomputeHost(); if (z === 'map') send(p, { t: 'host', id: HOST }); } break;
      }
      case 'chat': {
        if (!p.joined) return; const now = Date.now(); if (now - p.lastChat < 400) return; p.lastChat = now;
        const text = clean(m.text, 200); if (!text) return;
        const out = { t: 'chat', from: p.id, name: p.name, text, scope: m.scope === 'team' ? 'team' : 'all' };
        if (out.scope === 'team') { const t = TEAMS.get(p.team); if (!t) { send(p, { t: 'note', text: 'YOU ARE NOT IN A TEAM' }); return; } for (const id of t.members) { const q = P.get(id); if (q) send(q, out); } }
        else for (const q of P.values()) if (q.joined && q.zone === p.zone) send(q, out);
        break;
      }
      case 'invite': {
        const q = P.get(num(m.to, -1)); if (!q || q === p || !q.joined) return;
        if (p.team || q.team) { send(p, { t: 'note', text: p.team ? 'YOU ARE ALREADY IN A TEAM' : q.name + ' IS ALREADY IN A TEAM' }); return; }
        if (q.zone !== 'under' || p.zone !== 'under') { send(p, { t: 'note', text: 'INVITES WORK IN THE UNDERCITY' }); return; }
        INVITES.set(p.id + '>' + q.id, Date.now()); send(q, { t: 'invite', from: p.id, name: p.name }); send(p, { t: 'note', text: 'INVITE SENT TO ' + q.name }); break;
      }
      case 'reply': {
        const from = P.get(num(m.from, -1)); const k = (from ? from.id : 0) + '>' + p.id; const at = INVITES.get(k); INVITES.delete(k);
        if (!from || !at || Date.now() - at > 120000) { send(p, { t: 'note', text: 'THAT INVITE HAS EXPIRED' }); return; }
        if (!m.accept) { send(from, { t: 'note', text: p.name + ' DECLINED' }); return; }
        if (from.team || p.team) { send(p, { t: 'note', text: 'SOMEONE IS ALREADY IN A TEAM' }); return; }
        const t = { id: nextTeam++, members: [from.id, p.id] }; TEAMS.set(t.id, t); from.team = p.team = t.id; pushTeam(t.id, t.members); sendRoster(); break;
      }
      case 'goOut': {
        if (!p.joined || p.run) return; const t = TEAMS.get(p.team), ids = t ? t.members.slice() : [p.id];
        for (const id of ids) { const q = P.get(id); if (!q || q.zone !== 'under' || q.run) { send(p, { t: 'note', text: 'YOUR TEAMMATE MUST BE IN THE UNDERCITY TO GO OUT' }); return; } }
        const min = [5, 10, 15].includes(m.min) ? m.min : 10, run = { id: nextRun++, members: ids, min, tin: Math.floor(Math.random() * NTIN), ready: new Set(), bonus: 0, started: false, endsAt: 0, fired: false, timers: {} };
        RUNS.set(run.id, run); run.timers.start = setTimeout(() => beginRun(run), 90000);
        const depleted = []; for (const [i, e] of LOOT) if (e.left < 3) depleted.push([i, e.left]);
        ids.forEach((id, k) => { const q = P.get(id); q.run = run.id; send(q, { t: 'run', id: run.id, tin: run.tin, min, slot: k, by: p.name, depleted }); }); break;
      }
      case 'ready': {
        const run = RUNS.get(p.run); if (!run) return; run.ready.add(p.id); run.bonus = Math.max(run.bonus, Math.max(0, Math.min(600, num(m.bonus, 0))));
        if (run.members.every(i => run.ready.has(i))) beginRun(run); else send(p, { t: 'note', text: 'WAITING FOR YOUR TEAMMATE TO ARRIVE' }); break;
      }
      case 'back': { leaveRun(p); setDown(p, false); p.hp = p.max; p.zone = 'under'; sendRoster(); recomputeHost(); break; }
      case 'gather': {
        if (p.zone !== 'map' || p.down) return; const i = Math.floor(num(m.i, -1)); if (i < 0 || i > 4999) return; const e = LOOT.get(i) || { left: 3, t: 0 };
        if (e.left > 0) { e.left--; e.t = Date.now(); LOOT.set(i, e); toMap({ t: 'loot', i, left: e.left, by: p.id, ok: true }, p); send(p, { t: 'loot', i, left: e.left, by: p.id, ok: true }); }
        else send(p, { t: 'loot', i, left: 0, by: p.id, ok: false }); break;
      }
      case 'an': if (p.id === HOST && Array.isArray(m.a)) toMap({ t: 'an', a: m.a.slice(0, 80) }, p); break;
      case 'mon': if (p.id === HOST && Array.isArray(m.m)) toMap({ t: 'mon', m: m.m.slice(0, 120) }, p); break;
      case 'kill': if (p.id === HOST) toMap({ t: 'kill', id: m.id, kind: m.kind, by: Array.isArray(m.by) ? m.by.slice(0, 4) : [], x: m.x, z: m.z }, p); break;
      case 'hurt': { if (p.id !== HOST) return; const q = P.get(num(m.pid, -1)); if (q && q.zone === 'map' && !q.down) send(q, { t: 'hurt', dmg: Math.max(1, Math.min(4, num(m.dmg, 1))), from: m.kind }); break; }
      case 'shot': { if (p.zone !== 'map' || p.down) return; toMap({ t: 'shot', from: p.id, x: num(m.x, 0), y: num(m.y, 0), z: num(m.z, 0), dx: num(m.dx, 0), dz: num(m.dz, 1) }, p); break; }
      case 'hp': { p.hp = Math.max(0, Math.min(12, num(m.hp, p.hp))); p.max = Math.max(1, Math.min(12, num(m.max, p.max))); setDown(p, !!m.down); relayHp(p); break; }
      case 'revive': {
        const q = P.get(num(m.to, -1)); if (!q || !q.down || !p.run || q.run !== p.run || p.down) return; setDown(q, false); send(q, { t: 'revived' }); relayHp(q); break;
      }
      case 'rtc': { const q = P.get(num(m.to, -1)); if (q && q !== p && m.data && typeof m.data === 'object') send(q, { t: 'rtc', from: p.id, data: m.data }); break; }
      case 'leaveTeam': leaveTeam(p); sendRoster(); break;
    }
  });
  ws.on('close', () => { leaveRun(p); clearTimeout(p.bleed); leaveTeam(p); P.delete(p.id); recomputeHost(); for (const k of [...INVITES.keys()]) if (k.startsWith(p.id + '>') || k.endsWith('>' + p.id)) INVITES.delete(k); all({ t: 'gone', id: p.id }); sendRoster(); });
  ws.on('error', () => {});
});

/* ten times a second everyone is told where the people in their part of the world are */
setInterval(() => {
  const by = { under: [], map: [] };
  for (const p of P.values()) if (p.joined) by[p.zone].push([p.id, +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2), +p.yaw.toFixed(2), +p.mv.toFixed(2)]);
  for (const p of P.values()) if (p.joined) { const L = Math.round(runLeft(RUNS.get(p.run)) * 10) / 10; if (by[p.zone].length > 1 || L >= 0) send(p, { t: 'state', zone: p.zone, L, p: by[p.zone].filter(a => a[0] !== p.id) }); }
}, 100);
setInterval(() => { for (const p of P.values()) if (p.ws.readyState === 1) p.ws.ping(); }, 25000);
setInterval(() => {     // piles come back after a while, and everything resets when nobody is out there
  if (!onMap().length) { LOOT.clear(); return; }
  const now = Date.now(); for (const [i, e] of [...LOOT]) if (now - e.t > LOOT_BACK_MS) { LOOT.delete(i); toMap({ t: 'loot', i, left: 3, by: 0, ok: false }); }
}, 5000);   // keeps the connection awake

server.listen(PORT, () => console.log('Dragon Kingdom Raiders server on ' + PORT + ' serving ' + newestGame()));
