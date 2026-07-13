import { expect, test } from "bun:test";
import { isValidWatchDate, shouldNotify } from "../worker/domain";
test("date allows today through 30 days", () => { const now = new Date("2026-07-13T00:00:00Z"); expect(isValidWatchDate("20260713", now)).toBe(true); expect(isValidWatchDate("20260812", now)).toBe(true); expect(isValidWatchDate("20260813", now)).toBe(false); });
test("notifies only transitions into available", () => { expect(shouldNotify(undefined, true)).toBe(true); expect(shouldNotify(true, true)).toBe(false); expect(shouldNotify(true, false)).toBe(false); expect(shouldNotify(false, true)).toBe(true); });
