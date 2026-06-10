import { describe, it, expect } from "vitest";
import { applyMissStatus } from "../src/activation/webviewInjection";

// Regression: a transient injection miss (loopback port race on
// reload/self-update, or a single applyPatch failure) must NOT relabel a
// still-live, ad-serving block as "incompatible". This was the cosmetic
// "Kickbacks incompatible" label users saw while ads were actually serving.
describe("applyMissStatus (honest incompatible label)", () => {
  it("defers to active (null) when the block is already live", () => {
    expect(applyMissStatus(true, "2.1.161")).toBeNull();
  });

  it("reports incompatible ONLY when the target is genuinely un-patched", () => {
    expect(applyMissStatus(false, "2.1.161"))
      .toEqual({ kind: "incompatible", version: "2.1.161" });
  });
});
