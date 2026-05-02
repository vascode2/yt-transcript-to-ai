const CAPTION_EVENT = "__yts_ext_caption_meta";

let captionMeta = null;
let hookInjected = false;
/** @type {{ vid: string, result: object, formatted: string } | null} */
let transcriptCache = null;

const LANG_PREFS = ["ko", "ko-KR", "ko-kr", "en", "en-US", "en-GB", "en-CA", "en-AU", "en-IN", "ja", "ja-JP", "zh", "zh-CN", "zh-TW"];
const SUMMARY_INSTRUCTION =
  "Please summarize this YouTube transcript. Use clear headings, bullet points for main ideas, and keep names, numbers, and quotes accurate.\n\n---\n\n";

function injectPageHook() {
  if (hookInjected) return;
  hookInjected = true;
  const s = document.createElement("script");
  s.src = chrome.runtime.getURL("inject-hook.js");
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);
}

function videoIdFromUrl() {
  try {
    return new URLSearchParams(window.location.search).get("v") || "";
  } catch {
    return "";
  }
}

/** URL ?v= is source of truth; stale captionMeta from SPA must not override. */
function reconcileVideoIdentity() {
  const urlVid = videoIdFromUrl();
  if (!urlVid) return;
  if (captionMeta?.videoId && captionMeta.videoId !== urlVid) {
    captionMeta = null;
  }
  if (transcriptCache && transcriptCache.vid !== urlVid) {
    transcriptCache = null;
  }
}

function videoTitleGuess() {
  const vid = videoIdFromUrl() || captionMeta?.videoId || "";
  const fromMeta = captionMeta?.videoId === vid && captionMeta?.title?.trim() ? captionMeta.title.trim() : "";
  if (fromMeta) return fromMeta;
  const h1 = document.querySelector("ytd-watch-metadata h1.ytd-watch-metadata-video-title, ytd-watch-metadata #title h1, h1");
  return (h1 && h1.textContent && h1.textContent.trim()) || "";
}

function formatCopyBlock(title, videoId, transcript) {
  const header = title
    ? `${title}\nhttps://www.youtube.com/watch?v=${videoId}\n\n`
    : `https://www.youtube.com/watch?v=${videoId}\n\n`;
  return header + transcript;
}

function removeHost() {
  document.querySelectorAll(".yts-ext-host").forEach((el) => el.remove());
}

/** Toolbar first in the right column so it stays above “In this video” / chapters. */
function findSecondaryInnerTop() {
  const inner = document.querySelector("#columns #secondary #secondary-inner");
  if (!inner) return null;
  return { parent: inner, before: inner.firstChild };
}

function findTitleFallbackMount() {
  const meta = document.querySelector("ytd-watch-metadata");
  if (!meta) return null;
  const title = meta.querySelector("#title");
  return { parent: meta, after: title || null };
}

function copyViaTextarea(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  return ok;
}

async function copyToClipboard(text) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // writeText commonly rejects with NotAllowedError when the document is
      // not focused or the user-activation token has expired. Re-focus and
      // try the synchronous execCommand fallback (which only needs an active
      // selection, not a user gesture).
      try { window.focus(); } catch (_) {}
      try { document.body && document.body.focus({ preventScroll: true }); } catch (_) {}
      if (copyViaTextarea(text)) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return false;
}

async function fetchTranscriptFromPage(expectedVideoId, opts) {
  const aggressive = opts?.aggressive !== false;
  let bridge;
  try {
    bridge = await chrome.runtime.sendMessage({
      type: "YTS_FETCH_TRANSCRIPT",
      langPrefs: LANG_PREFS,
      expectedVideoId: expectedVideoId || "",
      aggressive,
    });
  } catch (err) {
    const m = String(err?.message || err || "");
    if (/invalidated|receiving end does not exist/i.test(m)) {
      throw new Error("Extension was reloaded — please refresh this page (F5).");
    }
    throw new Error(m || "Could not reach the extension.");
  }
  if (!bridge?.ok) {
    throw new Error(bridge?.error || "Could not get transcript.");
  }
  return bridge;
}

const TRANSCRIPT_MAX_RETRIES = 3;
const TRANSCRIPT_RETRY_DELAY_MS = 4000;

let prefetchInFlight = null;

/**
 * Fire-and-forget transcript prefetch. Populates transcriptCache as soon as
 * the player has captions, so the next Copy click can write to the clipboard
 * synchronously within the 5-second user-activation window.
 */
function prefetchTranscript() {
  try {
    reconcileVideoIdentity();
    const vid = videoIdFromUrl() || captionMeta?.videoId || "";
    if (!vid) return;
    if (transcriptCache && transcriptCache.vid === vid) return;
    if (prefetchInFlight && prefetchInFlight.vid === vid) return;
    const p = (async () => {
      try {
        // Quiet prefetch: HTTP-only tiers (timedtext + InnerTube). Do NOT
        // open YouTube's transcript panel — that’s reserved for the user’s
        // explicit Copy click.
        const result = await fetchTranscriptFromPage(vid, { aggressive: false });
        if (result?.text) {
          const title = videoTitleGuess();
          const formatted = formatCopyBlock(title, result.videoId || vid, result.text);
          transcriptCache = { vid, result, formatted };
        }
      } catch (_) {
        // Silent — the user will see real errors when they click Copy.
      } finally {
        if (prefetchInFlight && prefetchInFlight.vid === vid) {
          prefetchInFlight = null;
        }
      }
    })();
    prefetchInFlight = { vid, promise: p };
  } catch (_) { /* never throw from prefetch */ }
}

async function getTranscriptBundle() {
  reconcileVideoIdentity();
  const vid = videoIdFromUrl() || captionMeta?.videoId || "";
  if (!vid) {
    throw new Error("Open a video with ?v= in the URL.");
  }
  if (transcriptCache && transcriptCache.vid === vid) {
    return transcriptCache;
  }

  let lastErr = null;
  for (let attempt = 0; attempt < TRANSCRIPT_MAX_RETRIES; attempt++) {
    try {
      const result = await fetchTranscriptFromPage(vid);
      const transcript = result.text;
      if (!transcript) {
        throw new Error("Empty transcript.");
      }
      const title = videoTitleGuess();
      const headerVid = result.videoId || vid;
      const formatted = formatCopyBlock(title, headerVid, transcript);
      transcriptCache = { vid, result, formatted };
      return transcriptCache;
    } catch (e) {
      lastErr = e;
      if (attempt < TRANSCRIPT_MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, TRANSCRIPT_RETRY_DELAY_MS));
        reconcileVideoIdentity();
      }
    }
  }
  throw lastErr;
}

function mountUI() {
  removeHost();

  const host = document.createElement("div");
  host.className = "yts-ext-host yts-ext-host--sidebar";

  const row = document.createElement("div");
  row.className = "yts-ext-actions-row";

  const mkBtn = (text, className, title) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = className;
    b.textContent = text;
    if (title) b.title = title;
    return b;
  };

  const copyBtn = mkBtn("Copy transcript", "yts-ext-copy-btn", "Copy transcript to clipboard");
  const gptBtn = mkBtn(
    "ChatGPT",
    "yts-ext-ai-btn yts-ext-ai-btn--gpt",
    "Open ChatGPT — Ctrl/⌘+click or middle-click opens in a background tab"
  );
  const gemBtn = mkBtn(
    "Gemini",
    "yts-ext-ai-btn yts-ext-ai-btn--gem",
    "Open Gemini — Ctrl/⌘+click or middle-click opens in a background tab"
  );

  const status = document.createElement("span");
  status.className = "yts-ext-status";
  status.textContent = "";

  row.append(copyBtn, gptBtn, gemBtn);
  host.append(row, status);

  const top = findSecondaryInnerTop();
  if (top) {
    top.parent.insertBefore(host, top.before);
  } else {
    const fb = findTitleFallbackMount();
    if (fb?.after) {
      fb.after.insertAdjacentElement("afterend", host);
      host.classList.remove("yts-ext-host--sidebar");
      host.classList.add("yts-ext-host--fallback");
    } else if (fb?.parent) {
      fb.parent.insertAdjacentElement("afterbegin", host);
      host.classList.remove("yts-ext-host--sidebar");
      host.classList.add("yts-ext-host--fallback");
    } else {
      return;
    }
  }

  // Kick off a background prefetch as soon as the toolbar is mounted.
  // This populates transcriptCache so that the user's Copy click can call
  // navigator.clipboard.writeText() synchronously within the 5s
  // user-activation window (otherwise Chrome rejects with NotAllowedError).
  prefetchTranscript();

  function setBusy(buttons, on) {
    const list = Array.isArray(buttons) ? buttons : [buttons];
    for (const b of list) {
      if (!b) continue;
      b.disabled = on;
      b.classList.toggle("yts-ext-busy", on);
    }
  }

  async function onCopyClick() {
    status.textContent = "";
    status.classList.remove("yts-ext-err", "yts-ext-status--long");
    setBusy([copyBtn], true);
    status.textContent = "Fetching transcript…";

    const withRetryStatus = async () => {
      reconcileVideoIdentity();
      const vid = videoIdFromUrl() || captionMeta?.videoId || "";
      if (!vid) throw new Error("Open a video with ?v= in the URL.");
      if (transcriptCache && transcriptCache.vid === vid) return transcriptCache;

      let lastErr = null;
      for (let attempt = 0; attempt < TRANSCRIPT_MAX_RETRIES; attempt++) {
        try {
          const result = await fetchTranscriptFromPage(vid);
          if (!result.text) throw new Error("Empty transcript.");
          const title = videoTitleGuess();
          const formatted = formatCopyBlock(title, result.videoId || vid, result.text);
          transcriptCache = { vid, result, formatted };
          return transcriptCache;
        } catch (e) {
          lastErr = e;
          if (/reloaded|refresh this page/i.test(e.message)) throw e;
          if (attempt < TRANSCRIPT_MAX_RETRIES - 1) {
            status.textContent = `Retrying (${attempt + 2}/${TRANSCRIPT_MAX_RETRIES})… waiting for video data`;
            await new Promise((r) => setTimeout(r, TRANSCRIPT_RETRY_DELAY_MS));
            reconcileVideoIdentity();
          }
        }
      }
      throw lastErr;
    };

    try {
      const fetchStartedAt = Date.now();
      const wasCached = !!(transcriptCache && transcriptCache.vid === (videoIdFromUrl() || captionMeta?.videoId || ""));
      const { vid, result, formatted } = await withRetryStatus();
      const elapsed = Date.now() - fetchStartedAt;

      // Chrome only honors a recent user click for ~5s when calling
      // navigator.clipboard.writeText(). If the fetch took longer than that,
      // the user-activation token has expired and the clipboard write will
      // fail with NotAllowedError. Rather than show a confusing
      // "Clipboard blocked" error, prime the cache and ask the user to click
      // again — the second click is instant because the transcript is cached.
      const userActivationLikelyExpired = !wasCached && elapsed > 4500;
      if (userActivationLikelyExpired) {
        status.textContent = "Transcript ready — click Copy again to copy to clipboard.";
        return;
      }

      const ok = await copyToClipboard(formatted);
      if (!ok) {
        // Cache is now warm; next click will be instant. Tell the user that.
        status.textContent = "Transcript ready — click Copy again to copy to clipboard.";
        return;
      }
      const langCode = result.languageCode || "";
      const langNames = { en: "English", ko: "Korean", ja: "Japanese", zh: "Chinese", es: "Spanish", fr: "French", de: "German", pt: "Portuguese" };
      const langLabel = langNames[langCode] || langNames[langCode.split("-")[0]] || langCode;
      const autoLabel = result.kind === "asr" ? ", auto-generated" : "";
      status.textContent = `Copied${langLabel ? ` (${langLabel}${autoLabel})` : ""}.`;
    } catch (e) {
      status.classList.add("yts-ext-err");
      const msg = e.message || "Copy failed.";
      status.classList.toggle("yts-ext-status--long", msg.length > 90);
      status.textContent = msg;
    } finally {
      setBusy([copyBtn], false);
    }
  }

  async function onSendToAi(kind, opts = {}) {
    const openInBackground = !!opts.openInBackground;
    const triggerBtn = opts.triggerBtn;
    status.textContent = "";
    status.classList.remove("yts-ext-err", "yts-ext-status--long");
    setBusy([triggerBtn], true);
    status.textContent = "Fetching…";
    try {
      let prompt;
      let transcriptOk = true;
      let result = null;
      try {
        const bundle = await getTranscriptBundle();
        result = bundle.result;
        prompt = SUMMARY_INSTRUCTION + bundle.formatted;
      } catch (transcriptErr) {
        transcriptOk = false;
        reconcileVideoIdentity();
        const vid = videoIdFromUrl() || captionMeta?.videoId || "";
        if (!vid) {
          throw transcriptErr;
        }
        const title = videoTitleGuess();
        const placeholder =
          "Transcript could not be read from this page (timedtext blocked, empty panel, etc.). " +
          "Copy lines from YouTube’s transcript here, or use the project’s yt-dlp script, then ask for a summary.\n\n" +
          "[Paste transcript below]\n\n";
        prompt = SUMMARY_INSTRUCTION + formatCopyBlock(title, vid, placeholder);
      }

      const clipOk = await copyToClipboard(prompt);
      if (!clipOk) throw new Error("Clipboard blocked.");

      const storageKey = `yts_ext_ai_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
      await chrome.storage.local.set({ [storageKey]: prompt });
      let res;
      try {
        res = await chrome.runtime.sendMessage({
          type: "YTS_OPEN_AI_WITH_PROMPT",
          service: kind,
          storageKey,
          openInBackground,
        });
      } catch (msgErr) {
        const m = String(msgErr?.message || msgErr || "");
        throw new Error(
          /invalidated|receiving end does not exist/i.test(m)
            ? "Extension reloaded — refresh this YouTube tab and try again."
            : m || "Could not reach the extension."
        );
      }

      const lang = result?.languageCode || "";
      const auto = result?.kind === "asr" ? " · auto" : "";
      const bg = openInBackground ? " · background tab" : "";
      const fallbackNote = transcriptOk ? "" : " No transcript in prompt — paste from YouTube or yt-dlp.";

      if (!res?.ok) {
        throw new Error(res?.error || "Could not open chat tab.");
      }
      status.classList.remove("yts-ext-err");
      if (res.filled && res.autoSubmit) {
        status.textContent =
          (res.usedSubmitButton ? "Prompt sent in new tab." : "Filled and Enter sent — check the new tab.") +
          ` (${lang}${auto}${bg})${fallbackNote}`;
      } else if (res.filled) {
        status.textContent = `Prompt filled in new tab — review and send. (${lang}${auto}${bg})${fallbackNote}`;
      } else {
        status.textContent = `Opened chat — ${res.hint || "Press Ctrl+V to paste."} (${lang}${auto}${bg})${fallbackNote}`;
      }
      if (!transcriptOk) {
        status.classList.add("yts-ext-status--long");
      }
    } catch (e) {
      status.classList.add("yts-ext-err");
      const msg = e.message || "Failed.";
      status.classList.toggle("yts-ext-status--long", msg.length > 90);
      status.textContent = msg;
    } finally {
      setBusy([triggerBtn], false);
    }
  }

  function bindAiButton(btn, kind) {
    btn.addEventListener("click", (e) => {
      if (e.button !== 0) return;
      const openInBackground = !!(e.ctrlKey || e.metaKey);
      onSendToAi(kind, { openInBackground, triggerBtn: btn });
    });
    btn.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      onSendToAi(kind, { openInBackground: true, triggerBtn: btn });
    });
  }

  copyBtn.addEventListener("click", onCopyClick);
  bindAiButton(gptBtn, "chatgpt");
  bindAiButton(gemBtn, "gemini");
}

document.addEventListener(CAPTION_EVENT, (e) => {
  if (!e.detail) return;
  captionMeta = e.detail;
  // Player just published a caption-tracks list — kick off background fetch
  // so the next Copy click can complete inside the user-activation window.
  prefetchTranscript();
});

function scheduleMount() {
  requestAnimationFrame(() => {
    mountUI();
    scheduleNativeTranscriptFontSize();
  });
}

function shouldTryMount() {
  if (!document.querySelector("ytd-watch-metadata")) return false;
  const existing = document.querySelector(".yts-ext-host");
  if (!existing) return true;
  if (!document.body.contains(existing)) return true;
  if (existing.offsetParent === null && !existing.closest("[hidden]")) {
    if (!document.querySelector(".yts-ext-busy")) return true;
  }
  if (document.querySelector(".yts-ext-busy")) return false;
  const fallback = document.querySelector(".yts-ext-host--fallback");
  const inner = document.querySelector("#columns #secondary #secondary-inner");
  return !!(fallback && inner);
}

/** Keep sidebar bar first under the right column without remounting (remount kills in-flight copy/AI work). */
function repositionSidebarToolbar() {
  const host = document.querySelector(".yts-ext-host.yts-ext-host--sidebar");
  const inner = document.querySelector("#columns #secondary #secondary-inner");
  if (!host || !inner || !inner.contains(host)) return;
  if (inner.firstElementChild !== host) {
    inner.insertBefore(host, inner.firstChild);
  }
}

const NATIVE_TRANSCRIPT_FONT_PX = 12;
let nativeTranscriptFontTimer = 0;

function deepQueryTranscriptSegmentHosts(root = document.documentElement) {
  const results = [];
  const seen = new Set();
  function visit(node) {
    if (!node?.querySelectorAll) return;
    try {
      node.querySelectorAll("ytd-transcript-segment-renderer, transcript-segment-view-model").forEach((el) => {
        if (!seen.has(el)) {
          seen.add(el);
          results.push(el);
        }
      });
      node.querySelectorAll("*").forEach((el) => {
        if (el.shadowRoot) visit(el.shadowRoot);
      });
    } catch (_) {}
  }
  visit(root);
  return results;
}

function applyNativeTranscriptFontSize() {
  try {
    deepQueryTranscriptSegmentHosts().forEach((el) => {
      el.style.setProperty("font-size", `${NATIVE_TRANSCRIPT_FONT_PX}px`, "important");
      el.style.setProperty("line-height", "1.35", "important");
    });
    const panel =
      document.querySelector(
        'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]'
      ) || document.querySelector('ytd-engagement-panel-section-list-renderer[target-id*="transcript" i]');
    if (panel) {
      panel.style.setProperty("font-size", `${NATIVE_TRANSCRIPT_FONT_PX}px`, "important");
    }
    const tsp = document.querySelector("ytd-transcript-search-panel-renderer");
    if (tsp) {
      tsp.style.setProperty("font-size", `${NATIVE_TRANSCRIPT_FONT_PX}px`, "important");
    }
  } catch (_) {}
}

function scheduleNativeTranscriptFontSize() {
  clearTimeout(nativeTranscriptFontTimer);
  nativeTranscriptFontTimer = setTimeout(() => applyNativeTranscriptFontSize(), 100);
}

injectPageHook();

document.addEventListener("yt-navigate-finish", () => {
  captionMeta = null;
  transcriptCache = null;
  prefetchInFlight = null;
  scheduleMount();
  scheduleNativeTranscriptFontSize();
  // Try a prefetch shortly after navigation; the player may not have caption
  // metadata yet, in which case the CAPTION_EVENT listener above will retry.
  setTimeout(prefetchTranscript, 1500);
});

function ensureToolbarAfterLayoutShift() {
  const delays = [200, 500, 1000, 2000, 3500];
  for (const ms of delays) {
    setTimeout(() => {
      const host = document.querySelector(".yts-ext-host");
      if (!host || !document.body.contains(host) || host.offsetParent === null) {
        scheduleMount();
      }
    }, ms);
  }
}

document.addEventListener("yt-set-theater-mode-enabled", ensureToolbarAfterLayoutShift);
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement) ensureToolbarAfterLayoutShift();
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", scheduleMount);
} else {
  scheduleMount();
}

const mo = new MutationObserver(() => {
  if (shouldTryMount()) {
    scheduleMount();
  } else {
    repositionSidebarToolbar();
    scheduleNativeTranscriptFontSize();
  }
});
mo.observe(document.documentElement, { childList: true, subtree: true });
