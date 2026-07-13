export const MAX_BUS_WATCHES = 10;
export const MAX_RAIL_WATCHES = 10;

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
