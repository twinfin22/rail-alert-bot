import { bearer, constantTimeEqual, sha256 } from "./security";
import { MAX_BUS_WATCHES, MAX_RAIL_WATCHES, canRegister, isValidWatchDate } from "./domain";

export interface Env { DB: D1Database; BUS_TELEGRAM_TOKEN: string; RAIL_TELEGRAM_TOKEN: string; BUS_WEBHOOK_SECRET: string; RAIL_WEBHOOK_SECRET: string; INTERNAL_API_SECRET: string; }
type Provider = "bus" | "srt" | "ktx";
const json = (value: unknown, status = 200) => Response.json(value, { status });
const now = () => new Date().toISOString();

export default { async fetch(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/internal/health" && request.method === "GET") return internal(request, env, () => health(env));
  if (path === "/internal/polls/claim" && request.method === "POST") return internal(request, env, () => claim(request, env));
  if (path === "/internal/polls/result" && request.method === "POST") return internal(request, env, () => result(request, env));
  if (path === "/internal/maintenance" && request.method === "POST") return internal(request, env, () => maintenance(env));
  if (path === "/telegram/bus" && request.method === "POST") return telegram(request, env, "bus");
  if ((path === "/telegram/rail" || path === "/telegram/srt") && request.method === "POST") return telegram(request, env, "rail");
  return new Response("not found", { status: 404 });
} };

async function internal(request: Request, env: Env, handler: () => Promise<Response>): Promise<Response> {
  if (!constantTimeEqual(bearer(request), env.INTERNAL_API_SECRET)) return new Response("unauthorized", { status: 401 });
  return handler();
}

async function telegram(request: Request, env: Env, bot: "bus" | "rail"): Promise<Response> {
  const secret = bot === "bus" ? env.BUS_WEBHOOK_SECRET : env.RAIL_WEBHOOK_SECRET;
  if (!constantTimeEqual(request.headers.get("X-Telegram-Bot-Api-Secret-Token"), secret)) return new Response("forbidden", { status: 403 });
  const update = await request.json<{ update_id?: number; message?: { chat?: { id?: number; type?: string }; from?: { id?: number }; text?: string } }>();
  if (!Number.isInteger(update.update_id)) return new Response("bad update", { status: 400 });
  const inserted = await env.DB.prepare("INSERT OR IGNORE INTO updates(bot,update_id,processed_at) VALUES(?,?,?)").bind(bot, update.update_id, now()).run();
  if (!inserted.meta.changes) return new Response("OK");
  const message = update.message;
  if (!message?.chat?.id || message.chat.type !== "private" || !message.from?.id) return new Response("OK");
  await env.DB.prepare("INSERT OR REPLACE INTO chats(chat_id,telegram_user_id,bot,created_at) VALUES(?,?,?,?)").bind(message.chat.id, message.from.id, bot, now()).run();
  await handleCommand(env, bot, message.from.id, message.chat.id, message.text?.trim() ?? "");
  return new Response("OK");
}

async function handleCommand(env: Env, bot: "bus" | "rail", userId: number, chatId: number, text: string): Promise<void> {
  const [command, arg] = text.split(/\s+/, 2);
  if (command === "/start" && arg?.startsWith("admin_")) return useInvite(env, userId, chatId, bot, arg.slice(6), "admin");
  if (command === "/start" && arg?.startsWith("invite_")) return useInvite(env, userId, chatId, bot, arg.slice(7), "user");
  const user = await env.DB.prepare("SELECT is_admin FROM users WHERE telegram_user_id=?").bind(userId).first<{ is_admin: number }>();
  if (command === "/help") return send(env, bot, chatId, "5-minute polling is best effort; GitHub schedules can be delayed or missed. /list /stop /delete");
  if (command === "/status" && user?.is_admin) return send(env, bot, chatId, JSON.stringify(await status(env)));
  if (command === "/invite" && user?.is_admin && bot === "rail") return createInvite(env, userId, chatId, bot, "user", 24);
  if (command === "/bootstrap" && !user) return send(env, bot, chatId, "Use the one-time bootstrap link.");
  if (!user) return send(env, bot, chatId, "Access required.");
  if (command === "/delete") { await env.DB.batch([env.DB.prepare("DELETE FROM watches WHERE telegram_user_id=?").bind(userId), env.DB.prepare("DELETE FROM conversations WHERE telegram_user_id=?").bind(userId), env.DB.prepare("DELETE FROM chats WHERE telegram_user_id=?").bind(userId), env.DB.prepare("DELETE FROM users WHERE telegram_user_id=?").bind(userId)]); return; }
  if (command === "/list") { const watches = await env.DB.prepare("SELECT id,provider,query_json FROM watches WHERE telegram_user_id=?").bind(userId).all(); return send(env, bot, chatId, JSON.stringify(watches.results)); }
  if (command === "/stop" && arg) { await env.DB.prepare("DELETE FROM watches WHERE id=? AND telegram_user_id=?").bind(arg, userId).run(); return send(env, bot, chatId, "Stopped."); }
  if (command === "/start") return send(env, bot, chatId, bot === "rail" ? "Choose SRT or KTX, then enter route and date." : "Use the existing Bus registration flow.");
}

async function useInvite(env: Env, userId: number, chatId: number, bot: "bus" | "rail", code: string, kind: "admin" | "user") {
  const row = await env.DB.prepare("SELECT code_hash FROM invites WHERE code_hash=? AND kind=? AND used_at IS NULL AND expires_at>? ").bind(await sha256(code), kind, now()).first<{ code_hash: string }>();
  if (!row) return send(env, bot, chatId, "Invalid or expired invite.");
  await env.DB.batch([env.DB.prepare("UPDATE invites SET used_at=? WHERE code_hash=?").bind(now(), row.code_hash), env.DB.prepare("INSERT OR REPLACE INTO users(telegram_user_id,allowed_at,is_admin) VALUES(?,?,?)").bind(userId, now(), kind === "admin" ? 1 : 0)]);
  return send(env, bot, chatId, "Access granted.");
}
async function createInvite(env: Env, userId: number, chatId: number, bot: "rail", kind: "admin" | "user", hours: number) {
  const code = crypto.randomUUID().replaceAll("-", "");
  await env.DB.prepare("INSERT INTO invites(code_hash,kind,expires_at,created_by) VALUES(?,?,?,?)").bind(await sha256(code), kind, new Date(Date.now() + hours * 3_600_000).toISOString(), userId).run();
  return send(env, bot, chatId, `https://t.me/REPLACE_BOT?start=${kind === "admin" ? "admin" : "invite"}_${code}`);
}
async function send(env: Env, bot: "bus" | "rail", chatId: number, text: string) { await env.DB.prepare("INSERT INTO outbox(id,bot,chat_id,body_json,next_attempt_at,created_at) VALUES(?,?,?,?,?,?)").bind(crypto.randomUUID(), bot, chatId, JSON.stringify({ text }), now(), now()).run(); }

async function claim(request: Request, env: Env): Promise<Response> { const body = await request.json<{ provider?: Provider; run_id?: string }>(); if (!body.provider || !body.run_id) return json({ error: "bad request" }, 400); const active = await env.DB.prepare("SELECT run_id FROM poll_runs WHERE provider=? AND status='leased' AND leased_until>? LIMIT 1").bind(body.provider, now()).first(); if (active) return json({ claimed: false }); const lease = crypto.randomUUID(); const until = new Date(Date.now() + 4 * 60_000).toISOString(); await env.DB.prepare("INSERT OR REPLACE INTO poll_runs(run_id,provider,lease_token_hash,leased_until,status,created_at) VALUES(?,?,?,?,?,?)").bind(body.run_id, body.provider, await sha256(lease), until, "leased", now()).run(); return json({ claimed: true, lease_token: lease, expires_at: until }); }
async function result(request: Request, env: Env): Promise<Response> { const body = await request.json<{ run_id?: string; lease_token?: string; provider?: Provider; observations?: unknown[] }>(); if (!body.run_id || !body.lease_token || !body.provider) return json({ error: "bad request" }, 400); const run = await env.DB.prepare("SELECT lease_token_hash,leased_until,status,provider FROM poll_runs WHERE run_id=?").bind(body.run_id).first<{ lease_token_hash: string; leased_until: string; status: string; provider: string }>(); if (!run || run.status !== "leased" || run.provider !== body.provider || run.leased_until <= now() || !constantTimeEqual(await sha256(body.lease_token), run.lease_token_hash)) return json({ accepted: false }, 409); await env.DB.prepare("UPDATE poll_runs SET status='accepted',accepted_at=? WHERE run_id=?").bind(now(), body.run_id).run(); return json({ accepted: true, observation_count: body.observations?.length ?? 0 }); }
async function maintenance(env: Env): Promise<Response> { const time = now(); await env.DB.batch([env.DB.prepare("UPDATE poll_runs SET status='expired' WHERE status='leased' AND leased_until<?").bind(time), env.DB.prepare("DELETE FROM watches WHERE expires_at<?").bind(time), env.DB.prepare("DELETE FROM conversations WHERE expires_at<?").bind(time), env.DB.prepare("UPDATE outbox SET status='dead-letter' WHERE attempts>=5 AND status='pending'")]); await flushOutbox(env); return json({ ok: true }); }
async function flushOutbox(env: Env) {
  const rows = await env.DB.prepare("SELECT id,bot,chat_id,body_json,attempts FROM outbox WHERE status='pending' AND next_attempt_at<=? AND (locked_until IS NULL OR locked_until<?) LIMIT 25").bind(now(), now()).all<{ id: string; bot: "bus" | "rail"; chat_id: number; body_json: string; attempts: number }>();
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
async function status(env: Env) { const [backlog, dead] = await Promise.all([env.DB.prepare("SELECT COUNT(*) AS count FROM outbox WHERE status='pending'").first<{ count: number }>(), env.DB.prepare("SELECT COUNT(*) AS count FROM outbox WHERE status='dead-letter'").first<{ count: number }>()]); return { backlog: backlog?.count ?? 0, dead_letter: dead?.count ?? 0, registration_open: canRegister(backlog?.count ?? 0, 0) }; }
async function health(env: Env): Promise<Response> { return json(await status(env)); }
