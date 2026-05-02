# Copy-transcript flakiness — automated troubleshooting plan

## Symptom
On a fresh YouTube watch page, clicking **Copy transcript** sometimes succeeds
("Copied (Korean, auto-generated).") and sometimes shows:

> No captions from timedtext, InnerTube, or transcript panel.
> Refresh, restart playback, retry — or use local yt-dlp for this URL.

The existing single-shot E2E (`e2e/extension.spec.ts > "Copy transcript on
YOhZd1-AkNk"`) passed on the most recent run, which matches the user report
that it "sometimes worked but most of the time it didn't" — i.e. flaky.

## Goals
1. Reproduce the failure reliably without manual clicking.
2. Capture enough state per attempt to tell *which* of the three transcript
   sources failed (timedtext URL fetch / InnerTube `get_transcript` /
   transcript-panel scrape) and *why* (HTTP status, body length, panel state,
   video data readiness).
3. Iterate fix → run-loop until the test passes **5 times in a row**, then
   stop and report.

## Scope of automation
- New test (or a new spec file) `e2e/copy-flake.spec.ts` that re-uses the
  existing diagnostic helpers but: per attempt, opens a fresh page, captures
  status text + classification + console + network-style diag into
  `test-results/diag/run-<N>/`.
- A PowerShell harness `scripts/copy-flake-loop.ps1` that:
  - takes `-Runs <N>` (default 10) and `-StopOnFirstFailure` (default off),
  - runs `npm run test:e2e -- --grep "copy-flake"` in a loop,
  - aggregates pass/fail + failure reason + dominant-failed-source into
    `test-results/diag/summary.json` and a printed table,
  - exits non-zero if the most recent 5 runs are not all passes (this is the
    "verified 5x" stop condition).
- Nothing in the extension changes in this step. The harness is read-only
  diagnostics.

## Failure-classification taxonomy (what the harness records per run)
| Code | Means |
|------|-------|
| `OK` | status text matches `Copied`. |
| `EMPTY_TRACKS` | `getPlayerResponse().captions` had 0 caption tracks. |
| `TIMEDTEXT_EMPTY` | timedtext fetches returned 0-byte / 200-empty bodies. |
| `INNERTUBE_NO_KEY` | `INNERTUBE_API_KEY`/params not exposed yet on `window`. |
| `INNERTUBE_EMPTY` | InnerTube `get_transcript` returned no segments. |
| `PANEL_HIDDEN` | transcript engagement panel never rendered segments. |
| `CLIPBOARD_BLOCKED` | every transcript source returned text but
  `navigator.clipboard.writeText` + textarea fallback both failed. |
| `EXT_RELOAD` | "Extension was reloaded — please refresh this page" path. |
| `OTHER` | anything else; raw status text saved verbatim. |

The harness derives the code from the saved `diag-after-copy.txt` and the
status string the extension wrote in the page.

## Hypotheses to validate from the first batch
H1. Player data not ready: the click fires before `ytInitialPlayerResponse`
    is populated, so `captions.playerCaptionsTracklistRenderer.captionTracks`
    is empty for that attempt. Mitigation candidate: in `content.js`
    `onCopyClick`, also wait on `getPlayerResponse()` having tracks before
    the first attempt, not just retry the whole pipeline 3×4 s.

H2. Stale SPA state across two runs in the same browser session: the test
    currently navigates with `goto`, but YouTube's SPA may keep
    `transcriptCache` from a previous video. The reconcile already nulls it
    on vid mismatch; verify per-run that `videoIdFromUrl()` matches.

H3. timedtext returning 200 with empty body for `kind=asr` Korean tracks
    when the page hasn't finished initial caption fetch. Captured per
    attempt by re-fetching every URL variant and recording status + length.

H4. Clipboard permission lost when the page hasn't received a real user
    gesture in this session (Playwright's programmatic `click()` should
    count, but Brave/profile policy may differ). The harness records
    `navigator.permissions.query({name:'clipboard-write'})` per run.

## Loop control
- Phase A — *measurement*: run 10× with no fix applied, dump summary.
- Phase B — *fix proposal*: I'll write a one-paragraph diagnosis and a
  concrete code change for **your review**. No edit until you say go.
- Phase C — *verification*: after you say go, apply the fix, then run the
  harness with `-Runs 10`. Stop and report success when the **last 5 runs
  in a row** are `OK`. If a failure occurs after a streak starts, the
  streak resets; if 10 runs finish without a 5-streak, stop and re-enter
  Phase B with the new data.

## What I need from you to start Phase A autonomously
- Confirm Brave is the browser to use (auto-detected) or set `BRAVE_PATH`.
- Confirm the regression video URL is still
  `https://www.youtube.com/watch?v=YOhZd1-AkNk` (the one used in the
  current spec). If you'd rather use the URL from the screenshot
  (`blxtjqlMiXM`), say so and I'll switch the loop to that.
- Approve running the 10-iteration measurement batch (no extension edits).

## Files this plan will add
- `e2e/copy-flake.spec.ts`
- `scripts/copy-flake-loop.ps1`
- `test-results/diag/run-<N>/...` (generated, gitignored if you use one)
- `docs/copy-button-troubleshooting-plan.md` (this file)
