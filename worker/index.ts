import { bearer, constantTimeEqual, sha256 } from "./security";
import { MAX_BUS_WATCHES, MAX_RAIL_WATCHES, canRegister, isSafeToken, isTime, isValidWatchDate, normalizeDate, shouldNotify, validObservations, type Provider, type QueryObservation } from "./domain";

export interface Env {
  DB: D1Database;
  BUS_TELEGRAM_TOKEN: string;
  RAIL_TELEGRAM_TOKEN: string;
  BUS_WEBHOOK_SECRET: string;
  RAIL_WEBHOOK_SECRET: string;
  INTERNAL_API_SECRET: string;
  RAIL_TELEGRAM_USERNAME?: string;
}

type Bot = "bus" | "rail";
type TelegramUpdate = { update_id?: number; message?: { chat?: { id?: number; type?: string }; from?: { id?: number }; text?: string } };
type ClaimedWork = { query_key: string; query: unknown };
const json = (value: unknown, status = 200) => Response.json(value, { status });
const now = () => new Date().toISOString();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/internal/health" && request.method === "GET") return internal(request, env, () => health(env));
    if (path === "/internal/polls/claim" && request.method === "POST") return internal(request, env, () => claim(request, env));
    if (path === "/internal/polls/result" && request.method === "POST") return internal(request, env, () => result(request, env));
    if (path === "/internal/maintenance" && request.method === "POST") return internal(request, env, () => maintenance(env));
    if (path === "/telegram/bus" && request.method === "POST") return telegram(request, env, "bus");
    if ((path === "/telegram/rail" || path === "/telegram/srt") && request.method === "POST") return telegram(request, env, "rail");
    return new Response("not found", { status: 404 });
  },
};

async function internal(request: Request, env: Env, handler: () => Promise<Response>): Promise<Response> {
  if (!constantTimeEqual(bearer(request), env.INTERNAL_API_SECRET)) return new Response("unauthorized", { status: 401 });
  return handler();
}

async function telegram(request: Request, env: Env, bot: Bot): Promise<Response> {
  const secret = bot === "bus" ? env.BUS_WEBHOOK_SECRET : env.RAIL_WEBHOOK_SECRET;
  if (!constantTimeEqual(request.headers.get("X-Telegram-Bot-Api-Secret-Token"), secret)) return new Response("forbidden", { status: 403 });
  let update: TelegramUpdate;
  try { update = await request.json<TelegramUpdate>(); } catch { return new Response("bad update", { status: 400 }); }
  if (!Number.isInteger(update.update_id)) return new Response("bad update", { status: 400 });
  const inserted = await env.DB.prepare("INSERT OR IGNORE INTO updates(bot,update_id,processed_at) VALUES(?,?,?)").bind(bot, update.update_id, now()).run();
  if (!inserted.meta.changes) return new Response("OK");
  const message = update.message;
  if (!message?.chat?.id || message.chat.type !== "private" || !message.from?.id) return new Response("OK");
  await env.DB.prepare("INSERT OR REPLACE INTO chats(chat_id,telegram_user_id,bot,created_at) VALUES(?,?,?,?)").bind(message.chat.id, message.from.id, bot, now()).run();
  await handleCommand(env, bot, message.from.id, message.chat.id, message.text?.trim() ?? "");
  return new Response("OK");
}

async function handleCommand(env: Env, bot: Bot, userId: number, chatId: number, text: string): Promise<void> {
  const [command, arg] = text.split(/\s+/, 2);
  if (command === "/start" && arg?.startsWith("admin_")) return useInvite(env, userId, chatId, bot, arg.slice(6), "admin");
  if (command === "/start" && arg?.startsWith("invite_")) return useInvite(env, userId, chatId, bot, arg.slice(7), "user");
  const user = await env.DB.prepare("SELECT is_admin FROM users WHERE telegram_user_id=?").bind(userId).first<{ is_admin: number }>();
  if (command === "/help") return send(env, bot, chatId, "5-minute polling is best effort; GitHub schedules can be delayed or missed. /watch /list /stop /delete");
  if (!user) return send(env, bot, chatId, "Access required.");
  if (command === "/status" && user.is_admin && bot === "rail") return send(env, bot, chatId, JSON.stringify(await status(env)));
  if (command === "/users" && user.is_admin && bot === "rail") return listUsers(env, bot, chatId);
  if (command === "/invite" && user.is_admin && bot === "rail") return createInvite(env, userId, chatId, "user", 24);
  if (command === "/revoke" && user.is_admin && bot === "rail" && arg) return revoke(env, bot, chatId, arg);
  if (command === "/pause" && user.is_admin && bot === "rail") return setRegistration(env, bot, chatId, false);
  if (command === "/resume" && user.is_admin && bot === "rail") return setRegistration(env, bot, chatId, true);
  if (command === "/delete") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM watches WHERE telegram_user_id=?").bind(userId),
      env.DB.prepare("DELETE FROM seat_states WHERE watch_id NOT IN (SELECT id FROM watches)"),
      env.DB.prepare("DELETE FROM conversations WHERE telegram_user_id=?").bind(userId),
      env.DB.prepare("DELETE FROM chats WHERE telegram_user_id=?").bind(userId),
      env.DB.prepare("DELETE FROM users WHERE telegram_user_id=?").bind(userId),
    ]);
    return send(env, bot, chatId, "Your watches and access were deleted.");
  }
  if (command === "/list") return listWatches(env, bot, userId, chatId);
  if (command === "/stop" && arg) {
    await env.DB.prepare("DELETE FROM watches WHERE id=? AND telegram_user_id=?").bind(arg, userId).run();
    return send(env, bot, chatId, "Stopped.");
  }
  if (command === "/watch") return createWatch(env, bot, userId, chatId, text);
  if (command === "/start") return send(env, bot, chatId, bot === "rail" ? "Use /watch srt or /watch ktx. /help has the command format." : "Use /watch bus. /help has the command format.");
}

async function useInvite(env: Env, userId: number, chatId: number, bot: Bot, code: string, kind: "admin" | "user"): Promise<void> {
  const codeHash = await sha256(code);
  const used = await env.DB.prepare("UPDATE invites SET used_at=? WHERE code_hash=? AND kind=? AND used_at IS NULL AND expires_at>?").bind(now(), codeHash, kind, now()).run();
  if (!used.meta.changes) return send(env, bot, chatId, "Invalid or expired invite.");
  if (kind === "admin") {
    const admin = await env.DB.prepare("SELECT telegram_user_id FROM users WHERE is_admin=1 LIMIT 1").first();
    if (admin) return send(env, bot, chatId, "Administrator already configured.");
  }
  await env.DB.prepare("INSERT INTO users(telegram_user_id,allowed_at,is_admin) VALUES(?,?,?) ON CONFLICT(telegram_user_id) DO UPDATE SET allowed_at=excluded.allowed_at,is_admin=MAX(users.is_admin,excluded.is_admin)").bind(userId, now(), kind === "admin" ? 1 : 0).run();
  return send(env, bot, chatId, "Access granted.");
}

async function createInvite(env: Env, userId: number, chatId: number, kind: "admin" | "user", hours: number): Promise<void> {
  const code = crypto.randomUUID().replaceAll("-", "");
  await env.DB.prepare("INSERT INTO invites(code_hash,kind,expires_at,created_by) VALUES(?,?,?,?)").bind(await sha256(code), kind, new Date(Date.now() + hours * 3_600_000).toISOString(), userId).run();
  const username = env.RAIL_TELEGRAM_USERNAME;
  if (!username) return send(env, "rail", chatId, "Invite created but RAIL_TELEGRAM_USERNAME is not configured.");
  return send(env, "rail", chatId, `https://t.me/${username}?start=${kind === "admin" ? "admin" : "invite"}_${code}`);
}

async function createWatch(env: Env, bot: Bot, userId: number, chatId: number, text: string): Promise<void> {
  if (await registrationPaused(env)) return send(env, bot, chatId, "New registrations are temporarily paused.");
  const parsed = parseWatch(text);
  if (!parsed) return send(env, bot, chatId, "Bus: /watch bus txbus FROM_CODE TO_CODE YYYYMMDD; KOBUS: /watch bus kobus FROM_CODE FROM_NAME TO_CODE TO_NAME YYYYMMDD. Rail: /watch srt FROM TO YYYYMMDD HHMM HHMM or /watch ktx FROM TO YYYYMMDD HHMM HHMM general|special|all.");
  if ((parsed.provider === "bus") !== (bot === "bus")) return send(env, bot, chatId, "Use the matching bot for this watch.");
  if (parsed.provider !== "bus") return send(env, bot, chatId, "Rail polling is not enabled yet. Registration is blocked until its read-only adapter is deployed.");
  if (!isValidWatchDate(parsed.query.date)) return send(env, bot, chatId, "Date must be today through 30 days from today.");
  const limit = parsed.provider === "bus" ? MAX_BUS_WATCHES : MAX_RAIL_WATCHES;
  const count = await env.DB.prepare(parsed.provider === "bus" ? "SELECT COUNT(*) AS count FROM watches WHERE telegram_user_id=? AND provider='bus'" : "SELECT COUNT(*) AS count FROM watches WHERE telegram_user_id=? AND provider IN ('srt','ktx')").bind(userId).first<{ count: number }>();
  if ((count?.count ?? 0) >= limit) return send(env, bot, chatId, `Watch limit reached (${limit}).`);
  const queryJson = JSON.stringify(parsed.query);
  const queryKey = await sha256(queryJson);
  const expiresAt = new Date(`${parsed.query.date.slice(0, 4)}-${parsed.query.date.slice(4, 6)}-${parsed.query.date.slice(6, 8)}T23:59:59.999Z`).toISOString();
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO watches(id,telegram_user_id,provider,query_key,query_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)").bind(id, userId, parsed.provider, queryKey, queryJson, now(), expiresAt).run();
  return send(env, bot, chatId, `Watch registered: ${id}`);
}

function parseWatch(text: string): { provider: Provider; query: Record<string, string> } | null {
  const parts = text.trim().split(/\s+/);
  const provider = parts[1] as Provider;
  if (!(["bus", "srt", "ktx"] as string[]).includes(provider)) return null;
  if (provider === "bus") {
    const service = parts[2];
    if (service === "txbus") {
      const [, , , departureCode, arrivalCode, inputDate] = parts;
      const date = inputDate && normalizeDate(inputDate);
      if (!departureCode || !arrivalCode || !date || !isSafeToken(departureCode) || !isSafeToken(arrivalCode)) return null;
      return { provider, query: { service, departure_code: departureCode, arrival_code: arrivalCode, date } };
    }
    if (service === "kobus") {
      const [, , , departureCode, departureName, arrivalCode, arrivalName, inputDate] = parts;
      const date = inputDate && normalizeDate(inputDate);
      if (!departureCode || !departureName || !arrivalCode || !arrivalName || !date || ![departureCode, departureName, arrivalCode, arrivalName].every(isSafeToken)) return null;
      return { provider, query: { service, departure_code: departureCode, departure_name: departureName, arrival_code: arrivalCode, arrival_name: arrivalName, date } };
    }
    return null;
  }
  const [, , departure, arrival, inputDate, startTime, endTime, room] = parts;
  const date = inputDate && normalizeDate(inputDate);
  if (!departure || !arrival || !date || !startTime || !endTime || !isSafeToken(departure) || !isSafeToken(arrival) || !isTime(startTime) || !isTime(endTime) || startTime > endTime) return null;
  if (provider === "ktx" && !(room === "general" || room === "special" || room === "all")) return null;
  if (provider === "srt" && room) return null;
  return { provider, query: provider === "ktx" ? { departure, arrival, date, start_time: startTime, end_time: endTime, room: room! } : { departure, arrival, date, start_time: startTime, end_time: endTime } };
}

async function listWatches(env: Env, bot: Bot, userId: number, chatId: number): Promise<void> {
  const watches = await env.DB.prepare("SELECT id,provider,query_json FROM watches WHERE telegram_user_id=? ORDER BY created_at").bind(userId).all<{ id: string; provider: string; query_json: string }>();
  const text = watches.results.length ? watches.results.map((watch) => `${watch.id} ${watch.provider} ${watch.query_json}`).join("\n") : "No watches.";
  return send(env, bot, chatId, text);
}

async function revoke(env: Env, bot: Bot, chatId: number, rawUserId: string): Promise<void> {
  if (!/^\d+$/.test(rawUserId)) return send(env, bot, chatId, "Usage: /revoke TELEGRAM_USER_ID");
  const userId = Number(rawUserId);
  await env.DB.batch([env.DB.prepare("DELETE FROM watches WHERE telegram_user_id=?").bind(userId), env.DB.prepare("DELETE FROM chats WHERE telegram_user_id=?").bind(userId), env.DB.prepare("DELETE FROM users WHERE telegram_user_id=? AND is_admin=0").bind(userId)]);
  return send(env, bot, chatId, "Access revoked.");
}

async function listUsers(env: Env, bot: Bot, chatId: number): Promise<void> {
  const users = await env.DB.prepare("SELECT telegram_user_id,is_admin FROM users ORDER BY allowed_at").all<{ telegram_user_id: number; is_admin: number }>();
  return send(env, bot, chatId, users.results.length ? users.results.map((user) => `${user.telegram_user_id}${user.is_admin ? " admin" : ""}`).join("\n") : "No users.");
}

async function setRegistration(env: Env, bot: Bot, chatId: number, open: boolean): Promise<void> {
  await env.DB.prepare("INSERT INTO settings(key,value,updated_at) VALUES('registration_paused',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(open ? "0" : "1", now()).run();
  return send(env, bot, chatId, open ? "Registrations resumed." : "Registrations paused.");
}

async function registrationPaused(env: Env): Promise<boolean> {
  const setting = await env.DB.prepare("SELECT value FROM settings WHERE key='registration_paused'").first<{ value: string }>();
  return setting?.value === "1";
}

async function send(env: Env, bot: Bot, chatId: number, text: string): Promise<void> {
  await env.DB.prepare("INSERT INTO outbox(id,bot,chat_id,body_json,next_attempt_at,created_at) VALUES(?,?,?,?,?,?)").bind(crypto.randomUUID(), bot, chatId, JSON.stringify({ text: text.slice(0, 4000) }), now(), now()).run();
}

async function claim(request: Request, env: Env): Promise<Response> {
  const body = await bodyJson<{ provider?: Provider; run_id?: string }>(request);
  if (!body || !validProvider(body.provider) || !validRunId(body.run_id)) return json({ error: "bad request" }, 400);
  const timestamp = now();
  await env.DB.prepare("UPDATE poll_runs SET status='expired' WHERE status='leased' AND leased_until<?").bind(timestamp).run();
  const rows = await env.DB.prepare("SELECT query_key,query_json FROM watches WHERE provider=? AND expires_at>? GROUP BY query_key,query_json ORDER BY COALESCE(MIN(last_polled_at), MIN(created_at)) LIMIT 50").bind(body.provider, timestamp).all<{ query_key: string; query_json: string }>();
  if (rows.results.length === 0) return json({ claimed: false, reason: "no_work" });
  const work: ClaimedWork[] = [];
  for (const row of rows.results) {
    try { work.push({ query_key: row.query_key, query: JSON.parse(row.query_json) }); } catch { return json({ error: "corrupt watch" }, 500); }
  }
  const lease = crypto.randomUUID();
  const until = new Date(Date.now() + 4 * 60_000).toISOString();
  try {
    await env.DB.prepare("INSERT INTO poll_runs(run_id,provider,lease_token_hash,leased_until,claimed_query_keys,status,created_at) VALUES(?,?,?,?,?,?,?)").bind(body.run_id, body.provider, await sha256(lease), until, JSON.stringify(work.map((item) => item.query_key)), "leased", timestamp).run();
  } catch { return json({ claimed: false, reason: "already_leased" }); }
  return json({ claimed: true, lease_token: lease, expires_at: until, work });
}

async function result(request: Request, env: Env): Promise<Response> {
  const body = await bodyJson<{ run_id?: string; lease_token?: string; provider?: Provider; observations?: unknown }>(request);
  if (!body || !validProvider(body.provider) || !validRunId(body.run_id) || typeof body.lease_token !== "string" || !validObservations(body.observations)) return json({ error: "bad request" }, 400);
  const run = await env.DB.prepare("SELECT lease_token_hash,leased_until,status,provider,claimed_query_keys FROM poll_runs WHERE run_id=?").bind(body.run_id).first<{ lease_token_hash: string; leased_until: string; status: string; provider: Provider; claimed_query_keys: string }>();
  if (!run || run.status !== "leased" || run.provider !== body.provider || run.leased_until <= now() || !constantTimeEqual(await sha256(body.lease_token), run.lease_token_hash)) return json({ accepted: false }, 409);
  let expected: string[];
  try { expected = JSON.parse(run.claimed_query_keys); } catch { return json({ accepted: false }, 409); }
  const actual = body.observations.map((observation) => observation.query_key).sort();
  if (expected.sort().join(",") !== actual.join(",")) return json({ accepted: false, error: "incomplete result" }, 409);
  const alerts = await applyObservations(env, body.provider, body.observations);
  await env.DB.prepare("UPDATE poll_runs SET status='accepted',accepted_at=? WHERE run_id=? AND status='leased'").bind(now(), body.run_id).run();
  return json({ accepted: true, observation_count: body.observations.length, alert_count: alerts });
}

async function applyObservations(env: Env, provider: Provider, observations: QueryObservation[]): Promise<number> {
  let alerts = 0;
  const timestamp = now();
  for (const observation of observations) {
    const watches = await env.DB.prepare("SELECT id,telegram_user_id FROM watches WHERE provider=? AND query_key=? AND expires_at>?").bind(provider, observation.query_key, timestamp).all<{ id: string; telegram_user_id: number }>();
    for (const watch of watches.results) {
      for (const seat of observation.seats) {
        const previous = await env.DB.prepare("SELECT available FROM seat_states WHERE watch_id=? AND seat_key=?").bind(watch.id, seat.key).first<{ available: number }>();
        await env.DB.prepare("INSERT INTO seat_states(watch_id,seat_key,available,updated_at) VALUES(?,?,?,?) ON CONFLICT(watch_id,seat_key) DO UPDATE SET available=excluded.available,updated_at=excluded.updated_at").bind(watch.id, seat.key, seat.available ? 1 : 0, timestamp).run();
        if (!shouldNotify(previous?.available === 1 ? true : previous ? false : undefined, seat.available)) continue;
        const chats = await env.DB.prepare("SELECT chat_id,bot FROM chats WHERE telegram_user_id=? AND bot=?").bind(watch.telegram_user_id, provider === "bus" ? "bus" : "rail").all<{ chat_id: number; bot: Bot }>();
        for (const chat of chats.results) {
          await send(env, chat.bot, chat.chat_id, `Availability found (${watch.id}): ${seat.label}`);
          alerts++;
        }
      }
      await env.DB.prepare("UPDATE watches SET last_polled_at=? WHERE id=?").bind(timestamp, watch.id).run();
    }
  }
  return alerts;
}

async function maintenance(env: Env): Promise<Response> {
  const timestamp = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE poll_runs SET status='expired' WHERE status='leased' AND leased_until<?").bind(timestamp),
    env.DB.prepare("DELETE FROM watches WHERE expires_at<?").bind(timestamp),
    env.DB.prepare("DELETE FROM conversations WHERE expires_at<?").bind(timestamp),
    env.DB.prepare("DELETE FROM seat_states WHERE watch_id NOT IN (SELECT id FROM watches)"),
    env.DB.prepare("UPDATE outbox SET status='dead-letter' WHERE attempts>=5 AND status='pending'"),
  ]);
  await flushOutbox(env);
  return json({ ok: true });
}

async function flushOutbox(env: Env): Promise<void> {
  const rows = await env.DB.prepare("SELECT id,bot,chat_id,body_json,attempts FROM outbox WHERE status='pending' AND next_attempt_at<=? AND (locked_until IS NULL OR locked_until<?) LIMIT 25").bind(now(), now()).all<{ id: string; bot: Bot; chat_id: number; body_json: string; attempts: number }>();
  for (const row of rows.results) {
    const lockUntil = new Date(Date.now() + 30_000).toISOString();
    const locked = await env.DB.prepare("UPDATE outbox SET locked_until=? WHERE id=? AND status='pending' AND (locked_until IS NULL OR locked_until<?)").bind(lockUntil, row.id, now()).run();
    if (!locked.meta.changes) continue;
    try {
      const token = row.bot === "bus" ? env.BUS_TELEGRAM_TOKEN : env.RAIL_TELEGRAM_TOKEN;
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: row.chat_id, ...JSON.parse(row.body_json) }) });
      if (!response.ok) throw new Error(`telegram ${response.status}`);
      await env.DB.prepare("UPDATE outbox SET status='sent',locked_until=NULL,last_error=NULL WHERE id=?").bind(row.id).run();
    } catch (error) {
      const attempts = row.attempts + 1;
      const next = new Date(Date.now() + Math.min(300_000, 1_000 * 2 ** attempts)).toISOString();
      await env.DB.prepare("UPDATE outbox SET attempts=?,next_attempt_at=?,locked_until=NULL,last_error=?,status=? WHERE id=?").bind(attempts, next, String(error).slice(0, 200), attempts >= 5 ? "dead-letter" : "pending", row.id).run();
    }
  }
}

async function status(env: Env): Promise<Record<string, unknown>> {
  const [backlog, dead, active, paused] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS count FROM outbox WHERE status='pending'").first<{ count: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM outbox WHERE status='dead-letter'").first<{ count: number }>(),
    env.DB.prepare("SELECT provider,COUNT(*) AS count FROM poll_runs WHERE status='leased' AND leased_until>? GROUP BY provider").bind(now()).all<{ provider: string; count: number }>(),
    registrationPaused(env),
  ]);
  return { backlog: backlog?.count ?? 0, dead_letter: dead?.count ?? 0, active_leases: active.results, registration_open: !paused && canRegister(backlog?.count ?? 0, 0) };
}

async function health(env: Env): Promise<Response> { return json(await status(env)); }
async function bodyJson<T>(request: Request): Promise<T | null> { try { return await request.json<T>(); } catch { return null; } }
function validProvider(value: unknown): value is Provider { return value === "bus" || value === "srt" || value === "ktx"; }
function validRunId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9._-]{1,200}$/.test(value); }
