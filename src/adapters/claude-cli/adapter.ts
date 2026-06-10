import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync }
  from "node:fs";
import { resolve, dirname, join } from "node:path";
import type { TargetAdapter, PreflightResult, OpResult, RestoreResult,
              PatchParams } from "../types";
import { sha256 } from "../../util/crypto";
import { resolveAsset } from "../../util/asset";
import { parseable, upsertStatusLine, upsertSpinnerVerbs, removeSpinnerVerbs,
         removeTopLevel }
  from "./settingsEdit";

const ABSENT = " VIBE-ADS-ABSENT";
const SCRIPT_NAME = "vibe-ads-statusline.mjs";
const FRESH_MS = 10 * 60 * 1000;

/** Resolve the shipped asset in BOTH unbundled (co-located src) and
 *  esbuild-bundled (dist/adapters/claude-cli/) layouts — mirrors the
 *  webview adapter's resolveBlockAsset contract. */
export function resolveStatuslineAsset(baseDir: string): string {
  return resolveAsset(baseDir, "adapters/claude-cli", "statusline.asset.mjs");
}

export class ClaudeCliStatuslineAdapter implements TargetAdapter {
  readonly name = "claude-cli-statusline";
  private readonly settings: string;
  private readonly home: string;

  /** Whether to write the `spinnerVerbs` override. Gated on the terminal CLI
   *  honouring the key (CC >= 2.1.143). Defaults to true (fail-open) so the
   *  surface works before async version detection resolves; cliSync flips it
   *  off only when it positively detects an older CLI. See cliVersion.ts. */
  spinnerVerbsSupported = true;

  /** @param settingsPath absolute path to ~/.claude/settings.json. The home
   *  dir (for ~/.vibe-ads) is its grandparent (<home>/.claude/settings.json). */
  constructor(settingsPath: string) {
    this.settings = resolve(settingsPath);
    this.home = dirname(dirname(this.settings));
  }

  private backupPath(): string { return this.settings + ".vibe-ads-backup"; }
  private vibeDir(): string { return join(this.home, ".vibe-ads"); }
  private scriptPath(): string { return join(this.vibeDir(), SCRIPT_NAME); }
  private cachePath(): string { return join(this.vibeDir(), "cli-ad.json"); }

  version(): string | null { return "cli"; }

  preflight(): PreflightResult {
    try {
      if (!existsSync(this.settings))
        return { ok: true, compatible: true, version: "cli" };
      const src = readFileSync(this.settings, "utf8");
      if (!parseable(src))
        return { ok: true, compatible: false, version: "cli",
                 reason: "settings.json not parseable" };
      return { ok: true, compatible: true, version: "cli" };
    } catch (e) {
      return { ok: false, compatible: false, version: null, reason: String(e) };
    }
  }

  private renderScript(): string {
    const tplPath = resolveStatuslineAsset(dirname(__filename));
    const tpl = readFileSync(tplPath, "utf8");
    return tpl
      .split("__VIBE_ADS_CLI_AD_PATH__").join(JSON.stringify(this.cachePath()))
      .split("__VIBE_ADS_FRESH_MS__").join(String(FRESH_MS));
  }

  private statusLineValue(): string {
    const cmd = `node ${JSON.stringify(this.scriptPath())}`;
    return JSON.stringify({ type: "command", command: cmd, padding: 0 });
  }

  /** The spinnerVerbs override value: replace CC's stock verb dictionary with
   *  the single ad line so the thinking-shimmer verb shows the ad. */
  private spinnerVerbsValue(adText: string): string {
    return JSON.stringify({ mode: "replace", verbs: [adText] });
  }

  // The CLI adapter writes TWO surfaces into ~/.claude/settings.json:
  //   1. `statusLine` — an OSC 8 clickable hyperlink rendered at the bottom
  //      of the terminal on every status-line refresh (the click surface).
  //   2. `spinnerVerbs` — the ad text in the thinking-shimmer verb slot,
  //      replacing CC's stock "Discombobulating…"/"Baking…" pool (a
  //      brand-impression surface; the terminal verb is not clickable).
  // spinnerVerbs is gated on `spinnerVerbsSupported` (CC >= 2.1.143; older
  // CLIs silently ignore the key). History: an earlier adapter dropped
  // spinnerVerbs because, when the SAME settings.json was read by the VS
  // Code webview, the plain-text verb masked block.desync failures (rich
  // anchor missing but a plain-text ad still showed → broken click telemetry
  // looked fine). That risk is unchanged but accepted: the desync detector
  // (desyncDetector.ts) is timestamp-based and fires + auto-reloads
  // regardless of the spinner verb, and the webview overlay is the dominant
  // surface there. CC reads spinnerVerbs at boot, so the verb only rotates
  // on the next CC session; the statusLine ad updates live.

  applyPatch(p: PatchParams): OpResult {
    try {
      const existed = existsSync(this.settings);
      const pristine = existed
        ? readFileSync(this.settings, "utf8") : null;
      if (pristine !== null && !parseable(pristine))
        return { ok: false, reason: "settings.json not parseable" };

      mkdirSync(dirname(this.settings), { recursive: true });

      if (!existsSync(this.backupPath()))
        writeFileSync(this.backupPath(),
          pristine === null ? ABSENT : pristine, "utf8");
      mkdirSync(this.vibeDir(), { recursive: true });
      const script = this.renderScript();
      // Idempotent: cliSync re-applies every 60s — skip the write when the
      // on-disk script is already byte-identical (no per-tick disk churn).
      if (!existsSync(this.scriptPath())
          || readFileSync(this.scriptPath(), "utf8") !== script)
        writeFileSync(this.scriptPath(), script, "utf8");

      const base = pristine ?? "{\n}\n";
      let next = upsertStatusLine(base, this.statusLineValue());
      // Gate the spinnerVerbs surface on CLI support. When supported, write
      // the ad as the replacement verb; otherwise REMOVE any spinnerVerbs
      // entry so an unsupported CLI keeps a clean settings.json and any
      // stale entry from a prior session heals on activation.
      next = this.spinnerVerbsSupported
        ? upsertSpinnerVerbs(next, this.spinnerVerbsValue(p.adText))
        : removeSpinnerVerbs(next);
      if (!existed || next !== pristine)
        writeFileSync(this.settings, next, "utf8");
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: String(e) };
    }
  }

  restore(): RestoreResult {
    try {
      const bak = this.backupPath();
      if (!existsSync(bak))
        return { ok: true, restored: false, reason: "no backup present" };
      const saved = readFileSync(bak, "utf8");
      // KEY-SCOPED restore — never a whole-file rollback. The backup is a
      // point-in-time snapshot from FIRST apply; the user may have edited
      // settings.json since (hooks, permissions, model config), and any
      // restore trigger (offline blip → killswitch fail-safe, sign-out,
      // deactivate) would silently destroy those edits. Instead remove ONLY
      // the keys we own from the CURRENT file; everything else survives
      // byte-for-byte (settingsEdit raw-text edits). The snapshot is kept
      // solely as the ABSENT sentinel: when the file didn't exist before us
      // and nothing but our keys was ever added, delete the shell we created.
      if (existsSync(this.settings)) {
        const cur = readFileSync(this.settings, "utf8");
        if (!parseable(cur))
          // User-edited into unparseable JSONC — we can't edit it safely, and
          // overwriting with the stale snapshot would destroy their edits.
          // Leave everything (incl. the backup) so a later restore can finish.
          return { ok: false, restored: false,
                   reason: "settings.json not parseable" };
        let next = removeTopLevel(cur, "statusLine");
        next = removeTopLevel(next, "spinnerVerbs");
        // The shell we created is `{}` plus whitespace; anything else left
        // (user keys, even bare comments) means the file is now theirs.
        const emptyShell = /^[\s{}]*$/.test(next);
        if (saved === ABSENT && emptyShell) {
          rmSync(this.settings);
        } else if (next !== cur) {
          writeFileSync(this.settings, next, "utf8");
          if (sha256(readFileSync(this.settings))
              !== sha256(Buffer.from(next, "utf8")))
            return { ok: false, restored: false,
                     reason: "sha256 mismatch after restore" };
        }
      }
      if (existsSync(this.scriptPath())) rmSync(this.scriptPath());
      if (existsSync(this.cachePath())) rmSync(this.cachePath());
      rmSync(bak);
      return { ok: true, restored: true };
    } catch (e) {
      return { ok: false, restored: false, reason: String(e) };
    }
  }
}
