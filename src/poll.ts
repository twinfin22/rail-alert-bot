type Provider = "bus" | "srt" | "ktx";
export {};
const base = required("RAIL_WORKER_URL").replace(/\/$/, "");
const secret = required("INTERNAL_API_SECRET");
const provider = process.argv[2] as Provider;
if (!(["bus", "srt", "ktx"] as string[]).includes(provider)) throw new Error("provider must be bus, srt, or ktx");
const runId = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_RUN_ID}-${provider}` : crypto.randomUUID();

async function api(path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) throw new Error(`internal API ${response.status}`);
  return response.json<any>();
}
const claim = await api("/internal/polls/claim", { provider, run_id: runId });
if (!claim.claimed) process.exit(0);
// Provider adapters run read-only searches. Never receive Telegram user IDs or tokens.
const observations: unknown[] = [];
const completed = await api("/internal/polls/result", { provider, run_id: runId, lease_token: claim.lease_token, observations });
if (!completed.accepted) throw new Error("result rejected");
function required(name: string) { const value = process.env[name]; if (!value) throw new Error(`${name} required`); return value; }
