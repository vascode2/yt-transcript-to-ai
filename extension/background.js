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
  if (message?.type === "YTS_FETCH_TRANSCRIPT") {
    const tabId = sender.tab?.id;
    const langPrefs = Array.isArray(message.langPrefs) && message.langPrefs.length
      ? message.langPrefs
      : ["en", "en-US", "en-GB", "en-CA", "en-AU"];

    if (tabId == null) {
      sendResponse({ ok: false, error: "No tab id — reload the watch page." });
      return false;
    }

    chrome.scripting
      .executeScript({
        target: { tabId, allFrames: false },
        world: "MAIN",
        args: [langPrefs],
        func: async (prefs) => {
          function getPlayerResponse() {
            try {
              const a = window.ytInitialPlayerResponse;
              if (a && (a.videoDetails || a.captions)) return a;
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
              const el = document.querySelector("#movie_player");
              if (el && typeof el.getPlayerResponse === "function") {
                const o = el.getPlayerResponse();
                if (o && (o.videoDetails || o.captions)) return o;
              }
            } catch (_) {}
            return null;
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
            add(withFmt("srv1"));
            return out;
          }

          function orderTracks(tracks, prefList) {
            const out = [];
            const seen = new Set();
            for (const code of prefList) {
              const t = tracks.find((tr) => tr.languageCode === code);
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

          function parseBody(raw) {
            const trimmed = String(raw || "").trim();
            if (!trimmed) return { ok: false, reason: "empty" };
            if (trimmed.startsWith("<!") || /<html[\s>]/i.test(trimmed)) {
              return { ok: false, reason: "html" };
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
            return { ok: false, reason: "unknown" };
          }

          const FETCH_TIMEOUT_MS = 14000;

          async function fetchOne(url) {
            const ctrl = new AbortController();
            const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
            try {
              const res = await fetch(url, {
                credentials: "include",
                cache: "no-store",
                signal: ctrl.signal,
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

          function transcriptPanelRoot() {
            const panel = document.querySelector(
              'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]'
            );
            const content = panel?.querySelector("#content");
            return content || document;
          }

          function transcriptPanelVisible() {
            const panel = document.querySelector(
              'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]'
            );
            return !!(panel && panel.offsetParent !== null);
          }

          function clickShowTranscriptIfPresent() {
            const labeled = document.querySelector('[aria-label="Show transcript"]');
            if (labeled) {
              (labeled.closest("button") || labeled).click();
              return true;
            }
            const tryClickTranscriptItem = () => {
              const candidates = document.querySelectorAll(
                "button, yt-formatted-string, tp-yt-paper-item, ytd-menu-service-item-renderer, a, tp-yt-paper-listbox tp-yt-paper-item"
              );
              for (const el of candidates) {
                const txt = (el.textContent || "").trim().toLowerCase();
                if (txt === "show transcript" || txt.includes("show transcript")) {
                  const btn = el.closest("button") || el.closest("ytd-button-renderer") || el.closest("a");
                  (btn || el).click();
                  return true;
                }
              }
              const aria = document.querySelector("[aria-label*='transcript' i], [aria-label*='Transcript' i]");
              if (aria) {
                (aria.closest("button") || aria).click();
                return true;
              }
              return false;
            };

            if (tryClickTranscriptItem()) return true;

            const more =
              document.querySelector(
                'ytd-menu-renderer button[aria-label*="More actions"], button[aria-label="More actions"], button[aria-label*="more actions" i]'
              ) || document.querySelector("#button-shape-more button");
            if (more) {
              more.click();
            }

            return false;
          }

          async function scrapeTranscriptFromDom(maxWaitMs) {
            const deadline = Date.now() + maxWaitMs;
            while (Date.now() < deadline) {
              const root = transcriptPanelRoot();
              const list = root.querySelector("ytd-transcript-segment-list-renderer");
              const segs = root.querySelectorAll(
                "ytd-transcript-segment-renderer .segment-text, ytd-transcript-segment-renderer #segment-text, ytd-transcript-segment-renderer yt-formatted-string"
              );
              if (list && segs.length > 2) {
                const parts = [];
                segs.forEach((n) => {
                  const t = (n.textContent || "").trim();
                  if (t) parts.push(t);
                });
                const text = parts.join(" ").replace(/\s+/g, " ").trim();
                if (text.length > 50) return text;
              }
              await new Promise((r) => setTimeout(r, 250));
            }
            return "";
          }

          async function tryDomTranscriptPanel() {
            const already = transcriptPanelVisible();
            let opened = already;
            if (!opened) {
              opened = clickShowTranscriptIfPresent();
            }
            if (!opened) {
              await new Promise((r) => setTimeout(r, 400));
              const labeled = document.querySelector('[aria-label="Show transcript"]');
              if (labeled) {
                (labeled.closest("button") || labeled).click();
                opened = true;
              }
            }
            if (!opened) {
              opened = (() => {
                const candidates = document.querySelectorAll(
                  "tp-yt-paper-item, ytd-menu-service-item-renderer, yt-formatted-string"
                );
                for (const el of candidates) {
                  const txt = (el.textContent || "").trim().toLowerCase();
                  if (txt.includes("show transcript")) {
                    (el.closest("tp-yt-paper-item") || el.closest("button") || el).click();
                    return true;
                  }
                }
                return false;
              })();
            }
            if (!opened && !transcriptPanelVisible()) {
              return { ok: false, error: "Could not open transcript panel (use ⋮ → Show transcript)." };
            }
            const text = await scrapeTranscriptFromDom(22000);
            if (text) return { ok: true, text, source: "dom_panel" };
            return { ok: false, error: "Transcript panel opened but no text appeared in time." };
          }

          const pr = getPlayerResponse();
          const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
          if (!Array.isArray(tracks) || !tracks.length) {
            return { ok: false, error: "No captions in player data — refresh the page or pick a video with subtitles." };
          }

          const ordered = orderTracks(tracks, prefs);
          for (const track of ordered) {
            if (!track.baseUrl) continue;
            const urls = buildUrlAttempts(track.baseUrl);
            const res = await tryTimedtextUrls(urls);
            if (res.ok) {
              return {
                ok: true,
                text: res.text,
                languageCode: track.languageCode || "",
                kind: track.kind || "",
                source: res.source,
              };
            }
          }

          const domTry = await tryDomTranscriptPanel();
          if (domTry.ok) {
            return {
              ok: true,
              text: domTry.text,
              languageCode: ordered[0]?.languageCode || "",
              kind: ordered[0]?.kind || "",
              source: domTry.source,
            };
          }

          return {
            ok: false,
            error:
              "YouTube returned empty caption responses. Open ⋮ → Show transcript once, then click Copy again — or refresh the page.",
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
