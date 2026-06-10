import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// locate.ts reads join(homedir(), ".claude", "projects") — point homedir at a
// per-test temp root (everything else on node:os stays real).
const h = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof import("node:os")>();
  return { ...os, homedir: () => h.home };
});

import { locateClaudeCodeLog, transcriptEntrypoint } from "../src/locate";

function freshHome(): string {
  h.home = mkdtempSync(join(tmpdir(), "vibe-ads-locate-"));
  return h.home;
}
function projDir(home: string, name = "p1"): string {
  const d = join(home, ".claude", "projects", name);
  mkdirSync(d, { recursive: true });
  return d;
}
// One transcript record per call; `entrypoint` omitted when undefined
// (queue-operation lines / older CC builds carry no tag).
const rec = (entrypoint?: string, extra: object = {}): string =>
  JSON.stringify({ type: "user",
    message: { role: "user", content: "hi" },
    ...(entrypoint ? { entrypoint } : {}), ...extra }) + "\n";
function backdate(f: string, ms: number): void {
  const t = (Date.now() - ms) / 1000;
  utimesSync(f, t, t);
}

beforeEach(() => {
  delete process.env.KICKBACKS_CC_LOG;
  delete process.env.VIBE_ADS_CC_LOG;
  freshHome();
});

describe("transcriptEntrypoint", () => {
  it('reads the first tagged record, skipping untagged head lines', () => {
    const d = projDir(h.home);
    const f = join(d, "s.jsonl");
    writeFileSync(f,
      JSON.stringify({ type: "queue-operation", operation: "enqueue" }) + "\n"
      + rec("claude-vscode"), "utf8");
    expect(transcriptEntrypoint(f)).toBe("claude-vscode");
  });

  it("null for an untagged transcript (older CC builds)", () => {
    const d = projDir(h.home);
    const f = join(d, "s.jsonl");
    writeFileSync(f, rec(undefined), "utf8");
    expect(transcriptEntrypoint(f)).toBeNull();
  });

  it("null for a missing file (never throws)", () => {
    expect(transcriptEntrypoint(join(h.home, "nope.jsonl"))).toBeNull();
  });

  it("is not spoofed by message TEXT that quotes the tag", () => {
    const d = projDir(h.home);
    const f = join(d, "s.jsonl");
    writeFileSync(f, JSON.stringify({ type: "user",
      message: { role: "user", content: 'see "entrypoint":"cli" in docs' },
    }) + "\n", "utf8");
    expect(transcriptEntrypoint(f)).toBeNull();
  });
});

// Audit #24: the documented 'prefer entrypoint:"claude-vscode"' filter — a
// terminal-CLI transcript must not masquerade as VS Code panel activity.
describe("locateClaudeCodeLog entrypoint filter", () => {
  it("prefers the newest claude-vscode transcript over a NEWER terminal-CLI one", () => {
    const d = projDir(h.home);
    const vscode = join(d, "vscode.jsonl");
    const cli = join(d, "cli.jsonl");
    writeFileSync(vscode, rec("claude-vscode"), "utf8");
    writeFileSync(cli, rec("cli"), "utf8");
    backdate(vscode, 60_000);                  // CLI session moved last
    expect(locateClaudeCodeLog()).toBe(vscode);
  });

  it("falls back to the newest UNTAGGED transcript (older CC builds)", () => {
    const d = projDir(h.home);
    const older = join(d, "older.jsonl");
    const newer = join(d, "newer.jsonl");
    writeFileSync(older, rec(undefined), "utf8");
    writeFileSync(newer, rec(undefined), "utf8");
    backdate(older, 60_000);
    expect(locateClaudeCodeLog()).toBe(newer);
  });

  it('returns "" (no signal) when every candidate is a terminal-CLI session', () => {
    const d = projDir(h.home);
    writeFileSync(join(d, "a.jsonl"), rec("cli"), "utf8");
    writeFileSync(join(d, "b.jsonl"), rec("cli"), "utf8");
    expect(locateClaudeCodeLog()).toBe("");
  });

  it('returns "" when no transcripts exist at all', () => {
    expect(locateClaudeCodeLog()).toBe("");
  });
});
