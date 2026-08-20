import { describe, expect, it } from "vitest";
import { isPlaudAuthStatus } from "./client.js";

describe("isPlaudAuthStatus", () => {
  it("treats -419 (workspace token expired) as an auth failure", () => {
    expect(isPlaudAuthStatus(-419)).toBe(true);
  });

  it("does not treat success or unrelated failures as auth failures", () => {
    for (const status of [0, -302, -1, 1, 500]) {
      expect(isPlaudAuthStatus(status)).toBe(false);
    }
  });
});
