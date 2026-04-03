const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { execFile, execFileSync } = require("child_process");

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
  const body = JSON.stringify(data);
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
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

let cachedPythonInvocation = null;

const PYTHON_HINT =
  " Copy the full path from: python -c \"import sys; print(sys.executable)\" (paste exactly ΓÇö do not use ... as shorthand). Then: set PYTHON=C:\\full\\path\\python.exe";

function tryPyLauncherSysExecutable(pyLauncher) {
  try {
    const out = execFileSync(pyLauncher, ["-3", "-c", "import sys; print(sys.executable)"], {
      encoding: "utf8",
      timeout: 15_000,
      env: process.env,
    }).trim();
    if (out && fs.existsSync(out)) {
      return out;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Typical Microsoft Store / python.org install under the user profile.
 */
function findWindowsUserInstallPythonExe() {
  const local = process.env.LOCALAPPDATA;
  if (!local) {
    return null;
  }
  const root = path.join(local, "Programs", "Python");
  if (!fs.existsSync(root)) {
    return null;
  }
  try {
    const candidates = [];
    for (const name of fs.readdirSync(root)) {
      const exe = path.join(root, name, "python.exe");
      if (fs.existsSync(exe)) {
        candidates.push(exe);
      }
    }
    if (!candidates.length) {
      return null;
    }
    candidates.sort((a, b) => b.localeCompare(a, undefined, { sensitivity: "base", numeric: true }));
    return candidates[0];
  } catch {
    return null;
  }
}

/**
 * Windows: `python` on PATH is often a Store shim that answers --version but cannot be spawned (ENOENT).
 * Prefer a real python.exe from the py launcher, per-user installs, or where.exe.
 */
function resolveWindowsPythonExecutablePath() {
  const pyLaunchers = [
    "py",
    path.join(process.env.WINDIR || "C:\\Windows", "py.exe"),
  ];
  for (const launcher of pyLaunchers) {
    if (launcher !== "py" && !fs.existsSync(launcher)) {
      continue;
    }
    const resolved = tryPyLauncherSysExecutable(launcher);
    if (resolved) {
      return resolved;
    }
  }

  const userExe = findWindowsUserInstallPythonExe();
  if (userExe) {
    return userExe;
  }

  const pf = process.env.ProgramFiles || "C:\\Program Files";
  for (const ver of ["Python313", "Python312", "Python311", "Python310"]) {
    const exe = path.join(pf, ver, "python.exe");
    if (fs.existsSync(exe)) {
      return exe;
    }
  }

  try {
    const out = execFileSync("where.exe", ["python"], {
      encoding: "utf8",
      timeout: 15_000,
      env: process.env,
    }).trim();
    const lines = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const isStoreShim = (p) => /WindowsApps/i.test(p) && /python/i.test(p);
    for (const line of lines) {
      if (isStoreShim(line)) {
        continue;
      }
      if (fs.existsSync(line)) {
        return line;
      }
    }
    for (const line of lines) {
      if (fs.existsSync(line)) {
        return line;
      }
    }
  } catch {
    // ignore
  }

  return null;
}

/**
 * Node may run with a different PATH than your terminal (e.g. Windows GUI / Store Python).
 * On Windows, caches a concrete python.exe path when possible.
 */
function resolvePythonForTranscript() {
  if (cachedPythonInvocation) {
    return cachedPythonInvocation;
  }

  const tryVersion = (executable, prefixArgs = []) => {
    const base = { stdio: "ignore", timeout: 10_000, env: process.env };
    try {
      execFileSync(executable, [...prefixArgs, "--version"], base);
      return "direct";
    } catch {
      if (process.platform !== "win32") {
        return false;
      }
    }
    try {
      execFileSync(executable, [...prefixArgs, "--version"], { ...base, shell: true });
      return "shell";
    } catch {
      return false;
    }
  };

  if (process.env.PYTHON && String(process.env.PYTHON).trim()) {
    const exe = String(process.env.PYTHON).trim().replace(/^["']+|["']+$/g, "");
    if (/\.\.\.|ΓÇª/.test(exe)) {
      console.warn(
        'PYTHON looks like a placeholder (contains "..."). Use the real path from: python -c "import sys; print(sys.executable)"'
      );
    } else {
      const mode = tryVersion(exe, []);
      if (mode === "direct") {
        cachedPythonInvocation = { executable: exe, argvPrefix: [], hint: PYTHON_HINT };
        return cachedPythonInvocation;
      }
      if (mode === "shell") {
        console.warn(
          'PYTHON path only responds when run through cmd; using "python" from PATH for the transcript helper.'
        );
        cachedPythonInvocation = { executable: "python", argvPrefix: [], hint: PYTHON_HINT };
        return cachedPythonInvocation;
      }
      if (!fs.existsSync(exe)) {
        console.warn(
          `PYTHON did not run and path is not visible to Node (often Microsoft Store Python): ${exe}`
        );
      } else {
        console.warn(`PYTHON is set to "${exe}" but --version failed; probing other candidates...`);
      }
    }
  }

  if (process.platform === "win32") {
    const resolved = resolveWindowsPythonExecutablePath();
    if (resolved && tryVersion(resolved, [])) {
      cachedPythonInvocation = { executable: resolved, argvPrefix: [], hint: PYTHON_HINT };
      return cachedPythonInvocation;
    }
    if (tryVersion("py", ["-3"])) {
      cachedPythonInvocation = { executable: "py", argvPrefix: ["-3"], hint: PYTHON_HINT };
      return cachedPythonInvocation;
    }
    if (tryVersion("python", [])) {
      console.warn(
        'Using command name "python" on Windows; if the UI shows spawn ENOENT, set PYTHON to the full path from: py -3 -c "import sys; print(sys.executable)"'
      );
      cachedPythonInvocation = { executable: "python", argvPrefix: [], hint: PYTHON_HINT };
      return cachedPythonInvocation;
    }
  } else {
    if (tryVersion("python3", [])) {
      cachedPythonInvocation = { executable: "python3", argvPrefix: [], hint: PYTHON_HINT };
      return cachedPythonInvocation;
    }
    if (tryVersion("python", [])) {
      cachedPythonInvocation = { executable: "python", argvPrefix: [], hint: PYTHON_HINT };
      return cachedPythonInvocation;
    }
  }

  cachedPythonInvocation = {
    executable: process.platform === "win32" ? "python" : "python3",
    argvPrefix: [],
    unresolved: true,
    hint: PYTHON_HINT,
  };
  return cachedPythonInvocation;
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

/**
 * Start of our helper JSON (not yt-dlp log lines that contain `{` earlier).
 */
function findTranscriptJsonObjectStart(raw) {
  const byTitle = raw.indexOf('{"title"');
  if (byTitle !== -1) {
    return byTitle;
  }
  const seg = raw.indexOf('"segments"');
  if (seg !== -1) {
    return raw.lastIndexOf("{", seg);
  }
  return raw.indexOf("{");
}

/**
 * First complete `{ ... }` from `start`, respecting strings and nested braces.
 */
function extractFirstJsonObjectStringFrom(raw, start) {
  if (start < 0 || start >= raw.length || raw[start] !== "{") {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (c === "\\") {
        escaped = true;
      } else if (c === "\"") {
        inString = false;
      }
      continue;
    }
    if (c === "\"") {
      inString = true;
      continue;
    }
    if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return null;
}

function extractFirstJsonObjectString(raw) {
  const start = raw.indexOf("{");
  return extractFirstJsonObjectStringFrom(raw, start);
}

function parseTranscriptHelperJson(stdout) {
  const raw = String(stdout).replace(/^\uFEFF/, "").trim();
  if (!raw) {
    throw new Error("Transcript helper produced no output.");
  }
  try {
    return JSON.parse(raw);
  } catch {
    const anchor = findTranscriptJsonObjectStart(raw);
    const at = anchor === -1 ? raw.indexOf("{") : anchor;
    const jsonSlice = extractFirstJsonObjectStringFrom(raw, at) ?? extractFirstJsonObjectString(raw);
    if (!jsonSlice) {
      throw new Error(
        "Transcript helper returned invalid data. Set PYTHON to the python.exe where yt-dlp is installed (e.g. from `where python`)."
      );
    }
    try {
      return JSON.parse(jsonSlice);
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
  const py = resolvePythonForTranscript();
  const argv = [...py.argvPrefix, "-u", helperPath, youtubeUrl];

  const helperOutput = await new Promise((resolve, reject) => {
    execFile(
      py.executable,
      argv,
      {
        cwd: __dirname,
        maxBuffer: 10_000_000,
        encoding: "utf8",
        env: childEnvForTranscriptHelper(),
      },
      (error, stdout, stderr) => {
        if (error) {
          const extra = error.code === "ENOENT" ? py.hint || "" : "";
          reject(new Error((stderr.trim() || error.message || "Failed to fetch transcript.") + extra));
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
  const py = resolvePythonForTranscript();
  if (py.unresolved) {
    console.warn(
      "Warning: could not find Python on PATH (tried python, then py -3 on Windows). " +
        "Set PYTHON or fix PATH; transcript requests will fail until then."
    );
  } else {
    const label = [py.executable, ...py.argvPrefix].join(" ");
    console.log(`Transcript helper: ${label}${py.executable.includes(path.sep) ? " (absolute path)" : ""}`);
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use. Stop the other Node process or use another port, e.g.\n` +
        `  PowerShell:  $env:PORT=3001; node server.js\n` +
        `  cmd.exe:     set PORT=3001&& node server.js`
    );
    process.exit(1);
  }
  throw err;
});
