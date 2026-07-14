import { getSchedule as getKobusSchedule } from "./bus-alert/scraper/kobus";
import { getSchedule as getTxbusSchedule } from "./bus-alert/scraper/txbus";
import { searchSrt } from "./srt/search";
import type { QueryObservation } from "../worker/domain";

type Provider = "bus" | "srt" | "ktx";
type Work = { query_key: string; query: unknown };
export {};
const base = required("RAIL_WORKER_URL").replace(/\/$/, "");
const secret = required("INTERNAL_API_SECRET");
const provider = process.argv[2] as Provider;
if (!(["bus", "srt", "ktx"] as string[]).includes(provider)) throw new Error("provider must be bus, srt, or ktx");
const runId = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}-${provider}` : crypto.randomUUID();

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
const observations = provider === "ktx" ? await observeKtxBatch(work) : await observeWithConcurrency(provider, work, 2);
const completed = await api("/internal/polls/result", { provider, run_id: runId, lease_token: claim.lease_token, observations });
if (!completed.accepted) throw new Error("result rejected");
function required(name: string) { const value = process.env[name]; if (!value) throw new Error(`${name} required`); return value; }

async function observe(kind: Provider, workItem: Work): Promise<QueryObservation> {
  if (kind === "srt") return observeSrt(workItem);
  if (kind === "ktx") throw new Error("ktx provider adapter must be called in batch mode");
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

async function observeSrt(workItem: Work): Promise<QueryObservation> {
  const query = workItem.query as { departure?: string; arrival?: string; date?: string; start_time?: string; end_time?: string };
  if (!query.departure || !query.arrival || !query.date || !query.start_time || !query.end_time) throw new Error("invalid claimed SRT query");
  const trains = await searchSrt({ departure: query.departure, arrival: query.arrival, date: query.date, start_time: query.start_time, end_time: query.end_time });
  return {
    query_key: workItem.query_key,
    seats: trains.flatMap((train) => {
      const base = `srt|${train.trainNo}|${train.date}|${train.depTime}`;
      return [
        { key: `${base}|general`, available: train.generalAvailable, label: `SRT ${train.trainNo} ${train.depTime} general (${train.generalState})` },
        { key: `${base}|special`, available: train.specialAvailable, label: `SRT ${train.trainNo} ${train.depTime} special (${train.specialState})` },
      ];
    }),
  };
}

async function observeWithConcurrency(kind: Exclude<Provider, "ktx">, work: Work[], concurrency: number): Promise<QueryObservation[]> {
  const observations: QueryObservation[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= work.length) return;
      observations[index] = await observe(kind, work[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, work.length) }, worker));
  return observations;
}

async function observeKtxBatch(work: Work[]): Promise<QueryObservation[]> {
  const process = Bun.spawn(["python", "ktx/observe.py"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: processEnvForPython(),
  });
  process.stdin.write(JSON.stringify(work));
  process.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  if (exitCode !== 0) throw new Error(`KTX adapter failed: ${stderr.trim().slice(0, 300)}`);
  const parsed = JSON.parse(stdout) as QueryObservation[];
  return parsed;
}

function processEnvForPython(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return env;
}
