# Plan: Transform Kickbacks.ai into "Dev Quotes" — a fully offline quote-spinner extension

## Context

This repo is a fork of **Kickbacks.ai** (ShiftKeys, Inc.), a VS Code extension that monetizes the Claude Code "thinking…" spinner by patching Claude Code's installed files to overlay clickable, server-fetched ads — with OAuth sign-in, telemetry, earnings, a remote killswitch, consent flow, and self-update.

Goal: make it the user's own (**user states they have written permission from ShiftKeys for this derivative**): a 100% offline extension named **Dev Quotes** that displays inspirational/educational programming quotes — one per line from a `.txt` file — where ads used to appear. All network access, ad machinery, and original branding removed. Quotes ship with a bundled default, overridable by the end user or an Intune admin.

### Decisions made with the user

| Decision | Choice |
|---|---|
| License | User has ShiftKeys permission; replace LICENSE, document the permission |
| Surfaces | Claude Code **panel spinner** + Claude **CLI status line**; **delete all Codex** code |
| Precedence | **Admin wins**: machine-wide Intune file → VS Code setting → user file → bundled default |
| Name | **Dev Quotes** — package `dev-quotes`, settings `devQuotes.*`, dirs `DevQuotes/` & `~/.devquotes/` |

### Key architectural insight (verified in source)

Ad text is **baked into the injected webview block at patch time** (`src/adapters/claude-code/adapter.ts` substitutes placeholders into `block.asset.js` and appends it to Claude Code's `webview/index.js`). The local loopback HTTP server, the CSP patch on Claude Code's `extension.js`, and every `fetch` exist **only** for ads/metrics/rotation. The quotes version bakes the **entire parsed quote list** into the patch and rotates client-side in the webview — zero servers, zero network, and one fewer Claude Code file touched (no CSP patch).

The CLI status-line surface (`src/adapters/claude-cli/statusline.asset.mjs`, wired into `~/.claude/settings.json`) is already pure-offline: a per-render Node one-shot that reads a local file and prints.

---

## Phase 0 — Baseline

1. Run `npm run typecheck && npm test` to record the green baseline (~130 tests).
2. Replace `LICENSE` with the user's chosen license (e.g. MIT) and add a note/`PERMISSION.md` documenting the ShiftKeys permission for the derivative.

## Phase 1 — Delete dead modules

Delete from `src/`:

- Whole dirs: `auth/`, `metrics/`, `earnings/`, `killswitch/`, `consent/`, `update/`, `portfolio/`, `viewTracking/`, `adapters/codex/`, `adapters/codex-cli/`, `activity/`
- Files: `adapters/registry.ts` (codex locator), `loopback.ts`, `util/loopback.ts`, `util/loopbackBoot.ts`, `util/http.ts`, `banner.ts`, `testHooks.ts`, `buildflags.ts`, `reloadSignal.ts`, `adapters/claude-cli/cliAd.ts`, `config.ts` (config moves to VS Code settings), `sessionState.ts`
- `activation/`: `adRotation.ts`, `cliTick.ts`, `codexFallback.ts`, `earningsRefresh.ts`, `selfUpdate.ts`, `statusBarAd.ts`, `desyncDetector.ts`, `outdatedCliNotice.ts`
- `util/crypto.ts`: keep only `sha256` (used by both adapters for write verification); delete token-sealing/manifest-signature helpers
- `reassert.ts`: delete `desyncDecision`/`DESYNC_DEFAULTS`; keep simplified `shouldReassert({ haveQuotes })`
- Media/scripts: `media/logos/`, `scripts/gen-logos.mjs`, `scripts/_brand.mjs`

After deleting, `npm run typecheck` enumerates every dangling import — use as the worklist for Phases 3–5.

## Phase 2 — New quotes module (`src/quotes/`)

**`src/quotes/provider.ts`** (pure, no vscode import, fully unit-testable):

```ts
export interface QuotesSource { kind: "machine"|"setting"|"user"|"bundled"; path: string }
export interface QuotesResult { quotes: string[]; source: QuotesSource; truncated: boolean }

export const MAX_QUOTES = 1000;
export const MAX_QUOTE_LEN = 300;            // chars/line, longer truncated with "…"
export const MAX_SERIALIZED_BYTES = 196_608; // ~192 KB JSON budget baked into the patch

machineQuotesPath(platform)  // win32: %ProgramData%\DevQuotes\quotes.txt (env var, C:\ProgramData fallback)
                             // darwin: /Library/Application Support/DevQuotes/quotes.txt
                             // linux:  /etc/devquotes/quotes.txt
userQuotesPath()             // ~/.devquotes/quotes.txt
candidatePaths(settingPath)  // ADMIN WINS: machine → setting → user → bundled
parseQuotes(text)            // split /\r?\n/, trim, drop blanks + "#" comments,
                             // strip control chars + U+2028/U+2029, reject lines containing
                             // "__DEV_QUOTES" (placeholder-injection guard), dedupe, apply caps
loadQuotes(settingPath, bundledPath)  // first existing + non-empty-after-parse wins
```

**`media/quotes.txt`** — curated default (~100 programming quotes, `#` header documenting the format).

**`src/quotes/watch.ts`** — `fs.watchFile` (~5 s interval, same pattern as the old config watcher) on **all** candidate paths, so an Intune push *creating* the machine file triggers re-resolution; debounce and fire `onChange` only on real parsed-content change.

## Phase 3 — Rework Claude Code adapter + injected block

### 3a. `src/adapters/types.ts`
New `PatchParams = { quotes: string[]; rotationMs: number; cliQuotePaths?: string[]; debug?: boolean }`. Drop tier/adText/icon/click/loopback/banner/viewThreshold fields and `prime?()` (CSP gone). Keep `preflight/applyPatch/restore/isPatched/diagnose`.

### 3b. `src/adapters/claude-code/adapter.ts`
Keep the proven machinery (anchors, atomic write, backup taint guards, preflight, diagnose). Changes:
- Markers `/* DEV-QUOTES-START */ … END`; widen the strip regex + `isPatched`/taint checks to **also recognize legacy `VIBE-ADS` markers** → first apply auto-cleans an install patched by the original.
- Backup `webview/index.js.dev-quotes-backup`; `legacyBackupPaths()` also checks `.kickbacks-backup`/`.vibe-ads-backup`.
- **Delete the entire CSP layer**, but add one-time legacy cleanup: if `extension.js.vibe-ads-backup` exists, restore `extension.js` from it and delete the backup.
- `renderBlock`: substitute `__DEV_QUOTES_LIST__` = `JSON.stringify(quotes)` (then escape U+2028/U+2029), `__DEV_QUOTES_ROTATE_MS__`, `__DEV_QUOTES_DEBUG__`.
- `restore()` loses `keepCsp`; temp suffix `.dev-quotes-tmp-…`.

### 3c. `src/adapters/claude-code/block.asset.js` (~1269 → ~550 lines)
**Delete:** all loopback plumbing (BASE/PORT/token, `ping`, `pollAd`, `pollActivity`, no-serve latch, dock retarget), the whole view-time accumulator, click capture listener + anchor, icon/favicon + error listener, usage-banner subsystem, impression events, transcript second-opinion. **Zero `fetch` remains.**
**Keep verbatim** (React-safe core): `findSpinner` (`[class*="spinnerRow_"]`, last non-empty), `rowActive` glyph liveness, freshness signature + `GRACE_MS`, body-level overlay (`ensureOverlay`/`placeOverlay`/`surfaceBg`), idle dock-to-composer, `dropOverlay`, render loop + visibility re-evaluate, `module.exports` test hook, outer try/catch.
**New quote logic:** `QUOTES`/`ROTATE_MS` baked in; random start index, `nextQuote()` sequential; new quote on every idle→active transition (hook: `paint()` when `st.simStart === 0`); mid-turn rotation every `ROTATE_MS` (0 = off). `buildQuoteHtml` replaces `buildAdHtml`: non-clickable styled text (optional dim `❝` glyph) + the kept animated dots and right-pinned elapsed timer; text always through the kept `esc()`. Empty list ⇒ block no-ops. Debug = `console.debug("[dev-quotes]", …)` gated on `__DEV_QUOTES_DEBUG__` — local only.
**Known behavior:** the panel picks up quotes-file edits on next webview/window reload (list is baked in); the statusline is live. Document; optionally show the existing reload nudge once on change.

## Phase 4 — CLI status-line surface

**Approach: statusline script reads the resolved quotes.txt directly** (no cache JSON, no extension timer — the cache only existed because ads came from a server).

- **4a. `statusline.asset.mjs` rewrite (~40 lines):** placeholders `__DEV_QUOTES_PATHS__` (candidate paths in precedence order incl. bundled `dist/media/quotes.txt`) + `__DEV_QUOTES_ROTATE_MS__`. Reads first existing file, same parse rules, deterministic time-bucket selection (`Math.floor(Date.now()/bucket) % n` — stable within a window, rotates naturally), strips control chars, hard-truncates ~120 chars, prints `❝ quote`, never throws. No OSC 8 hyperlink.
- **4b. `adapters/claude-cli/adapter.ts`:** keep key-scoped settings edit/restore (`settingsEdit.ts` unchanged). Script `~/.devquotes/dev-quotes-statusline.mjs`; backup `settings.json.dev-quotes-backup` + legacy `.vibe-ads-backup` recognition; `restore()` also removes legacy `~/.vibe-ads/vibe-ads-statusline.mjs` + `cli-ad.json`. `spinnerVerbsValue()` → `{ mode: "replace", verbs: quotes.filter(q => q.length <= 60).slice(0, 30) }` so CC ≥ 2.1.143 rotates quotes natively in the terminal spinner (keep `cliVersion.ts` gating).
- **4c. `activation/cliSync.ts` → ~50 lines:** verdict `write` → `applyPatch`, `restore` → restore, `freeze` → no-op; keep the 60 s idempotent reassert and `syncNow` (called by the quotes watcher); delete metrics/codex wiring.

## Phase 5 — Rewrite activation

- **5a. `servingGate.ts`:** remove kill posture entirely; verdict = `!enabled → "restore"`, `suspended → "freeze"`, else `"write"`.
- **5b. `debug.ts` (controller):** delete loopback/auth/metrics/portfolio/codex hooks; keep `K_ON` persistence as `devQuotes.on` (with legacy `kickbacks.debug.on`/`vibe-ads.debug.on` reads for migration), `setOn`, `reapplyIfOn`, `cyclePatch`, `reassertTick`, `doRestore`, menu. New menu: Enable/Disable · Edit quotes file (creates `~/.devquotes/quotes.txt` from bundled default) · Show active quotes source · Re-apply now · Restore Claude Code · Open debug log. `apply()` builds params from an injected `quotesProvider`.
- **5c. `activation/webviewInjection.ts` → ~60 lines:** apply once (gated `canPatch() && webviewMode()==="on" && claudeCompatible`), 60 s `isPatched()` reassert (heals CC self-updates), `cycleReassert` (restore+apply, used by boot canary), `reapplyNow` (quotes watcher hook). `adRotation.ts` is deleted — rotation lives in the webview; re-patch happens only on quotes-file change. Desync ladder dropped (its heartbeat was loopback telemetry); remaining healing = boot `cyclePatch` + 60 s reassert + first-run reload nudge.
- **5d. `extension.ts` rewrite (~150 lines):**
  ```
  activate: locate CC → adapter → legacyCleanup (extension.js CSP backup restore)
    → preflight → statusBar → quotesState = loadQuotes(setting, bundled)
    → DebugController + wireServingGateEnabled
    → register devQuotes.{menu,enable,disable,restore,status,diagnose,editQuotes,openQuotesFile}
    → if incompatible: status bar + notice + CLI strand-restore → return
    → bootCanary (firstRun ⇒ reload nudge) → setupWebviewInjection → setupCliSync
    → watchQuoteSources(onChange: reload quotes, wv.reapplyNow(), cli.syncNow())
    → onDidChangeConfiguration("devQuotes") → onChange
    → 60 s reassertTick timer
  deactivate: clear timers, unlink ~/.devquotes/boot.canary,
    if (!debugCtl.on()) adapter.restore(), always cliStatus.restore()
  ```
  No BASE/auth/kill/consent/serving-retry/loopback teardown.
- **5e. Remaining files:** `bootCanary` (path `~/.devquotes/boot.canary`, key `devQuotes.firstRun.completed`), `reloadNudge`/`incompatNotice` (rebrand; drop sign-in nudge), `diagnose` (+ quotes-resolution section: source kind/path/count/truncated), `commands.ts` (new set, **no legacy aliases**), `context.ts` (trim to `{timers, ccAdapter, cliStatus, debugCtl}`), `statusbar.ts` (states: `Dev Quotes ✓ · N quotes` / off / incompatible / needs-reload), `modes.ts` (sentinels under `~/.devquotes/`: keep `webview.off`/`cli.off` only), `log.ts` (dir `~/.devquotes/`, env `DEV_QUOTES_DEBUG=1`), `locate.ts` (keep CC locator, env `DEV_QUOTES_CC_TARGET`; delete log/transcript locators). Keep `util/asset.ts`, `util/claudeCodeVersion.ts`, `util/errMsg.ts`, `buildinfo.ts`.

## Phase 6 — Rebrand & packaging

- **package.json:** `name: "dev-quotes"`, `displayName: "Dev Quotes"`, user's publisher/repo/homepage, version `1.0.0`, keywords (`claude-code`, `quotes`, `motivation`). Settings:
  - `devQuotes.quotesFile` (string, ""): absolute path; overridden by the machine-wide file; overrides `~/.devquotes/quotes.txt`
  - `devQuotes.rotationSeconds` (number, 30, min 0): mid-turn rotation; 0 disables
  Delete `menus` block, test commands, all `kickbacks.*`/`vibe-ads.*` commands.
- **esbuild.mjs:** drop `.env`/BUILD_FLAGS defines; copy `block.asset.js`, `statusline.asset.mjs`, and `media/quotes.txt` → `dist/media/quotes.txt` (+ `bundledQuotesPath()` with src-tree fallback for vitest); remove codex assets.
- **scripts/package.mjs:** artifact `dev-quotes.vsix`; stage `media/quotes.txt`. **scripts/gen-icon.mjs:** replace with a simple procedural icon (no Playwright); commit new `media/icon.png`.
- **Sweep:** `grep -ri "kickbacks\|vibe-ads\|vibads\|shiftkeys\|KICKBACKS_\|VIBE_ADS_" src test scripts *.md *.json` → zero hits except deliberate legacy-cleanup constants (each annotated `// legacy cleanup`).
- **README.md** rewrite (delete/rewrite `readme_extension.md`): what it does, **privacy statement ("100% offline — zero network requests")**, quote-file format, precedence table, settings/commands, safety/restore behavior, and an **Intune section**: deploy `quotes.txt` to `%ProgramData%\DevQuotes\quotes.txt` via Win32 app or Platform Scripts PowerShell (`New-Item -ItemType Directory -Force "$env:ProgramData\DevQuotes"; Copy-Item …`); macOS MDM script → `/Library/Application Support/DevQuotes/quotes.txt`; Linux config mgmt → `/etc/devquotes/quotes.txt`. Note: machine file always wins; changes are live on the CLI statusline, on-reload for the panel.

## Phase 7 — Tests

- **Delete** all network/business tests: auth, metrics, portfolio, earnings, killswitch/killEnforcement, consent*, loopback*, update*, selfUpdateWiring, rotation, adRotation-token-refresh, attribution, click-telemetry, viewTimer/cc-viewtimer, cliTick, banner, all codex*, statusBarAd, earningsRefresh, servingRetry, testHooks, hooksE2E, dedupe, vault, reloadSignal, localVsixWatcher, logTail/locateLog, registry, cc-pollad, audit-deferred-xfail, incident-guards (review), icon-render. Delete `test/fixtures/synthetic-thinking-shimmer.js`.
- **Keep & adapt:** `adapter` + `backup-safety` (new markers/backups; **add legacy-marker strip + legacy-backup restore cases**), `block` + `cc-spinner-detect` (assert quote rendering, no anchor/icon), `cli-statusline` (direct-read script + spinnerVerbs), `commands`, `debug`, `diagnose`, `extension`/`extension-lifecycle`/`e2e` (heavy trim), `servingGate` (no kill), `reassert`, `statusbar`, `statusbarReloadLock`, `honest-incompatible`, `incompatNotice`, `reloadNudge`, `log`, `modes`, `smoke`, `buildinfo`, `claudeCodeVersion`. Keep `test/fixtures/synthetic-index.js`, `test/mocks/vscode.ts`.
- **New:** `quotes-provider.test.ts` (per-platform paths, admin-wins precedence, parsing rules, caps/truncated, empty-file fall-through), `quotes-watch.test.ts` (change fires; higher-precedence file creation re-resolves; touch doesn't), `block-quotes.test.ts` (jsdom: renders over synthetic spinnerRow, new quote per turn, rotation, **assert a global fetch spy is never called**, idle dock), `statusline-quotes.test.ts` (run rendered .mjs via node against temp files; precedence; bucket rotation).

## Phase 8 — Verification

1. `npm run typecheck` and `npm test` green.
2. `npm run build && npm run package` → `dev-quotes.vsix`; inspect: `dist/media/quotes.txt` present, no codex assets.
3. `grep -c "fetch(" dist/.../block.asset.js` → 0; `grep -ri kickbacks dist/` → only annotated legacy-cleanup constants.
4. Manual with Claude Code installed: install vsix → reload → quote overlays the spinner, new quote per turn + 30 s rotation, idle docks above composer; `Dev Quotes: Restore` → `webview/index.js` byte-identical to backup; Diagnose renders.
5. Precedence: create machine file (`sudo mkdir -p /etc/devquotes && echo "machine quote" | sudo tee /etc/devquotes/quotes.txt`) → watcher re-patches, diagnose shows `source: machine`; delete → falls back.
6. CLI: statusline shows a quote and live-updates on quotes.txt edits; CC ≥ 2.1.143 spinner verbs are quotes; uninstall → settings.json keys restored, script removed.
7. Migration: against a Kickbacks-patched CC install, first apply strips `/* VIBE-ADS-START */`, restores `extension.js` from `.vibe-ads-backup`, removes legacy `~/.vibe-ads` statusline artifacts.

## Risks / open issues

- **Patch size:** triple cap (1000 quotes / 300 chars / ~192 KB) bounds the baked list; surface `truncated` in diagnose + one-time toast.
- **Escaping:** `JSON.stringify` + U+2028/29 escape + control-char strip + `__DEV_QUOTES` line rejection prevents patch self-corruption; quote text only enters HTML via the kept `esc()`.
- **Stale webview after quote edits:** panel needs reload (documented); statusline is live.
- **Desync detector heartbeat is gone** (was loopback telemetry): rely on boot cyclePatch + 60 s reassert + reload nudge; never re-add network.
- **spinnerVerbs ergonomics:** filter to ≤60-char quotes, cap 30 entries; verbs refresh on CC session start (existing behavior).
- **`%ProgramData%`:** resolve via `process.env.ProgramData` with `C:\ProgramData` fallback; platform injected in tests.
- **Legacy `~/.vibe-ads/`:** remove only artifacts we created (statusline script, cli-ad.json); leave the dir.
