/**
 * Optional local summarization via Ollama (http://127.0.0.1:11434 by default).
 * No API key; runs fully offline once Ollama is installed and a model is pulled.
 *
 * Env:
 *   OLLAMA_MODEL       — required to enable (e.g. llama3.2, mistral, phi3)
 *   OLLAMA_HOST        — base URL, default http://127.0.0.1:11434
 *   OLLAMA_CHUNK_CHARS — map chunk size for long transcripts (default 2800)
 *   OLLAMA_ONESHOT_MAX_CHARS — max chars for single request (default 12000)
 */

const { attachTimestamps } = require("./openai-summarize.js");

function parseJsonObject(content) {
  const raw = String(content || "").trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = fence ? fence[1].trim() : raw;
  return JSON.parse(text);
}

async function chatOllamaJson({ baseUrl, model, system, user }) {
  const root = String(baseUrl || "http://127.0.0.1:11434").replace(/\/$/, "");
  const res = await fetch(`${root}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      format: "json",
      stream: false,
      options: { temperature: 0.35 },
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error || data.message || res.statusText || "Ollama request failed";
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  const content = data.message?.content;
  if (!content) {
    throw new Error("Ollama returned an empty response.");
  }
  return parseJsonObject(content);
}

const MAP_SYSTEM = `You summarize part of a YouTube transcript.

Hard rules:
- Each bullet "label" is a SHORT topic heading (3–8 words). It must NOT copy the opening words of "body".
- "body" explains the point in 1–2 full sentences. Do not repeat the label text at the start of body.
- Ignore caption credits, filler (uh, um), and repetition. Keep numbers, times, and concrete advice.
- Output ONLY valid JSON as described in the user message.`;

const REDUCE_SYSTEM = `You merge partial video summaries into one outline.

Rules:
- Deduplicate overlapping points; keep chronological order where possible.
- Each bullet: short "label" (not a sentence), "body" (standalone sentences, no repeating the label).
- Output ONLY valid JSON as described in the user message.`;

/**
 * @returns {Promise<Array|null>} sections with timestamps, or null if OLLAMA_MODEL unset
 */
async function summarizeTranscriptOllama(videoId, title, transcriptText, segments) {
  const model = process.env.OLLAMA_MODEL && String(process.env.OLLAMA_MODEL).trim();
  if (!model) {
    return null;
  }

  const baseUrl = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
  const maxMapChars = Number(process.env.OLLAMA_CHUNK_CHARS || 2800);
  const oneShotMax = Number(process.env.OLLAMA_ONESHOT_MAX_CHARS || 12000);

  if (transcriptText.length <= oneShotMax) {
    const user = `Video title: ${title}

Transcript:
${transcriptText}

Return JSON:
{
  "sections": [
    {
      "title": "Section theme (short phrase, not the first sentence of the transcript)",
      "bullets": [
        { "label": "Topic phrase", "body": "Explanation without repeating the label." }
      ]
    }
  ]
}

Use 3 to 5 sections. Each section: 3 to 5 bullets. Order chronologically.`;

    const out = await chatOllamaJson({
      baseUrl,
      model,
      system: MAP_SYSTEM,
      user,
    });

    const raw = Array.isArray(out.sections) ? out.sections : [];
    const sections = raw
      .map((sec) => ({
        title: String(sec.title || "").trim() || "Section",
        bullets: (Array.isArray(sec.bullets) ? sec.bullets : [])
          .map((b) => ({
            label: String(b.label || "").trim(),
            body: String(b.body || "").trim(),
          }))
          .filter((b) => b.label && b.body),
      }))
      .filter((sec) => sec.bullets.length > 0);
    if (!sections.length) {
      throw new Error("Ollama returned no usable sections.");
    }
    return attachTimestamps(sections, segments, videoId);
  }

  const chunks = [];
  for (let i = 0; i < transcriptText.length; i += maxMapChars) {
    chunks.push(transcriptText.slice(i, i + maxMapChars));
  }

  const partials = [];
  for (let ci = 0; ci < chunks.length; ci++) {
    const user = `Video title: ${title}
Part ${ci + 1} of ${chunks.length} (in order).

Transcript:
${chunks[ci]}

Return JSON:
{
  "section_title": "Theme of this part",
  "bullets": [
    { "label": "Short phrase", "body": "Clear sentence(s), label not repeated at start." }
  ]
}
Use 3 to 6 bullets.`;

    const part = await chatOllamaJson({
      baseUrl,
      model,
      system: MAP_SYSTEM,
      user,
    });

    partials.push({
      section_title: part.section_title || `Part ${ci + 1}`,
      bullets: Array.isArray(part.bullets) ? part.bullets : [],
    });
  }

  const reduceUser = `Video title: ${title}

Notes from chunks (JSON):
${JSON.stringify(partials)}

Return JSON:
{
  "sections": [
    {
      "title": "Merged theme",
      "bullets": [
        { "label": "Topic phrase", "body": "Merged detail; do not duplicate label." }
      ]
    }
  ]
}

Aim for 4 to 7 sections, 3 to 5 bullets each.`;

  const merged = await chatOllamaJson({
    baseUrl,
    model,
    system: REDUCE_SYSTEM,
    user: reduceUser,
  });

  const rawMerged = Array.isArray(merged.sections) ? merged.sections : [];
  const sections = rawMerged
    .map((sec) => ({
      title: String(sec.title || "").trim() || "Section",
      bullets: (Array.isArray(sec.bullets) ? sec.bullets : [])
        .map((b) => ({
          label: String(b.label || "").trim(),
          body: String(b.body || "").trim(),
        }))
        .filter((b) => b.label && b.body),
    }))
    .filter((sec) => sec.bullets.length > 0);
  if (!sections.length) {
    throw new Error("Ollama merge returned no usable sections.");
  }
  return attachTimestamps(sections, segments, videoId);
}

module.exports = {
  summarizeTranscriptOllama,
};
