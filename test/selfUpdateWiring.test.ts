// audit-2026-06-09 #38 regression: setupSelfUpdate must wire UpdateClient
// with the timeout-wrapped fetch (timeoutFetch(120000)), not bare global
// fetch — a black-holed manifest/VSIX connection otherwise hangs checkOnce
// forever (and, with the #31 single-flight guard, silently wedges every
// later 90s poll behind the stuck one). Pin: every request the updater
// makes carries an AbortSignal.
import { describe, it, expect, vi, afterEach } from "vitest";
import { setupSelfUpdate } from "../src/activation/selfUpdate";
import { makeContext } from "./mocks/vscode";

afterEach(() => { vi.unstubAllGlobals(); });

describe("setupSelfUpdate fetch wiring (audit #38)", () => {
  it("manifest polls carry an abort signal (timeoutFetch, not bare fetch)", async () => {
    const inits: (RequestInit | undefined)[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      inits.push(init);
      // Not-newer version -> checkOnce stops after the manifest fetch.
      return { ok: true, json: async () => ({ version: "0.0.0",
        sha256: "x", url: "http://b/x.vsix" }) } as Response;
    }));
    const timers: NodeJS.Timeout[] = [];
    const watchFileFn =
      (() => {}) as unknown as typeof import("node:fs").watchFile;
    try {
      const { updater } = setupSelfUpdate(
        makeContext() as never, "http://b", "0.1.0", undefined, 0,
        watchFileFn, timers, 60_000);
      expect(await updater.checkOnce()).toBe(false);
      expect(inits).toHaveLength(1);
      // Pre-fix: bare global fetch was called with NO init at all.
      expect(inits[0]?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      for (const t of timers) clearInterval(t);
    }
  });
});
