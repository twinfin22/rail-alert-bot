import { getSchedule as getKobusSchedule } from "./bus-alert/scraper/kobus";
import { getSchedule as getTxbusSchedule } from "./bus-alert/scraper/txbus";
import { searchSrt } from "./srt/search";
import type { QueryObservation } from "../worker/domain";

export type Provider = "bus" | "srt" | "ktx";
type Work = { query_key: string; query: unknown };
export type PollLease = { provider: Provider; runId: string; leaseToken: string };
export type PollRunRequest = {
  provider: Provider;
  runId: string;
  scheduledFor?: string;
  source?: string;
  attempt?: number;
  signal?: AbortSignal;
  onClaim?: (lease: PollLease) => void;
};

export class ProviderPollError extends Error {
  constructor(message: string, readonly lease?: PollLease, readonly cause?: unknown) {
    super(message);
    this.name = "ProviderPollError";
  }
}

type ApiConfig = { base: string; secret: string };

function config(): ApiConfig {
  return { base: required("RAIL_WORKER_URL").replace(/\/$/, ""), secret: required("INTERNAL_API_SECRET") };
}

async function api(path: string, body: unknown, signal?: AbortSignal, apiConfig = config()) {
  const response = await fetch(`${apiConfig.base}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiConfig.secret}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(`internal API ${response.status}`);
  return response.json<any>();
}

export async function runProviderPoll(request: PollRunRequest): Promise<"skipped" | "completed"> {
  let lease: PollLease | undefined;
  try {
    const claim = await api("/internal/polls/claim", {
      provider: request.provider,
      run_id: request.runId,
      scheduled_for: request.scheduledFor,
      source: request.source,
      attempt: request.attempt,
    }, request.signal);
    if (!claim.claimed) return "skipped";
    if (typeof claim.lease_token !== "string") throw new Error("claim missing lease token");
    lease = { provider: request.provider, runId: request.runId, leaseToken: claim.lease_token };
    request.onClaim?.(lease);
    const work = claim.work as Work[];
    if (!Array.isArray(work) || work.length === 0) return "skipped";
    const observations = request.provider === "ktx"
      ? await observeKtxBatch(work, request.signal)
      : await observeWithConcurrency(request.provider, work, 2, request.signal);
    const completed = await api("/internal/polls/result", {
      provider: request.provider,
      run_id: request.runId,
      lease_token: lease.leaseToken,
      observations,
    }, request.signal);
    if (!completed.accepted) throw new Error("result rejected");
    return "completed";
  } catch (error) {
    if (error instanceof ProviderPollError) throw error;
    throw new ProviderPollError(error instanceof Error ? error.message : "provider poll failed", lease, error);
  }
}

export async function closeFailedLease(lease: PollLease, error: unknown, signal?: AbortSignal): Promise<void> {
  await api("/internal/polls/fail", {
    provider: lease.provider,
    run_id: lease.runId,
    lease_token: lease.leaseToken,
    reason: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
  }, signal);
}

function required(name: string) { const value = process.env[name]; if (!value) throw new Error(`${name} required`); return value; }

async function observe(kind: Exclude<Provider, "ktx">, workItem: Work, signal?: AbortSignal): Promise<QueryObservation> {
  if (kind === "srt") return observeSrt(workItem, signal);
  const query = workItem.query as { service?: string; departure_code?: string; departure_name?: string; arrival_code?: string; arrival_name?: string; date?: string };
  if (!query.departure_code || !query.arrival_code || !query.date) throw new Error("invalid claimed bus query");
  const schedules = query.service === "kobus"
    ? await getKobusSchedule(query.departure_code, query.departure_name ?? query.departure_code, query.arrival_code, query.arrival_name ?? query.arrival_code, query.date, signal)
    : await getTxbusSchedule(query.departure_code, query.arrival_code, query.date, signal);
  return { query_key: workItem.query_key, seats: schedules.map((schedule) => ({
    key: `${schedule.departureTime}|${schedule.busGrade}`,
    available: schedule.remainingSeats > 0,
    label: `${schedule.departureTime} ${schedule.busGrade} (${schedule.remainingSeats} seats)`,
  })) };
}

async function observeSrt(workItem: Work, signal?: AbortSignal): Promise<QueryObservation> {
  const query = workItem.query as { departure?: string; arrival?: string; date?: string; start_time?: string; end_time?: string };
  if (!query.departure || !query.arrival || !query.date || !query.start_time || !query.end_time) throw new Error("invalid claimed SRT query");
  const trains = await searchSrt({ departure: query.departure, arrival: query.arrival, date: query.date, start_time: query.start_time, end_time: query.end_time }, signal);
  return { query_key: workItem.query_key, seats: trains.flatMap((train) => {
    const base = `srt|${train.trainNo}|${train.date}|${train.depTime}`;
    return [
      { key: `${base}|general`, available: train.generalAvailable, label: `SRT ${train.trainNo} ${train.depTime} general (${train.generalState})` },
      { key: `${base}|special`, available: train.specialAvailable, label: `SRT ${train.trainNo} ${train.depTime} special (${train.specialState})` },
    ];
  }) };
}

async function observeWithConcurrency(kind: Exclude<Provider, "ktx">, work: Work[], concurrency: number, signal?: AbortSignal): Promise<QueryObservation[]> {
  const observations: QueryObservation[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const index = next++;
      if (index >= work.length) return;
      observations[index] = await observe(kind, work[index]!, signal);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, work.length) }, worker));
  return observations;
}

async function observeKtxBatch(work: Work[], signal?: AbortSignal): Promise<QueryObservation[]> {
  const process = Bun.spawn(["python", "ktx/observe.py"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: processEnvForPython() });
  const abort = () => process.kill();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    process.stdin.write(JSON.stringify(work));
    process.stdin.end();
    const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    if (exitCode !== 0) throw new Error(`KTX adapter failed: ${stderr.trim().slice(0, 300)}`);
    return JSON.parse(stdout) as QueryObservation[];
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

function processEnvForPython(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return env;
}
