import http from "node:http";
import os from "node:os";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { WebSocketServer, WebSocket } from "ws";

/**
 * pi-plus agent board server.
 *
 * Single file, one dependency (`ws`), SQLite via node's built-in driver.
 * Designed to sit idle at a few MB: every statement is prepared once, the
 * per-agent activity log is a fixed ring, and housekeeping is set-based SQL
 * rather than per-row loops.
 */

const PORT = Number(process.env.AGENT_BOARD_PORT ?? 8787);
const TOKEN = process.env.AGENT_BOARD_TOKEN;
const DB_PATH = resolve(process.env.AGENT_BOARD_DB ?? "./data/board.sqlite");
const MAX_MESSAGE = Number(process.env.AGENT_BOARD_MAX_MESSAGE ?? 8_000);
/** Auto repo rooms and ad-hoc groups keep a rolling window of traffic. */
const GROUP_TTL_MS = Number(process.env.AGENT_BOARD_GROUP_TTL_MS ?? 5 * 24 * 60 * 60 * 1_000);
/** A direct thread is discarded once every participant has been gone this long. */
const DIRECT_GRACE_MS = Number(process.env.AGENT_BOARD_DIRECT_GRACE_MS ?? 120_000);
const PURGE_INTERVAL_MS = Number(process.env.AGENT_BOARD_PURGE_INTERVAL_MS ?? 60_000);
const ACTIVITY_RING = 48;

if (!TOKEN) throw new Error("AGENT_BOARD_TOKEN is required");

// Keep the message store readable only by the account that owns it.
process.umask(0o077);

/** The tailnet range (100.64.0.0/10) is the only remote interface the board may bind. */
function tailnetAddresses() {
  const found = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const [a, b] = entry.address.split(".").map(Number);
      if (a === 100 && b >= 64 && b <= 127) found.push(entry.address);
    }
  }
  return found;
}

const HOSTS = process.env.AGENT_BOARD_HOST ? [process.env.AGENT_BOARD_HOST] : ["127.0.0.1", ...tailnetAddresses()];

/* ---------------------------------- store --------------------------------- */

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA foreign_keys=ON;
  PRAGMA busy_timeout=5000;
  PRAGMA synchronous=NORMAL;
  -- Negative is KiB: cap the page cache instead of letting it grow unbounded.
  PRAGMA cache_size=-2000;
  CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('direct','group')),
    title TEXT,
    participant_key TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    auto INTEGER NOT NULL DEFAULT 0,
    repo_key TEXT
  );
  CREATE TABLE IF NOT EXISTS thread_participants (
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    PRIMARY KEY(thread_id, agent_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    sender_type TEXT NOT NULL CHECK(sender_type IN ('user','agent')),
    sender_id TEXT NOT NULL,
    sender_alias TEXT,
    text TEXT NOT NULL,
    priority TEXT NOT NULL CHECK(priority IN ('normal','urgent')),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_thread_time ON messages(thread_id, created_at);
  CREATE TABLE IF NOT EXISTS coordinators (
    agent_key TEXT PRIMARY KEY,
    coordinator_key TEXT NOT NULL,
    set_by TEXT,
    set_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS coordinators_coordinator ON coordinators(coordinator_key);
  CREATE TABLE IF NOT EXISTS agent_seen (
    agent_id TEXT PRIMARY KEY,
    agent_key TEXT,
    alias TEXT,
    last_seen INTEGER NOT NULL
  );
`);

// Older databases predate these columns; adding them is a no-op once present.
for (const statement of [
  "ALTER TABLE threads ADD COLUMN auto INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE threads ADD COLUMN repo_key TEXT",
  "ALTER TABLE messages ADD COLUMN sender_alias TEXT",
]) {
  try {
    db.exec(statement);
  } catch { /* column already exists */ }
}

/**
 * Prepared-statement cache. The previous implementation compiled SQL on every
 * call: 36 separate `prepare()` sites, several inside per-row loops.
 */
const statements = new Map();
const q = (sql) => {
  let statement = statements.get(sql);
  if (!statement) statements.set(sql, (statement = db.prepare(sql)));
  return statement;
};

/* --------------------------------- agents --------------------------------- */

/** @type {Map<string, {ws: WebSocket, agent: any, activity: any[], cursor: number, adminThreads: Set<string>}>} */
const active = new Map();

const agentKey = (agent) => agent?.key || agent?.alias || agent?.sessionId || "";
const liveEntry = (id) => (id ? active.get(id) : undefined);
const liveEntries = () => [...active.values()];
const liveByKey = (key) => liveEntries().find((entry) => agentKey(entry.agent) === key);

/** Fixed ring: writes never reallocate and memory per agent is bounded. */
function recordActivity(entry, event) {
  entry.activity[entry.cursor % ACTIVITY_RING] = event;
  entry.cursor += 1;
}

function readActivity(entry, limit) {
  const size = Math.min(entry.cursor, ACTIVITY_RING);
  const take = Math.max(1, Math.min(limit, size));
  const out = [];
  for (let i = size - take; i < size; i += 1) {
    out.push(entry.activity[(entry.cursor - size + i) % ACTIVITY_RING]);
  }
  return out.filter(Boolean);
}

function publicAgent(entry) {
  const seen = q("SELECT last_seen AS lastSeen FROM agent_seen WHERE agent_id=?").get(entry.agent.sessionId);
  return { ...entry.agent, lastSeenAt: seen?.lastSeen ?? Date.now(), ...coordination(entry.agent) };
}

function resolveAgent(needle) {
  const text = String(needle ?? "").trim().toLowerCase();
  if (!text) return undefined;
  const entries = liveEntries();
  const exact = entries.filter((e) => e.agent.sessionId === text || e.agent.alias?.toLowerCase() === text);
  if (exact.length === 1) return exact[0];
  const loose = entries.filter((e) =>
    e.agent.sessionId.startsWith(text) || e.agent.alias?.toLowerCase().includes(text) || e.agent.cwd?.toLowerCase().includes(text));
  return loose.length === 1 ? loose[0] : undefined;
}

function resolveKey(needle) {
  const match = resolveAgent(needle);
  if (match) return agentKey(match.agent);
  const text = String(needle ?? "").trim();
  if (!text) return undefined;
  const row = q("SELECT agent_key AS key FROM agent_seen WHERE agent_key=? OR alias=? ORDER BY last_seen DESC LIMIT 1").get(text, text);
  return row?.key;
}

function markSeen(agent) {
  q(`INSERT INTO agent_seen(agent_id,agent_key,alias,last_seen) VALUES(?,?,?,?)
     ON CONFLICT(agent_id) DO UPDATE SET agent_key=excluded.agent_key, alias=excluded.alias, last_seen=excluded.last_seen`)
    .run(agent.sessionId, agentKey(agent), agent.alias ?? null, Date.now());
}

/* ------------------------------ coordination ------------------------------ */

const coordinatorOf = (key) =>
  q("SELECT coordinator_key AS coordinatorKey, set_by AS setBy, set_at AS setAt FROM coordinators WHERE agent_key=?").get(key);

const reportsOf = (key) =>
  q("SELECT agent_key AS agentKey FROM coordinators WHERE coordinator_key=? ORDER BY agent_key").all(key).map((r) => r.agentKey);

function coordination(agent) {
  const key = agentKey(agent);
  return { key, coordinator: coordinatorOf(key)?.coordinatorKey ?? null, reports: reportsOf(key) };
}

function wouldCycle(agent, coordinator) {
  const seen = new Set([agent]);
  let cursor = coordinator;
  while (cursor) {
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    cursor = coordinatorOf(cursor)?.coordinatorKey;
  }
  return false;
}

/* --------------------------------- threads -------------------------------- */

const threadRow = (id) =>
  id ? q("SELECT id, kind, title, auto, repo_key AS repoKey, created_at AS createdAt FROM threads WHERE id=?").get(id) : undefined;

const participants = (threadId) =>
  q("SELECT agent_id AS agentId FROM thread_participants WHERE thread_id=? ORDER BY agent_id").all(threadId).map((r) => r.agentId);

function offlineAgent(id) {
  const seen = q("SELECT alias, last_seen AS lastSeen FROM agent_seen WHERE agent_id=?").get(id);
  return { agent: { sessionId: id, alias: seen?.alias ?? undefined, state: "stopped", lastSeenAt: seen?.lastSeen }, offline: true };
}

function materializeThread(row) {
  if (!row) return undefined;
  const ids = participants(row.id);
  const last = q(`SELECT text, sender_type AS senderType, sender_id AS senderId, sender_alias AS senderAlias, created_at AS createdAt
                  FROM messages WHERE thread_id=? ORDER BY created_at DESC LIMIT 1`).get(row.id);
  return {
    id: row.id,
    kind: row.kind,
    title: row.title ?? undefined,
    auto: !!row.auto,
    repoKey: row.repoKey ?? undefined,
    participantIds: ids,
    participants: ids.map((id) => liveEntry(id) ? publicAgent(liveEntry(id)) : offlineAgent(id).agent),
    lastMessage: last ?? null,
  };
}

function listThreads(actor, selfId) {
  const rows = actor === "user"
    ? q("SELECT id, kind, title, auto, repo_key AS repoKey, created_at AS createdAt FROM threads ORDER BY auto DESC, created_at DESC").all()
    : q(`SELECT t.id, t.kind, t.title, t.auto, t.repo_key AS repoKey, t.created_at AS createdAt
         FROM threads t JOIN thread_participants p ON p.thread_id=t.id
         WHERE p.agent_id=? ORDER BY t.auto DESC, t.created_at DESC`).all(selfId);
  return rows.map(materializeThread);
}

function getOrCreateThread(agentIds, title) {
  const ids = [...new Set(agentIds)].sort();
  const key = ids.join("|");
  const existing = q("SELECT id, kind, title, auto, repo_key AS repoKey, created_at AS createdAt FROM threads WHERE participant_key=?").get(key);
  if (existing) return materializeThread(existing);

  const id = randomUUID();
  const kind = ids.length <= 2 ? "direct" : "group";
  q("INSERT INTO threads(id,kind,title,participant_key,created_at,auto) VALUES(?,?,?,?,?,0)")
    .run(id, kind, title ?? null, key, Date.now());
  const insert = q("INSERT OR IGNORE INTO thread_participants(thread_id,agent_id) VALUES(?,?)");
  for (const agentId of ids) insert.run(id, agentId);
  return materializeThread(threadRow(id));
}

const repoKeyOf = (agent) => agent?.repo || undefined;

function repoTitle(repoKey) {
  const tail = String(repoKey).split(/[\\/]/).filter(Boolean).pop() ?? repoKey;
  return `${tail} (repo)`;
}

/** Everyone who works in a repo shares one auto-created room. */
function ensureRepoThread(agent) {
  const repoKey = repoKeyOf(agent);
  if (!repoKey) return undefined;
  let row = q("SELECT id, kind, title, auto, repo_key AS repoKey, created_at AS createdAt FROM threads WHERE repo_key=? AND auto=1").get(repoKey);
  if (!row) {
    const id = randomUUID();
    q("INSERT INTO threads(id,kind,title,participant_key,created_at,auto,repo_key) VALUES(?,?,?,?,?,1,?)")
      .run(id, "group", repoTitle(repoKey), `repo:${repoKey}`, Date.now(), repoKey);
    row = threadRow(id);
  }
  q("INSERT OR IGNORE INTO thread_participants(thread_id,agent_id) VALUES(?,?)").run(row.id, agent.sessionId);
  return row.id;
}


/**
 * Housekeeping. Every step is a single set-based statement; the previous
 * version ran a query per thread inside two loops.
 */
function purge() {
  const now = Date.now();
  const group = now - GROUP_TTL_MS;
  const direct = now - DIRECT_GRACE_MS;

  q("DELETE FROM messages WHERE created_at < ? AND thread_id IN (SELECT id FROM threads WHERE auto=1 OR kind='group')").run(group);

  // Empty auto rooms whose members have all gone.
  q(`DELETE FROM threads WHERE auto=1 AND created_at < ?1
     AND NOT EXISTS (SELECT 1 FROM messages WHERE thread_id=threads.id)
     AND NOT EXISTS (SELECT 1 FROM thread_participants p JOIN agent_seen s ON s.agent_id=p.agent_id
                     WHERE p.thread_id=threads.id AND s.last_seen > ?1)`).run(direct);

  // Idle explicit threads. "Idle" is the newest of: last message, creation,
  // and the last time any participant was seen. Direct threads expire quickly.
  q(`DELETE FROM threads WHERE auto=0 AND MAX(
       created_at,
       COALESCE((SELECT MAX(created_at) FROM messages WHERE thread_id=threads.id), 0),
       COALESCE((SELECT MAX(s.last_seen) FROM thread_participants p JOIN agent_seen s ON s.agent_id=p.agent_id
                 WHERE p.thread_id=threads.id), 0)
     ) < (CASE kind WHEN 'direct' THEN ? ELSE ? END)`).run(direct, group);

  q("DELETE FROM agent_seen WHERE last_seen < ?").run(now - GROUP_TTL_MS * 2);
}

const messages = (threadId, limit = 80) =>
  q(`SELECT id, thread_id AS threadId, sender_type AS senderType, sender_id AS senderId,
            sender_alias AS senderAlias, text, priority, created_at AS createdAt
     FROM messages WHERE thread_id=? ORDER BY created_at DESC LIMIT ?`)
    .all(threadId, Math.max(1, Math.min(Number(limit) || 80, 200)))
    .reverse();

/* -------------------------------- transport ------------------------------- */

function push(entry, value) {
  if (entry?.ws?.readyState === WebSocket.OPEN) entry.ws.send(JSON.stringify(value));
}

function pushCoordination(key) {
  const target = liveByKey(key);
  if (target) push(target, { t: "coordination", ...coordination(target.agent) });
}

function secretMatches(candidate) {
  const a = Buffer.from(String(candidate ?? ""));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* -------------------------------- requests -------------------------------- */

function handleRequest(selfId, request) {
  const self = liveEntry(selfId);
  if (!self) throw new Error("Agent is no longer registered");
  const actor = request.actor === "user" ? "user" : "agent";

  switch (request.action) {
    case "agents":
      return liveEntries().filter((e) => e.agent.sessionId !== selfId).map(publicAgent);

    case "inspect": {
      const target = resolveAgent(request.agent);
      if (!target) throw new Error(`No unique running agent matched '${request.agent ?? ""}'`);
      return { agent: publicAgent(target), activity: readActivity(target, Number(request.limit) || 15) };
    }

    case "threads":
      return listThreads(actor, selfId);

    case "messages": {
      const thread = threadRow(request.thread);
      if (!thread) throw new Error("Unknown thread");
      if (actor !== "user" && !participants(thread.id).includes(selfId)) throw new Error("Not a thread participant");
      return { thread: materializeThread(thread), messages: messages(thread.id, request.limit) };
    }

    case "subscribe": {
      if (actor !== "user") throw new Error("Admin subscription required");
      if (request.thread && !threadRow(request.thread)) throw new Error("Unknown thread");
      if (request.previous) self.adminThreads.delete(String(request.previous));
      if (request.thread) self.adminThreads.add(String(request.thread));
      return { subscribed: request.thread ?? null };
    }

    case "coordinators": {
      const rows = q("SELECT agent_key AS agent, coordinator_key AS coordinator, set_by AS setBy, set_at AS setAt FROM coordinators ORDER BY coordinator_key, agent_key").all();
      const online = new Set(liveEntries().map((e) => agentKey(e.agent)));
      return {
        self: coordination(self.agent),
        links: rows.map((row) => ({ ...row, agentOnline: online.has(row.agent), coordinatorOnline: online.has(row.coordinator) })),
      };
    }

    case "set_coordinator": {
      const requested = Array.isArray(request.recipients) ? request.recipients.filter(Boolean) : [];
      const targets = requested.length ? requested : (actor === "agent" ? [agentKey(self.agent)] : []);
      if (!targets.length) throw new Error("set_coordinator requires 'recipients' when acting as the admin user");

      const raw = String(request.agent ?? "").trim().toLowerCase();
      const clear = !raw || ["none", "clear", "off", "null"].includes(raw);
      const coordinatorKey = clear ? undefined : resolveKey(request.agent);
      if (!clear && !coordinatorKey) throw new Error("set_coordinator requires 'agent', the coordinator alias or session id");

      const applied = [];
      const touched = new Set();
      for (const needle of targets) {
        const key = resolveKey(needle);
        if (!key) continue;
        if (clear) {
          const previous = coordinatorOf(key)?.coordinatorKey;
          q("DELETE FROM coordinators WHERE agent_key=?").run(key);
          applied.push({ agent: key, coordinator: null });
          touched.add(key);
          if (previous) touched.add(previous);
          continue;
        }
        if (key === coordinatorKey) throw new Error(`'${key}' cannot be its own coordinator`);
        if (wouldCycle(key, coordinatorKey)) {
          throw new Error(`Setting '${coordinatorKey}' as coordinator of '${key}' would create a reporting cycle`);
        }
        q(`INSERT INTO coordinators(agent_key,coordinator_key,set_by,set_at) VALUES(?,?,?,?)
           ON CONFLICT(agent_key) DO UPDATE SET coordinator_key=excluded.coordinator_key, set_by=excluded.set_by, set_at=excluded.set_at`)
          .run(key, coordinatorKey, actor === "user" ? "admin" : agentKey(self.agent), Date.now());
        applied.push({ agent: key, coordinator: coordinatorKey });
        touched.add(key);
        touched.add(coordinatorKey);
      }
      for (const key of touched) pushCoordination(key);
      return { applied, self: coordination(self.agent) };
    }

    case "report": {
      if (actor !== "agent") throw new Error("report is only available to agents");
      const key = agentKey(self.agent);
      const link = coordinatorOf(key);
      if (!link) throw new Error("No coordinator is set for you. Use action 'set_coordinator' with the coordinator's alias first.");
      const target = liveByKey(link.coordinatorKey);
      if (!target) throw new Error(`Coordinator '${link.coordinatorKey}' is not currently running, so the report was not delivered.`);
      const body = String(request.message ?? "").trim();
      if (!body) throw new Error("report requires a non-empty message");
      return handleRequest(selfId, {
        ...request,
        action: "send",
        actor: "agent",
        thread: undefined,
        recipients: [target.agent.sessionId],
        title: `${key} → ${link.coordinatorKey}`,
        message: `[report from ${key}]\n${body}`,
      });
    }

    case "send": {
      const text = String(request.message ?? "").trim().slice(0, MAX_MESSAGE);
      if (!text) throw new Error("send requires a non-empty message");

      let thread;
      const notRunning = [];
      if (request.thread) {
        const row = threadRow(request.thread);
        if (!row) throw new Error("Unknown thread");
        thread = materializeThread(row);
        if (actor !== "user" && !thread.participantIds.includes(selfId)) throw new Error("Not a thread participant");
      } else {
        const resolved = [];
        for (const needle of Array.isArray(request.recipients) ? request.recipients : []) {
          const match = resolveAgent(needle);
          if (match) resolved.push(match.agent.sessionId);
          else notRunning.push(String(needle));
        }
        if (resolved.length === 0) {
          throw new Error(`No requested recipients are currently running${notRunning.length ? `: ${notRunning.join(", ")}` : ""}`);
        }
        thread = getOrCreateThread(actor === "agent" ? [selfId, ...resolved] : resolved, request.title);
      }

      const message = {
        id: randomUUID(),
        threadId: thread.id,
        senderType: actor,
        senderId: actor === "user" ? "admin" : selfId,
        senderAlias: actor === "user" ? "you" : (self.agent.alias || selfId.slice(0, 8)),
        text,
        priority: request.priority === "urgent" ? "urgent" : "normal",
        createdAt: Date.now(),
      };
      q("INSERT INTO messages(id,thread_id,sender_type,sender_id,sender_alias,text,priority,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(message.id, message.threadId, message.senderType, message.senderId, message.senderAlias, message.text, message.priority, message.createdAt);

      // Re-materialize once; the previous version rebuilt this three times.
      const fresh = materializeThread(threadRow(thread.id));
      const delivered = [];
      const pushed = new Set();
      for (const participantId of fresh.participantIds) {
        if (actor === "agent" && participantId === selfId) continue;
        const recipient = liveEntry(participantId);
        if (!recipient) {
          // Auto rooms list everyone who ever worked in the repo; only report absent explicit recipients.
          if (!fresh.auto) notRunning.push(active.get(participantId)?.agent.alias || offlineAgent(participantId).agent.alias);
          continue;
        }
        push(recipient, { t: "message", thread: fresh, message });
        pushed.add(recipient.agent.sessionId);
        delivered.push(recipient.agent.alias || participantId.slice(0, 8));
      }
      for (const viewer of active.values()) {
        if (viewer === self || pushed.has(viewer.agent.sessionId) || !viewer.adminThreads.has(fresh.id)) continue;
        push(viewer, { t: "message", adminView: true, thread: fresh, message });
      }
      return { thread: fresh, message, delivered, notRunning: [...new Set(notRunning)] };
    }

    default:
      throw new Error(`Unknown action '${request.action}'`);
  }
}

/* ---------------------------------- http ---------------------------------- */

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const isAuthorized = (req) => {
  const header = req.headers.authorization ?? "";
  return secretMatches(header.startsWith("Bearer ") ? header.slice(7) : header);
};

function handleHttp(req, res) {
  if (req.url === "/health") return json(res, 200, { ok: true, activeAgents: active.size });
  if (!isAuthorized(req)) return json(res, 401, { error: "unauthorized" });
  if (req.url === "/stats") {
    return json(res, 200, {
      activeAgents: active.size,
      threads: q("SELECT COUNT(*) AS n FROM threads").get().n,
      messages: q("SELECT COUNT(*) AS n FROM messages").get().n,
      statements: statements.size,
      rss: process.memoryUsage().rss,
    });
  }
  if (req.url === "/clear" && req.method === "POST") {
    // Wipe conversational state. Coordinator links and presence are kept so a
    // clear does not silently dismantle a reporting structure.
    const before = q("SELECT COUNT(*) AS n FROM messages").get().n;
    db.exec("DELETE FROM messages; DELETE FROM thread_participants; DELETE FROM threads;");
    db.exec("VACUUM");
    for (const entry of active.values()) {
      entry.adminThreads.clear();
      // Re-create the repo room so live agents stay reachable immediately.
      ensureRepoThread(entry.agent);
    }
    return json(res, 200, { cleared: before });
  }
  if (req.url === "/clear-all" && req.method === "POST") {
    const before = q("SELECT COUNT(*) AS n FROM messages").get().n;
    db.exec("DELETE FROM messages; DELETE FROM thread_participants; DELETE FROM threads; DELETE FROM coordinators; DELETE FROM agent_seen;");
    db.exec("VACUUM");
    for (const entry of active.values()) {
      entry.adminThreads.clear();
      markSeen(entry.agent);
      ensureRepoThread(entry.agent);
      push(entry, { t: "coordination", ...coordination(entry.agent) });
    }
    return json(res, 200, { cleared: before, coordinators: true });
  }
  return json(res, 404, { error: "not found" });
}

function onConnection(ws) {
  let sessionId;

  ws.on("message", (raw) => {
    let value;
    try {
      value = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (value.t === "register") {
      if (!secretMatches(value.token)) {
        push({ ws }, { t: "error", error: "unauthorized" });
        ws.close(4401, "unauthorized");
        return;
      }
      const agent = value.agent ?? {};
      sessionId = agent.sessionId;
      if (!sessionId) {
        ws.close(4400, "sessionId required");
        return;
      }
      active.set(sessionId, { ws, agent, activity: Array.from({ length: ACTIVITY_RING }), cursor: 0, adminThreads: new Set() });
      markSeen(agent);
      const repoThread = ensureRepoThread(agent);
      push(active.get(sessionId), { t: "registered", ...coordination(agent), repoThread });
      return;
    }

    const entry = liveEntry(sessionId);
    if (!entry) return;

    if (value.t === "presence") {
      entry.agent = { ...entry.agent, ...value.agent };
      markSeen(entry.agent);
      if (value.agent?.repo) ensureRepoThread(entry.agent);
      return;
    }

    if (value.t === "activity") {
      recordActivity(entry, { ...value.event, at: value.event?.at ?? Date.now() });
      return;
    }

    if (value.t === "req") {
      try {
        push(entry, { t: "res", id: value.id, ok: true, data: handleRequest(sessionId, value) });
      } catch (error) {
        push(entry, { t: "res", id: value.id, ok: false, error: error?.message ?? String(error) });
      }
    }
  });

  ws.on("close", () => {
    if (sessionId && active.get(sessionId)?.ws === ws) active.delete(sessionId);
  });
}

// One listener per bound address: loopback for local health checks, plus the
// tailnet address agents actually connect through. They share all state.
const listeners = HOSTS.map((host) => {
  const httpServer = http.createServer(handleHttp);
  const wss = new WebSocketServer({ server: httpServer, path: "/ws", maxPayload: MAX_MESSAGE * 4 });
  wss.on("connection", onConnection);
  httpServer.on("error", (error) => console.error(`agent-board listen error on ${host}:${PORT}: ${error.message}`));
  httpServer.listen(PORT, host, () => console.log(`agent-board listening on http://${host}:${PORT}, db=${DB_PATH}`));
  return { httpServer, wss };
});

const timer = setInterval(purge, PURGE_INTERVAL_MS);
timer.unref?.();

function shutdown() {
  clearInterval(timer);
  for (const entry of active.values()) entry.ws.close(1001, "server shutting down");
  for (const { httpServer, wss } of listeners) {
    wss.close();
    httpServer.close();
  }
  try {
    db.close();
  } catch { /* already closed */ }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
