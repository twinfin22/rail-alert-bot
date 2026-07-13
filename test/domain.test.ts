import { expect, test } from "bun:test";
import { isValidWatchDate, normalizeDate, shouldNotify, validObservations } from "../worker/domain";
test("date allows today through 30 days", () => { const now = new Date("2026-07-13T00:00:00Z"); expect(isValidWatchDate("20260713", now)).toBe(true); expect(isValidWatchDate("20260812", now)).toBe(true); expect(isValidWatchDate("20260813", now)).toBe(false); });
test("notifies only transitions into available", () => { expect(shouldNotify(undefined, true)).toBe(true); expect(shouldNotify(true, true)).toBe(false); expect(shouldNotify(true, false)).toBe(false); expect(shouldNotify(false, true)).toBe(true); });
test("normalizes only supported watch date input", () => { expect(normalizeDate("2026-07-13")).toBe("20260713"); expect(normalizeDate("2026/07/13")).toBeNull(); });
test("requires complete unique poll observations", () => {
  const observation = { query_key: "a".repeat(64), seats: [{ key: "1200|general", available: true, label: "12:00 general" }] };
  expect(validObservations([observation])).toBe(true);
  expect(validObservations([])).toBe(false);
  expect(validObservations([observation, observation])).toBe(false);
  expect(validObservations([{ ...observation, seats: [{ ...observation.seats[0], label: "" }] }])).toBe(false);
});
