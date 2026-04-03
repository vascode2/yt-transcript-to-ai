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

## Notes

- The app works only for videos where YouTube exposes subtitles or auto-captions.
- It uses `yt-dlp` to retrieve the transcript and a built-in extractive summarizer, so no API key is required.
