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
    WEBHOOK_REGISTRATION_ENABLED: "true",
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

test("admin bootstrap is one-use and permanently unavailable after the first administrator", async () => {
  const response = await internalResponse("/internal/admin/bootstrap", {});
  expect(response.status).toBe(200);
  const { bootstrap_url: link } = await response.json() as { bootstrap_url: string };
  const code = new URL(link).searchParams.get("start")!.slice("admin_".length);
  await railUpdate(4, 14, `/start admin_${code}`);
  expect(await user(14)).toEqual({ telegram_user_id: 14, is_admin: 1 });
  expect((await internalResponse("/internal/admin/bootstrap", {})).status).toBe(409);
});

test("registers both Telegram webhooks through the authenticated internal endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: { url: string; secret_token: string; allowed_updates: string[] } }> = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;
  try {
    const response = await internalResponse("/internal/webhooks/register", {});
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      { url: "https://api.telegram.org/botbus-token/setWebhook", body: { url: "https://worker.test/telegram/bus", secret_token: "bus-secret", allowed_updates: ["message"] } },
      { url: "https://api.telegram.org/botrail-token/setWebhook", body: { url: "https://worker.test/telegram/rail", secret_token: "rail-secret", allowed_updates: ["message"] } },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("staging can disable Telegram webhook registration", async () => {
  env.WEBHOOK_REGISTRATION_ENABLED = "false";
  expect((await internalResponse("/internal/webhooks/register", {})).status).toBe(403);
});

test("Telegram commands flush their reply through the execution context", async () => {
  const originalFetch = globalThis.fetch;
  let pending: Promise<unknown> | undefined;
  const calls: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    calls.push(String(input));
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;
  try {
    const response = await worker.fetch(new Request("https://worker.test/telegram/rail", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "rail-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ update_id: 6, message: { chat: { id: 1600, type: "private" }, from: { id: 16 }, text: "/help" } }),
    }), env, { waitUntil: (promise: Promise<unknown>) => { pending = promise; } } as ExecutionContext);
    expect(response.status).toBe(200);
    await pending;
    expect(calls).toEqual(["https://api.telegram.org/botrail-token/sendMessage"]);
    const sent = await d1.prepare("SELECT status FROM outbox").first<{ status: string }>();
    expect(sent?.status).toBe("sent");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("forged and replayed Telegram updates are rejected before command handling", async () => {
  const forged = await worker.fetch(new Request("https://worker.test/telegram/rail", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "not json",
  }), env);
  expect(forged.status).toBe(403);

  await railUpdate(5, 15, "/help");
  await railUpdate(5, 15, "/help");
  const outbox = await d1.prepare("SELECT COUNT(*) AS count FROM outbox").first<{ count: number }>();
  expect(outbox?.count).toBe(1);
});

test("rail start asks for a train type and collects SRT watch fields one at a time", async () => {
  await allowUser(21);
  await railUpdate(10, 21, "/start");
  expect(await conversation(21)).toEqual({ step: "provider" });
  expect(await lastOutboxText()).toBe("SRT 또는 KTX를 입력하세요.");
  await railUpdate(11, 21, "SRT");
  expect(await conversation(21)).toEqual({ step: "departure", provider: "srt" });
  expect(await lastOutboxText()).toBe("출발역을 입력하세요. 예: 수서");
  await railUpdate(12, 21, "수서");
  expect(await conversation(21)).toEqual({ step: "arrival", provider: "srt", departure: "수서" });
  expect(await lastOutboxText()).toBe("도착역을 입력하세요. 예: 부산");
  await railUpdate(13, 21, "부산");
  expect(await conversation(21)).toEqual({ step: "date", provider: "srt", departure: "수서", arrival: "부산" });
  expect(await lastOutboxText()).toBe("출발 날짜를 입력하세요. 예: 20260715");
  await railUpdate(14, 21, "20990101");
  expect(await conversation(21)).toEqual({ step: "date", provider: "srt", departure: "수서", arrival: "부산" });
  expect(await lastOutboxText()).toContain("YYYYMMDD");
  const date = watchDate();
  await railUpdate(15, 21, date);
  expect(await conversation(21)).toEqual({ step: "start_time", provider: "srt", departure: "수서", arrival: "부산", date });
  await railUpdate(16, 21, "0600");
  expect(await conversation(21)).toEqual({ step: "end_time", provider: "srt", departure: "수서", arrival: "부산", date, start_time: "0600" });
  await railUpdate(17, 21, "0500");
  expect(await conversation(21)).toEqual({ step: "end_time", provider: "srt", departure: "수서", arrival: "부산", date, start_time: "0600" });
  expect(await lastOutboxText()).toContain("같거나 늦은");
  await railUpdate(18, 21, "0900");
  const watch = await d1.prepare("SELECT id,provider,query_json FROM watches WHERE telegram_user_id=?").bind(21).first<{ id: string; provider: string; query_json: string }>();
  expect(watch?.provider).toBe("srt");
  expect(JSON.parse(watch!.query_json)).toMatchObject({ departure: "수서", arrival: "부산", date });
  expect(await lastOutboxText()).toContain("✅ SRT 모니터링 등록!");
  expect(await lastOutboxText()).toContain("수서 → 부산");
  expect(await lastOutboxText()).toContain(`#${watch!.id.replaceAll("-", "").slice(0, 8).toUpperCase()}`);
  expect(await conversation(21)).toBeNull();
});

test("KTX flow asks for a seat type and summarizes the chosen room", async () => {
  await allowUser(22);
  const date = watchDate();
  for (const [updateId, input] of [[30, "/start"], [31, "ktx"], [32, "서울"], [33, "부산"], [34, date], [35, "1200"], [36, "1800"], [37, "일반실"]] as const) {
    await railUpdate(updateId, 22, input);
  }
  const watch = await d1.prepare("SELECT provider,query_json FROM watches WHERE telegram_user_id=?").bind(22).first<{ provider: string; query_json: string }>();
  expect(watch?.provider).toBe("ktx");
  expect(JSON.parse(watch!.query_json)).toMatchObject({ departure: "서울", arrival: "부산", date, room: "general" });
  expect(await lastOutboxText()).toContain("✅ KTX 모니터링 등록!");
  expect(await lastOutboxText()).toContain("일반실");
});

test("a provider accepts subscriptions to existing queries but caps active unique queries at ten", async () => {
  const date = watchDate();
  for (let index = 0; index < 10; index++) {
    await insertWatch(`cap-${index}`, 50 + index, "srt", { departure: `수서${index}`, arrival: "부산", date, start_time: "0600", end_time: "0900" });
  }
  await allowUser(70);
  await railUpdate(70, 70, `/watch srt 수서 부산 ${date} 0600 0900`);
  expect(await lastOutboxText()).toContain("active query limit");

  const existing = await d1.prepare("SELECT query_json FROM watches WHERE id='cap-0'").first<{ query_json: string }>();
  const query = JSON.parse(existing!.query_json) as { departure: string; arrival: string; date: string; start_time: string; end_time: string };
  await railUpdate(71, 70, `/watch srt ${query.departure} ${query.arrival} ${query.date} ${query.start_time} ${query.end_time}`);
  const count = await d1.prepare("SELECT COUNT(*) AS count FROM watches WHERE telegram_user_id=70").first<{ count: number }>();
  expect(count?.count).toBe(1);
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

test("expired, duplicate, and stale results are rejected", async () => {
  const queryKey = await insertWatch("w-result", 32, "srt", { departure: "수서", arrival: "부산", date: watchDate(), start_time: "0600", end_time: "0900" });
  const claim = await internal("/internal/polls/claim", { provider: "srt", run_id: "result-1" });
  const payload = { provider: "srt", run_id: "result-1", lease_token: claim.lease_token, observations: [{ query_key: queryKey, seats: [] }] };
  expect((await internal("/internal/polls/result", payload)).accepted).toBe(true);
  expect((await internal("/internal/polls/result", payload)).accepted).toBe(false);

  const second = await internal("/internal/polls/claim", { provider: "srt", run_id: "result-2" });
  await d1.prepare("UPDATE poll_runs SET leased_until=? WHERE run_id='result-2'").bind(past()).run();
  const stale = await internal("/internal/polls/result", { ...payload, run_id: "result-2", lease_token: second.lease_token });
  expect(stale.accepted).toBe(false);
});

test("two expired leases pause registration until two fast successful runs recover it", async () => {
  const queryKey = await insertWatch("w-overload", 33, "srt", { departure: "수서", arrival: "부산", date: watchDate(), start_time: "0600", end_time: "0900" });
  for (const runId of ["slow-1", "slow-2"]) {
    await internal("/internal/polls/claim", { provider: "srt", run_id: runId });
    await d1.prepare("UPDATE poll_runs SET leased_until=? WHERE run_id=?").bind(past(), runId).run();
    await internal("/internal/maintenance", {});
  }
  await railUpdate(22, 33, `/watch srt 수서 부산 ${watchDate()} 0600 0900`);
  expect(await lastOutboxText()).toBe("New registrations are temporarily paused.");

  for (const runId of ["fast-1", "fast-2"]) {
    const claim = await internal("/internal/polls/claim", { provider: "srt", run_id: runId });
    const result = await internal("/internal/polls/result", { provider: "srt", run_id: runId, lease_token: claim.lease_token, observations: [{ query_key: queryKey, seats: [] }] });
    expect(result.accepted).toBe(true);
  }
  await railUpdate(23, 33, `/watch srt 수서 부산 ${watchDate()} 0600 0900`);
  const watches = await d1.prepare("SELECT COUNT(*) AS count FROM watches WHERE telegram_user_id=33").first<{ count: number }>();
  expect(watches?.count).toBe(2);
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
  return (await internalResponse(path, body)).json();
}

async function internalResponse(path: string, body: unknown): Promise<Response> {
  return worker.fetch(new Request(`https://worker.test${path}`, {
    method: "POST",
    headers: { Authorization: "Bearer internal-secret", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), env);
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
