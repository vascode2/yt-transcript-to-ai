/**
 * Extension E2E — develop-test loop for YOhZd1-AkNk.
 *
 * Run:  npm run test:e2e          (Brave if found, else Playwright Chromium)
 *       npm run e2e:chromium      (force Playwright Chromium)
 *
 * BRAVE_PATH env overrides auto-detection.
 */

import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const EXTENSION_DIR = path.resolve(process.cwd(), "extension");
const VIDEO_URL = "https://www.youtube.com/watch?v=YOhZd1-AkNk";
const DIAG_DIR = path.resolve(process.cwd(), "test-results", "diag");

const BRAVE_CANDIDATES = [
  process.env.BRAVE_PATH,
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
].filter(Boolean) as string[];

function resolveChannelExecutable(): { channel?: "chromium"; executablePath?: string } {
  if (process.env.USE_PLAYWRIGHT_CHROMIUM === "1") {
    return { channel: "chromium" };
  }
  for (const p of BRAVE_CANDIDATES) {
    try {
      if (p && fs.existsSync(p)) return { executablePath: p };
    } catch { /* */ }
  }
  return { channel: "chromium" };
}

let userDataDir: string;
let context: BrowserContext;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(EXTENSION_DIR, "manifest.json"))) {
    throw new Error(`Extension folder missing manifest: ${EXTENSION_DIR}`);
  }
  fs.mkdirSync(DIAG_DIR, { recursive: true });
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yts-ext-e2e-"));
  const { channel, executablePath } = resolveChannelExecutable();
  const launchOpts: Parameters<typeof chromium.launchPersistentContext>[1] = {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      "--autoplay-policy=no-user-gesture-required",
      "--disable-blink-features=AutomationControlled",
    ],
  };
  if (executablePath) launchOpts.executablePath = executablePath;
  if (!executablePath && channel) launchOpts.channel = channel;
  context = await chromium.launchPersistentContext(userDataDir, launchOpts);
});

test.afterAll(async () => {
  await context?.close();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* */ }
});

async function screenshot(page: Page, name: string) {
  try {
    await page.screenshot({ path: path.join(DIAG_DIR, `${name}.png`), fullPage: false });
  } catch { /* */ }
}

async function dismissConsentIfAny(page: Page) {
  try {
    const consentBtn = page.locator(
      'button:has-text("Accept all"), button:has-text("Reject all"), ' +
      'button:has-text("I agree"), button:has-text("동의"), ' +
      'form[action*="consent"] button'
    ).first();
    if (await consentBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
      await consentBtn.click();
      await page.waitForTimeout(1500);
    }
  } catch { /* */ }
}

async function collectPageDiagnostics(page: Page): Promise<string> {
  return page.evaluate(() => {
    const lines: string[] = [];
    lines.push(`URL: ${location.href}`);
    lines.push(`document.readyState: ${document.readyState}`);

    const player = document.querySelector("#movie_player") as any;
    lines.push(`#movie_player exists: ${!!player}`);
    if (player) {
      try {
        const pr = typeof player.getPlayerResponse === "function" ? player.getPlayerResponse() : null;
        lines.push(`getPlayerResponse(): ${pr ? "object" : "null"}`);
        if (pr) {
          const vid = pr.videoDetails?.videoId || "";
          lines.push(`  videoId: ${vid}`);
          const tracks = pr.captions?.playerCaptionsTracklistRenderer?.captionTracks;
          lines.push(`  captionTracks: ${Array.isArray(tracks) ? tracks.length : "none"}`);
          if (Array.isArray(tracks)) {
            tracks.forEach((t: any, i: number) => {
              lines.push(`    [${i}] lang=${t.languageCode} kind=${t.kind || ""} baseUrl=${(t.baseUrl || "").slice(0, 80)}...`);
            });
          }
        }
      } catch (e) {
        lines.push(`  getPlayerResponse error: ${e}`);
      }
    }

    const ytipr = (window as any).ytInitialPlayerResponse;
    lines.push(`ytInitialPlayerResponse: ${ytipr ? "object" : "null/undef"}`);
    if (ytipr) {
      const tracks2 = ytipr.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      lines.push(`  ytipr captionTracks: ${Array.isArray(tracks2) ? tracks2.length : "none"}`);
    }

    const panel = document.querySelector(
      'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]'
    );
    lines.push(`transcript panel DOM: ${panel ? "found" : "NOT found"}`);
    if (panel) {
      lines.push(`  panel visible: ${(panel as any).offsetParent !== null}`);
      const rect = panel.getBoundingClientRect();
      lines.push(`  panel rect: ${rect.width}x${rect.height}`);
    }

    const segs = document.querySelectorAll("ytd-transcript-segment-renderer");
    lines.push(`ytd-transcript-segment-renderer count (light DOM): ${segs.length}`);
    if (segs.length > 0) {
      const first = segs[0];
      lines.push(`  first seg text: "${(first.textContent || "").trim().slice(0, 80)}"`);
    }

    const extBtn = document.querySelector(".yts-ext-copy-btn");
    lines.push(`extension copy btn: ${extBtn ? "found" : "NOT found"}`);
    const extStatus = document.querySelector(".yts-ext-status");
    lines.push(`extension status: "${(extStatus?.textContent || "").trim().slice(0, 200)}"`);

    return lines.join("\n");
  });
}

test("diagnose timedtext fetch from page context", async () => {
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(120_000);

  await page.goto(VIDEO_URL, { waitUntil: "domcontentloaded" });
  await dismissConsentIfAny(page);
  await page.waitForSelector("#movie_player", { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(5000);

  const result = await page.evaluate(async () => {
    const lines: string[] = [];

    function getPlayerResponse(): any {
      try {
        const a = (window as any).ytInitialPlayerResponse;
        if (a?.captions) return a;
      } catch {}
      try {
        const el = document.querySelector("#movie_player") as any;
        if (el?.getPlayerResponse) return el.getPlayerResponse();
      } catch {}
      return null;
    }

    const pr = getPlayerResponse();
    const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    lines.push(`tracks count: ${tracks.length}`);

    if (tracks.length === 0) {
      return lines.join("\n");
    }

    const track = tracks[0];
    const baseUrl = String(track.baseUrl || "");
    lines.push(`baseUrl: ${baseUrl.slice(0, 120)}...`);

    lines.push(`FULL baseUrl: ${baseUrl}`);
    lines.push(`track obj keys: ${JSON.stringify(track)}`);

    // Try baseUrl as-is and with various lang/kind additions
    const urls = [
      baseUrl,
      baseUrl + "&fmt=json3",
      baseUrl + "&fmt=json3&lang=ko&kind=asr",
      baseUrl.replace(/&fmt=[^&]*/g, "") + "&fmt=json3",
    ];
    for (const url of urls) {
      try {
        const res = await fetch(url, { credentials: "include" });
        const body = await res.text();
        lines.push(`\nURL: ${url.slice(0, 160)}...`);
        lines.push(`  status=${res.status} bodyLen=${body.length}`);
        lines.push(`  body: ${JSON.stringify(body.slice(0, 300))}`);
      } catch (e: any) {
        lines.push(`\nURL: ${url.slice(0, 160)}...`);
        lines.push(`  FETCH ERROR: ${e?.message || e}`);
      }
    }

    // Try to open transcript panel and check DOM
    lines.push("\n=== DOM PANEL TEST ===");
    
    // Check for "Show transcript" or similar buttons
    const allBtns = document.querySelectorAll("button, yt-formatted-string, tp-yt-paper-item, ytd-menu-service-item-renderer");
    const transcriptBtns: string[] = [];
    allBtns.forEach((el) => {
      const txt = (el.textContent || "").trim();
      if (txt.length < 80 && /transcript|스크립트|대본/i.test(txt)) {
        transcriptBtns.push(`<${el.tagName}> "${txt}" visible=${(el as any).offsetParent !== null}`);
      }
    });
    lines.push(`Transcript-related elements: ${transcriptBtns.length}`);
    transcriptBtns.forEach((b) => lines.push(`  ${b}`));

    // Check for "More actions" button
    const moreBtn = document.querySelector('button[aria-label*="More actions"], button[aria-label*="more actions" i], button[aria-label*="더보기"], button[aria-label*="기타"]');
    lines.push(`"More actions" button: ${moreBtn ? `found (aria-label="${moreBtn.getAttribute("aria-label")}")` : "NOT found"}`);

    // List all aria-labels on buttons in the description area
    const descBtns: string[] = [];
    document.querySelectorAll('ytd-watch-metadata button[aria-label], ytd-menu-renderer button[aria-label], #menu button[aria-label]').forEach((el) => {
      descBtns.push(`"${el.getAttribute("aria-label")}"`);
    });
    lines.push(`Buttons with aria-label near metadata: ${descBtns.join(", ")}`);

    // Check engagement panels
    const panels = document.querySelectorAll("ytd-engagement-panel-section-list-renderer");
    lines.push(`Engagement panels: ${panels.length}`);
    panels.forEach((p, i) => {
      const tid = p.getAttribute("target-id") || "";
      const vis = (p as any).offsetParent !== null;
      const rect = p.getBoundingClientRect();
      lines.push(`  [${i}] target-id="${tid}" visible=${vis} rect=${rect.width}x${rect.height}`);
    });

    // Also try ytInitialData for getTranscriptEndpoint
    const ytid = (window as any).ytInitialData;
    let transcriptParams = "";
    function walk(obj: any, depth: number): void {
      if (!obj || typeof obj !== "object" || depth > 30) return;
      const ep = obj.getTranscriptEndpoint;
      if (ep?.params && typeof ep.params === "string") {
        transcriptParams = ep.params;
        return;
      }
      for (const k of Object.keys(obj)) {
        walk(obj[k], depth + 1);
        if (transcriptParams) return;
      }
    }
    try { walk(ytid, 0); } catch {}
    lines.push(`\ngetTranscriptEndpoint.params: ${transcriptParams ? transcriptParams.slice(0, 60) + "..." : "NOT FOUND"}`);

    // Try innertube get_transcript if params found
    if (transcriptParams) {
      const ytcfg = (window as any).ytcfg;
      const apiKey = ytcfg?.get?.("INNERTUBE_API_KEY") || ytcfg?.data_?.INNERTUBE_API_KEY || "";
      const clientVersion = ytcfg?.get?.("INNERTUBE_CLIENT_VERSION") || ytcfg?.data_?.INNERTUBE_CLIENT_VERSION || "2.0";
      lines.push(`apiKey: ${apiKey ? apiKey.slice(0, 20) + "..." : "EMPTY"}`);

      if (apiKey) {
        try {
          const itRes = await fetch(
            `https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKey}&prettyPrint=false`,
            {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                context: { client: { clientName: "WEB", clientVersion, hl: "ko" } },
                params: transcriptParams,
              }),
            }
          );
          const itBody = await itRes.text();
          lines.push(`innertube status=${itRes.status} bodyLen=${itBody.length}`);
          lines.push(`  body preview: ${JSON.stringify(itBody.slice(0, 400))}`);
        } catch (e: any) {
          lines.push(`innertube FETCH ERROR: ${e?.message || e}`);
        }
      }
    }

    return lines.join("\n");
  });

  fs.writeFileSync(path.join(DIAG_DIR, "timedtext-diag.txt"), result, "utf-8");
  console.log("=== TIMEDTEXT DIAGNOSTIC ===\n" + result);
});

test("try opening transcript panel from Playwright", async () => {
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(120_000);

  await page.goto(VIDEO_URL, { waitUntil: "domcontentloaded" });
  await dismissConsentIfAny(page);
  await page.waitForSelector("#movie_player", { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(5000);

  // Try clicking "Show transcript" button directly from Playwright
  const showTranscriptBtn = page.locator('button[aria-label="Show transcript"]').first();
  const exists = await showTranscriptBtn.count();
  console.log(`"Show transcript" buttons found: ${exists}`);

  if (exists > 0) {
    // Click via JS — element may be hidden/off-screen
    await showTranscriptBtn.evaluate((el: HTMLElement) => el.click());
    console.log("Clicked Show transcript (force)");
    await page.waitForTimeout(3000);
    await screenshot(page, "05-after-show-transcript-click");

    const panelState = await page.evaluate(() => {
      const panels = document.querySelectorAll("ytd-engagement-panel-section-list-renderer");
      const lines: string[] = [];
      panels.forEach((p, i) => {
        const tid = p.getAttribute("target-id") || "";
        const vis = (p as any).offsetParent !== null;
        const rect = p.getBoundingClientRect();
        const hidden = p.hasAttribute("hidden");
        const visibility = p.getAttribute("visibility") || "";
        lines.push(`[${i}] id="${tid}" vis=${vis} rect=${rect.width}x${rect.height} hidden=${hidden} visibility="${visibility}"`);
      });
      const segs = document.querySelectorAll("ytd-transcript-segment-renderer");
      lines.push(`segments: ${segs.length}`);
      if (segs.length > 0) {
        lines.push(`first seg: "${(segs[0].textContent || "").trim().slice(0, 100)}"`);
      }
      return lines.join("\n");
    });
    console.log("=== PANEL STATE AFTER CLICK ===\n" + panelState);
    fs.writeFileSync(path.join(DIAG_DIR, "panel-after-click.txt"), panelState, "utf-8");

    // Wait more for content to load
    await page.waitForTimeout(8000);
    await screenshot(page, "06-after-8s-wait");

    // Inspect what's actually inside the modern transcript panel
    const panelInner = await page.evaluate(() => {
      const panel = document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"]');
      if (!panel) return "Panel not found";
      const lines: string[] = [];
      lines.push(`Panel outer HTML length: ${panel.outerHTML.length}`);
      lines.push(`Panel inner HTML length: ${panel.innerHTML.length}`);

      // List all unique tag names inside the panel
      const tags = new Set<string>();
      panel.querySelectorAll("*").forEach((el) => tags.add(el.tagName.toLowerCase()));
      lines.push(`Unique tags inside panel: ${[...tags].sort().join(", ")}`);

      // Check for ytd-transcript-segment-renderer specifically
      const segs = panel.querySelectorAll("ytd-transcript-segment-renderer");
      lines.push(`ytd-transcript-segment-renderer: ${segs.length}`);

      // Check for other possible transcript containers
      const tsp = panel.querySelector("ytd-transcript-search-panel-renderer");
      lines.push(`ytd-transcript-search-panel-renderer: ${tsp ? "found" : "no"}`);
      const tslr = panel.querySelector("ytd-transcript-segment-list-renderer");
      lines.push(`ytd-transcript-segment-list-renderer: ${tslr ? "found" : "no"}`);
      const tbody = panel.querySelector("ytd-transcript-body-renderer");
      lines.push(`ytd-transcript-body-renderer: ${tbody ? "found" : "no"}`);

      // Check for any element with "segment" or "transcript" in its tag
      const segLike: string[] = [];
      panel.querySelectorAll("*").forEach((el) => {
        const tag = el.tagName.toLowerCase();
        if (tag.includes("segment") || tag.includes("transcript")) {
          segLike.push(tag);
        }
      });
      lines.push(`Elements with segment/transcript in tag: ${[...new Set(segLike)].join(", ") || "none"}`);

      // Look for text content in specific containers
      const content = panel.querySelector("#content");
      if (content) {
        const text = (content.textContent || "").trim();
        lines.push(`#content text length: ${text.length}`);
        lines.push(`#content text preview: "${text.slice(0, 300)}"`);
        lines.push(`#content childElementCount: ${content.childElementCount}`);
        if (content.childElementCount > 0) {
          for (let i = 0; i < Math.min(content.children.length, 5); i++) {
            const child = content.children[i];
            lines.push(`  child[${i}]: <${child.tagName.toLowerCase()}> text="${(child.textContent || "").trim().slice(0, 80)}"`);
          }
        }
      }

      // Check for any yt-formatted-string inside the panel
      const fmtStrings = panel.querySelectorAll("yt-formatted-string");
      lines.push(`yt-formatted-string elements: ${fmtStrings.length}`);
      fmtStrings.forEach((el, i) => {
        if (i < 10) {
          lines.push(`  [${i}] "${(el.textContent || "").trim().slice(0, 80)}"`);
        }
      });

      // First 500 chars of innerHTML for manual inspection
      lines.push(`\nPanel innerHTML (first 2000 chars):\n${panel.innerHTML.slice(0, 2000)}`);

      return lines.join("\n");
    });
    console.log("=== PANEL INNER STRUCTURE ===\n" + panelInner);
    fs.writeFileSync(path.join(DIAG_DIR, "panel-inner-structure.txt"), panelInner, "utf-8");
  }
});

test("Copy transcript on YOhZd1-AkNk", async () => {
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(120_000);

  // Collect console messages for diagnostics
  const consoleMsgs: string[] = [];
  page.on("console", (msg) => consoleMsgs.push(`[${msg.type()}] ${msg.text()}`));

  await page.goto(VIDEO_URL, { waitUntil: "domcontentloaded" });
  await dismissConsentIfAny(page);
  await screenshot(page, "01-after-navigate");

  // Wait for page to settle and player to be ready
  await page.waitForSelector("#movie_player", { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(5000);
  await screenshot(page, "02-player-loaded");

  // Dismiss any overlay/consent that appeared late
  await dismissConsentIfAny(page);

  // Collect diagnostics BEFORE clicking Copy
  const diagBefore = await collectPageDiagnostics(page);
  fs.writeFileSync(path.join(DIAG_DIR, "diag-before-copy.txt"), diagBefore, "utf-8");
  console.log("=== DIAGNOSTICS BEFORE COPY ===\n" + diagBefore);

  // Wait for extension button
  const copyBtn = page.locator(".yts-ext-copy-btn");
  await expect(copyBtn).toBeVisible({ timeout: 60_000 });
  await screenshot(page, "03-before-copy-click");

  // Click Copy
  await copyBtn.click();
  console.log("Clicked Copy transcript, waiting for result...");

  // Wait for status to resolve (not "Fetching…" or "Retrying…")
  await page.waitForFunction(
    () => {
      const el = document.querySelector(".yts-ext-status");
      if (!el) return false;
      const t = (el.textContent || "").trim();
      if (t.length < 2) return false;
      if (/^Fetching/i.test(t)) return false;
      if (/^Retrying/i.test(t)) return false;
      return true;
    },
    { timeout: 120_000 }
  );

  await screenshot(page, "04-after-copy-result");
  const diagAfter = await collectPageDiagnostics(page);
  fs.writeFileSync(path.join(DIAG_DIR, "diag-after-copy.txt"), diagAfter, "utf-8");
  console.log("=== DIAGNOSTICS AFTER COPY ===\n" + diagAfter);

  // Check result
  const statusEl = page.locator(".yts-ext-status");
  const text = ((await statusEl.textContent()) || "").trim();
  const isErr = await statusEl.evaluate((el) => el.classList.contains("yts-ext-err"));

  // Save console logs
  fs.writeFileSync(path.join(DIAG_DIR, "console-log.txt"), consoleMsgs.join("\n"), "utf-8");

  if (isErr) {
    console.log(`FAILED with error: ${text}`);
    throw new Error(`Copy transcript failed. Status: ${text.slice(0, 500)}`);
  }
  expect(text).toMatch(/Copied/i);
  console.log(`SUCCESS: ${text}`);
});
