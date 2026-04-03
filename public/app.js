const form = document.getElementById("summary-form");
const urlInput = document.getElementById("youtube-url");
const submitButton = document.getElementById("submit-button");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const videoTitleEl = document.getElementById("video-title");
const summarySectionsEl = document.getElementById("summary-sections");
const transcriptTextEl = document.getElementById("transcript-text");
const transcriptBodyEl = document.getElementById("transcript-body");
const copyBtn = document.getElementById("copy-btn");
const copyLabel = document.getElementById("copy-label");
const expandBtn = document.getElementById("expand-btn");
const expandIcon = document.getElementById("expand-icon");
const transcriptSearchEl = document.getElementById("transcript-search");
const transcriptSearchMetaEl = document.getElementById("transcript-search-meta");

let fullTranscript = "";
let isExpanded = false;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function highlightTranscriptHtml(text, queryRaw) {
  const q = queryRaw.trim();
  if (!q) {
    return { html: escapeHtml(text).replace(/\n/g, "<br>"), count: 0 };
  }
  const lowerText = text.toLowerCase();
  const lowerQ = q.toLowerCase();
  const len = lowerQ.length;
  if (!len) {
    return { html: escapeHtml(text).replace(/\n/g, "<br>"), count: 0 };
  }

  const parts = [];
  let i = 0;
  let count = 0;
  while (i < text.length) {
    const j = lowerText.indexOf(lowerQ, i);
    if (j < 0) {
      parts.push(escapeHtml(text.slice(i)));
      break;
    }
    parts.push(escapeHtml(text.slice(i, j)));
    parts.push(`<mark class="transcript-highlight">${escapeHtml(text.slice(j, j + len))}</mark>`);
    count += 1;
    i = j + len;
  }

  return { html: parts.join("").replace(/\n/g, "<br>"), count };
}

function applyTranscriptSearch() {
  const q = transcriptSearchEl?.value ?? "";
  if (!fullTranscript) {
    transcriptSearchMetaEl.textContent = "";
    return;
  }
  if (!q.trim()) {
    transcriptTextEl.textContent = fullTranscript;
    transcriptSearchMetaEl.textContent = "";
    return;
  }

  if (!isExpanded) {
    setExpanded(true);
  }

  const { html, count } = highlightTranscriptHtml(fullTranscript, q);
  transcriptTextEl.innerHTML = html;
  transcriptSearchMetaEl.textContent = count ? `${count} match${count === 1 ? "" : "es"}` : "No matches";

  const first = transcriptTextEl.querySelector("mark.transcript-highlight");
  if (first) {
    first.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function setStatus(message) {
  statusEl.textContent = message;
}

function renderSummarySections(sections, videoId) {
  summarySectionsEl.innerHTML = "";

  if (!sections || !sections.length) {
    const li = document.createElement("li");
    li.className = "summary-section";
    li.textContent = "No summary sections could be built from this transcript.";
    summarySectionsEl.appendChild(li);
    return;
  }

  sections.forEach((section, si) => {
    const li = document.createElement("li");
    li.className = "summary-section";

    const titleEl = document.createElement("div");
    titleEl.className = "summary-section-title";
    const num = document.createElement("span");
    num.className = "summary-section-num";
    num.textContent = `${si + 1}. `;
    const titleText = document.createElement("strong");
    titleText.textContent = section.title || "Section";
    titleEl.append(num, titleText);
    li.appendChild(titleEl);

    const ul = document.createElement("ul");
    ul.className = "summary-bullets";

    for (const b of section.bullets || []) {
      const bulletLi = document.createElement("li");
      bulletLi.className = "summary-bullet";

      const label = document.createElement("strong");
      label.className = "summary-bullet-label";
      label.textContent = b.label || "";

      const body = document.createElement("span");
      body.className = "summary-bullet-body";
      body.textContent = b.body || "";

      const a = document.createElement("a");
      a.className = "summary-timestamp";
      a.href = b.href || `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${b.startSec || 0}s`;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = b.bracket || `[${b.startSec || 0}s]`;

      bulletLi.append(label, body, a);
      ul.appendChild(bulletLi);
    }

    li.appendChild(ul);
    summarySectionsEl.appendChild(li);
  });
}

function setExpanded(expanded) {
  isExpanded = expanded;
  expandBtn.setAttribute("aria-expanded", String(expanded));

  if (expanded) {
    transcriptBodyEl.classList.remove("collapsed");
    expandIcon.setAttribute("points", "18 15 12 9 6 15");
  } else {
    transcriptBodyEl.classList.add("collapsed");
    expandIcon.setAttribute("points", "6 9 12 15 18 9");
  }
}

async function copyTranscript() {
  if (!fullTranscript) return;
  try {
    await navigator.clipboard.writeText(fullTranscript);
    copyLabel.textContent = "Copied!";
    copyBtn.classList.add("copied");
    setTimeout(() => {
      copyLabel.textContent = "Copy";
      copyBtn.classList.remove("copied");
    }, 2000);
  } catch {
    copyLabel.textContent = "Failed";
    setTimeout(() => { copyLabel.textContent = "Copy"; }, 2000);
  }
}

copyBtn.addEventListener("click", copyTranscript);
expandBtn.addEventListener("click", () => setExpanded(!isExpanded));

transcriptSearchEl.addEventListener("input", () => {
  applyTranscriptSearch();
});

transcriptSearchEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    transcriptSearchEl.value = "";
    applyTranscriptSearch();
    transcriptSearchEl.blur();
  }
});

async function submitSummary(event) {
  event.preventDefault();

  const url = urlInput.value.trim();
  if (!url) {
    setStatus("Paste a YouTube URL first.");
    return;
  }

  submitButton.disabled = true;
  setStatus("Fetching captions and generating the summary...");
  resultsEl.classList.add("hidden");
  setExpanded(false);

  try {
    const response = await fetch("/api/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Unable to summarize this video.");
    }

    fullTranscript = payload.fullTranscript || "";
    videoTitleEl.textContent = payload.title;
    transcriptTextEl.textContent = fullTranscript;
    if (transcriptSearchEl) transcriptSearchEl.value = "";
    transcriptSearchMetaEl.textContent = "";
    renderSummarySections(payload.summarySections || [], payload.videoId || "");

    resultsEl.classList.remove("hidden");
    const mode =
      payload.summarySource === "openai"
        ? "AI outline"
        : "Quick extract";
    setStatus(`Summary ready (${mode}) · ${payload.transcriptLength.toLocaleString()} characters`);
  } catch (error) {
    setStatus(error.message || "Something went wrong.");
  } finally {
    submitButton.disabled = false;
  }
}

form.addEventListener("submit", submitSummary);
