import { expect, test } from "bun:test";
import { constantTimeEqual } from "../worker/security";
test("compares webhook secrets", () => { expect(constantTimeEqual("abc", "abc")).toBe(true); expect(constantTimeEqual("abc", "abd")).toBe(false); expect(constantTimeEqual(null, "abc")).toBe(false); });
