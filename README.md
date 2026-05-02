# YouTube Summary

A Chrome / Brave extension that adds a **Copy transcript** button to every YouTube watch page, plus one-click handoff buttons for **ChatGPT** and **Gemini** that paste the transcript into the chat for you.

A small Node app (`server.js`) ships alongside as an optional fallback for videos where the in-browser copy path can't reach the captions — see [Optional: localhost summarizer](#optional-localhost-summarizer) at the bottom.

> 📊 **Visual walkthrough:** **[vascode2.github.io/yt-transcript-to-ai](https://vascode2.github.io/yt-transcript-to-ai/)** — a single-page dashboard that walks through the install, the toolbar, the data flow, and what each button does. Source: [docs/index.html](docs/index.html).

---

## Chrome / Brave extension (the main thing)

The folder `extension/` is an **unpacked** Manifest V3 extension.

### Install (one minute)

1. Open Chrome or Brave → `chrome://extensions` (or `brave://extensions`).
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** → choose the `extension/` directory in this repo.

That's it — open any YouTube watch page (`youtube.com/watch?v=…`) and you'll see a small toolbar pinned at the **top of the right column** (`#secondary-inner`), above "In this video" and the recommendation chips. The toolbar is **sticky** so it stays visible while you scroll.

### What the buttons do

| Button | What it copies | What else it does |
|---|---|---|
| **Copy transcript** | Plain text transcript of the current video | Status line shows the language and whether the captions were auto-generated. |
| **ChatGPT** | A summarize prompt + the transcript | Opens chatgpt.com in a new tab and **injects the prompt into the composer**, then tries to send it. If injection fails, the prompt is on your clipboard — just press **Ctrl/⌘+V**. |
| **Gemini** | Same prompt + transcript | Same flow against gemini.google.com. |

**Tip:** **Ctrl/⌘+click** or **middle-click** an AI button to open that tab in the **background** so you stay on YouTube.

### Why long transcripts go through the clipboard, not the URL

URLs have a length limit (a few KB on most browsers); a real transcript can be tens of KB. The extension uses `chrome.scripting` to drop the prompt straight into the chat composer on the AI site. That's why it asks for host access to **chatgpt.com**, **chat.openai.com**, and **gemini.google.com** in addition to **youtube.com**.

### How fetching works (and why "Copy" is fast now)

When the toolbar mounts on a watch page, the extension **prefetches** the transcript in the background — by the time you click **Copy transcript**, the text is already in memory and the click completes in roughly 30 ms. This matters because Chrome's clipboard API only honors a recent user click for ~5 seconds; the old "click → fetch → copy" flow used to fail on slow fetches with `Clipboard blocked`. The fix lives in [`extension/content.js`](extension/content.js) (`prefetchTranscript()` plus a refocus-and-`execCommand` fallback).

The transcript itself is sourced in three tiers — the extension tries each and stops at the first one that returns text:

1. The video's `timedtext` URL exposed in the player JSON.
2. The InnerTube `get_transcript` endpoint.
3. Scraping the native transcript side-panel.

### Permissions, plain English

| Permission | Why |
|---|---|
| `scripting` | To paste the prompt into the ChatGPT / Gemini composer. |
| `storage` | Briefly holds the prompt while the AI tab opens. |
| Host: `youtube.com` | Read captions, mount the toolbar. |
| Host: `chatgpt.com`, `chat.openai.com`, `gemini.google.com` | Inject the prompt into the chat box. |

Chrome / Brave may ask you to re-approve host access after an update.

---

## Troubleshooting

### "YouTube returned empty caption responses…"

This message comes from the **extension** when it couldn't get usable text from YouTube's in-page caption URLs (or from scraping the transcript panel in time).

**Easy fix that works most of the time** — open YouTube's own transcript panel once:

1. Click the **⋮** (more) menu under the video.
2. Click **Show transcript**.
3. Wait until lines appear in the side panel.
4. Click **Copy transcript** in the extension toolbar again.

Opening the native transcript forces YouTube to lazy-load the caption data, which "wakes up" the same data the extension reads.

**Still failing?** Try, in order:

- Refresh the page, then open Show transcript, then click Copy.
- Wait a few seconds after the video starts playing — some videos don't expose captions until the player is fully initialized.
- Disable other YouTube extensions (ad-blockers and SponsorBlock can race with us for the player object).
- Try a different browser profile.

### "Clipboard blocked — click the page first, then try again."

Should be rare now (the prefetch fix above). If you do see it, click anywhere on the page and click Copy again — Chrome requires the document to be focused for `navigator.clipboard.writeText`.

---

## Automated test (Playwright + Brave or Chromium)

Headed browser test that loads `extension/`, opens a regression URL, clicks **Copy transcript**, and **fails** unless the status reads **Copied**.

```powershell
cd <repo-root>
npm install
npm run test:e2e                  # prefers Brave (common Windows paths) or BRAVE_PATH; else Playwright Chromium
npm run e2e:chromium              # force Playwright's Chromium
npx playwright install chromium   # only needed for the line above, first run
```

- Set `BRAVE_PATH` to your `brave.exe` if auto-detection misses it.
- For repeated reproductions across many runs, use the loop harness:

  ```powershell
  .\scripts\copy-flake-loop.ps1 -Runs 10 -Url '<youtube-url>'
  ```

  It writes per-iteration diagnostics to `test-results/diag/batch-<ts>/` and stops early on a 5-pass streak.

**Manual launch** (Brave with the unpacked extension preloaded, no Playwright):

```powershell
.\scripts\launch-brave-with-extension.ps1
```

---

## Optional: localhost summarizer

A small dependency-free Node app (`server.js`) that takes a YouTube URL, downloads captions with `yt-dlp` **outside** the browser tab, and renders a short summary, timestamped key points, and a transcript preview.

**When to use it:** if the extension's in-page caption fetch keeps failing for a particular video, the localhost path uses a different code path (`yt-dlp` from your shell vs. the YouTube tab's player), so one can succeed where the other fails.

### Run

```powershell
python -m pip install --user yt-dlp
node server.js
```

Open <http://localhost:3000>.

### Summary quality: which mode to use

| Mode | Cost | Typical look |
|------|------|----------------|
| **Quick extract** | Free | Sentence highlights; good for skimming, weak "analyst" headings |
| **Ollama** | Free, local | Real outline; use a strong multilingual model (e.g. **Qwen 2.5**, **Mistral**) |
| **LM Studio** | Free, local | Same idea as OpenAI-compatible chat; set `OPENAI_BASE_URL` + a small model |
| **Gemini API** | Free tier / paid | Often closest to the Gemini web app for structure and Korean |
| **OpenAI API** | Paid | Strong JSON outlines; set `OPENAI_API_KEY` |

Provider order: **OpenAI → Gemini → Ollama → Quick extract**. Each step runs only if the previous did not produce a summary.

<details>
<summary>Provider configuration (env vars)</summary>

- **Gemini API:** create a key in [Google AI Studio](https://aistudio.google.com/), set `GEMINI_API_KEY`. Override model with `GEMINI_SUMMARY_MODEL` (default `gemini-2.0-flash`). Chunking knobs: `GEMINI_CHUNK_CHARS`, `GEMINI_ONESHOT_MAX_CHARS`.
- **OpenAI:** set `OPENAI_API_KEY`. Calls OpenAI in JSON mode (one request for short transcripts, map+reduce for long). Override with `OPENAI_SUMMARY_MODEL` (default `gpt-4o-mini`). Knobs: `OPENAI_CHUNK_CHARS`, `OPENAI_ONESHOT_MAX_CHARS`.
- **LM Studio (or any OpenAI-compatible local server):** start the server, then set `OPENAI_BASE_URL` to e.g. `http://localhost:1234/v1`, keep `OPENAI_API_KEY` set to any placeholder (LM Studio accepts `sk-local`), and pick the loaded model with `OPENAI_SUMMARY_MODEL`. If the server errors on JSON mode, set `OPENAI_DISABLE_JSON_MODE=1`.
- **Ollama (no cloud API):** install [Ollama](https://ollama.com), `ollama pull llama3.2` (or `mistral`, `qwen2.5`), leave `ollama serve` running (default `http://127.0.0.1:11434`). Set `OLLAMA_MODEL` before `node server.js`. Knobs: `OLLAMA_HOST`, `OLLAMA_CHUNK_CHARS` (default `2800`), `OLLAMA_ONESHOT_MAX_CHARS` (default `12000`). For Korean news-style outlines, try `qwen2.5` or `mistral`.

  ```powershell
  $env:OLLAMA_MODEL = "llama3.2"
  node server.js
  ```

</details>

### Notes

- Works only for videos where YouTube exposes subtitles or auto-captions.
- The default **Quick extract** is heuristic, not a real semantic summary — for thematic Korean / Japanese outlines, use Gemini or a strong Ollama model.

---

## Requirements

- **Chrome** or **Brave** (or any Chromium browser that supports unpacked MV3 extensions) — for the extension. Browser-specific, not OS-specific: runs the same on **macOS, Windows, and Linux**.
- **Node.js 18+** and **Python with `yt-dlp`** — only if you want the optional localhost server.
