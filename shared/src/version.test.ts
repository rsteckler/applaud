import { describe, it, expect } from "vitest";

describe("test infrastructure smoke", () => {
  it("vitest + ts + esm pipeline works end-to-end", () => {
    expect(1 + 1).toBe(2);
  });
});
