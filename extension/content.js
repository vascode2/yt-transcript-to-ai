const CAPTION_EVENT = "__yts_ext_caption_meta";

let captionMeta = null;
let hookInjected = false;
/** @type {{ vid: string, result: object, formatted: string } | null} */
let transcriptCache = null;

const LANG_PREFS = ["en", "en-US", "en-GB", "en-CA", "en-AU", "en-IN"];
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

function videoTitleGuess() {
  const fromMeta = captionMeta?.title?.trim();
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
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return copyViaTextarea(text);
  }
}

async function fetchTranscriptFromPage() {
  const bridge = await chrome.runtime.sendMessage({
    type: "YTS_FETCH_TRANSCRIPT",
    langPrefs: LANG_PREFS,
  });
  if (!bridge?.ok) {
    throw new Error(bridge?.error || "Could not get transcript.");
  }
  return bridge;
}

async function getTranscriptBundle() {
  const vid = captionMeta?.videoId || videoIdFromUrl();
  if (!vid) {
    throw new Error("Open a video with ?v= in the URL.");
  }
  if (transcriptCache && transcriptCache.vid === vid) {
    return transcriptCache;
  }
  const result = await fetchTranscriptFromPage();
  const transcript = result.text;
  if (!transcript) {
    throw new Error("Empty transcript.");
  }
  const title = videoTitleGuess();
  const formatted = formatCopyBlock(title, vid, transcript);
  transcriptCache = { vid, result, formatted };
  return transcriptCache;
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
    status.classList.remove("yts-ext-err");
    setBusy([copyBtn], true);
    status.textContent = "Fetching…";
    try {
      const { vid, result, formatted } = await getTranscriptBundle();
      const ok = await copyToClipboard(formatted);
      if (!ok) throw new Error("Clipboard blocked.");
      const lang = result.languageCode || "";
      const auto = result.kind === "asr" ? " · auto" : "";
      const src = result.source?.startsWith("dom") ? " · panel" : "";
      status.textContent = `Copied (${lang}${auto}${src}).`;
    } catch (e) {
      status.classList.add("yts-ext-err");
      status.textContent = e.message || "Copy failed.";
    } finally {
      setBusy([copyBtn], false);
    }
  }

  async function onSendToAi(kind, opts = {}) {
    const openInBackground = !!opts.openInBackground;
    const triggerBtn = opts.triggerBtn;
    status.textContent = "";
    status.classList.remove("yts-ext-err");
    setBusy([triggerBtn], true);
    status.textContent = "Fetching…";
    try {
      const { result, formatted } = await getTranscriptBundle();
      const prompt = SUMMARY_INSTRUCTION + formatted;
      const clipOk = await copyToClipboard(prompt);
      if (!clipOk) throw new Error("Clipboard blocked.");

      const storageKey = `yts_ext_ai_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
      await chrome.storage.local.set({ [storageKey]: prompt });
      const res = await chrome.runtime.sendMessage({
        type: "YTS_OPEN_AI_WITH_PROMPT",
        service: kind,
        storageKey,
        openInBackground,
      });

      const lang = result.languageCode || "";
      const auto = result.kind === "asr" ? " · auto" : "";
      const bg = openInBackground ? " · background tab" : "";

      if (!res?.ok) {
        throw new Error(res?.error || "Could not open chat tab.");
      }
      if (res.filled && res.autoSubmit) {
        status.textContent = res.usedSubmitButton
          ? `Prompt sent in new tab. (${lang}${auto}${bg})`
          : `Filled and Enter sent — check the new tab. (${lang}${auto}${bg})`;
      } else if (res.filled) {
        status.textContent = `Prompt filled in new tab — review and send. (${lang}${auto}${bg})`;
      } else {
        status.textContent = `Opened chat — ${res.hint || "Press Ctrl+V to paste."} (${lang}${auto}${bg})`;
      }
    } catch (e) {
      status.classList.add("yts-ext-err");
      status.textContent = e.message || "Failed.";
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
});

function scheduleMount() {
  requestAnimationFrame(() => {
    mountUI();
  });
}

function shouldTryMount() {
  if (!document.querySelector("ytd-watch-metadata")) return false;
  if (!document.querySelector(".yts-ext-host")) return true;
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

injectPageHook();

document.addEventListener("yt-navigate-finish", () => {
  captionMeta = null;
  transcriptCache = null;
  scheduleMount();
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
  }
});
mo.observe(document.documentElement, { childList: true, subtree: true });
