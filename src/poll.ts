import { closeFailedLease, ProviderPollError, runProviderPoll, type Provider } from "./poll-runner";

const provider = process.argv[2] as Provider;
if (!(["bus", "srt", "ktx"] as string[]).includes(provider)) throw new Error("provider must be bus, srt, or ktx");
const runId = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}-${provider}`
  : crypto.randomUUID();

try {
  await runProviderPoll({ provider, runId, source: process.env.POLL_SOURCE ?? "manual", scheduledFor: process.env.POLL_SCHEDULED_FOR, attempt: numberEnv("POLL_ATTEMPT") });
} catch (error) {
  if (error instanceof ProviderPollError && error.lease) await closeFailedLease(error.lease, error);
  throw error;
}

function numberEnv(name: string): number | undefined {
  const value = process.env[name];
  return value ? Number(value) : undefined;
}
