import { describe, it, expect, vi, afterEach } from "vitest";
import { setupAdRotation, type AdRotationDeps } from "../src/activation/adRotation";
import type { PatchAd, PortfolioResponse } from "../src/portfolio/client";

// Regression: the server mints a FRESH session token on every /v1/portfolio(/demo)
// fetch (300s TTL). adRotation used to discard the refreshed response whenever the
// ad SET (adId signature) was unchanged — so the in-use `activeAd.sessionToken`
// aged out and every billable view event started returning 403 after ~5 min on
// stable inventory. The fix adopts the fresh token without re-patching the overlay.

function ad(adId: string, sessionToken: string): PatchAd {
  return {
    adId, campaignId: "c-" + adId, adText: "Ad " + adId,
    iconRef: "i", iconUrl: "", clickUrl: "https://x.test",
    bannerEnabled: false, sessionToken,
  };
}

function resp(ads: PatchAd[]): PortfolioResponse {
  return {
    ad: ads[0] ?? null, ads, queueId: "q", ttlMs: 60_000,
    rotationIntervalMs: 120_000, viewThresholdMs: 3_000, balances: null,
  };
}

function makeDeps(initial: PortfolioResponse, fetchImpl: () => Promise<PortfolioResponse>) {
  const timers: NodeJS.Timeout[] = [];
  const activeAdRef = { current: initial.ads[0] };
  const adRef = { current: initial.ads[0] as PatchAd | null };
  const applyPatch = vi.fn(() => ({ ok: true }));
  const deps = {
    adapter: { applyPatch, isPatched: () => true,
               preflight: () => ({ compatible: true }), restore: () => {} },
    portfolio: { fetchPortfolio: fetchImpl, fetchDemoPortfolio: fetchImpl },
    auth: { accessToken: () => "tok", clientId: () => "cid" },
    debugCtl: { setPortfolioAd: vi.fn() },
    session: { set: vi.fn() },
    ccVersion: "2.1.167",
    port: 12345,
    patchParams: { adText: "", iconRef: "", iconUrl: "", clickUrl: "" },
    activeAdRef,
    corrRef: { current: "corr" },
    adRef,
    impDedupe: { reset: vi.fn() },
    reapplyCodex: null,
    timers,
  } as unknown as AdRotationDeps;
  return { deps, timers, activeAdRef, adRef, applyPatch };
}

describe("adRotation session-token refresh", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { cleanups.forEach((c) => c()); cleanups.length = 0; });

  it("adopts the fresh session token when the ad set is unchanged (no re-patch)", async () => {
    const initial = resp([ad("a1", "tok-OLD")]);
    const fetchImpl = vi.fn(async () => resp([ad("a1", "tok-NEW")])); // same adId, new token
    const { deps, timers, activeAdRef, adRef, applyPatch } = makeDeps(initial, fetchImpl);
    cleanups.push(() => timers.forEach((t) => clearInterval(t as unknown as NodeJS.Timeout)));

    const handle = setupAdRotation(deps, initial);
    applyPatch.mockClear();              // ignore any setup-time apply
    await handle.refreshNow(false);      // unchanged ad set → must still refresh token

    expect(fetchImpl).toHaveBeenCalled();
    expect(activeAdRef.current.sessionToken).toBe("tok-NEW");
    expect(adRef.current?.sessionToken).toBe("tok-NEW");
    // Unchanged text/clickUrl ⇒ the overlay must NOT be re-patched on a pure
    // token refresh (no visible churn, no loopback re-mint).
    expect(applyPatch).not.toHaveBeenCalled();
  });

  it("still swaps fully (re-patch) when the ad actually changes", async () => {
    const initial = resp([ad("a1", "tok-OLD")]);
    const fetchImpl = vi.fn(async () => resp([ad("a2", "tok-A2")])); // different adId
    const { deps, timers, activeAdRef, applyPatch } = makeDeps(initial, fetchImpl);
    cleanups.push(() => timers.forEach((t) => clearInterval(t as unknown as NodeJS.Timeout)));

    const handle = setupAdRotation(deps, initial);
    applyPatch.mockClear();
    await handle.refreshNow(false);

    expect(activeAdRef.current.adId).toBe("a2");
    expect(activeAdRef.current.sessionToken).toBe("tok-A2");
    expect(applyPatch).toHaveBeenCalled(); // real ad change ⇒ overlay re-patched
  });
});
