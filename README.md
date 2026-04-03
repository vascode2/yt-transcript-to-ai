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

## Notes

- The app works only for videos where YouTube exposes subtitles or auto-captions.
- It uses `yt-dlp` to retrieve the transcript. By default it builds a **quick extractive** outline (no API key).
- **Optional — ChatGPT-style outline:** set `OPENAI_API_KEY` in the environment before `node server.js`. The server calls OpenAI in JSON mode: one request for shorter transcripts, or map (chunk) + reduce for very long text. Override the model with `OPENAI_SUMMARY_MODEL` (default `gpt-4o-mini`). Tune chunking with `OPENAI_CHUNK_CHARS` and `OPENAI_ONESHOT_MAX_CHARS` if needed.

## Requirements

- **Node.js 18+** (uses `fetch` for the optional OpenAI path).
