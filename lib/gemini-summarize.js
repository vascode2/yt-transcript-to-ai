/**
 * Optional summarization via Google Gemini (JSON mode).
 * Set GEMINI_API_KEY. Model: GEMINI_SUMMARY_MODEL (default gemini-2.0-flash).
 * @see https://ai.google.dev/gemini-api/docs
 */

const { attachTimestamps } = require("./openai-summarize.js");

function parseJsonObject(content) {
  const raw = String(content || "").trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = fence ? fence[1].trim() : raw;
  return JSON.parse(text);
}

async function chatGeminiJson({ apiKey, model, system, user }) {
  const m = model || "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        temperature: 0.35,
        responseMimeType: "application/json",
      },
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error?.message || JSON.stringify(data.error || data) || res.statusText;
    throw new Error(msg);
  }
  const block = data.promptFeedback?.blockReason;
  if (block) {
    throw new Error(`Gemini blocked the prompt: ${block}`);
  }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("Gemini returned empty content.");
  }
  return parseJsonObject(text);
}

const MAP_SYSTEM = `You summarize YouTube transcripts into a structured outline.

Rules:
- If the transcript is not in English, write section titles and bullets in the SAME language as the transcript (e.g. Korean transcript → Korean outline).
- Section titles must be short THEMATIC headings (like a good analyst would write). Never use a long verbatim copy of the transcript as a title.
- Each bullet has a short "label" (topic phrase) and a "body" (1–2 clear sentences). The body must NOT repeat the label at the start.
- Ignore caption credits, filler, and repetition. Keep numbers, names, and concrete claims.
- Output ONLY valid JSON matching the user schema.`;

const REDUCE_SYSTEM = `You merge partial summaries of one video into one coherent outline.

Rules:
- Same language as the source notes (match transcript language).
- Thematic section titles — not raw transcript sentences.
- Deduplicate overlaps; keep chronological order where helpful.
- Bullet bodies must not repeat their labels.
- Output ONLY valid JSON as described in the user message.`;

async function summarizeTranscriptGemini(videoId, title, transcriptText, segments) {
  const apiKey = process.env.GEMINI_API_KEY && String(process.env.GEMINI_API_KEY).trim();
  if (!apiKey) {
    return null;
  }

  const model = process.env.GEMINI_SUMMARY_MODEL || "gemini-2.0-flash";
  const maxMapChars = Number(process.env.GEMINI_CHUNK_CHARS || 3200);
  const oneShotMax = Number(process.env.GEMINI_ONESHOT_MAX_CHARS || 14000);

  if (transcriptText.length <= oneShotMax) {
    const user = `Video title: ${title}

Full transcript:
${transcriptText}

Return JSON:
{
  "sections": [
    {
      "title": "Thematic section heading",
      "bullets": [
        { "label": "Short topic phrase", "body": "1–2 clear sentences with specifics." }
      ]
    }
  ]
}

Use 3 to 5 sections when the video has multiple topics. Each section: 3 to 5 bullets. Chronological order.`;

    const out = await chatGeminiJson({
      apiKey,
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
      throw new Error("Gemini returned no usable sections.");
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
Part ${ci + 1} of ${chunks.length}.

Transcript:
${chunks[ci]}

Return JSON:
{
  "section_title": "Theme of this part",
  "bullets": [
    { "label": "Topic phrase", "body": "Clear sentence(s)." }
  ]
}
Use 3 to 6 bullets.`;

    const part = await chatGeminiJson({
      apiKey,
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

Chunk notes (JSON):
${JSON.stringify(partials)}

Return JSON:
{
  "sections": [
    {
      "title": "Merged thematic title",
      "bullets": [
        { "label": "Topic phrase", "body": "Merged detail." }
      ]
    }
  ]
}

Aim for 4 to 7 sections, 3 to 5 bullets each.`;

  const merged = await chatGeminiJson({
    apiKey,
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
    throw new Error("Gemini merge returned no usable sections.");
  }
  return attachTimestamps(sections, segments, videoId);
}

module.exports = {
  summarizeTranscriptGemini,
};
