/**
 * Copy-transcript flake hunt.
 *
 * Per-attempt: fresh browser context (so SPA cache, in-memory transcriptCache,
 * and the extension's storage start clean), navigate to the URL passed via
 * COPY_FLAKE_URL (default = the screenshot URL, blxtjqlMiXM), click Copy,
 * record everything into test-results/diag/run-<ts>/.
 *
 * Drives one attempt per `npx playwright test` invocation so that the
 * PowerShell harness can loop and aggregate.
 */

import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const EXTENSION_DIR = path.resolve(process.cwd(), "extension");

const PRIMARY_URL = process.env.COPY_FLAKE_URL || "https://www.youtube.com/watch?v=blxtjqlMiXM";
const RUN_TAG = process.env.COPY_FLAKE_RUN_TAG || `run-${Date.now()}`;
const DIAG_ROOT = path.resolve(process.cwd(), "test-results", "diag", RUN_TAG);

const BRAVE_CANDIDATES = [
  process.env.BRAVE_PATH,
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
].filter(Boolean) as string[];

function resolveChannelExecutable(): { channel?: "chromium"; executablePath?: string } {
  if (process.env.USE_PLAYWRIGHT_CHROMIUM === "1") return { channel: "chromium" };
  for (const p of BRAVE_CANDIDATES) {
    try { if (p && fs.existsSync(p)) return { executablePath: p }; } catch { /* */ }
  }
  return { channel: "chromium" };
}

async function dismissConsentIfAny(page: Page) {
  try {
    const btn = page.locator(
      'button:has-text("Accept all"), button:has-text("Reject all"), ' +
      'button:has-text("I agree"), button:has-text("동의"), ' +
      'form[action*="consent"] button'
    ).first();
    if (await btn.isVisible({ timeout: 4000 }).catch(() => false)) {
      await btn.click();
      await page.waitForTimeout(1500);
    }
  } catch { /* */ }
}

/** Snapshot of what the extension's transcript pipeline would see. */
async function probePage(page: Page) {
  return page.evaluate(async () => {
    const out: any = {
      url: location.href,
      readyState: document.readyState,
      ts: Date.now(),
    };
    const player: any = document.querySelector("#movie_player");
    out.moviePlayer = !!player;
    let pr: any = null;
    try { pr = (window as any).ytInitialPlayerResponse || null; } catch {}
    if (!pr && player?.getPlayerResponse) {
      try { pr = player.getPlayerResponse(); } catch {}
    }
    out.playerResponse = !!pr;
    out.videoIdFromPlayer = pr?.videoDetails?.videoId || "";
    out.playabilityStatus = pr?.playabilityStatus?.status || "";
    out.playabilityReason = pr?.playabilityStatus?.reason || "";
    out.hasVideoDetails = !!pr?.videoDetails;
    out.hasCaptionsBlock = !!pr?.captions;
    // Source check: is ytInitialPlayerResponse the same object reference?
    try {
      const yipr = (window as any).ytInitialPlayerResponse;
      out.yiprPresent = !!yipr;
      out.yiprVideoId = yipr?.videoDetails?.videoId || "";
      out.yiprPlayability = yipr?.playabilityStatus?.status || "";
      out.yiprHasCaptions = !!(yipr?.captions);
      out.prFromYipr = pr === yipr;
    } catch { out.yiprPresent = "err"; }
    // Also check the live player object
    try {
      const live = player?.getPlayerResponse?.();
      out.livePresent = !!live;
      out.liveVideoId = live?.videoDetails?.videoId || "";
      out.livePlayability = live?.playabilityStatus?.status || "";
      out.liveHasCaptions = !!(live?.captions);
    } catch { out.livePresent = "err"; }
    const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    out.captionTracks = tracks.length;
    out.tracks = tracks.map((t: any) => ({
      lang: t.languageCode, kind: t.kind || "", baseUrlLen: (t.baseUrl || "").length,
    }));

    // Permissions snapshot
    try {
      const p = await (navigator as any).permissions?.query?.({ name: "clipboard-write" });
      out.clipboardWrite = p?.state || "unknown";
    } catch { out.clipboardWrite = "err"; }

    // Engagement panel
    const panel = document.querySelector(
      'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]'
    );
    out.transcriptPanelDom = !!panel;
    out.transcriptSegments = document.querySelectorAll("ytd-transcript-segment-renderer").length;

    // Innertube key surface
    const ytcfg: any = (window as any).ytcfg;
    out.innertubeKeyExposed = !!(ytcfg?.get?.("INNERTUBE_API_KEY") || ytcfg?.data_?.INNERTUBE_API_KEY);

    // Extension UI
    const btn = document.querySelector(".yts-ext-copy-btn");
    const status = document.querySelector(".yts-ext-status");
    out.copyBtnPresent = !!btn;
    out.statusText = (status?.textContent || "").trim();
    out.statusIsError = !!status?.classList.contains("yts-ext-err");
    return out;
  });
}

function safeWrite(filePath: string, data: string) {
  // Google Drive's virtual FS sometimes returns ENOENT for a directory that
  // exists. Retry a few times with mkdirSync between attempts.
  let lastErr: any = null;
  for (let i = 0; i < 6; i++) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, data);
      return;
    } catch (e) {
      lastErr = e;
      // small backoff
      const until = Date.now() + 300;
      while (Date.now() < until) { /* spin */ }
    }
  }
  console.log(`safeWrite gave up on ${filePath}: ${lastErr?.message || lastErr}`);
}

/** Map status text + probe to a single failure code. */
function classify(statusText: string, statusIsError: boolean, probe: any): string {
  // Test-environment failures get their own codes so they don't get confused
  // with real bugs.
  if (probe?.playabilityStatus && probe.playabilityStatus !== "OK" && probe.playabilityStatus !== "") {
    return `PLAYABILITY_${probe.playabilityStatus}`;
  }
  if (!statusIsError && /Copied/i.test(statusText)) return "OK";
  const t = statusText || "";
  if (/reloaded|refresh this page/i.test(t)) return "EXT_RELOAD";
  if (/[Cc]lipboard blocked/.test(t)) return "CLIPBOARD_BLOCKED";
  if (/No captions from timedtext, InnerTube, or transcript panel/i.test(t)) {
    if (probe?.captionTracks === 0) return "EMPTY_TRACKS";
    if (!probe?.innertubeKeyExposed) return "INNERTUBE_NO_KEY";
    return "TIMEDTEXT_EMPTY";
  }
  if (/transcript panel/i.test(t)) return "PANEL_HIDDEN";
  if (/Empty transcript/i.test(t)) return "TIMEDTEXT_EMPTY";
  if (/Open a video with \?v=/i.test(t)) return "NO_VIDEO_ID";
  if (!t) return "NO_STATUS";
  return "OTHER";
}

let userDataDir: string;
let context: BrowserContext;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXTENSION_DIR, "manifest.json"))) {
    throw new Error(`Extension folder missing manifest: ${EXTENSION_DIR}`);
  }
  fs.mkdirSync(DIAG_ROOT, { recursive: true });

  // Allow the harness to point at a real user-data-dir (e.g. the user's Brave
  // profile cloned to a safe location). Otherwise spin a fresh tmp profile.
  if (process.env.YTS_USER_DATA_DIR && fs.existsSync(process.env.YTS_USER_DATA_DIR)) {
    userDataDir = process.env.YTS_USER_DATA_DIR;
  } else {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yts-flake-"));
  }
  const { channel, executablePath } = resolveChannelExecutable();
  const launchOpts: Parameters<typeof chromium.launchPersistentContext>[1] = {
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      "--autoplay-policy=no-user-gesture-required",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1400,900",
      "--window-position=0,0",
    ],
  };
  if (executablePath) launchOpts.executablePath = executablePath;
  if (!executablePath && channel) launchOpts.channel = channel;
  context = await chromium.launchPersistentContext(userDataDir, launchOpts);
});

test.afterAll(async () => {
  await context?.close();
  // Only delete tmp profiles we created.
  if (!process.env.YTS_USER_DATA_DIR) {
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* */ }
  }
});

test("copy-flake: single attempt", async () => {
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(120_000);

  const consoleMsgs: string[] = [];
  page.on("console", (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e?.message || e)));

  const url = PRIMARY_URL;
  const t0 = Date.now();

  // Pre-warm: visit youtube.com homepage first so the page sets consent/
  // region cookies before navigating to the watch URL. This noticeably
  // reduces "playabilityStatus: ERROR" on Playwright-launched Brave with a
  // fresh profile.
  try {
    await page.goto("https://www.youtube.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await dismissConsentIfAny(page);
    await page.waitForTimeout(1500);
  } catch { /* keep going */ }

  await page.goto(url, { waitUntil: "domcontentloaded" });
  await dismissConsentIfAny(page);
  await page.waitForSelector("#movie_player", { timeout: 60_000 }).catch(() => {});
  // Pre-click wait. Default 5s simulates a fast click. In real usage, users
  // typically take 10–15s to read the page before clicking, by which time
  // the extension's background prefetch has populated the cache and the
  // click can write to the clipboard synchronously. Override via
  // COPY_FLAKE_PRECLICK_WAIT_MS to test the warm-cache path.
  const preClickWait = parseInt(process.env.COPY_FLAKE_PRECLICK_WAIT_MS || "5000", 10);
  await page.waitForTimeout(preClickWait);

  const probeBefore = await probePage(page);
  safeWrite(path.join(DIAG_ROOT, "probe-before.json"), JSON.stringify(probeBefore, null, 2));

  const copyBtn = page.locator(".yts-ext-copy-btn");
  // Wait for it to exist in DOM (visible OR not).
  await copyBtn.first().waitFor({ state: "attached", timeout: 60_000 });

  // If it's not visible, record WHY before continuing — we still click via JS
  // because the user's mouse click would also work even if Playwright's
  // strict visibility check disagrees with the layout.
  const visInfo = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".yts-ext-copy-btn");
    if (!el) return { found: false } as any;
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    function ancestorHidden(node: HTMLElement | null): string {
      let n: HTMLElement | null = node;
      while (n && n !== document.body) {
        const s = getComputedStyle(n);
        if (s.display === "none") return `${n.tagName}#${n.id || ""}.${(n.className || "").toString().slice(0, 60)} display:none`;
        if (s.visibility === "hidden") return `${n.tagName}#${n.id || ""} visibility:hidden`;
        if (n.hasAttribute("hidden")) return `${n.tagName}#${n.id || ""} [hidden]`;
        n = n.parentElement;
      }
      return "";
    }
    const inner = document.querySelector("#columns #secondary #secondary-inner") as HTMLElement | null;
    return {
      found: true,
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      display: cs.display,
      visibility: cs.visibility,
      hostClass: el.closest(".yts-ext-host")?.className || "",
      ancestorHidden: ancestorHidden(el),
      secondaryInnerVisible: inner ? !!inner.offsetParent : null,
      windowInner: { w: window.innerWidth, h: window.innerHeight },
    };
  });
  safeWrite(path.join(DIAG_ROOT, "button-visibility.json"), JSON.stringify(visInfo, null, 2));

  const tClick = Date.now();
  // JS-driven click works regardless of Playwright's hit-testing.
  await copyBtn.first().evaluate((el: HTMLElement) => el.click());

  // Wait for status to settle (not Fetching/Retrying).
  await page.waitForFunction(
    () => {
      const el = document.querySelector(".yts-ext-status");
      const t = (el?.textContent || "").trim();
      if (t.length < 2) return false;
      if (/^Fetching/i.test(t)) return false;
      if (/^Retrying/i.test(t)) return false;
      return true;
    },
    { timeout: 120_000 }
  ).catch(() => {});

  const probeAfter = await probePage(page);
  const elapsedMs = Date.now() - tClick;

  const code = classify(probeAfter.statusText, probeAfter.statusIsError, probeAfter);
  const summary = {
    url,
    runTag: RUN_TAG,
    code,
    statusText: probeAfter.statusText,
    statusIsError: probeAfter.statusIsError,
    elapsedMs,
    totalMs: Date.now() - t0,
    probeBefore,
    probeAfter,
    pageErrors,
  };
  safeWrite(path.join(DIAG_ROOT, "summary.json"), JSON.stringify(summary, null, 2));
  safeWrite(path.join(DIAG_ROOT, "console.log"), consoleMsgs.join("\n"));
  await page.screenshot({ path: path.join(DIAG_ROOT, "after-copy.png"), fullPage: false }).catch(() => {});

  // Print one machine-readable line the harness greps for.
  // Format: COPY_FLAKE_RESULT|<code>|<elapsedMs>|<statusText>
  // (statusText newlines stripped.)
  const oneLine = (probeAfter.statusText || "").replace(/[\r\n]+/g, " ").slice(0, 240);
  console.log(`COPY_FLAKE_RESULT|${code}|${elapsedMs}|${oneLine}`);

  if (code !== "OK") {
    throw new Error(`copy-flake FAIL code=${code} status="${oneLine}"`);
  }
});
