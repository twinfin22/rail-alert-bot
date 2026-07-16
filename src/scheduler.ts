import { closeFailedLease, runProviderPoll, type PollLease, type Provider } from "./poll-runner";

export const PROVIDERS: readonly Provider[] = ["bus", "srt", "ktx"];
export const SLOT_MS = 5 * 60_000;
export const PROVIDER_TIMEOUT_MS = 90_000;
export const RETRY_DELAY_MS = 15_000;

export type Clock = { now: () => Date; sleep: (milliseconds: number) => Promise<void> };
export type ProviderExecution = (request: ProviderExecutionRequest, signal: AbortSignal, onClaim: (lease: PollLease) => void) => Promise<void>;
export type LeaseFailure = (lease: PollLease, error: unknown) => Promise<void>;
export type ProviderExecutionRequest = { provider: Provider; runId: string; scheduledFor: string; source: string; attempt: number };

export type SchedulerOptions = {
  clock?: Clock;
  providers?: readonly Provider[];
  source?: string;
  signal?: AbortSignal;
  execute?: ProviderExecution;
  failLease?: LeaseFailure;
  onError?: (error: unknown, request: ProviderExecutionRequest) => void;
  timings?: Partial<SchedulerTimings>;
};
export type SchedulerTimings = { providerTimeoutMs: number; retryDelayMs: number };
const defaultTimings: SchedulerTimings = { providerTimeoutMs: PROVIDER_TIMEOUT_MS, retryDelayMs: RETRY_DELAY_MS };

const systemClock: Clock = {
  now: () => new Date(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export function slotFor(date: Date): Date {
  return new Date(Math.floor(date.getTime() / SLOT_MS) * SLOT_MS);
}

export function millisecondsUntilNextSlot(now: Date): number {
  return slotFor(now).getTime() + SLOT_MS - now.getTime();
}

export async function runProviderSlot(request: Omit<ProviderExecutionRequest, "runId" | "attempt"> & { runId?: string }, execute: ProviderExecution = defaultExecute, failLease: LeaseFailure = closeFailedLease, sleep: Clock["sleep"] = systemClock.sleep, timings: Partial<SchedulerTimings> = {}): Promise<void> {
  const { providerTimeoutMs, retryDelayMs } = { ...defaultTimings, ...timings };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const current: ProviderExecutionRequest = {
      ...request,
      attempt,
      runId: request.runId ?? `${request.source}:${request.provider}:${request.scheduledFor}:${attempt}:${crypto.randomUUID()}`,
    };
    let lease: PollLease | undefined;
    const controller = new AbortController();
    const result = await executeWithTimeout(() => execute(current, controller.signal, (claimed) => { lease = claimed; }), controller, providerTimeoutMs);
    if (!result.ok) {
      if (lease) await failLease(lease, result.error);
      if (attempt === 1) {
        await sleep(retryDelayMs);
        continue;
      }
      throw result.error;
    }
    return;
  }
}

export async function runScheduler(options: SchedulerOptions = {}): Promise<void> {
  const clock = options.clock ?? systemClock;
  const providers = options.providers ?? PROVIDERS;
  const source = options.source ?? "railway";
  const execute = options.execute ?? defaultExecute;
  const failLease = options.failLease ?? closeFailedLease;
  const active = new Set<Provider>();
  let lastSlot = "";

  while (!options.signal?.aborted) {
    const slot = slotFor(clock.now());
    const scheduledFor = slot.toISOString();
    if (scheduledFor !== lastSlot) {
      lastSlot = scheduledFor;
      for (const provider of providers) {
        if (active.has(provider)) continue;
        active.add(provider);
        const request = { provider, scheduledFor, source };
        void runProviderSlot(request, execute, failLease, clock.sleep, options.timings)
          .catch((error) => options.onError?.(error, { ...request, runId: "", attempt: 2 }))
          .finally(() => active.delete(provider));
      }
    }
    await clock.sleep(millisecondsUntilNextSlot(clock.now()));
  }
}

async function defaultExecute(request: ProviderExecutionRequest, signal: AbortSignal, onClaim: (lease: PollLease) => void): Promise<void> {
  await runProviderPoll({
    provider: request.provider,
    runId: request.runId,
    scheduledFor: request.scheduledFor,
    source: request.source,
    attempt: request.attempt,
    signal,
    onClaim,
  });
}

async function executeWithTimeout(operation: () => Promise<void>, controller: AbortController, timeoutMs: number): Promise<{ ok: true } | { ok: false; error: Error }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const task = operation();
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`provider timed out after ${timeoutMs}ms`));
      resolve();
    }, timeoutMs);
  });
  try {
    await Promise.race([task, timeout]);
    if (!timedOut) return { ok: true };
    // All adapters receive this signal (the KTX child is killed). Do not release
    // the provider lock or start the retry until the original task has settled.
    try { await task; } catch { /* timeout is the reported failure */ }
    return { ok: false, error: new Error(`provider timed out after ${timeoutMs}ms`) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

if (import.meta.main) {
  await runScheduler({ onError: (error, request) => console.error("provider poll failed", request.provider, request.scheduledFor, error) });
}
