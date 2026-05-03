/**
 * Transcript fetch (YouTube MAIN world) + open ChatGPT/Gemini, fill composer, auto-send.
 */

async function fillAiComposerInPage(payload) {
  const text = String(payload?.text || "");
  const service = payload?.service || "";

  function allTextareasAndEditables() {
    const out = [];
    document.querySelectorAll("textarea").forEach((el) => out.push(el));
    document.querySelectorAll('[contenteditable="true"]').forEach((el) => {
      if (el.offsetParent !== null || el.getClientRects().length) out.push(el);
    });
    document.querySelectorAll("*").forEach((host) => {
      if (host.shadowRoot) {
        host.shadowRoot.querySelectorAll("textarea").forEach((el) => out.push(el));
        host.shadowRoot.querySelectorAll('[contenteditable="true"]').forEach((el) => out.push(el));
      }
    });
    return out;
  }

  function pickComposer() {
    if (service === "chatgpt") {
      const ordered = [
        "textarea#prompt-textarea",
        "div#prompt-textarea[contenteditable='true']",
        "textarea[data-id='root']",
        "div[contenteditable='true'][data-testid*='prompt']",
        "form textarea",
        "main textarea",
      ];
      for (const sel of ordered) {
        const el = document.querySelector(sel);
        if (el) return el;
      }
    }
    if (service === "gemini") {
      const rt = document.querySelector("rich-textarea");
      if (rt?.shadowRoot) {
        const ta = rt.shadowRoot.querySelector("textarea");
        if (ta) return ta;
        const ed = rt.shadowRoot.querySelector('[contenteditable="true"]');
        if (ed) return ed;
      }
      const ordered = [
        "textarea[placeholder*='prompt' i]",
        "textarea[aria-label*='prompt' i]",
        "div.ql-editor[contenteditable='true']",
        ".text-input-field_textarea",
        "textarea",
      ];
      for (const sel of ordered) {
        const el = document.querySelector(sel);
        if (el) return el;
      }
    }
    const visible = allTextareasAndEditables();
    return visible[0] || null;
  }

  function setTextareaValue(el, value) {
    const proto = window.HTMLTextAreaElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) {
      desc.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setContentEditable(el, value) {
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand("insertText", false, value);
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: value,
      })
    );
  }

  function isVisibleSubmitButton(b) {
    if (!b || !(b instanceof Element)) return false;
    if (b.disabled || b.getAttribute("aria-disabled") === "true") return false;
    const style = window.getComputedStyle(b);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return b.offsetParent !== null || b.getClientRects().length > 0;
  }

  function findSubmitButton(composer) {
    if (service === "gemini") {
      const rt = document.querySelector("rich-textarea");
      const scope = rt?.closest("form") || rt?.parentElement?.parentElement?.parentElement;
      if (scope) {
        const cand = scope.querySelector(
          'button[aria-label*="Send" i], button[data-testid*="send" i], button[type="submit"]'
        );
        if (isVisibleSubmitButton(cand)) return cand;
      }
      const globalGem = document.querySelector(
        'button[aria-label*="Send" i], button[mattooltip*="Send" i], button[data-testid*="send" i]'
      );
      if (isVisibleSubmitButton(globalGem)) return globalGem;
    }
    if (service === "chatgpt") {
      const cand =
        document.querySelector("#composer-submit-button, button[data-testid='send-button']") ||
        document.querySelector('button[aria-label*="Send" i], button[data-testid*="send" i]');
      if (isVisibleSubmitButton(cand)) return cand;
    }
    const selectors = [
      'button[aria-label*="Send" i]',
      'button[aria-label*="Submit" i]',
      "button[type='submit']",
      "[data-testid*='submit' i]",
      "[data-testid*='send' i]",
    ];

    let n = composer;
    for (let i = 0; i < 14 && n; i++) {
      for (const sel of selectors) {
        const found = n.querySelector?.(sel);
        if (isVisibleSubmitButton(found)) return found;
      }
      const direct = selectors.map((s) => (n.matches?.(s) ? n : null)).filter(Boolean)[0];
      if (isVisibleSubmitButton(direct)) return direct;
      n = n.parentElement;
    }

    for (const sel of selectors) {
      const found = document.querySelector(sel);
      if (isVisibleSubmitButton(found)) return found;
    }
    return null;
  }

  function tryAutoSubmit(composer) {
    composer.focus();
    const btn = findSubmitButton(composer);
    if (btn) {
      btn.click();
      return { usedSubmitButton: true };
    }
    for (const type of ["keydown", "keypress", "keyup"]) {
      composer.dispatchEvent(
        new KeyboardEvent(type, {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        })
      );
    }
    return { usedSubmitButton: false };
  }

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const el = pickComposer();
    if (el) {
      try {
        if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
          setTextareaValue(el, text);
        } else {
          setContentEditable(el, text);
        }
        el.focus();
        await new Promise((r) => setTimeout(r, 160));
        const sub = tryAutoSubmit(el);
        return { ok: true, autoSubmit: true, usedSubmitButton: sub.usedSubmitButton };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  return { ok: false, error: "Could not find the chat input — use Ctrl+V (prompt is on clipboard)." };
}

function startUrlForService(service) {
  if (service === "chatgpt") return "https://chatgpt.com/";
  if (service === "gemini") return "https://gemini.google.com/app";
  return null;
}

function urlMatchesService(service, url) {
  if (!url) return false;
  if (service === "chatgpt") return /chatgpt\.com|chat\.openai\.com/i.test(url);
  if (service === "gemini") return /gemini\.google\.com/i.test(url);
  return false;
}

function openAiTabAndFill(service, promptText, sendResponse, openInBackground) {
  const startUrl = startUrlForService(service);
  if (!startUrl) {
    sendResponse({ ok: false, error: "Unknown AI service." });
    return;
  }

  let finished = false;
  const done = (obj) => {
    if (finished) return;
    finished = true;
    try {
      sendResponse(obj);
    } catch (_) {
      /* channel may be closed */
    }
  };

  const active = openInBackground !== true;
  chrome.tabs.create({ url: startUrl, active }, (tab) => {
    if (chrome.runtime.lastError || !tab?.id) {
      done({ ok: false, error: chrome.runtime.lastError?.message || "Could not open tab." });
      return;
    }

    const tabId = tab.id;
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      done({ ok: false, error: "Timed out waiting for the chat page to load." });
    }, 50000);

    function onUpdated(updatedId, info, t) {
      if (updatedId !== tabId || info.status !== "complete" || !t?.url) return;
      if (!urlMatchesService(service, t.url)) return;

      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);

      setTimeout(() => {
        chrome.scripting
          .executeScript({
            target: { tabId },
            world: "MAIN",
            args: [{ text: promptText, service }],
            func: fillAiComposerInPage,
          })
          .then((inj) => {
            const r = inj?.[0]?.result;
            if (r?.ok) {
              done({
                ok: true,
                filled: true,
                autoSubmit: !!r.autoSubmit,
                usedSubmitButton: !!r.usedSubmitButton,
              });
            } else {
              done({
                ok: true,
                filled: false,
                hint: r?.error || "Paste with Ctrl+V — prompt is on your clipboard.",
              });
            }
          })
          .catch((err) => {
            done({
              ok: true,
              filled: false,
              hint: err?.message || "Paste with Ctrl+V — prompt is on your clipboard.",
            });
          });
      }, 900);
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "YTS_LOCAL_TRANSCRIPT") {
    // Route localhost yt-dlp call through the background worker so it's not
    // subject to page-context CORS quirks (Brave + cross-origin to localhost
    // can be flaky from a content script).
    (async () => {
      try {
        const url = String(message.url || "");
        if (!url) {
          sendResponse({ ok: false, error: "missing url" });
          return;
        }
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 30000);
        let resp;
        try {
          resp = await fetch("http://localhost:3000/api/transcript", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url }),
            signal: ctrl.signal,
          });
        } finally {
          clearTimeout(t);
        }
        if (!resp.ok) {
          sendResponse({ ok: false, error: `server ${resp.status}` });
          return;
        }
        const data = await resp.json();
        sendResponse({ ok: true, data });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true; // async sendResponse
  }
  return undefined;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "YTS_FETCH_TRANSCRIPT") {
    const tabId = sender.tab?.id;
    const langPrefs = Array.isArray(message.langPrefs) && message.langPrefs.length
      ? message.langPrefs
      : ["ko", "ko-KR", "en", "en-US", "en-GB", "en-CA", "en-AU"];

    if (tabId == null) {
      sendResponse({ ok: false, error: "No tab id — reload the watch page." });
      return false;
    }

    chrome.scripting
      .executeScript({
        target: { tabId, allFrames: false },
        world: "MAIN",
        args: [langPrefs, message.expectedVideoId || "", message.aggressive !== false],
        func: async (prefs, expectedVideoId, aggressive) => {
          function getPlayerResponse() {
            // Prefer the LIVE player response. YouTube refreshes caption
            // baseUrls with a Proof-of-Origin Token (pot=) shortly after the
            // player initializes; the cached ytInitialPlayerResponse holds
            // the stale pre-pot baseUrl which YouTube now rejects (HTTP 400).
            try {
              const el = document.querySelector("#movie_player");
              if (el && typeof el.getPlayerResponse === "function") {
                const o = el.getPlayerResponse();
                if (o && (o.videoDetails || o.captions)) return o;
              }
            } catch (_) {}
            try {
              const args = window.ytplayer?.config?.args;
              const raw = args?.player_response || args?.raw_player_response;
              if (typeof raw === "string" && raw.length > 10) {
                const o = JSON.parse(raw);
                if (o && (o.videoDetails || o.captions)) return o;
              }
            } catch (_) {}
            try {
              const a = window.ytInitialPlayerResponse;
              if (a && (a.videoDetails || a.captions)) return a;
            } catch (_) {}
            return null;
          }

          // True once a caption baseUrl carries a pot= or potc= param —
          // the marker that YouTube has accepted the player's
          // Proof-of-Origin Token and the URL will return 200 instead of 400.
          function trackHasPotToken(track) {
            const u = String(track?.baseUrl || "");
            return /[?&]potc?=/.test(u);
          }

          function normalizeUrl(raw) {
            let s = String(raw || "").trim();
            if (!s) return "";
            if (s.startsWith("//")) s = `${location.protocol}${s}`;
            return s;
          }

          function stripFmtParam(urlStr) {
            const s = normalizeUrl(urlStr);
            const q = s.indexOf("?");
            if (q < 0) return s;
            const base = s.slice(0, q);
            const qs = s
              .slice(q + 1)
              .split("&")
              .filter((p) => p && !/^fmt=/i.test(p));
            return qs.length ? `${base}?${qs.join("&")}` : base;
          }

          function buildUrlAttempts(baseUrl) {
            const s = normalizeUrl(baseUrl);
            if (!s) return [];
            const bare = stripFmtParam(s);
            const out = [];
            const seen = new Set();
            const add = (u) => {
              if (u && !seen.has(u)) {
                seen.add(u);
                out.push(u);
              }
            };
            add(bare);
            add(s);
            const withFmt = (fmt) => {
              const b = bare;
              return b + (b.includes("?") ? "&" : "?") + `fmt=${encodeURIComponent(fmt)}`;
            };
            add(withFmt("xml"));
            add(withFmt("json3"));
            add(withFmt("srv3"));
            add(withFmt("srv2"));
            add(withFmt("srv1"));
            add(withFmt("vtt"));
            add(withFmt("txt"));
            add(withFmt("ttml"));
            return out;
          }

          function orderTracks(tracks, prefList) {
            const out = [];
            const seen = new Set();
            for (const code of prefList) {
              const low = String(code || "").toLowerCase();
              let t = tracks.find((tr) => tr.languageCode === code);
              if (!t) {
                t = tracks.find((tr) => String(tr.languageCode || "").toLowerCase() === low);
              }
              if (!t) {
                t = tracks.find((tr) =>
                  String(tr.languageCode || "")
                    .toLowerCase()
                    .startsWith(low)
                );
              }
              if (t && !seen.has(t)) {
                seen.add(t);
                out.push(t);
              }
            }
            for (const t of tracks) {
              if (!seen.has(t)) {
                seen.add(t);
                out.push(t);
              }
            }
            return out;
          }

          function textFromJson3(data) {
            const parts = [];
            for (const ev of data.events || []) {
              if (!ev.segs) continue;
              for (const seg of ev.segs) {
                if (seg.utf8) parts.push(seg.utf8);
              }
            }
            return parts.join("").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
          }

          function textFromTimedtextXml(xmlStr) {
            const parser = new DOMParser();
            const doc = parser.parseFromString(xmlStr, "text/xml");
            if (doc.querySelector("parsererror")) return "";
            const nodes = doc.getElementsByTagName("text");
            const parts = [];
            for (let i = 0; i < nodes.length; i++) {
              const t = nodes[i].textContent;
              if (t) parts.push(t);
            }
            return parts.join(" ").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
          }

          function textFromWebVtt(raw) {
            const s = String(raw || "").trim();
            if (!/^WEBVTT/i.test(s)) return "";
            const parts = [];
            const blocks = s.split(/\n{2,}/);
            for (const block of blocks) {
              const lines = block.trim().split(/\n/);
              if (!lines.length) continue;
              let i = 0;
              if (/^\d+$/.test(lines[0].trim())) i += 1;
              if (i < lines.length && /-->/u.test(lines[i])) i += 1;
              for (; i < lines.length; i++) {
                let L = lines[i].replace(/<[^>]+>/gu, "").trim();
                if (!L || /^NOTE\b/iu.test(L)) continue;
                if (/^Kind:|^Language:/iu.test(L)) continue;
                parts.push(L);
              }
            }
            return parts.join(" ").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
          }

          /** YouTube fmt=txt or plain SRT-like bodies without XML/WEBVTT wrapper. */
          function textFromLooseSrtLike(raw) {
            const lines = String(raw || "").split(/\r?\n/);
            const parts = [];
            for (const line of lines) {
              const L = line.trim();
              if (!L) continue;
              if (/^\d+$/.test(L)) continue;
              if (/-->\s*/.test(L)) continue;
              if (/^WEBVTT/i.test(L)) continue;
              parts.push(L.replace(/<[^>]+>/gu, ""));
            }
            return parts.join(" ").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
          }

          function textFromTtml(xmlStr) {
            const parser = new DOMParser();
            const doc = parser.parseFromString(xmlStr, "text/xml");
            if (doc.querySelector("parsererror")) return "";
            const root = doc.documentElement;
            if (!root) return "";
            const tag = root.tagName.toLowerCase();
            const ns = root.getAttribute("xmlns") || "";
            if (tag !== "tt" && !/ttml/i.test(ns) && !/<p[\s>]/.test(xmlStr)) return "";
            let t = (root.textContent || "").replace(/\u00a0/g, " ");
            return t.replace(/\s+/g, " ").trim();
          }

          function matchesTranscriptUiHint(raw) {
            const s = String(raw || "").trim();
            if (!s || s.length > 220) return false;
            const low = s.toLowerCase();
            const latin = [
              "show transcript",
              "show transcription",
              "full transcript",
              "open transcript",
              "view transcript",
              "transkript anzeigen",
              "afficher la transcription",
              "mostrar transcripción",
              "mostrar transcrição",
              "trascrizione",
            ];
            for (const h of latin) {
              if (low.includes(h)) return true;
            }
            if (low.includes("transcript") && s.length < 90) return true;
            const cjk = [
              "스크립트",
              "대본",
              "スクリプト",
              "文字起こし",
              "转录",
              "轉錄",
              "显示转录",
              "顯示轉錄",
            ];
            for (const h of cjk) {
              if (s.includes(h)) return true;
            }
            return false;
          }

          function findTranscriptOpenByAriaLabel() {
            const nodes = document.querySelectorAll("[aria-label]");
            for (const el of nodes) {
              const lab = el.getAttribute("aria-label") || "";
              if (matchesTranscriptUiHint(lab)) return el;
            }
            return null;
          }

          function parseBody(raw) {
            const trimmed = String(raw || "").trim();
            if (!trimmed) return { ok: false, reason: "empty" };
            if (trimmed.startsWith("<!") || /<html[\s>]/i.test(trimmed)) {
              return { ok: false, reason: "html" };
            }
            if (/^WEBVTT/im.test(trimmed)) {
              const t = textFromWebVtt(trimmed);
              return t ? { ok: true, text: t } : { ok: false, reason: "vtt_no_text" };
            }
            if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
              try {
                const data = JSON.parse(trimmed);
                const t = textFromJson3(data);
                return t ? { ok: true, text: t } : { ok: false, reason: "json_no_text" };
              } catch {
                return { ok: false, reason: "bad_json" };
              }
            }
            if (trimmed.includes("<transcript") || /<text[\s>]/.test(trimmed)) {
              const t = textFromTimedtextXml(trimmed);
              return t ? { ok: true, text: t } : { ok: false, reason: "bad_xml" };
            }
            if (
              (/<tt[\s>]/i.test(trimmed) || /xmlns=["']http:\/\/www\.w3\.org\/ns\/ttml/i.test(trimmed)) &&
              !/<transcript[\s>]/i.test(trimmed)
            ) {
              const t = textFromTtml(trimmed);
              return t ? { ok: true, text: t } : { ok: false, reason: "bad_ttml" };
            }
            const loose = textFromLooseSrtLike(trimmed);
            if (loose.length > 45) return { ok: true, text: loose };
            return { ok: false, reason: "unknown" };
          }

          const FETCH_TIMEOUT_MS = 14000;

          function timedtextPageHeaders() {
            const href = String(location.href || "").split("#")[0];
            const referer = /^https:\/\/www\.youtube\.com\/watch/i.test(href)
              ? href
              : "https://www.youtube.com/";
            return {
              Accept: "*/*",
              "Accept-Language": navigator.language || "en-US,en;q=0.9",
              Referer: referer,
              Origin: "https://www.youtube.com",
            };
          }

          async function fetchOne(url) {
            const ctrl = new AbortController();
            const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
            try {
              const res = await fetch(url, {
                credentials: "include",
                cache: "no-store",
                signal: ctrl.signal,
                mode: "cors",
                headers: timedtextPageHeaders(),
              });
              const body = await res.text();
              return { ok: res.ok, status: res.status, body, via: "fetch" };
            } catch (e) {
              if (e && e.name === "AbortError") {
                return { ok: false, error: "Request timed out.", via: "fetch" };
              }
              return { ok: false, error: String(e?.message || e), via: "fetch" };
            } finally {
              clearTimeout(tid);
            }
          }

          function xhrOne(url) {
            return new Promise((resolve) => {
              let settled = false;
              const finish = (obj) => {
                if (settled) return;
                settled = true;
                clearTimeout(tid);
                resolve(obj);
              };
              let tid = 0;
              try {
                const x = new XMLHttpRequest();
                tid = setTimeout(() => {
                  try {
                    x.abort();
                  } catch (_) {}
                  finish({ ok: false, error: "Request timed out.", via: "xhr" });
                }, FETCH_TIMEOUT_MS);
                x.open("GET", url, true);
                x.withCredentials = true;
                try {
                  const h = timedtextPageHeaders();
                  x.setRequestHeader("Accept", h.Accept);
                  x.setRequestHeader("Accept-Language", h["Accept-Language"]);
                  x.setRequestHeader("Referer", h.Referer);
                  x.setRequestHeader("Origin", h.Origin);
                } catch (_) {}
                x.onreadystatechange = () => {
                  if (x.readyState === 4) {
                    finish({
                      ok: x.status >= 200 && x.status < 400,
                      status: x.status,
                      body: x.responseText || "",
                      via: "xhr",
                    });
                  }
                };
                x.send();
              } catch (e) {
                finish({ ok: false, error: String(e?.message || e), via: "xhr" });
              }
            });
          }

          function findGetTranscriptParams() {
            let params = "";
            function walk(obj, depth, seen) {
              if (!obj || typeof obj !== "object" || depth > 42) return;
              if (seen.has(obj)) return;
              seen.add(obj);
              const ep = obj.getTranscriptEndpoint;
              if (ep && typeof ep.params === "string" && ep.params.length > 8) {
                params = ep.params;
                return;
              }
              for (const k of Object.keys(obj)) {
                walk(obj[k], depth + 1, seen);
                if (params) return;
              }
            }
            try {
              walk(window.ytInitialData, 0, new WeakSet());
            } catch (_) {}
            if (!params) {
              try {
                walk(getPlayerResponse(), 0, new WeakSet());
              } catch (_) {}
            }
            return params;
          }

          function extractTranscriptFromGetTranscriptResponse(data) {
            const parts = [];
            function walk(obj, depth) {
              if (!obj || depth > 50) return;
              if (Array.isArray(obj)) {
                for (let i = 0; i < obj.length; i++) walk(obj[i], depth + 1);
                return;
              }
              if (typeof obj !== "object") return;
              const seg = obj.transcriptSegmentRenderer;
              if (seg) {
                const sn = seg.snippet;
                if (sn?.runs && Array.isArray(sn.runs)) {
                  for (const r of sn.runs) {
                    if (r.text) parts.push(r.text);
                  }
                } else if (sn?.simpleText) {
                  parts.push(sn.simpleText);
                }
              }
              for (const k of Object.keys(obj)) walk(obj[k], depth + 1);
            }
            walk(data, 0);
            return parts.join("").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
          }

          async function tryInnerTubeTranscript(ordered, effectiveVid, pageVid) {
            const params = findGetTranscriptParams();
            if (!params) return null;
            let apiKey = "";
            let clientVersion = "2.0";
            let clientName = "WEB";
            try {
              const y = window.ytcfg;
              const d = y?.data_ || {};
              if (typeof y?.get === "function") {
                apiKey = y.get("INNERTUBE_API_KEY") || d.INNERTUBE_API_KEY || "";
                clientVersion = String(y.get("INNERTUBE_CLIENT_VERSION") || d.INNERTUBE_CLIENT_VERSION || "2.0");
                clientName = String(y.get("INNERTUBE_CLIENT_NAME") || d.INNERTUBE_CLIENT_NAME || "WEB");
              } else {
                apiKey = d.INNERTUBE_API_KEY || "";
                clientVersion = String(d.INNERTUBE_CLIENT_VERSION || "2.0");
                clientName = String(d.INNERTUBE_CLIENT_NAME || "WEB");
              }
            } catch (_) {}
            if (!apiKey) return null;
            const url = `https://www.youtube.com/youtubei/v1/get_transcript?key=${encodeURIComponent(apiKey)}&prettyPrint=false`;
            const ctrl = new AbortController();
            const tid = setTimeout(() => ctrl.abort(), 12000);
            try {
              const res = await fetch(url, {
                method: "POST",
                credentials: "include",
                cache: "no-store",
                signal: ctrl.signal,
                headers: {
                  "Content-Type": "application/json",
                  ...timedtextPageHeaders(),
                },
                body: JSON.stringify({
                  context: {
                    client: {
                      clientName,
                      clientVersion,
                      hl: (navigator.language || "en-US").slice(0, 2),
                      visitorData: (() => {
                        try {
                          const y = window.ytcfg;
                          return (typeof y?.get === "function" ? y.get("VISITOR_DATA") : null)
                            || y?.data_?.VISITOR_DATA || "";
                        } catch { return ""; }
                      })(),
                    },
                  },
                  params,
                }),
              });
              const raw = await res.text();
              if (!res.ok) return null;
              let data;
              try {
                data = JSON.parse(raw);
              } catch {
                return null;
              }
              const text = extractTranscriptFromGetTranscriptResponse(data);
              if (text.length < 40) return null;
              return {
                ok: true,
                videoId: effectiveVid || pageVid,
                text,
                languageCode: ordered[0]?.languageCode || "",
                kind: ordered[0]?.kind || "",
                source: "innertube_get_transcript",
              };
            } catch {
              return null;
            } finally {
              clearTimeout(tid);
            }
          }

          async function tryTimedtextUrls(urls) {
            let last = "No usable caption response.";
            for (const url of urls) {
              let r = await fetchOne(url);
              if (!String(r.body || "").trim() && !r.error) {
                r = await xhrOne(url);
              }
              if (r.error) {
                last = r.error;
                continue;
              }
              if (!r.ok) {
                last = `HTTP ${r.status}`;
                continue;
              }
              const parsed = parseBody(r.body);
              if (parsed.ok) {
                return { ok: true, text: parsed.text, source: `timedtext:${r.via}` };
              }
              last = parsed.reason || "parse_fail";
            }
            return { ok: false, error: last };
          }

          function findTranscriptEngagementPanel() {
            const selectors = [
              'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]',
              'ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"]',
              'ytd-engagement-panel-section-list-renderer[target-id*="transcript" i]',
            ];
            for (const sel of selectors) {
              const el = document.querySelector(sel);
              if (el) return el;
            }
            return null;
          }

          function transcriptPanelRoot() {
            const panel = findTranscriptEngagementPanel();
            if (panel) {
              const content = panel.querySelector("#content");
              if (content) return content;
            }
            const tsp = document.querySelector("ytd-transcript-search-panel-renderer");
            if (tsp) return tsp;
            const body = document.querySelector("ytd-transcript-body-renderer");
            return body || null;
          }

          function elementLooksVisible(el) {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }

          /** Selector for transcript segments (old + modern view model). */
          const SEGMENT_SELECTORS = "ytd-transcript-segment-renderer, transcript-segment-view-model";

          /** YouTube often nests segments under shadow roots; light-DOM querySelector misses them. */
          function deepQuerySelectorAll(root, selector) {
            const results = [];
            const seen = new Set();
            function visit(node) {
              if (!node || !node.querySelectorAll) return;
              try {
                node.querySelectorAll(selector).forEach((el) => {
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

          function textContentDeep(root) {
            if (!root) return "";
            const parts = [];
            function walk(node) {
              if (!node) return;
              if (node.nodeType === 3) {
                const s = node.textContent;
                if (s) parts.push(s);
                return;
              }
              if (node.nodeType === 1) {
                const tag = node.tagName;
                if (tag === "SCRIPT" || tag === "STYLE") return;
                if (node.shadowRoot) walk(node.shadowRoot);
                const ch = node.childNodes;
                for (let i = 0; i < ch.length; i++) walk(ch[i]);
              }
            }
            walk(root);
            return parts.join(" ");
          }

          function visibleTranscriptSegmentsDeep() {
            const all = deepQuerySelectorAll(document.documentElement, SEGMENT_SELECTORS);
            return all.filter((s) => elementLooksVisible(s));
          }

          function transcriptPanelVisible() {
            const panel = findTranscriptEngagementPanel();
            if (panel && (panel.offsetParent !== null || elementLooksVisible(panel))) return true;
            const tsp = document.querySelector("ytd-transcript-search-panel-renderer");
            if (tsp && (tsp.offsetParent !== null || elementLooksVisible(tsp))) return true;
            if (visibleTranscriptSegmentsDeep().length > 0) return true;
            const segs = document.querySelectorAll(SEGMENT_SELECTORS);
            for (let i = 0; i < segs.length; i++) {
              const host = segs[i].closest(
                "ytd-engagement-panel-section-list-renderer, ytd-transcript-search-panel-renderer"
              );
              if (host && elementLooksVisible(host)) return true;
            }
            return false;
          }

          function collectTranscriptSegmentTexts(segs) {
            const parts = [];
            segs.forEach((seg) => {
              const inner = seg.querySelector(
                ".segment-text, #segment-text, #segment, yt-formatted-string#text, yt-formatted-string, yt-attributed-string"
              );
              let t = (inner && inner.textContent ? inner.textContent : "").trim();
              if (!t) {
                t = textContentDeep(seg);
              }
              if (!t) {
                t = (seg.textContent || "").trim();
              }
              t = t
                .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
                .replace(/\d+\s*seconds?/gi, " ")
                .replace(/\s+/g, " ")
                .trim();
              if (t) parts.push(t);
            });
            return parts.join(" ").replace(/\s+/g, " ").trim();
          }

          /** Fallback: read all text from the transcript panel #content, strip timestamps. */
          function scrapeTranscriptPanelTextContent() {
            const panel = findTranscriptEngagementPanel();
            if (!panel) return "";
            const content = panel.querySelector("#content");
            if (!content) return "";
            const raw = (content.textContent || "").trim();
            if (raw.length < 40) return "";
            return raw
              .replace(/^Search transcript/i, "")
              .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
              .replace(/\d+\s*seconds?/gi, " ")
              .replace(/\s+/g, " ")
              .trim();
          }

          /** Detect what language the panel is currently showing. */
          function detectPanelLanguage(panelText, tracks) {
            const panel = findTranscriptEngagementPanel();
            if (panel) {
              const ctxInfo = panel.querySelector("#contextual-info");
              const ctxText = (ctxInfo?.textContent || "").trim().toLowerCase();
              for (const t of tracks) {
                const name = (t.name?.simpleText || t.name?.runs?.[0]?.text || "").toLowerCase();
                if (name && ctxText.includes(name)) {
                  return { languageCode: t.languageCode || "", kind: t.kind || "" };
                }
              }
              if (ctxText.includes("english")) return { languageCode: "en", kind: "asr" };
              if (ctxText.includes("korean") || ctxText.includes("한국어")) return { languageCode: "ko", kind: "asr" };
              if (ctxText.includes("japanese") || ctxText.includes("日本語")) return { languageCode: "ja", kind: "asr" };
            }
            if (panelText) {
              const sample = panelText.slice(0, 500);
              const koreanChars = (sample.match(/[\uAC00-\uD7AF]/g) || []).length;
              const latinChars = (sample.match(/[a-zA-Z]/g) || []).length;
              const cjkChars = (sample.match(/[\u3000-\u9FFF\uF900-\uFAFF]/g) || []).length;
              if (latinChars > koreanChars && latinChars > cjkChars) {
                const enTrack = tracks.find((t) => /^en/i.test(t.languageCode));
                if (enTrack) return { languageCode: enTrack.languageCode, kind: enTrack.kind || "" };
                return { languageCode: "en", kind: "asr" };
              }
              if (koreanChars > latinChars) {
                const koTrack = tracks.find((t) => /^ko/i.test(t.languageCode));
                if (koTrack) return { languageCode: koTrack.languageCode, kind: koTrack.kind || "" };
                return { languageCode: "ko", kind: "asr" };
              }
            }
            return { languageCode: tracks[0]?.languageCode || "", kind: tracks[0]?.kind || "" };
          }

          function clickShowTranscript() {
            const selectors = [
              'button[aria-label="Show transcript"]',
              'button[aria-label="스크립트 표시"]',
              'button[aria-label*="transcript" i]',
              'button[aria-label*="스크립트" i]',
            ];
            for (const sel of selectors) {
              const btns = document.querySelectorAll(sel);
              for (const btn of btns) {
                try { btn.click(); return true; } catch (_) {}
              }
            }
            const byAria = findTranscriptOpenByAriaLabel();
            if (byAria) {
              try { (byAria.closest("button") || byAria).click(); return true; } catch (_) {}
            }
            const candidates = document.querySelectorAll(
              "button, yt-formatted-string, tp-yt-paper-item, ytd-menu-service-item-renderer"
            );
            for (const el of candidates) {
              const txt = (el.textContent || "").trim();
              if (matchesTranscriptUiHint(txt)) {
                try { (el.closest("button") || el).click(); return true; } catch (_) {}
              }
            }
            return false;
          }

          async function tryDomTranscriptAggressive() {
            let opened = transcriptPanelVisible();

            if (!opened) {
              opened = clickShowTranscript();
              if (opened) await new Promise((r) => setTimeout(r, 1200));
            }

            if (!opened || !transcriptPanelVisible()) {
              const more = document.querySelector(
                'button[aria-label*="More actions"], button[aria-label="More actions"], ' +
                'button[aria-label*="more actions" i], button[aria-label*="더보기"], ' +
                'button[aria-label*="기타"]'
              ) || document.querySelector("#button-shape-more button");
              if (more) {
                more.click();
                await new Promise((r) => setTimeout(r, 800));
                opened = clickShowTranscript();
                if (opened) await new Promise((r) => setTimeout(r, 1200));
              }
            }

            if (!opened || !transcriptPanelVisible()) {
              const allBtns = document.querySelectorAll('button[aria-label]');
              for (const btn of allBtns) {
                const lab = btn.getAttribute("aria-label") || "";
                if (/transcript|스크립트|대본/i.test(lab)) {
                  btn.click();
                  opened = true;
                  await new Promise((r) => setTimeout(r, 1200));
                  break;
                }
              }
            }

            await new Promise((r) => setTimeout(r, 400));
            const text = await scrapeTranscriptFromDom(28000);
            if (text) return { ok: true, text, source: "dom_panel_auto" };
            return { ok: false, error: "dom_auto_fail" };
          }

          async function scrapeTranscriptFromDom(maxWaitMs) {
            const deadline = Date.now() + maxWaitMs;
            const minSegs = 2;
            const minChars = 35;
            while (Date.now() < deadline) {
              const allDeep = deepQuerySelectorAll(document.documentElement, SEGMENT_SELECTORS);
              const visDeep = allDeep.filter((s) => elementLooksVisible(s));
              const segPool = visDeep.length > minSegs ? visDeep : allDeep;
              if (segPool.length > minSegs) {
                const text = collectTranscriptSegmentTexts(segPool);
                if (text.length >= minChars) return text;
              }

              const roots = [];
              const r1 = document.querySelector(
                'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"] #content'
              );
              if (r1) roots.push(r1);
              const r1b = findTranscriptEngagementPanel()?.querySelector("#content");
              if (r1b && !roots.includes(r1b)) roots.push(r1b);
              const tsp = document.querySelector("ytd-transcript-search-panel-renderer");
              if (tsp) roots.push(tsp);
              const tbody = document.querySelector("ytd-transcript-body-renderer");
              if (tbody) roots.push(tbody);
              const fallbackRoot = transcriptPanelRoot();
              if (fallbackRoot && !roots.includes(fallbackRoot)) roots.push(fallbackRoot);

              for (const root of roots) {
                const segs = deepQuerySelectorAll(root, SEGMENT_SELECTORS);
                if (segs.length > minSegs) {
                  const text = collectTranscriptSegmentTexts(segs);
                  if (text.length >= minChars) return text;
                }
                const segsLight = root.querySelectorAll(SEGMENT_SELECTORS);
                if (segsLight.length > minSegs) {
                  const text = collectTranscriptSegmentTexts(Array.from(segsLight));
                  if (text.length >= minChars) return text;
                }
              }

              const panels = document.querySelectorAll("ytd-engagement-panel-section-list-renderer");
              for (let i = 0; i < panels.length; i++) {
                const panel = panels[i];
                const tid = panel.getAttribute("target-id") || "";
                const isTranscriptPanel = /transcript/i.test(tid);
                if (!isTranscriptPanel && panel.hasAttribute("hidden")) continue;
                if (!isTranscriptPanel && !elementLooksVisible(panel) && panel.offsetParent === null) continue;
                const segs = deepQuerySelectorAll(panel, SEGMENT_SELECTORS);
                if (segs.length > minSegs) {
                  const text = collectTranscriptSegmentTexts(segs);
                  if (text.length >= minChars) return text;
                }
              }

              const panelText = scrapeTranscriptPanelTextContent();
              if (panelText.length >= minChars) return panelText;

              await new Promise((r) => setTimeout(r, 250));
            }
            return "";
          }

          /** Only read the panel if the user already opened it — no ⋮ clicks (faster, less UI noise). */
          async function tryPassiveDomScrape() {
            const panelOpen = transcriptPanelVisible();
            const hasDeepSegs = visibleTranscriptSegmentsDeep().length > 2;
            if (!panelOpen && !hasDeepSegs) {
              return { ok: false, error: "panel_not_open" };
            }
            const text = await scrapeTranscriptFromDom(9000);
            if (text) return { ok: true, text, source: "dom_panel_passive" };
            return { ok: false, error: "empty_panel" };
          }

          const pageVid = new URLSearchParams(location.search).get("v") || "";
          const expectVid = String(expectedVideoId || pageVid || "").trim();
          if (pageVid && expectVid && pageVid !== expectVid) {
            return {
              ok: false,
              error: "Extension state out of sync — refresh the watch page.",
            };
          }

          function captionUrlMatchesVideo(baseUrl, vid) {
            if (!vid || !baseUrl) return true;
            try {
              const dec = decodeURIComponent(String(baseUrl));
              return (
                dec.includes(`v=${vid}`) ||
                dec.includes(`&v=${vid}`) ||
                dec.includes(`vid=${vid}`) ||
                dec.includes(`&vid=${vid}`)
              );
            } catch (_) {
              return String(baseUrl).includes(vid);
            }
          }

          let pr = null;
          // Wait up to ~6.5s for (a) the live player response to expose
          // captionTracks AND (b) at least one track baseUrl to carry the
          // pot=/potc= Proof-of-Origin marker. Without pot, the timedtext
          // server returns HTTP 400 on every fetch.
          const syncDeadline = Date.now() + 6500;
          let sawTracks = false;
          while (Date.now() < syncDeadline) {
            pr = getPlayerResponse();
            const loopTracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
            const loopPv = pr?.videoDetails?.videoId || "";
            if (Array.isArray(loopTracks) && loopTracks.length > 0) {
              sawTracks = true;
              const anyPotted = loopTracks.some(trackHasPotToken);
              if (anyPotted && loopPv) break;
              // Tracks present but no pot yet — keep polling so we don't
              // race the player and burn our retry budget on guaranteed-400s.
            }
            await new Promise((r) => setTimeout(r, 250));
          }
          // Final read in case the loop exited on the deadline.
          pr = getPlayerResponse() || pr;

          const pv = pr?.videoDetails?.videoId || "";
          const effectiveVid = pv || pageVid;

          if (!pr || !Array.isArray(pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks)) {
            return {
              ok: false,
              error: "No captions in player data yet — wait a few seconds and tap Copy again, or refresh.",
            };
          }

          const tracks = pr.captions.playerCaptionsTracklistRenderer.captionTracks;
          if (!tracks.length) {
            return { ok: false, error: "No captions in player data — this video may have no subtitles." };
          }

          const ordered = orderTracks(tracks, prefs);

          function tryTimedtextForTracks(filterByVid) {
            return (async () => {
              for (const track of ordered) {
                if (!track.baseUrl) continue;
                if (filterByVid && effectiveVid && !captionUrlMatchesVideo(track.baseUrl, effectiveVid)) {
                  continue;
                }
                const urls = buildUrlAttempts(track.baseUrl);
                const res = await tryTimedtextUrls(urls);
                if (res.ok) {
                  return {
                    ok: true,
                    videoId: effectiveVid || pageVid,
                    text: res.text,
                    languageCode: track.languageCode || "",
                    kind: track.kind || "",
                    source: res.source,
                  };
                }
              }
              return null;
            })();
          }

          let got = await tryTimedtextForTracks(true);
          if (!got) {
            got = await tryTimedtextForTracks(false);
          }
          if (!got) {
            // Tier 1 came up empty — likely the baseUrls 400'd because the
            // pot token wasn't ready. Re-read the live player response and
            // retry with whatever (potentially fresh) baseUrls it now has.
            const fresh = getPlayerResponse();
            const freshTracks = fresh?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
            if (Array.isArray(freshTracks) && freshTracks.length) {
              const freshOrdered = orderTracks(freshTracks, prefs);
              const same =
                freshOrdered.length === ordered.length &&
                freshOrdered.every((t, i) => t.baseUrl === ordered[i].baseUrl);
              if (!same) {
                for (const track of freshOrdered) {
                  if (!track.baseUrl) continue;
                  const urls = buildUrlAttempts(track.baseUrl);
                  const res = await tryTimedtextUrls(urls);
                  if (res.ok) {
                    got = {
                      ok: true,
                      videoId: effectiveVid || pageVid,
                      text: res.text,
                      languageCode: track.languageCode || "",
                      kind: track.kind || "",
                      source: `${res.source}_refreshed`,
                    };
                    break;
                  }
                }
              }
            }
          }
          if (!got) {
            got = await tryInnerTubeTranscript(ordered, effectiveVid, pageVid);
          }
          if (got) {
            return got;
          }

          const domTry = await tryPassiveDomScrape();
          if (domTry.ok) {
            const lang = detectPanelLanguage(domTry.text, tracks);
            return {
              ok: true,
              videoId: effectiveVid || pageVid,
              text: domTry.text,
              languageCode: lang.languageCode,
              kind: lang.kind,
              source: domTry.source,
            };
          }

          // Skip the panel-opening tier during prefetch so the extension
          // never opens YouTube's transcript UI on its own. The user's
          // explicit Copy click runs with aggressive=true and may open it.
          if (!aggressive) {
            return {
              ok: false,
              error: "prefetch_no_captions_yet",
            };
          }

          const domAuto = await tryDomTranscriptAggressive();
          if (domAuto.ok) {
            const lang = detectPanelLanguage(domAuto.text, tracks);
            return {
              ok: true,
              videoId: effectiveVid || pageVid,
              text: domAuto.text,
              languageCode: lang.languageCode,
              kind: lang.kind,
              source: domAuto.source,
            };
          }

          got = await tryInnerTubeTranscript(ordered, effectiveVid, pageVid);
          if (got) {
            return got;
          }

          return {
            ok: false,
            error:
              "No captions from timedtext, InnerTube, or transcript panel. Refresh, start playback, retry — or use local yt-dlp for this URL.",
          };
        },
      })
      .then((injected) => {
        const result = injected?.[0]?.result;
        if (result?.ok) {
          sendResponse(result);
        } else {
          sendResponse({ ok: false, error: result?.error || "Unknown error." });
        }
      })
      .catch((err) => {
        sendResponse({ ok: false, error: err?.message || String(err) });
      });

    return true;
  }

  if (message?.type === "YTS_OPEN_AI_WITH_PROMPT") {
    (async () => {
      try {
        const key = message.storageKey;
        if (!key || typeof key !== "string") {
          sendResponse({ ok: false, error: "Missing storage key. Try the button again." });
          return;
        }
        const data = await chrome.storage.local.get(key);
        const promptText = data[key];
        await chrome.storage.local.remove(key);
        if (!promptText || typeof promptText !== "string") {
          sendResponse({ ok: false, error: "Missing prompt. Try the button again." });
          return;
        }
        const service = message.service;
        if (!["chatgpt", "gemini"].includes(service)) {
          sendResponse({ ok: false, error: "Unknown service." });
          return;
        }
        openAiTabAndFill(service, promptText, sendResponse, message.openInBackground === true);
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }

  return false;
});
