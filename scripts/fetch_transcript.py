import json
import os
import sys
import urllib.request
import xml.etree.ElementTree as ET

# Prefer pip-installed yt-dlp if PYTHONPATH includes repo vendor/ (would shadow site-packages).
_here = os.path.dirname(os.path.abspath(__file__))
_root = os.path.dirname(_here)
_vendor = os.path.normpath(os.path.join(_root, "vendor"))
_nv = os.path.normcase(_vendor)
sys.path[:] = [p for p in sys.path if p and os.path.normcase(os.path.normpath(p)) != _nv]

from yt_dlp import YoutubeDL  # type: ignore  # noqa: E402


def _collapse_ws(text: str) -> str:
    return " ".join(text.replace("\n", " ").split())


def _parse_xml_time(value: str | None) -> float:
    if not value:
        return 0.0
    v = value.strip()
    if v.endswith("ms"):
        return float(v[:-2]) / 1000.0
    if v.endswith("s") and len(v) > 1:
        try:
            return float(v[:-1])
        except ValueError:
            pass
    if ":" in v:
        return parse_vtt_time(v.split()[0])
    try:
        return float(v)
    except ValueError:
        return 0.0


def iter_caption_urls(info: dict) -> list[str]:
    """Caption download URLs in preference order (deduplicated)."""
    subtitle_groups = [
        info.get("subtitles") or {},
        info.get("automatic_captions") or {},
    ]

    preferred_langs = ("en", "en-US", "en-GB")
    preferred_exts = ("json3", "srv3", "srv2", "srv1", "vtt", "ttml")

    ordered: list[str] = []
    seen: set[str] = set()

    def add(url: str | None) -> None:
        if url and url not in seen:
            seen.add(url)
            ordered.append(url)

    for group in subtitle_groups:
        for lang in preferred_langs:
            candidates = group.get(lang) or []
            if not candidates:
                continue

            for ext in preferred_exts:
                for candidate in candidates:
                    if candidate.get("ext") == ext:
                        add(candidate.get("url"))

            add(candidates[0].get("url"))

    for group in subtitle_groups:
        for candidates in group.values():
            for ext in preferred_exts:
                for candidate in candidates:
                    if candidate.get("ext") == ext:
                        add(candidate.get("url"))
            if candidates:
                add(candidates[0].get("url"))

    if not ordered:
        raise RuntimeError("No subtitles or automatic captions were available for this video.")

    return ordered


def fetch_text(url: str) -> str:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8", errors="replace")


def parse_json3(payload: str) -> list[dict]:
    data = json.loads(payload)
    events = data.get("events", [])
    segments = []

    for event in events:
        segs = event.get("segs") or []
        parts = []
        for seg in segs:
            if isinstance(seg, str):
                chunk = seg
            elif isinstance(seg, dict):
                chunk = (
                    seg.get("utf8")
                    or seg.get("text")
                    or seg.get("ut")
                    or seg.get("unicode")
                    or ""
                )
            else:
                chunk = ""
            if chunk:
                parts.append(chunk)
        text = _collapse_ws("".join(parts))
        if not text:
            top = event.get("text") or event.get("utf8") or ""
            if isinstance(top, str) and top:
                text = _collapse_ws(top)
        if not text:
            continue
        start = float(event.get("tStartMs", 0)) / 1000
        duration = float(event.get("dDurationMs", 0)) / 1000
        segments.append({"start": start, "duration": duration, "text": text})

    return segments


def parse_xml(payload: str) -> list[dict]:
    root = ET.fromstring(payload)
    segments: list[dict] = []

    for node in root.findall(".//text"):
        text = _collapse_ws("".join(node.itertext()))
        if not text:
            continue
        start = float(node.attrib.get("start", "0"))
        duration = float(node.attrib.get("dur", "0"))
        segments.append({"start": start, "duration": duration, "text": text})

    if segments:
        return segments

    for node in root.iter():
        tag = node.tag.split("}")[-1] if "}" in node.tag else node.tag
        if tag != "p":
            continue
        text = _collapse_ws("".join(node.itertext()))
        if not text:
            continue
        start = _parse_xml_time(node.attrib.get("begin") or node.attrib.get("start"))
        end_raw = node.attrib.get("end")
        if end_raw:
            end = _parse_xml_time(end_raw)
            duration = max(0.0, end - start)
        else:
            duration = float(node.attrib.get("dur", "0") or 0)
        if duration <= 0:
            duration = 1.0
        segments.append({"start": start, "duration": duration, "text": text})

    return segments


def parse_vtt(payload: str) -> list[dict]:
    segments = []
    blocks = payload.replace("\r\n", "\n").split("\n\n")

    for block in blocks:
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        if not lines or "-->" not in lines[0]:
            continue

        timing = lines[0]
        text_lines = lines[1:]
        if not text_lines:
            continue

        start_raw, end_raw = [part.strip() for part in timing.split("-->", 1)]
        start = parse_vtt_time(start_raw)
        end = parse_vtt_time(end_raw.split(" ")[0])
        text = _collapse_ws(" ".join(text_lines))

        if text:
            segments.append({"start": start, "duration": max(0.0, end - start), "text": text})

    return segments


def parse_vtt_time(value: str) -> float:
    parts = value.split(":")
    if len(parts) == 3:
        hours, minutes, seconds = parts
    else:
        hours = "0"
        minutes, seconds = parts

    return int(hours) * 3600 + int(minutes) * 60 + float(seconds.replace(",", "."))


def parse_captions(payload: str, url: str) -> list[dict]:
    lowered = payload.lstrip("\ufeff \t\n\r")

    if not lowered:
        return []

    if "fmt=json3" in url or url.endswith("fmt=json3"):
        return parse_json3(payload)

    if lowered.startswith("{"):
        try:
            data = json.loads(payload)
        except json.JSONDecodeError:
            data = None
        if isinstance(data, dict) and "events" in data:
            return parse_json3(payload)

    if lowered.startswith("WEBVTT"):
        return parse_vtt(payload)

    if lowered.startswith("<?xml") or lowered.startswith("<transcript") or lowered.startswith("<tt"):
        return parse_xml(payload)

    if "fmt=vtt" in url:
        return parse_vtt(payload)

    return parse_xml(payload)


def main() -> int:
    if len(sys.argv) < 2:
        print("A YouTube URL is required.", file=sys.stderr)
        return 1

    url = sys.argv[1]
    os.environ.setdefault("YTDLP_NO_LAZY_EXTRACTORS", "1")

    ydl_opts = {
        "quiet": True,
        "skip_download": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": ["en.*", "en", "en-US", "en-GB"],
        "socket_timeout": 30,
        "nocheckcertificate": False,
    }

    try:
        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)

        last_fetch_error: str | None = None
        segments: list[dict] = []
        for caption_url in iter_caption_urls(info):
            try:
                payload = fetch_text(caption_url)
                segments = parse_captions(payload, caption_url)
            except Exception as exc:
                last_fetch_error = str(exc)
                segments = []
                continue
            if segments:
                break

        if not segments:
            detail = last_fetch_error or "Could not parse any caption track."
            raise RuntimeError(
                "Captions were found, but the transcript payload was empty. " + detail
            )

        result = {
            "title": info.get("title") or "YouTube Video",
            "segments": segments,
        }
        payload_out = json.dumps(result, ensure_ascii=False) + "\n"
        sys.stdout.buffer.write(payload_out.encode("utf-8"))
        return 0
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
