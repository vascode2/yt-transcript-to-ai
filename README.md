# YouTube Summary

Small dependency-free Node app that accepts a YouTube URL, pulls available captions, and generates:

- a short summary
- timestamped key points
- a transcript preview

## Run locally

```powershell
python -m pip install --user yt-dlp
node server.js
```

Then open [http://localhost:3000](http://localhost:3000).

## Chrome extension (copy transcript on YouTube)

The folder `extension/` is an **unpacked** Manifest V3 extension:

1. Open Chrome → `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → choose the `extension` directory inside this repo

On a watch page (`youtube.com/watch?v=…`), the toolbar is injected at the **top of the right column** (`#secondary-inner`), above “In this video” and recommendation chips, with **sticky** styling so it stays visible while you scroll. **Copy transcript** copies text only. **ChatGPT** and **Gemini** copy the same summarize prompt + transcript to the clipboard, open the site in a new tab, and the extension **injects the prompt into the chat box** when it can find the composer (long transcripts are too big for URL parameters, so this uses `chrome.scripting` on those origins). When injection succeeds, it also **tries to send** the message (submit button click, or simulated Enter if no button is found). **Ctrl/⌘+click** or **middle-click** an AI button to open that tab in the **background** and stay on YouTube. If the site UI changes and automation misses, use **Ctrl+V** or send manually. Permissions: **scripting**, **storage** (brief local hold for the prompt), and host access for **youtube.com**, **chatgpt.com**, **chat.openai.com**, and **gemini.google.com** — Chrome may ask you to approve host access after an update.

#### Extension: “YouTube returned empty caption responses…”

That message is from the **browser extension** only. It means: the extension could not get usable text from YouTube’s **in-page** caption URLs (or from scraping the transcript panel in time).

**Why the localhost app can still summarize the same URL:** the Node app uses **yt-dlp** (and your Python helper) to download captions **outside** the YouTube tab. That is a different code path than the extension, which runs **inside** Chrome on the watch page and depends on what the embedded player exposes (and on cookies / experiments / `timedtext` responses). One path succeeding does **not** guarantee the other will.

**What “open ⋮ → Show transcript once” does:** YouTube often lazy-loads caption data. Opening **Show transcript** from the **⋮** menu forces the client to fetch and render captions in the side panel, which can “wake up” the same data the extension needs. After lines appear in **In this video → Transcript**, try **Copy transcript** again (or refresh first, then open transcript, then copy).

If it still fails: try another browser profile, disable other YouTube extensions temporarily, or use **Copy transcript** only after the video has played a few seconds so the player is fully initialized.

### Extension: automated E2E (Playwright + Brave or Chromium)

Headed browser test that loads the **unpacked** `extension/` folder, opens the regression URL `https://www.youtube.com/watch?v=YOhZd1-AkNk`, waits for **Copy transcript**, clicks it, and **fails** unless the status shows **Copied** (otherwise throws with the error line).

```powershell
cd <repo-root>
npm install
npx playwright install chromium   # only if you use npm run e2e:chromium
npm run test:e2e                  # prefers Brave (common Windows paths) or BRAVE_PATH; else Playwright Chromium
npm run e2e:chromium              # force Playwright’s Chromium
```

- Set **`BRAVE_PATH`** to your `brave.exe` if auto-detection misses it.
- YouTube may show consent or block automation; if the test is flaky, use the manual launcher below.

**Manual Brave + extension (same URL):**

```powershell
.\scripts\launch-brave-with-extension.ps1
```

Then confirm **Load extension** worked (`brave://extensions`), dismiss any cookie wall, and try **Copy transcript**.

## Notes

- The app works only for videos where YouTube exposes subtitles or auto-captions.
- It uses `yt-dlp` to retrieve the transcript. By default it builds a **quick extractive** outline (no API key). That mode picks important sentences and splits them heuristically — it is **not** a semantic summary. For Korean (and other languages with sparse commas), headings can still look “transcript-y” compared with a model like Gemini. For **Gemini-style thematic sections** (e.g. “트럼프의 대국민 연설과 시장의 반응”), use one of the optional model paths below.

### Summary quality: what to use

| Mode | Cost | Typical look |
|------|------|----------------|
| **Quick extract** | Free | Sentence/chunk highlights; good for skimming, weaker “analyst” headings |
| **Ollama** | Free, local | Much closer to a real outline; use a strong multilingual model (e.g. **Qwen 2.5**, **Mistral**) |
| **LM Studio** | Free, local | Same idea as OpenAI-compatible chat; set `OPENAI_BASE_URL` + a small model |
| **Gemini API** | Free tier / paid | Often closest to the Gemini web app for structure and Korean |
| **OpenAI API** | Paid | Strong JSON outlines; set `OPENAI_API_KEY` |

**Chrome extension “Copy transcript”** still uses YouTube’s in-page captions; if that fails while this app works, use **Copy** on localhost (transcript panel) or keep using **Generate Summary** here — the extension and `yt-dlp` are different pipelines.

- **Optional — Gemini API:** create a key in [Google AI Studio](https://aistudio.google.com/), then set `GEMINI_API_KEY` before `node server.js`. Override the model with `GEMINI_SUMMARY_MODEL` (default `gemini-2.0-flash`; try `gemini-1.5-flash` if your project does not have 2.0). Chunking: `GEMINI_CHUNK_CHARS`, `GEMINI_ONESHOT_MAX_CHARS`. Order of attempt: **OpenAI → Gemini → Ollama → Quick extract** (each step only if the previous did not produce a summary).
- **Optional — ChatGPT-style outline:** set `OPENAI_API_KEY` in the environment before `node server.js`. The server calls OpenAI in JSON mode: one request for shorter transcripts, or map (chunk) + reduce for very long text. Override the model with `OPENAI_SUMMARY_MODEL` (default `gpt-4o-mini`). Tune chunking with `OPENAI_CHUNK_CHARS` and `OPENAI_ONESHOT_MAX_CHARS` if needed.
- **Optional — LM Studio (or any OpenAI-compatible local server):** start the server (e.g. LM Studio **Local Server**), note the base URL (often `http://localhost:1234/v1`). Set **`OPENAI_BASE_URL`** to that base (no trailing path beyond `/v1`), keep **`OPENAI_API_KEY`** set to any non-empty placeholder if your server ignores it (LM Studio commonly accepts `sk-local`). The app will call `{OPENAI_BASE_URL}/chat/completions` like the official API. Choose the loaded model name in **`OPENAI_SUMMARY_MODEL`**. If the server errors on JSON mode, set **`OPENAI_DISABLE_JSON_MODE=1`** (the model should still return JSON in its reply; parsing may be less reliable).
- **Optional — local outline (Ollama, no cloud API):** install [Ollama](https://ollama.com), run `ollama pull llama3.2` (or `mistral`, etc.), leave `ollama serve` running (default **http://127.0.0.1:11434**). Then set `OLLAMA_MODEL` before starting the app, for example:
  ```powershell
  $env:OLLAMA_MODEL = "llama3.2"
  node server.js
  ```
  If `OPENAI_API_KEY` or `GEMINI_API_KEY` is set, those run before Ollama; Ollama runs when `OLLAMA_MODEL` is set and no earlier provider produced a summary. Override the API base with `OLLAMA_HOST` if needed. For long transcripts, tune `OLLAMA_CHUNK_CHARS` (default `2800`) and `OLLAMA_ONESHOT_MAX_CHARS` (default `12000`). For Korean news-style outlines, try **`qwen2.5`** or **`mistral`**.

## Requirements

- **Node.js 18+** (uses `fetch` for optional OpenAI, Gemini, and Ollama).
