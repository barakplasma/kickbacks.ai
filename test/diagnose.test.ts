import { describe, it, expect } from "vitest";
import { interpret, formatDiagnostics } from "../src/activation/diagnose";
import type { AdapterDiagnostics, TargetAdapter } from "../src/adapters/types";

function diag(over: Partial<AdapterDiagnostics> = {}): AdapterDiagnostics {
  return {
    name: "claude-code", target: "/x/anthropic.claude-code-2.1.161/webview/index.js",
    targetExists: true, version: "2.1.161", compatible: false, isPatched: false,
    backup: { exists: false, path: null, hasArray: false, hasBlock: false },
    live: { hasArray: false, bareVerbPresent: false },
    ...over,
  };
}

describe("interpret (diagnose verdict)", () => {
  it("compatible + live block → OK/live", () => {
    expect(interpret(diag({ compatible: true, isPatched: true }))).toMatch(/OK.*live/i);
  });

  it("target missing → Claude Code not found", () => {
    expect(interpret(diag({ targetExists: false }))).toMatch(/not found/i);
  });

  it("verb word present but not in an array → bundle format change → fix regex", () => {
    const v = interpret(diag({ live: { hasArray: false, bareVerbPresent: true } }));
    expect(v).toMatch(/bundle format/i);
    expect(v).toMatch(/regex|anchor/i);
  });

  it("no verb word + no backup array → stripped/corrupted → reinstall Claude Code", () => {
    const v = interpret(diag({ live: { hasArray: false, bareVerbPresent: false } }));
    expect(v).toMatch(/reinstall.*claude code/i);
  });

  it("stale backup but live OK → self-heal → update Kickbacks", () => {
    const v = interpret(diag({
      backup: { exists: true, path: "/x.bak", hasArray: false, hasBlock: false },
      live: { hasArray: true, bareVerbPresent: true },
    }));
    expect(v).toMatch(/self-heal|update Kickbacks/i);
  });
});

describe("formatDiagnostics", () => {
  it("renders the CC section, preflight, and a verdict", () => {
    const cc = {
      name: "claude-code",
      diagnose: () => diag({ compatible: false, reason: "verb array not found (incompatible build)",
        live: { hasArray: false, bareVerbPresent: false } }),
    } as unknown as TargetAdapter;
    const report = formatDiagnostics(cc, null);
    expect(report).toContain("Kickbacks Diagnostics");
    expect(report).toContain("PREFLIGHT compatible: false");
    expect(report).toContain("preflight reason: verb array not found");
    expect(report).toMatch(/VERDICT:/);
    expect(report).toMatch(/reinstall.*claude code/i);
  });

  it("degrades gracefully when the adapter has no diagnose()", () => {
    const cc = { name: "claude-code" } as unknown as TargetAdapter;
    expect(formatDiagnostics(cc, null)).toContain("no diagnose() available");
  });
});
