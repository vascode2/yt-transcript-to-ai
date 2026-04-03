const form = document.getElementById("summary-form");
const urlInput = document.getElementById("youtube-url");
const submitButton = document.getElementById("submit-button");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const videoTitleEl = document.getElementById("video-title");
const summaryTextEl = document.getElementById("summary-text");
const keyPointsEl = document.getElementById("key-points");
const transcriptPreviewEl = document.getElementById("transcript-preview");

function setStatus(message) {
  statusEl.textContent = message;
}

function renderKeyPoints(points) {
  keyPointsEl.innerHTML = "";

  for (const point of points) {
    const item = document.createElement("article");
    item.className = "key-point";

    const timestamp = document.createElement("div");
    timestamp.className = "timestamp";
    timestamp.textContent = point.timestamp;

    const copy = document.createElement("p");
    copy.className = "body-copy";
    copy.textContent = point.text;

    item.append(timestamp, copy);
    keyPointsEl.appendChild(item);
  }
}

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

    videoTitleEl.textContent = payload.title;
    summaryTextEl.textContent = payload.summary;
    transcriptPreviewEl.textContent = payload.transcriptPreview;
    renderKeyPoints(payload.keyPoints || []);
    resultsEl.classList.remove("hidden");
    setStatus(`Summary ready. Transcript length: ${payload.transcriptLength.toLocaleString()} characters.`);
  } catch (error) {
    setStatus(error.message || "Something went wrong.");
  } finally {
    submitButton.disabled = false;
  }
}

form.addEventListener("submit", submitSummary);
