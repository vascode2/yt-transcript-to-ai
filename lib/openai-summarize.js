/**
 * Optional map-style summarization via OpenAI Chat Completions (JSON mode).
 * Set OPENAI_API_KEY. Model: OPENAI_SUMMARY_MODEL (default gpt-4o-mini).
 * Optional OPENAI_BASE_URL (e.g. http://localhost:1234/v1) for LM Studio / compatible servers.
 * OPENAI_DISABLE_JSON_MODE=1 if the server rejects response_format json_object.
 */

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

function formatTimestampBracket(startSec, endSec) {
  const a = formatTimestamp(startSec);
  if (endSec > startSec + 1.5) {
    return `[${a}, ${formatTimestamp(endSec)}]`;
  }
  return `[${a}]`;
}

function ensureLabelColon(label) {
  const t = String(label || "").trim();
  if (!t) return "Takeaway:";
  return /[:：]\s*$/.test(t) ? t : `${t}:`;
}

function attachTimestamps(sections, segments, videoId) {
  const list = Array.isArray(segments) ? segments.filter((s) => s && String(s.text || "").trim()) : [];
  if (!list.length) {
    return sections;
  }
  const tStart = list[0].start;
  const last = list[list.length - 1];
  const tEnd = last.start + (last.duration || 0);
  const dur = Math.max(1, tEnd - tStart);
  const nSec = Math.max(1, sections.length);

  return sections.map((sec, si) => {
    const s0 = tStart + (si / nSec) * dur;
    const s1 = tStart + ((si + 1) / nSec) * dur;
    const span = Math.max(1, s1 - s0);
    const rawBullets = Array.isArray(sec.bullets) ? sec.bullets : [];
    const nB = Math.max(1, rawBullets.length);

    const bullets = rawBullets.map((b, bi) => {
      const bs = s0 + (bi / nB) * span;
      const be = s0 + ((bi + 1) / nB) * span;
      const label = ensureLabelColon(b.label);
      const body = String(b.body || "").trim();
      return {
        label,
        body,
        startSec: Math.floor(bs),
        endSec: Math.floor(be),
        bracket: formatTimestampBracket(bs, be),
        href: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${Math.floor(bs)}s`,
      };
    });

    return {
      title: String(sec.title || "Section").trim() || "Section",
      sectionStartSec: Math.floor(s0),
      sectionEndSec: Math.floor(s1),
      bullets,
    };
  });
}

function parseJsonObject(content) {
  const raw = String(content || "").trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = fence ? fence[1].trim() : raw;
  return JSON.parse(text);
}

function chatCompletionsUrl() {
  const base = process.env.OPENAI_BASE_URL && String(process.env.OPENAI_BASE_URL).trim();
  if (base) {
    return `${base.replace(/\/$/, "")}/chat/completions`;
  }
  return "https://api.openai.com/v1/chat/completions";
}

async function chatJson({ apiKey, model, system, user }) {
  const payload = {
    model,
    temperature: 0.35,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  if (process.env.OPENAI_DISABLE_JSON_MODE !== "1" && process.env.OPENAI_DISABLE_JSON_MODE !== "true") {
    payload.response_format = { type: "json_object" };
  }

  const res = await fetch(chatCompletionsUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error?.message || res.statusText || "OpenAI request failed";
    throw new Error(msg);
  }
  const content = data.choices?.[0]?.message?.content;
  return parseJsonObject(content);
}

const MAP_SYSTEM = `You summarize one portion of a YouTube video transcript for a reader.

Rules:
- If the transcript is not in English, write in the same language as the transcript.
- Ignore caption credits (Transcriber, Reviewer, translator names), filler (uh, you know, like), and repetition.
- Preserve concrete facts: numbers, temperatures, time recommendations, warnings, and exceptions.
- Labels must be short topic phrases (like subheadings), 3–8 words, no trailing punctuation before the JSON ends (the app adds a colon).
- Bodies must be clear, grammatical sentences that stand alone (not fragments). Do not repeat the label wording at the start of the body.
- Output ONLY valid JSON matching the schema described in the user message.`;

const REDUCE_SYSTEM = `You merge partial summaries of one video into one coherent outline.

Rules:
- Deduplicate overlapping points; keep hierarchy (main ideas before details).
- Preserve specificity; do not replace concrete advice with vague language.
- Each bullet body must not repeat its label at the start.
- Output ONLY valid JSON as described in the user message.`;

/**
 * @returns {Promise<{ sections: Array<{title: string, bullets: {label: string, body: string}[]}> } | null>}
 */
async function summarizeTranscriptOpenAI(videoId, title, transcriptText, segments) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !String(apiKey).trim()) {
    return null;
  }

  const model = process.env.OPENAI_SUMMARY_MODEL || "gpt-4o-mini";
  const maxMapChars = Number(process.env.OPENAI_CHUNK_CHARS || 3200);
  const oneShotMax = Number(process.env.OPENAI_ONESHOT_MAX_CHARS || 14000);

  if (transcriptText.length <= oneShotMax) {
    const user = `Video title: ${title}

Full transcript (spoken content):
${transcriptText}

Return JSON with this exact shape:
{
  "sections": [
    {
      "title": "Readable section heading (not random keywords; describe the theme)",
      "bullets": [
        { "label": "Short topic phrase for skimming", "body": "1–2 clear sentences." }
      ]
    }
  ]
}

Use 3 to 5 sections when the video has multiple topics. Each section needs 3 to 5 bullets. Order sections chronologically.`;

    const out = await chatJson({
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
      throw new Error("OpenAI returned no usable sections.");
    }
    return attachTimestamps(sections, segments, videoId);
  }

  /* Long transcripts: map by chunks, then reduce */
  const chunks = [];
  for (let i = 0; i < transcriptText.length; i += maxMapChars) {
    chunks.push(transcriptText.slice(i, i + maxMapChars));
  }

  const partials = [];
  for (let ci = 0; ci < chunks.length; ci++) {
    const user = `Video title: ${title}
Part ${ci + 1} of ${chunks.length} (chronological).

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

    const part = await chatJson({
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
      "title": "Merged section title",
      "bullets": [
        { "label": "Topic phrase", "body": "Merged or best sentence(s)." }
      ]
    }
  ]
}

Aim for 4 to 7 sections total and 3 to 5 bullets each; combine duplicates.`;

  const merged = await chatJson({
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
    throw new Error("OpenAI merge returned no usable sections.");
  }
  return attachTimestamps(sections, segments, videoId);
}

module.exports = {
  summarizeTranscriptOpenAI,
  attachTimestamps,
  ensureLabelColon,
};
