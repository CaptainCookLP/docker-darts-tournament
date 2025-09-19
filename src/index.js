// src/index.js with HTTPS/WSS + overlay
import express from "express";
import http from "http";
import https from "https";
import fs from "fs";
import { Server as IOServer } from "socket.io";
import cors from "cors";
import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { WebSocketServer } from "ws";

// --- Config ---
const PORT = Number(process.env.PORT || 8080);
const DB_PATH = process.env.DB_PATH || "/data/tournament.sqlite";
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "*").split(",").map(s=>s.trim());
const TLS_ENABLED = (process.env.TLS_ENABLED || "false").toLowerCase() === "true";
const TLS_KEY_FILE = process.env.TLS_KEY_FILE || "/certs/privkey.pem";
const TLS_CERT_FILE = process.env.TLS_CERT_FILE || "/certs/fullchain.pem";

// --- Single-Tournament-ID ---
const CURRENT_TID = "t_current";

// --- DB ---
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS settings(
  id INTEGER PRIMARY KEY CHECK (id=1),
  payload TEXT
);
CREATE TABLE IF NOT EXISTS tournaments(
  id TEXT PRIMARY KEY, name TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS players(
  id TEXT PRIMARY KEY, tournament_id TEXT, name TEXT, seed INTEGER
);
CREATE TABLE IF NOT EXISTS matches(
  id TEXT PRIMARY KEY, tournament_id TEXT,
  round_index INTEGER, position INTEGER,
  playerA_id TEXT, playerB_id TEXT, winner_id TEXT,
  board TEXT, status TEXT,
  x01_base INTEGER, x01_in TEXT, x01_out TEXT, bull TEXT,
  legs_per_set INTEGER, sets_to_win INTEGER,
  set_score_A INTEGER DEFAULT 0, set_score_B INTEGER DEFAULT 0,
  leg_score_A INTEGER DEFAULT 0, leg_score_B INTEGER DEFAULT 0,
  meta_json TEXT
);
CREATE TABLE IF NOT EXISTS events(
  id TEXT PRIMARY KEY, match_id TEXT, ts TEXT, type TEXT, payload TEXT, tournament_id TEXT
);
CREATE TABLE IF NOT EXISTS agents(
  id TEXT PRIMARY KEY, label TEXT, last_seen TEXT, status TEXT
);
`);

// --- Queries ---
const q = {
  getSettings: db.prepare(`SELECT payload FROM settings WHERE id=1`),
  upsertSettings: db.prepare(`INSERT INTO settings(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`),
  insertTournament: db.prepare(`INSERT INTO tournaments(id,name,created_at) VALUES(?,?,?)`),
  insertPlayer: db.prepare(`INSERT INTO players(id,tournament_id,name,seed) VALUES(?,?,?,?)`),
  insertMatch: db.prepare(`INSERT INTO matches(
    id,tournament_id,round_index,position,playerA_id,playerB_id,winner_id,board,status,
    x01_base,x01_in,x01_out,bull,legs_per_set,sets_to_win,meta_json
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  listPlayers: db.prepare(`SELECT * FROM players WHERE tournament_id=? ORDER BY seed ASC`),
  listMatches: db.prepare(`SELECT * FROM matches WHERE tournament_id=? ORDER BY round_index ASC, position ASC`),
  updateMatchStatus: db.prepare(`UPDATE matches SET status=? WHERE id=?`),
  setMatchBoard: db.prepare(`UPDATE matches SET board=? WHERE id=?`),
  setWinner: db.prepare(`UPDATE matches SET winner_id=? WHERE id=?`),
  setScores: db.prepare(`UPDATE matches SET set_score_A=?, set_score_B=?, leg_score_A=?, leg_score_B=? WHERE id=?`),
  getMatch: db.prepare(`SELECT * FROM matches WHERE id=?`),
  getPlayer: db.prepare(`SELECT * FROM players WHERE id=?`),
  listPending: db.prepare(`SELECT * FROM matches WHERE tournament_id=? AND status='pending' ORDER BY round_index ASC, position ASC`),
  insertEvent: db.prepare(`INSERT INTO events(id,match_id,ts,type,payload,tournament_id) VALUES(?,?,?,?,?,?)`),
  listEvents: db.prepare(`SELECT * FROM events WHERE tournament_id IS NULL OR tournament_id=? ORDER BY ts DESC LIMIT ?`)
};

// --- App ---
const app = express();
app.use(express.json());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || CORS_ORIGINS.includes("*") || CORS_ORIGINS.includes(origin)) cb(null, true);
    else cb(null, false);
  }
}));
app.use(express.static("public", { extensions: ["html"] }));

// --- HTTP/HTTPS server ---
let server;
if (TLS_ENABLED) {
  const key = fs.readFileSync(TLS_KEY_FILE);
  const cert = fs.readFileSync(TLS_CERT_FILE);
  server = https.createServer({ key, cert }, app);
  console.log("[TLS] HTTPS/WSS enabled");
} else {
  server = http.createServer(app);
  console.log("[TLS] HTTP/WS mode");
}

// --- Socket.IO ---
const io = new IOServer(server, { cors: { origin: CORS_ORIGINS.includes("*") ? true : CORS_ORIGINS } });
const dashNS = io.of("/dashboard");
const wslogNS = io.of("/wslog");

// --- Helpers ---
function makeId(prefix="id"){ return `${prefix}_${randomUUID()}`; }
function shuffle(arr){ for(let i=arr.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]]; } return arr; }
function nextRoundFrom(r){ return r>=4? null : r+1; }

function parseSeedFromLine(raw){
  const text = (raw ?? "").toString().trim();
  if (!text) return { name: "", seed: null };
  const lead = text.match(/^(\d{1,2})\s*(?:[.)-]\s*)?(.*)$/);
  if (lead && lead[2] && lead[2].trim()) {
    return { name: lead[2].trim(), seed: Number(lead[1]) };
  }
  const hash = text.match(/^(.*\S)\s+#\s*(\d{1,2})$/);
  if (hash) {
    return { name: hash[1].trim(), seed: Number(hash[2]) };
  }
  const paren = text.match(/^(.*\S)\s*\(\s*(\d{1,2})\s*\)$/);
  if (paren) {
    return { name: paren[1].trim(), seed: Number(paren[2]) };
  }
  return { name: text, seed: null };
}

function normalizePlayersPayload(body){
  const results = [];
  let order = 0;
  const add = (name, seed) => {
    const trimmed = (name || "").toString().trim();
    if (!trimmed) return;
    const s = Number.isFinite(seed) ? Math.min(Math.max(Math.round(seed), 1), 16) : null;
    results.push({ name: trimmed, seed: s, order: order++ });
  };

  const processTextBlock = (text) => {
    if (typeof text !== "string") return;
    text.split(/\r?\n/).forEach(line => {
      if (!line || !line.trim()) return;
      const parsed = parseSeedFromLine(line);
      add(parsed.name, parsed.seed);
    });
  };

  if (Array.isArray(body?.players)) {
    body.players.forEach((entry) => {
      if (typeof entry === "string") {
        const parsed = parseSeedFromLine(entry);
        add(parsed.name, parsed.seed);
        return;
      }
      if (entry && typeof entry === "object") {
        const name = entry.name ?? entry.label ?? "";
        const seedRaw = entry.seed ?? entry.position ?? entry.preferredSeed;
        const seedNum = seedRaw === undefined || seedRaw === null || seedRaw === "" ? null : Number(seedRaw);
        add(name, Number.isFinite(seedNum) ? seedNum : null);
      }
    });
  } else if (typeof body?.players === "string") {
    processTextBlock(body.players);
  }

  processTextBlock(body?.playersText);
  return results;
}

function allocatePlayerSlots(players, shuffleRequested){
  const slots = new Array(16).fill(null);
  const queue = [];
  const sorted = players
    .filter(p => p && p.name)
    .map(p => ({ name: p.name, seed: Number.isFinite(p.seed) ? p.seed : null, order: p.order ?? 0 }))
    .sort((a,b) => (a.order ?? 0) - (b.order ?? 0));

  for (const p of sorted) {
    const idx = p.seed ? Math.min(Math.max(p.seed, 1), 16) - 1 : null;
    if (idx !== null && slots[idx] === null) {
      slots[idx] = { name: p.name, submittedSeed: p.seed };
    } else {
      queue.push({ name: p.name, submittedSeed: p.seed });
    }
  }

  if (shuffleRequested) shuffle(queue);

  for (let i=0;i<16;i++) {
    if (!slots[i]) {
      const next = queue.shift() || null;
      slots[i] = next;
    }
  }

  return { slots, overflow: queue.length };
}

function asPositiveInt(value, fallback){
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.round(num);
}

function getDefaultSettings(){
  return {
    mode: "single-elim",
    defaults: {
      name: "Vereins-Cup",
      x01: { base: 501, in: "Straight", out: "Double", bull: "25/50" },
      formatsPerRound: {
        1:{legsPerSet:3,setsToWin:2},
        2:{legsPerSet:3,setsToWin:2},
        3:{legsPerSet:3,setsToWin:2},
        4:{legsPerSet:5,setsToWin:3},
        5:{legsPerSet:3,setsToWin:2}
      }
    }
  };
}
function loadSettings(){
  const row = q.getSettings.get();
  if (!row || !row.payload) return getDefaultSettings();
  try { return JSON.parse(row.payload); } catch { return getDefaultSettings(); }
}
function saveSettings(obj){ q.upsertSettings.run(JSON.stringify(obj)); }

function getTournamentDetail(tid){
  return { id: tid, players: q.listPlayers.all(tid), matches: q.listMatches.all(tid) };
}
function resolvePlayersNames(m){
  const A = m.playerA_id ? q.getPlayer.get(m.playerA_id)?.name : null;
  const B = m.playerB_id ? q.getPlayer.get(m.playerB_id)?.name : null;
  return [A,B];
}
function broadcastTournament(tid){ dashNS.emit("TOURNAMENT", getTournamentDetail(tid)); }
function broadcastAgents(){ 
  const list = Array.from(AGENTS.values()).map(a => ({ agentId:a.agentId, label:a.label, busy:a.busy })); 
  dashNS.emit("AGENTS", list);
  wslogNS.emit("AGENTS", list);
}
function logEvent(ev){ wslogNS.emit("LOG", ev); }

// Winner
function advanceWinner(tid, match){
  const next = nextRoundFrom(match.round_index);
  if (!next) return;
  const all = q.listMatches.all(tid);
  const targetPos = Math.ceil(match.position/2);
  const target = all.find(x => x.round_index===next && x.position===targetPos);
  if (!target) return;
  const col = (match.position % 2 === 1) ? "playerA_id" : "playerB_id";
  db.prepare(`UPDATE matches SET ${col}=? WHERE id=?`).run(match.winner_id, target.id);
}
// Bronze
function advanceLoserToBronze(tid, match){
  if (match.round_index !== 3) return;
  const all = q.listMatches.all(tid);
  const bronze = all.find(m => m.round_index===4 && m.position===2);
  if (!bronze) return;
  const current = q.getMatch.get(match.id);
  const winnerId = current.winner_id;
  const loserId = (match.playerA_id && match.playerA_id !== winnerId) ? match.playerA_id :
                  (match.playerB_id && match.playerB_id !== winnerId) ? match.playerB_id : null;
  if (!loserId) return;
  if (!bronze.playerA_id) db.prepare(`UPDATE matches SET playerA_id=? WHERE id=?`).run(loserId, bronze.id);
  else if (!bronze.playerB_id) db.prepare(`UPDATE matches SET playerB_id=? WHERE id=?`).run(loserId, bronze.id);
}

// --- Agents (Raw WS) ---
const AGENTS = new Map(); // agentId -> {agentId,label,busy,ws}
function upsertAgent(agentId, label, ws){
  const a = AGENTS.get(agentId) || { agentId, label: label || agentId, busy:false, ws:null };
  a.label = label || a.label; a.ws = ws || a.ws;
  AGENTS.set(agentId, a); broadcastAgents();
}
function markAgentBusy(agentId, busy){ const a=AGENTS.get(agentId); if(a){ a.busy=busy; broadcastAgents(); } }
function freeAgents(){ return Array.from(AGENTS.values()).filter(a => !a.busy && a.ws); }

// --- Scheduling ---
function schedule(tid){
  const pending = q.listPending.all(tid);
  const free = freeAgents();
  if (!pending.length || !free.length) return;
  for (const agent of free) {
    const m = pending.shift(); if (!m) break;
    q.updateMatchStatus.run("assigned", m.id);
    q.setMatchBoard.run(agent.agentId, m.id);
    const payload = {
      t:"ASSIGN_MATCH",
      matchId: m.id,
      players: resolvePlayersNames(m),
      x01: { base:m.x01_base, in:m.x01_in, out:m.x01_out, bull:m.bull },
      format: { legsPerSet:m.legs_per_set, setsToWin:m.sets_to_win }
    };
    try { agent.ws.send(JSON.stringify(payload)); } catch {}
    markAgentBusy(agent.agentId, true);
    broadcastTournament(tid);
    const ev = { ts:new Date().toISOString(), type:"ASSIGN_MATCH", payload, tournament_id: m.tournament_id };
    q.insertEvent.run(makeId("e"), m.id, ev.ts, ev.type, JSON.stringify(payload), m.tournament_id);
    logEvent(ev);
  }
}

// --- REST ---
app.get("/api/settings", (req,res) => res.json(loadSettings()));
app.post("/api/settings", (req,res) => { saveSettings(req.body || {}); res.json({ok:true}); });
app.get("/api/agents", (req,res) => res.json(Array.from(AGENTS.values()).map(a=>({agentId:a.agentId,label:a.label,busy:a.busy}))));
app.get("/api/events", (req,res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
  const tid = req.query.tournament_id || null;
  res.json(q.listEvents.all(tid, limit));
});

// Create/replace the single current tournament
app.post("/api/tournaments", (req,res) => {
  try {
    const payload = req.body || {};
    const normalizedPlayers = normalizePlayersPayload(payload);
    const doShuffle = !!(payload.shuffle === true || payload.shuffle === "true");
    const { slots, overflow } = allocatePlayerSlots(normalizedPlayers, doShuffle);
    const effectivePlayers = slots.filter(Boolean);
    if (effectivePlayers.length < 2) {
      return res.status(400).json({ error:"at least two players are required" });
    }
    if (overflow > 0) {
      console.warn(`[tournament] ignoring ${overflow} players beyond the first 16`);
    }

    const settings = loadSettings();
    const tid = CURRENT_TID; // <— feste ID
    const tournamentName = payload.name?.toString().trim() || settings.defaults?.name || "Tournament";
    const createdAt = new Date().toISOString();

    // DB: vorherige Daten des aktuellen Turniers löschen
    db.transaction(() => {
      db.prepare(`DELETE FROM events   WHERE tournament_id=?`).run(tid);
      db.prepare(`DELETE FROM matches  WHERE tournament_id=?`).run(tid);
      db.prepare(`DELETE FROM players  WHERE tournament_id=?`).run(tid);
      db.prepare(`DELETE FROM tournaments WHERE id=?`).run(tid);
    })();

    const base = asPositiveInt(payload.x01?.base, settings.defaults.x01.base);
    const xin  = payload.x01?.in   ?? settings.defaults.x01.in;
    const xout = payload.x01?.out  ?? settings.defaults.x01.out;
    const bull = payload.x01?.bull ?? settings.defaults.x01.bull;

    const defaultL = asPositiveInt(payload.format?.legsPerSet, settings.defaults.formatsPerRound[1].legsPerSet);
    const defaultS = asPositiveInt(payload.format?.setsToWin, settings.defaults.formatsPerRound[1].setsToWin);
    const frDefaults = settings.defaults.formatsPerRound || {};
    const fmt = (r) => {
      const fr = payload.formatsPerRound && payload.formatsPerRound[r];
      const d  = frDefaults[r] || { legsPerSet: defaultL, setsToWin: defaultS };
      return {
        legsPerSet: asPositiveInt(fr?.legsPerSet, d.legsPerSet),
        setsToWin: asPositiveInt(fr?.setsToWin, d.setsToWin)
      };
    };

    const createTournamentTx = db.transaction(() => {
      q.insertTournament.run(tid, tournamentName, createdAt);
      const ids = [];
      slots.forEach((entry, i) => {
        const id = entry ? makeId("p") : null;
        if (entry) q.insertPlayer.run(id, tid, entry.name, i+1);
        ids.push(id);
      });

      const pairs = [[0,15],[7,8],[4,11],[3,12],[2,13],[5,10],[6,9],[1,14]].map(([a,b]) => [ids[a], ids[b]]);
      const f1 = fmt(1);
      pairs.forEach((pair,i)=> q.insertMatch.run(makeId("m"), tid, 1, i+1, pair[0], pair[1], null, null, "pending",
        base,xin,xout,bull,f1.legsPerSet,f1.setsToWin, JSON.stringify({})));
      const f2 = fmt(2);
      for (let i=1;i<=4;i++) q.insertMatch.run(makeId("m"), tid, 2, i, null,null,null,null,"pending",
        base,xin,xout,bull,f2.legsPerSet,f2.setsToWin, JSON.stringify({}));
      const f3 = fmt(3);
      for (let i=1;i<=2;i++) q.insertMatch.run(makeId("m"), tid, 3, i, null,null,null,null,"pending",
        base,xin,xout,bull,f3.legsPerSet,f3.setsToWin, JSON.stringify({}));
      const f4 = fmt(4);
      q.insertMatch.run(makeId("m"), tid, 4, 1, null,null,null,null,"pending",
        base,xin,xout,bull,f4.legsPerSet,f4.setsToWin, JSON.stringify({}));
      const fBronze = fmt(5) || f4;
      q.insertMatch.run(makeId("m"), tid, 4, 2, null,null,null,null,"pending",
        base,xin,xout,bull,fBronze.legsPerSet,fBronze.setsToWin, JSON.stringify({ bronze:true }));

      return ids;
    });

    createTournamentTx();

    // Neu: sofort Broadcasten, damit Bracket ohne Reload rendert
    broadcastTournament(tid);

    res.json(getTournamentDetail(tid));
  } catch (e) { console.error(e); res.status(500).json({error:e.message}); }
});

// Start Scheduling for current tournament
app.post("/api/tournaments/current/start", (req,res)=>{ schedule(CURRENT_TID); res.json({ok:true}); });

// Convenience: read current tournament
app.get("/api/tournaments/current", (req,res)=> res.json(getTournamentDetail(CURRENT_TID)));

// Legacy endpoints (weiter nutzbar)
app.post("/api/tournaments/:id/start", (req,res)=>{ schedule(req.params.id); res.json({ok:true}); });
app.get("/api/tournaments/:id", (req,res)=> res.json(getTournamentDetail(req.params.id)));

app.post("/api/advance/:id", (req,res)=>{
  const tid=req.params.id;
  const pending=q.listPending.all(tid);
  if(!pending.length) return res.json({info:"no pending"});
  const m=pending[0];
  q.updateMatchStatus.run("done", m.id);
  q.setWinner.run(m.playerA_id || m.playerB_id, m.id);
  advanceWinner(tid, q.getMatch.get(m.id));
  if (m.round_index===3) advanceLoserToBronze(tid, q.getMatch.get(m.id));
  broadcastTournament(tid);
  res.json({advanced:m.id});
});

// --- Raw WS endpoint (/agents-raw) ---
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (!req.url || !req.url.startsWith("/agents-raw")) return;
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
wss.on("connection", (ws) => {
  ws.on("message", (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.t === "AGENT_READY") {
      const id = msg.agentId || makeId("agent");
      ws._agentId = id;
      upsertAgent(id, msg.label || id, ws);
      const ev = { ts:new Date().toISOString(), type:"AGENT_READY", payload:{agentId:id,label:msg.label||id} };
      logEvent(ev);
      return;
    }
    if (msg.t === "LOBBY_OPENED") {
      const m = q.getMatch.get(msg.matchId);
      if (m) {
        q.updateMatchStatus.run("running", msg.matchId);
        broadcastTournament(m.tournament_id);
        const ev = { ts:new Date().toISOString(), type:"LOBBY_OPENED", payload:{matchId:msg.matchId,agentId:ws._agentId}, tournament_id:m.tournament_id };
        q.insertEvent.run(makeId("e"), msg.matchId, ev.ts, ev.type, JSON.stringify(ev.payload), m.tournament_id);
        logEvent(ev);
      }
      return;
    }
    if (msg.t === "SCORE_UPDATE") {
      const m = q.getMatch.get(msg.matchId);
      if (!m) return;
      const [sa,sb] = (msg.setScore || "0-0").split("-").map(n=>parseInt(n||"0",10));
      const [la,lb] = (msg.legScore || "0-0").split("-").map(n=>parseInt(n||"0",10));
      q.setScores.run(sa,sb,la,lb,msg.matchId);
      const ev = { ts:new Date().toISOString(), type:"SCORE_UPDATE", payload:{matchId:msg.matchId, scores:msg.scores, legScore:msg.legScore, setScore:msg.setScore}, tournament_id:m.tournament_id };
      q.insertEvent.run(makeId("e"), msg.matchId, ev.ts, ev.type, JSON.stringify(ev.payload), m.tournament_id);
      broadcastTournament(m.tournament_id);
      wslogNS.emit("SCORE", ev);
      return;
    }
    if (msg.t === "MATCH_END") {
      const m = q.getMatch.get(msg.matchId);
      if (!m) return;
      const A = m.playerA_id && q.getPlayer.get(m.playerA_id)?.name;
      const B = m.playerB_id && q.getPlayer.get(m.playerB_id)?.name;
      const winnerId = (msg.winner===A)? m.playerA_id : (msg.winner===B)? m.playerB_id : null;
      q.updateMatchStatus.run("done", msg.matchId);
      if (winnerId) q.setWinner.run(winnerId, msg.matchId);
      advanceWinner(m.tournament_id, q.getMatch.get(msg.matchId));
      if (m.round_index === 3) advanceLoserToBronze(m.tournament_id, q.getMatch.get(msg.matchId));
      markAgentBusy(ws._agentId, false);
      const ev = { ts:new Date().toISOString(), type:"MATCH_END", payload:{matchId:msg.matchId,winner:msg.winner,agentId:ws._agentId}, tournament_id:m.tournament_id };
      q.insertEvent.run(makeId("e"), msg.matchId, ev.ts, ev.type, JSON.stringify(ev.payload), m.tournament_id);
      broadcastTournament(m.tournament_id);
      schedule(m.tournament_id);
      logEvent(ev);
      return;
    }
    if (msg.t === "PONG") { return; }
  });
  const iv = setInterval(()=>{ try{ ws.send(JSON.stringify({t:"PING"})); }catch{} }, 15000);
  ws.on("close", () => {
    clearInterval(iv);
    const id = ws._agentId;
    if (id && AGENTS.has(id)) AGENTS.delete(id);
    broadcastAgents();
  });
});

// --- WSLOG namespace ---
wslogNS.on("connection", (socket)=>{
  socket.emit("HELLO", { ok:true, ts: Date.now() });
});

// --- Dashboard NS ---
dashNS.on("connection", (socket) => {
  broadcastAgents();
  // Neu: aktuellen Turnierstand sofort beim Connect senden
  socket.emit("TOURNAMENT", getTournamentDetail(CURRENT_TID));
});

// --- Start ---
server.listen(PORT, () => {
  console.log(`Tournament server listening on ${TLS_ENABLED ? "https" : "http"}://0.0.0.0:${PORT}`);
});
