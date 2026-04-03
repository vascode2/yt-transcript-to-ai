const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { execFile } = require("child_process");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

const STOP_WORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "am", "an", "and",
  "any", "are", "as", "at", "be", "because", "been", "before", "being", "below",
  "between", "both", "but", "by", "can", "could", "did", "do", "does", "doing",
  "down", "during", "each", "few", "for", "from", "further", "had", "has", "have",
  "having", "he", "her", "here", "hers", "herself", "him", "himself", "his", "how",
  "i", "if", "in", "into", "is", "it", "its", "itself", "just", "me", "more", "most",
  "my", "myself", "no", "nor", "not", "now", "of", "off", "on", "once", "only", "or",
  "other", "our", "ours", "ourselves", "out", "over", "own", "same", "she", "should",
  "so", "some", "such", "than", "that", "the", "their", "theirs", "them", "themselves",
  "then", "there", "these", "they", "this", "those", "through", "to", "too", "under",
  "until", "up", "very", "was", "we", "were", "what", "when", "where", "which", "while",
  "who", "whom", "why", "will", "with", "you", "your", "yours", "yourself", "yourselves"
]);

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function sendFile(res, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[extension] || "application/octet-stream";

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(res, 404, { error: "File not found." });
      return;
    }

    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  });
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Invalid JSON body."));
      }
    });

    req.on("error", reject);
  });
}

function childEnvForTranscriptHelper() {
  const env = { ...process.env };
  env.PYTHONUTF8 = "1";
  env.PYTHONIOENCODING = "utf-8";
  if (process.platform === "win32") {
    const denoBin = path.join(process.env.USERPROFILE || process.env.HOME || "", ".deno", "bin");
    try {
      if (denoBin && fs.existsSync(denoBin)) {
        const p = env.PATH || "";
        const lower = p.toLowerCase();
        const needle = denoBin.toLowerCase();
        if (!lower.includes(needle)) {
          env.PATH = `${denoBin}${path.delimiter}${p}`;
        }
      }
    } catch {
      // ignore fs errors
    }
  }
  return env;
}

function parseTranscriptHelperJson(stdout) {
  const raw = String(stdout).replace(/^\uFEFF/, "").trim();
  if (!raw) {
    throw new Error("Transcript helper produced no output.");
  }
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw new Error(
        "Transcript helper returned invalid data. Set PYTHON to the python.exe where yt-dlp is installed (e.g. from `where python`)."
      );
    }
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      throw new Error(
        "Transcript helper returned invalid data. Set PYTHON to the python.exe where yt-dlp is installed (e.g. from `where python`)."
      );
    }
  }
}

function extractVideoId(input) {
  let parsed;

  try {
    parsed = new URL(input);
  } catch (error) {
    throw new Error("Please enter a valid YouTube URL.");
  }

  const hostname = parsed.hostname.replace(/^www\./, "");

  if (hostname === "youtu.be") {
    const id = parsed.pathname.split("/").filter(Boolean)[0];
    if (id) return id;
  }

  if (hostname === "youtube.com" || hostname === "m.youtube.com") {
    if (parsed.pathname === "/watch") {
      const id = parsed.searchParams.get("v");
      if (id) return id;
    }

    const match = parsed.pathname.match(/^\/(shorts|embed)\/([^/?]+)/);
    if (match) return match[2];
  }

  throw new Error("Unsupported YouTube URL format.");
}

function formatTimestamp(seconds) {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 35);
}

function scoreSentences(sentences) {
  const frequencies = new Map();

  for (const sentence of sentences) {
    for (const token of sentence.toLowerCase().match(/[a-z0-9']+/g) || []) {
      if (STOP_WORDS.has(token) || token.length < 3) continue;
      frequencies.set(token, (frequencies.get(token) || 0) + 1);
    }
  }

  return sentences.map((sentence, index) => {
    const words = sentence.toLowerCase().match(/[a-z0-9']+/g) || [];
    const score = words.reduce((total, word) => total + (frequencies.get(word) || 0), 0);

    return { index, sentence, score };
  });
}

function buildParagraphSummary(transcriptText) {
  const sentences = splitSentences(transcriptText);

  if (!sentences.length) {
    return transcriptText.slice(0, 600);
  }

  const ranked = scoreSentences(sentences)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(5, sentences.length))
    .sort((a, b) => a.index - b.index)
    .map((item) => item.sentence);

  return ranked.join(" ");
}

function buildKeyPoints(segments) {
  if (!segments.length) return [];

  const points = [];
  const chunkSize = Math.max(1, Math.floor(segments.length / 5));

  for (let i = 0; i < segments.length && points.length < 5; i += chunkSize) {
    const chunk = segments.slice(i, i + chunkSize);
    const combined = chunk.map((item) => item.text).join(" ");
    const summary = buildParagraphSummary(combined);

    if (summary) {
      points.push({
        timestamp: formatTimestamp(chunk[0].start),
        text: summary,
      });
    }
  }

  return points;
}

function normalizeSegmentText(item) {
  const raw = item != null && typeof item.text === "string" ? item.text : String(item?.text ?? "");
  return raw.replace(/\s+/g, " ").trim();
}

function buildSummaryPayload(videoId, title, segments) {
  const normalizedSegments = segments
    .map((item) => ({ ...item, text: normalizeSegmentText(item) }))
    .filter((item) => item.text.length > 0);

  const transcriptText = normalizedSegments.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();

  if (!transcriptText) {
    throw new Error(
      "Transcript was empty after parsing. The video may have no usable captions, or caption text used a format we could not read. Try another video, enable auto-captions on YouTube, or ensure Deno is installed and on PATH (see yt-dlp EJS docs)."
    );
  }

  return {
    videoId,
    title,
    summary: buildParagraphSummary(transcriptText),
    keyPoints: buildKeyPoints(normalizedSegments),
    transcriptPreview: transcriptText.slice(0, 3000),
    transcriptLength: transcriptText.length,
  };
}

async function summarizeYoutubeUrl(youtubeUrl) {
  const videoId = extractVideoId(youtubeUrl);
  const helperPath = path.join(__dirname, "scripts", "fetch_transcript.py");
  const pythonPath = process.env.PYTHON || "python";

  const helperOutput = await new Promise((resolve, reject) => {
    execFile(
      pythonPath,
      [helperPath, youtubeUrl],
      {
        cwd: __dirname,
        maxBuffer: 10_000_000,
        encoding: "utf8",
        env: childEnvForTranscriptHelper(),
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message || "Failed to fetch transcript."));
          return;
        }

        try {
          resolve(parseTranscriptHelperJson(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      }
    );
  });

  const transcriptSegments = helperOutput.segments || [];
  const title = helperOutput.title || "YouTube Video";

  return buildSummaryPayload(videoId, title, transcriptSegments);
}

function handleApi(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  parseRequestBody(req)
    .then(async (body) => {
      if (!body?.url || typeof body.url !== "string") {
        sendJson(res, 400, { error: "A YouTube URL is required." });
        return;
      }

      const result = await summarizeYoutubeUrl(body.url);
      sendJson(res, 200, result);
    })
    .catch((error) => {
      const statusCode = /required|valid|unsupported/i.test(error.message) ? 400 : 500;
      sendJson(res, statusCode, { error: error.message || "Something went wrong." });
    });
}

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  if (reqUrl.pathname === "/api/summarize") {
    handleApi(req, res);
    return;
  }

  let targetPath = reqUrl.pathname === "/" ? "index.html" : reqUrl.pathname.replace(/^[/\\]+/, "");
  targetPath = path.normalize(targetPath).replace(/^(\.\.[/\\])+/, "");
  const fullPath = path.join(PUBLIC_DIR, targetPath);

  if (!fullPath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden." });
    return;
  }

  sendFile(res, fullPath);
});

server.listen(PORT, () => {
  console.log(`YouTube Summary app running at http://localhost:${PORT}`);
});
