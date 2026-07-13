export {};

const workerUrl = required("RAIL_WORKER_URL").replace(/\/$/, "");
const secret = required("INTERNAL_API_SECRET");

const response = await fetch(`${workerUrl}/internal/admin/bootstrap`, {
  method: "POST",
  headers: { Authorization: `Bearer ${secret}` },
});
if (!response.ok) throw new Error(`bootstrap request failed (${response.status})`);
const result = await response.json() as { bootstrap_url?: string };
if (!result.bootstrap_url) throw new Error("bootstrap URL missing");
console.log(result.bootstrap_url);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} required`);
  return value;
}
