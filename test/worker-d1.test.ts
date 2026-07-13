import { beforeEach, expect, test } from "bun:test";
import worker, { type Env } from "../worker/index";
import { sha256 } from "../worker/security";
import { createFakeD1, type FakeD1 } from "./fake-d1";

let d1: FakeD1;
let env: Env;

beforeEach(async () => {
  d1 = await createFakeD1();
  env = {
    DB: d1 as unknown as D1Database,
    BUS_TELEGRAM_TOKEN: "bus-token",
    RAIL_TELEGRAM_TOKEN: "rail-token",
    BUS_WEBHOOK_SECRET: "bus-secret",
    RAIL_WEBHOOK_SECRET: "rail-secret",
    INTERNAL_API_SECRET: "internal-secret",
    RAIL_TELEGRAM_USERNAME: "railbot",
  };
});

test("invites grant access once and reject reuse or expiry", async () => {
  await insertInvite("good", "user", future());
  await railUpdate(1, 11, "/start invite_good");
  expect(await user(11)).toEqual({ telegram_user_id: 11, is_admin: 0 });
  await railUpdate(2, 12, "/start invite_good");
  expect(await lastOutboxText()).toBe("Invalid or expired invite.");

  await insertInvite("old", "user", past());
  await railUpdate(3, 13, "/start invite_old");
  expect(await user(13)).toBeNull();
});

test("rail start creates conversation and srt watch registration is real", async () => {
  await allowUser(21);
  await railUpdate(10, 21, "/start");
  expect(await conversation(21)).toEqual({ step: "provider" });
  await railUpdate(11, 21, "srt");
  expect(await conversation(21)).toEqual({ step: "watch_command", provider: "srt" });
  const date = watchDate();
  await railUpdate(12, 21, `/watch srt 수서 부산 ${date} 0600 0900`);
  const watch = await d1.prepare("SELECT provider,query_json FROM watches WHERE telegram_user_id=?").bind(21).first<{ provider: string; query_json: string }>();
  expect(watch?.provider).toBe("srt");
  expect(JSON.parse(watch!.query_json)).toMatchObject({ departure: "수서", arrival: "부산", date });
});

test("expired leases are reclaimed and active leases block overlap", async () => {
  await insertWatch("w1", 31, "srt", { departure: "수서", arrival: "부산", date: watchDate(), start_time: "0600", end_time: "0900" });
  const first = await internal("/internal/polls/claim", { provider: "srt", run_id: "run-1" });
  expect(first.claimed).toBe(true);
  const overlap = await internal("/internal/polls/claim", { provider: "srt", run_id: "run-2" });
  expect(overlap).toEqual({ claimed: false, reason: "already_leased" });
  await d1.prepare("UPDATE poll_runs SET leased_until=? WHERE run_id='run-1'").bind(past()).run();
  const reclaimed = await internal("/internal/polls/claim", { provider: "srt", run_id: "run-3" });
  expect(reclaimed.claimed).toBe(true);
  const expired = await d1.prepare("SELECT status FROM poll_runs WHERE run_id='run-1'").first<{ status: string }>();
  expect(expired?.status).toBe("expired");
});

test("state transitions enqueue only unavailable to available alerts", async () => {
  await allowUser(41);
  await d1.prepare("INSERT INTO chats(chat_id,telegram_user_id,bot,created_at) VALUES(?,?,?,?)").bind(4100, 41, "rail", now()).run();
  const query = { departure: "수서", arrival: "부산", date: watchDate(), start_time: "0600", end_time: "0900" };
  const queryKey = await insertWatch("watch-state", 41, "srt", query);

  await submitObservation("state-1", queryKey, true);
  expect(await alertCount()).toBe(1);
  await submitObservation("state-2", queryKey, true);
  expect(await alertCount()).toBe(1);
  await submitObservation("state-3", queryKey, false);
  expect(await alertCount()).toBe(1);
  await submitObservation("state-4", queryKey, true);
  expect(await alertCount()).toBe(2);
});

test("outbox retries failures and dead-letters after max attempts", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(new Response("no", { status: 500 }))) as unknown as typeof fetch;
  try {
    await d1.prepare("INSERT INTO outbox(id,bot,chat_id,body_json,next_attempt_at,created_at) VALUES(?,?,?,?,?,?)").bind("o1", "rail", 9, JSON.stringify({ text: "hi" }), past(), now()).run();
    await internal("/internal/maintenance", {});
    let row = await d1.prepare("SELECT status,attempts,last_error FROM outbox WHERE id='o1'").first<{ status: string; attempts: number; last_error: string }>();
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toContain("telegram 500");

    await d1.prepare("UPDATE outbox SET attempts=4,next_attempt_at=? WHERE id='o1'").bind(past()).run();
    await internal("/internal/maintenance", {});
    row = await d1.prepare("SELECT status,attempts FROM outbox WHERE id='o1'").first<{ status: string; attempts: number; last_error: string }>();
    expect(row?.status).toBe("dead-letter");
    expect(row?.attempts).toBe(5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function railUpdate(updateId: number, userId: number, text: string): Promise<Response> {
  return worker.fetch(new Request("https://worker.test/telegram/rail", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "rail-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ update_id: updateId, message: { chat: { id: userId * 100, type: "private" }, from: { id: userId }, text } }),
  }), env);
}

async function internal(path: string, body: unknown): Promise<any> {
  const response = await worker.fetch(new Request(`https://worker.test${path}`, {
    method: "POST",
    headers: { Authorization: "Bearer internal-secret", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), env);
  return response.json();
}

async function insertInvite(code: string, kind: "admin" | "user", expiresAt: string): Promise<void> {
  await d1.prepare("INSERT INTO invites(code_hash,kind,expires_at,created_by) VALUES(?,?,?,?)").bind(await sha256(code), kind, expiresAt, 1).run();
}

async function allowUser(userId: number): Promise<void> {
  await d1.prepare("INSERT OR IGNORE INTO users(telegram_user_id,allowed_at,is_admin) VALUES(?,?,0)").bind(userId, now()).run();
}

async function insertWatch(id: string, userId: number, provider: "srt" | "ktx" | "bus", query: Record<string, string>): Promise<string> {
  await allowUser(userId);
  const queryJson = JSON.stringify(query);
  const queryKey = await sha256(queryJson);
  await d1.prepare("INSERT INTO watches(id,telegram_user_id,provider,query_key,query_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)").bind(id, userId, provider, queryKey, queryJson, now(), future()).run();
  return queryKey;
}

async function submitObservation(runId: string, queryKey: string, available: boolean): Promise<void> {
  const claim = await internal("/internal/polls/claim", { provider: "srt", run_id: runId });
  const result = await internal("/internal/polls/result", { provider: "srt", run_id: runId, lease_token: claim.lease_token, observations: [{ query_key: queryKey, seats: [{ key: "srt|1|20990101|060000|general", available, label: "SRT 1 060000 general" }] }] });
  expect(result.accepted).toBe(true);
}

async function user(userId: number): Promise<{ telegram_user_id: number; is_admin: number } | null> {
  return d1.prepare("SELECT telegram_user_id,is_admin FROM users WHERE telegram_user_id=?").bind(userId).first();
}

async function conversation(userId: number): Promise<unknown> {
  const row = await d1.prepare("SELECT state_json FROM conversations WHERE telegram_user_id=? AND bot='rail'").bind(userId).first<{ state_json: string }>();
  return row ? JSON.parse(row.state_json) : null;
}

async function lastOutboxText(): Promise<string | undefined> {
  const row = await d1.prepare("SELECT body_json FROM outbox ORDER BY created_at DESC,rowid DESC LIMIT 1").first<{ body_json: string }>();
  return row ? JSON.parse(row.body_json).text : undefined;
}

async function alertCount(): Promise<number> {
  const row = await d1.prepare("SELECT COUNT(*) AS count FROM outbox WHERE body_json LIKE '%Availability found%'").first<{ count: number }>();
  return row?.count ?? 0;
}

function now(): string { return new Date().toISOString(); }
function future(): string { return new Date(Date.now() + 3_600_000).toISOString(); }
function past(): string { return new Date(Date.now() - 3_600_000).toISOString(); }
function watchDate(): string {
  const date = new Date(Date.now() + 86_400_000);
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
}
