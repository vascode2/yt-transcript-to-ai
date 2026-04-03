const form = document.getElementById("summary-form");
const urlInput = document.getElementById("youtube-url");
const submitButton = document.getElementById("submit-button");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const videoTitleEl = document.getElementById("video-title");
const summaryPointsEl = document.getElementById("summary-points");
const transcriptTextEl = document.getElementById("transcript-text");
const transcriptBodyEl = document.getElementById("transcript-body");
const copyBtn = document.getElementById("copy-btn");
const copyLabel = document.getElementById("copy-label");
const expandBtn = document.getElementById("expand-btn");
const expandIcon = document.getElementById("expand-icon");

let fullTranscript = "";
let isExpanded = false;

function setStatus(message) {
  statusEl.textContent = message;
}

function renderSummaryPoints(points) {
  summaryPointsEl.innerHTML = "";
  for (const point of points) {
    const li = document.createElement("li");
    li.className = "summary-point";
    li.textContent = point.text;
    summaryPointsEl.appendChild(li);
  }
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
    renderSummaryPoints(payload.summaryPoints || []);

    resultsEl.classList.remove("hidden");
    setStatus(`Summary ready · ${payload.transcriptLength.toLocaleString()} characters`);
  } catch (error) {
    setStatus(error.message || "Something went wrong.");
  } finally {
    submitButton.disabled = false;
  }
}

form.addEventListener("submit", submitSummary);
