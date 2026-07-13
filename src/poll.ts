import { getSchedule as getKobusSchedule } from "./bus-alert/scraper/kobus";
import { getSchedule as getTxbusSchedule } from "./bus-alert/scraper/txbus";
import type { QueryObservation } from "../worker/domain";

type Provider = "bus" | "srt" | "ktx";
type Work = { query_key: string; query: unknown };
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
const work = claim.work as Work[];
if (!Array.isArray(work) || work.length === 0) process.exit(0);
const observations = await Promise.all(work.map((item) => observe(provider, item)));
const completed = await api("/internal/polls/result", { provider, run_id: runId, lease_token: claim.lease_token, observations });
if (!completed.accepted) throw new Error("result rejected");
function required(name: string) { const value = process.env[name]; if (!value) throw new Error(`${name} required`); return value; }

async function observe(kind: Provider, workItem: Work): Promise<QueryObservation> {
  if (kind !== "bus") throw new Error(`${kind} provider adapter is not implemented`);
  const query = workItem.query as { service?: string; departure_code?: string; departure_name?: string; arrival_code?: string; arrival_name?: string; date?: string };
  if (!query.departure_code || !query.arrival_code || !query.date) throw new Error("invalid claimed bus query");
  const schedules = query.service === "kobus"
    ? await getKobusSchedule(query.departure_code, query.departure_name ?? query.departure_code, query.arrival_code, query.arrival_name ?? query.arrival_code, query.date)
    : await getTxbusSchedule(query.departure_code, query.arrival_code, query.date);
  return {
    query_key: workItem.query_key,
    seats: schedules.map((schedule) => ({
      key: `${schedule.departureTime}|${schedule.busGrade}`,
      available: schedule.remainingSeats > 0,
      label: `${schedule.departureTime} ${schedule.busGrade} (${schedule.remainingSeats} seats)`,
    })),
  };
}
