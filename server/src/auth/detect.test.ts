import { describe, it, expect } from "vitest";
import { autoDetectSupported } from "./detect.js";

describe("autoDetectSupported", () => {
  it("is false on Windows (cookies are DPAPI / App-Bound encrypted)", () => {
    expect(autoDetectSupported("win32")).toBe(false);
  });

  it("is true on Linux and macOS", () => {
    expect(autoDetectSupported("linux")).toBe(true);
    expect(autoDetectSupported("darwin")).toBe(true);
  });
});
