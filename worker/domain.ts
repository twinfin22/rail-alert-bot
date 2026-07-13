export const MAX_BUS_WATCHES = 10;
export const MAX_RAIL_WATCHES = 10;
export type Provider = "bus" | "srt" | "ktx";

export interface SeatObservation {
  key: string;
  available: boolean;
  label: string;
}

export interface QueryObservation {
  query_key: string;
  seats: SeatObservation[];
}

export function isValidWatchDate(value: string, now = new Date()): boolean {
  if (!/^\d{8}$/.test(value)) return false;
  const date = new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00Z`);
  if (Number.isNaN(date.valueOf())) return false;
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return date >= today && date <= new Date(today.valueOf() + 30 * 86_400_000);
}

export function shouldNotify(previousAvailable: boolean | undefined, currentlyAvailable: boolean): boolean {
  return currentlyAvailable && previousAvailable !== true;
}

export function canRegister(backlog: number, slowRuns: number): boolean {
  return backlog === 0 && slowRuns < 2;
}

export function normalizeDate(value: string): string | null {
  const normalized = value.replaceAll("-", "");
  return /^\d{8}$/.test(normalized) ? normalized : null;
}

export function isTime(value: string): boolean {
  return /^([01]\d|2[0-3])[0-5]\d$/.test(value);
}

export function isSafeToken(value: string): boolean {
  return value.length > 0 && value.length <= 80 && /^[\p{L}\p{N}_-]+$/u.test(value);
}

export function validObservations(value: unknown): value is QueryObservation[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return false;
  const keys = new Set<string>();
  return value.every((observation) => {
    if (!observation || typeof observation !== "object") return false;
    const entry = observation as Partial<QueryObservation>;
    if (typeof entry.query_key !== "string" || !/^[a-f0-9]{64}$/.test(entry.query_key) || keys.has(entry.query_key) || !Array.isArray(entry.seats) || entry.seats.length > 100) return false;
    keys.add(entry.query_key);
    const seatKeys = new Set<string>();
    return entry.seats.every((seat) => {
      if (!seat || typeof seat !== "object") return false;
      const candidate = seat as Partial<SeatObservation>;
      if (typeof candidate.key !== "string" || candidate.key.length === 0 || candidate.key.length > 160 || seatKeys.has(candidate.key)) return false;
      seatKeys.add(candidate.key);
      return typeof candidate.available === "boolean" && typeof candidate.label === "string" && candidate.label.length > 0 && candidate.label.length <= 300;
    });
  });
}
