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

/**
 * Strip YouTube/TED-style caption credits at the start of text.
 * Also removes a stray reviewer surname (e.g. "Korom") glued before the real line ("We can…").
 */
function stripTranscriptCruft(text) {
  let t = String(text || "");
  const nameBeforeSpeech =
    /^(?:[A-Z][a-z]{1,20}\s+){1,3}(?=We\b|I think\b|I should\b|You can\b|They(?:'re|'ve)?\b|The general\b|The last\b|The brain\b|Regularity\b|Sleep\b|Sometimes\b|In the\b|If you\b|And the\b|So\b|But\b|When\b|What\b|Many\b|Some\b|One\b|It\b|This\b|That\b|Here\b|There\b|A\b|An\b)/u;

  for (let pass = 0; pass < 10; pass++) {
    const next = t
      .replace(/^Transcriber:\s*[\s\S]*?\s+Reviewer:\s*[\s\S]*?\s+/i, "")
      .replace(/^Reviewer:\s*[\s\S]*?\s+Transcriber:\s*[\s\S]*?\s+/i, "")
      .replace(/^(Transcriber|Reviewer):\s*[^\n.]+[.!?]?\s*/gi, "")
      .replace(/^(Transcriber|Reviewer):\s*[^\n]+\s*/gi, "")
      .replace(nameBeforeSpeech, "")
      .trim();
    if (next === t) break;
    t = next;
  }
  return t.trim();
}

const FILLER_PREFIX_REGEXES = [
  /^it turns out that\s+/i,
  /^it expects regularity and\s+/i,
  /^what we know is that\s+/i,
  /^the reason is that\s+/i,
  /^the important thing is that\s+/i,
  /^i think (that )?/i,
  /^i should note that\s+/i,
  /^the last thing i should note is that\s+/i,
  /^the last thing i\s+(should note|want to say)\s+is that\s+/i,
  /^\s*in the last \d+\s+(minutes?|seconds?)\s+before (?:bed|sleep)\b[,]?\s*/i,
  /^and in that way[,]?\s*/i,
  /^and certainly\b[,]?\s*/i,
  /^and the general rule of thumb is that\s+/i,
  /^and the general rule of thumb is\b[,]?\s*/i,
  /^if you'?d like[,]?\s*/i,
  /^if you('?ve|'re)\s+been\s+/i,
  /^we can (all|think of)\s+/i,
  /^you can also\s+/i,
  /^the brain has learned that\s+/i,
  /^the brain has learned\b[,]?\s*/i,
  /^this is (really |very )?important because\s+/i,
];

function stripLeadFillers(text) {
  let t = String(text || "").trim();
  let prev;
  do {
    prev = t;
    for (const re of FILLER_PREFIX_REGEXES) {
      t = t.replace(re, "").trim();
    }
  } while (t !== prev);
  return t;
}

function isMetadataSentence(sentence) {
  const t = String(sentence || "").trim();
  if (!t) return true;
  if (/^(Transcriber|Reviewer|Subtitles?|Subtitle by|Speaker)\s*:/i.test(t)) return true;
  if (/Translate\s+TED/i.test(t) && t.length < 140) return true;
  const after = stripTranscriptCruft(t);
  if (after.length < 10 && t.length < 100) return true;
  return false;
}

function truncateAtWord(text, maxLen) {
  const t = String(text || "").trim();
  if (t.length <= maxLen) {
    return t;
  }
  const cut = t.slice(0, maxLen);
  const sp = cut.lastIndexOf(" ");
  return (sp > maxLen * 0.45 ? cut.slice(0, sp) : cut).trim();
}

function sentenceCaseStart(s) {
  const t = s.trim();
  if (!t) return t;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function looksKorean(s) {
  return /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/.test(String(s || ""));
}

/** Leftmost strong delimiter in [minPos, maxPos] (supports Korean / CJK punctuation). */
function firstMajorDelimiterIndex(s, minPos, maxPos) {
  const str = String(s || "");
  const delims = [",", "，", "、", ";", "；"];
  let best = -1;
  for (const d of delims) {
    let from = 0;
    while (true) {
      const i = str.indexOf(d, from);
      if (i < 0) break;
      if (d === "、" && i < 26) {
        from = i + 1;
        continue;
      }
      if (i >= minPos && i <= maxPos && (best < 0 || i < best)) {
        best = i;
      }
      from = i + 1;
    }
  }
  return best;
}

function maybeCapitalizeLabelPhrase(left) {
  const t = String(left || "").trim();
  if (!t) return t;
  if (/^[a-z]/.test(t)) return sentenceCaseStart(t);
  return t;
}

function normalizeForOverlap(s) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** True if title is mostly the same opening as body (extractive duplicate headings). */
function overlapTooHigh(title, body, minChars = 28) {
  const a = normalizeForOverlap(title).replace(/[,;:：，、.!?…]+$/u, "");
  const b = normalizeForOverlap(body);
  if (a.length < 12 || b.length < minChars) return false;
  const take = Math.min(a.length, b.length, 120);
  if (take < minChars) return false;
  if (b.slice(0, take) === a.slice(0, take)) return true;
  const prefix = Math.min(a.length, b.length);
  let i = 0;
  while (i < prefix && a[i] === b[i]) i++;
  const ratio = i / Math.min(a.length, b.length);
  return i >= minChars && ratio >= 0.88;
}

function finalizeSectionTitle(title) {
  let t = String(title || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[,;:，、]+$/u, "")
    .trim();
  if (!t) return "Main ideas";
  if (t.length > 78) {
    t = `${t.slice(0, 75)}…`;
  }
  if (/^[a-z]/.test(t)) {
    return sentenceCaseStart(t);
  }
  return t;
}

function clauseTitleFromSentence(sentence) {
  const a = stripLeadFillers(stripTranscriptCruft(String(sentence || ""))).trim();
  if (!a) return "";
  const idx = firstMajorDelimiterIndex(a, 24, 100);
  if (idx < 0) {
    return finalizeSectionTitle(truncateAtWord(a, 56));
  }
  const left = a.slice(0, idx).trim();
  if (left.length < 14) {
    return finalizeSectionTitle(truncateAtWord(a, 56));
  }
  return finalizeSectionTitle(left);
}

/**
 * If section heading repeats the first bullet (common in Korean / long clauses), pick another cue.
 */
function ensureDistinctSectionTitle(title, bullets, picked, sentences, scored, partIndex) {
  if (!bullets.length || !picked.length) {
    return finalizeSectionTitle(title);
  }
  const b0 = String(bullets[0].body || "").trim();
  let t = finalizeSectionTitle(title);
  if (!overlapTooHigh(t, b0)) {
    return t;
  }

  const skip = new Set([String(picked[0].sentence || "").trim()]);
  let t2 = sectionTitleFromSentences(sentences, scored, { skipSentences: skip });
  if (!overlapTooHigh(t2, b0)) {
    return t2;
  }

  if (picked[1]) {
    skip.add(String(picked[1].sentence || "").trim());
    t2 = sectionTitleFromSentences(sentences, scored, { skipSentences: skip });
    if (!overlapTooHigh(t2, b0)) {
      return t2;
    }
    const alt = clauseTitleFromSentence(picked[1].sentence);
    if (alt && !overlapTooHigh(alt, b0)) {
      return alt;
    }
  }

  const ko = looksKorean(b0 + t);
  return ko ? `이 구간 핵심 (${partIndex})` : `Key points (part ${partIndex})`;
}

const LEADING_CONN = /^(\s*(?:And|But|So|Yet|Plus|Also|Still|Oh|Well)\s+)+/i;

/** Drop leading text from `full` when it repeats `labelPlain` (case-insensitive). */
function bodyWithoutRedundantLabelPrefix(full, labelPlain) {
  const L = String(labelPlain || "")
    .replace(/:\s*$/, "")
    .trim();
  if (!L || !full) return full;
  const fl = full.toLowerCase();
  const ll = L.toLowerCase();
  if (!fl.startsWith(ll)) return full;
  let rest = full.slice(L.length).trim().replace(/^[,;:，、]\s*/, "").trim();
  if (rest.length < 10) return full;
  return maybeCapitalizeLabelPhrase(rest);
}

/**
 * Bold label = skimmable topic line; body = continuation only (no repeating the label).
 */
function naturalBulletFromSentence(sentence) {
  const raw = String(sentence || "").trim();
  const cleaned = stripLeadFillers(stripTranscriptCruft(raw));
  const body = cleaned || raw;
  if (!body) {
    return { label: "Takeaway:", body: raw };
  }

  let s = body.replace(LEADING_CONN, "").trim() || body;

  const dIdx = firstMajorDelimiterIndex(s, 22, 110);
  if (dIdx >= 0) {
    const left = s.slice(0, dIdx).trim();
    const wc = left.split(/\s+/).filter(Boolean).length;
    if (wc >= 4 && wc <= 22 && left.length <= 92) {
      const rest = s.slice(dIdx + 1).replace(/^\s+/, "").trim();
      const bodyOut = rest.length >= 8 ? maybeCapitalizeLabelPhrase(rest) : s;
      return { label: `${maybeCapitalizeLabelPhrase(left)}:`, body: bodyOut };
    }
  }

  let words = s.split(/\s+/).filter(Boolean);
  const maxLabelWords = 11;
  if (words.length > maxLabelWords) {
    words = words.slice(0, maxLabelWords);
  }
  const weakFirst = /^(it|there|this|that|these|those)$/i;
  if (words.length >= 8 && weakFirst.test(words[0].replace(/['']s$/i, ""))) {
    words = words.slice(1);
  }
  if (words.length < 4) {
    words = s.split(/\s+/).filter(Boolean).slice(0, 9);
  }

  let labelText = words.join(" ");
  labelText = truncateAtWord(labelText, 64).replace(/\s+[,;:，、]+$/u, "").trim();
  const label = `${maybeCapitalizeLabelPhrase(labelText)}:`;
  const bodyOut = bodyWithoutRedundantLabelPrefix(s, labelText);
  return {
    label,
    body: bodyOut,
  };
}

function sectionTitleFromSentences(sentences, scoredRows, options = {}) {
  const list = Array.isArray(sentences) ? sentences : [];
  if (!list.length) {
    return "Main ideas";
  }

  const skip =
    options.skipSentences instanceof Set ? options.skipSentences : new Set([...(options.skipSentences || [])]);

  const usable = list.filter((s) => !isMetadataSentence(s));
  const pool = usable.length ? usable : list;

  const norm = (x) => String(x || "").trim();

  function pickPrimary() {
    if (Array.isArray(scoredRows) && scoredRows.length) {
      const byScore = [...scoredRows].sort((a, b) => b.score - a.score);
      const best = byScore.find(
        (row) => row.sentence && !isMetadataSentence(row.sentence) && !skip.has(norm(row.sentence))
      );
      if (best && best.sentence) {
        return best.sentence;
      }
    }
    const fromPool = pool.find((s) => !skip.has(norm(s)));
    return fromPool || pool[0];
  }

  let primary = pickPrimary();

  const a = stripLeadFillers(stripTranscriptCruft(primary)).trim();
  const clauseAt = firstMajorDelimiterIndex(a, 26, 98);
  let title;
  if (clauseAt >= 0) {
    const clause = a.slice(0, clauseAt).trim();
    const wc = clause.split(/\s+/).filter(Boolean).length;
    if (wc >= 4 && clause.length <= 88) {
      title = clause;
    }
  }
  if (!title) {
    title = truncateAtWord(a, 72).replace(/[`'"“”]+$/, "").replace(/[,;:，、]\s*$/u, "").trim();
  }

  if (title.length < 18 && pool[1]) {
    const b = stripLeadFillers(stripTranscriptCruft(pool[1])).trim();
    const part2 = truncateAtWord(b, 52);
    if (part2) {
      title = `${truncateAtWord(a, 38)} — ${part2}`;
    }
  }

  return finalizeSectionTitle(title);
}

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
    .split(/(?<=[.!?。！？])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 12);
}

function tokenizeForScore(sentence) {
  const lower = sentence.toLowerCase();
  const latin = lower.match(/[a-z0-9']+/g) || [];
  if (latin.length) {
    return latin;
  }
  return lower.match(/[\p{L}\p{N}]+/gu) || [];
}

function scoreSentences(sentences) {
  const frequencies = new Map();

  for (const sentence of sentences) {
    for (const token of tokenizeForScore(sentence)) {
      if (STOP_WORDS.has(token) || token.length < 2) continue;
      frequencies.set(token, (frequencies.get(token) || 0) + 1);
    }
  }

  return sentences.map((sentence, index) => {
    const words = tokenizeForScore(sentence);
    const score = words.reduce((total, word) => total + (frequencies.get(word.toLowerCase()) || 0), 0);

    return { index, sentence, score };
  });
}

function chunkLongText(text, maxLen) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + maxLen, text.length);
    if (end < text.length) {
      const space = text.lastIndexOf(" ", end);
      if (space > i + 30) {
        end = space;
      }
    }
    const piece = text.slice(i, end).trim();
    if (piece.length > 8) {
      out.push(piece);
    } else if (piece.length > 0 && end >= text.length) {
      out.push(piece);
    }
    if (end <= i) {
      i += 1;
    } else {
      i = end;
    }
  }
  return out.length ? out : text.trim() ? [text.trim().slice(0, maxLen)] : [];
}

function sentencesFromChunkText(combined) {
  const trimmed = combined.trim();
  if (!trimmed) {
    return [];
  }

  let sentences = splitSentences(trimmed);
  if (!sentences.length && trimmed.length > 25) {
    sentences = chunkLongText(trimmed, 200);
  }
  if (!sentences.length) {
    sentences = [trimmed.length > 900 ? `${trimmed.slice(0, 897)}…` : trimmed];
  }
  return sentences;
}

function formatTimestampBracket(startSec, endSec) {
  const a = formatTimestamp(startSec);
  if (endSec > startSec + 1.5) {
    return `[${a}, ${formatTimestamp(endSec)}]`;
  }
  return `[${a}]`;
}

function buildSummarySections(segments, videoId) {
  const list = Array.isArray(segments) ? segments : [];
  if (!list.length) {
    return [];
  }

  const targetSections = Math.min(5, Math.max(3, Math.ceil(list.length / 70)));
  const chunkSize = Math.max(1, Math.ceil(list.length / targetSections));
  const sections = [];

  for (let i = 0; i < list.length && sections.length < targetSections; i += chunkSize) {
    const chunk = list.slice(i, i + chunkSize);
    const combined = chunk
      .map((item) => (item != null && item.text != null ? String(item.text) : "").trim())
      .filter(Boolean)
      .join(" ");
    const sentences = sentencesFromChunkText(stripTranscriptCruft(combined.trim()));
    if (!sentences.length) {
      continue;
    }

    const scored = scoreSentences(sentences);
    const hasSignal = scored.some((row) => row.score > 0);
    const maxBullets = 4;
    let picked;
    if (hasSignal) {
      picked = scored
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.min(maxBullets, scored.length))
        .sort((a, b) => a.index - b.index);
    } else {
      picked = scored.slice(0, Math.min(maxBullets, scored.length));
    }

    const t0 = chunk[0].start;
    const last = chunk[chunk.length - 1];
    const t1 = last.start + (last.duration || 0);
    const span = Math.max(1, t1 - t0);

    const bullets = picked.map((row, bi) => {
      const { label, body } = naturalBulletFromSentence(row.sentence);
      const startSec = t0 + (bi / Math.max(1, picked.length)) * span;
      const endSec = t0 + ((bi + 1) / Math.max(1, picked.length)) * span;
      return {
        label,
        body,
        startSec: Math.floor(startSec),
        endSec: Math.floor(endSec),
        bracket: formatTimestampBracket(startSec, endSec),
        href: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${Math.floor(startSec)}s`,
      };
    });

    let secTitle = sectionTitleFromSentences(sentences, scored);
    secTitle = ensureDistinctSectionTitle(secTitle, bullets, picked, sentences, scored, sections.length + 1);

    sections.push({
      title: secTitle,
      sectionStartSec: Math.floor(t0),
      sectionEndSec: Math.floor(t1),
      bullets,
    });
  }

  if (!sections.length && list.length > 0) {
    const whole = list
      .map((item) => (item != null && item.text != null ? String(item.text) : "").trim())
      .filter(Boolean)
      .join(" ");
    const sentences = sentencesFromChunkText(stripTranscriptCruft(whole.trim()));
    if (!sentences.length) {
      return [];
    }
    const scored = scoreSentences(sentences);
    const hasSignal = scored.some((row) => row.score > 0);
    const maxBullets = 6;
    const picked = hasSignal
      ? scored
          .sort((a, b) => b.score - a.score)
          .slice(0, Math.min(maxBullets, scored.length))
          .sort((a, b) => a.index - b.index)
      : scored.slice(0, Math.min(maxBullets, scored.length));
    const t0 = list[0].start;
    const last = list[list.length - 1];
    const t1 = last.start + (last.duration || 0);
    const span = Math.max(1, t1 - t0);
    const bullets = picked.map((row, bi) => {
      const { label, body } = naturalBulletFromSentence(String(row.sentence));
      const startSec = t0 + (bi / Math.max(1, picked.length)) * span;
      const endSec = t0 + ((bi + 1) / Math.max(1, picked.length)) * span;
      return {
        label,
        body,
        startSec: Math.floor(startSec),
        endSec: Math.floor(endSec),
        bracket: formatTimestampBracket(startSec, endSec),
        href: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${Math.floor(startSec)}s`,
      };
    });
    let secTitle = sectionTitleFromSentences(sentences, scored);
    secTitle = ensureDistinctSectionTitle(secTitle, bullets, picked, sentences, scored, sections.length + 1);
    sections.push({
      title: secTitle,
      sectionStartSec: Math.floor(t0),
      sectionEndSec: Math.floor(t1),
      bullets,
    });
  }

  return sections;
}

function normalizeSegmentText(item) {
  const raw = item != null && typeof item.text === "string" ? item.text : String(item?.text ?? "");
  return raw.replace(/\s+/g, " ").trim();
}

async function buildSummaryPayload(videoId, title, segments) {
  const normalizedSegments = segments
    .map((item) => ({ ...item, text: normalizeSegmentText(item) }))
    .filter((item) => item.text.length > 0);

  const transcriptText = normalizedSegments.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();

  if (!transcriptText) {
    throw new Error(
      "Transcript was empty after parsing. The video may have no usable captions, or caption text used a format we could not read. Try another video, enable auto-captions on YouTube, or ensure Deno is installed and on PATH (see yt-dlp EJS docs)."
    );
  }

  let summarySections = buildSummarySections(normalizedSegments, videoId);
  let summarySource = "extractive";

  const apiKey = process.env.OPENAI_API_KEY && String(process.env.OPENAI_API_KEY).trim();
  if (apiKey) {
    try {
      const { summarizeTranscriptOpenAI } = require(path.join(__dirname, "lib", "openai-summarize.js"));
      const llm = await summarizeTranscriptOpenAI(videoId, title, transcriptText, normalizedSegments);
      if (Array.isArray(llm) && llm.length) {
        summarySections = llm;
        summarySource = "openai";
      }
    } catch (err) {
      console.warn("[youtube-summary] OpenAI summarization failed; trying Gemini, Ollama, or extractive.", err.message || err);
    }
  }

  if (summarySource === "extractive") {
    const geminiKey = process.env.GEMINI_API_KEY && String(process.env.GEMINI_API_KEY).trim();
    if (geminiKey) {
      try {
        const { summarizeTranscriptGemini } = require(path.join(__dirname, "lib", "gemini-summarize.js"));
        const gem = await summarizeTranscriptGemini(videoId, title, transcriptText, normalizedSegments);
        if (Array.isArray(gem) && gem.length) {
          summarySections = gem;
          summarySource = "gemini";
        }
      } catch (err) {
        console.warn("[youtube-summary] Gemini summarization failed; trying Ollama or extractive.", err.message || err);
      }
    }
  }

  if (summarySource === "extractive") {
    const ollamaModel = process.env.OLLAMA_MODEL && String(process.env.OLLAMA_MODEL).trim();
    if (ollamaModel) {
      try {
        const { summarizeTranscriptOllama } = require(path.join(__dirname, "lib", "ollama-summarize.js"));
        const local = await summarizeTranscriptOllama(videoId, title, transcriptText, normalizedSegments);
        if (Array.isArray(local) && local.length) {
          summarySections = local;
          summarySource = "ollama";
        }
      } catch (err) {
        console.warn("[youtube-summary] Ollama summarization failed; using extractive summary.", err.message || err);
      }
    }
  }

  return {
    videoId,
    title,
    summarySections,
    summarySource,
    fullTranscript: transcriptText,
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

  return await buildSummaryPayload(videoId, title, transcriptSegments);
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
