/**
 * Page context: read ytInitialPlayerResponse and notify the content script via a DOM event.
 */
(function () {
  const EVENT = "__yts_ext_caption_meta";
  let lastSig = "";

  function getPlayerResponse() {
    try {
      const a = window.ytInitialPlayerResponse;
      if (a && (a.videoDetails || a.captions)) return a;
    } catch (_) {}
    try {
      const args = window.ytplayer?.config?.args;
      const raw = args?.player_response || args?.raw_player_response;
      if (typeof raw === "string" && raw.length > 10) {
        const o = JSON.parse(raw);
        if (o && (o.videoDetails || o.captions)) return o;
      }
    } catch (_) {}
    try {
      const el = document.querySelector("#movie_player");
      if (el && typeof el.getPlayerResponse === "function") {
        const o = el.getPlayerResponse();
        if (o && (o.videoDetails || o.captions)) return o;
      }
    } catch (_) {}
    return null;
  }

  function pickDetail(pr) {
    if (!pr || !pr.videoDetails) return null;
    const vid = pr.videoDetails.videoId;
    const tracks = pr.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!vid) return null;
    return {
      videoId: vid,
      title: pr.videoDetails.title || "",
      tracks: Array.isArray(tracks)
        ? tracks.map((t) => ({
            baseUrl: t.baseUrl,
            languageCode: t.languageCode || "",
            name: (t.name && (t.name.simpleText || t.name.runs?.[0]?.text)) || "",
            kind: t.kind || "",
          }))
        : [],
    };
  }

  function tryEmit() {
    const urlVid = new URLSearchParams(window.location.search).get("v") || "";
    const detail = pickDetail(getPlayerResponse());
    if (!detail) return;
    if (
      urlVid &&
      detail.videoId !== urlVid &&
      detail.videoId.toLowerCase() !== urlVid.toLowerCase()
    ) {
      return;
    }
    const sig = `${detail.videoId}|${detail.tracks.map((t) => t.baseUrl).join(";")}`;
    if (sig === lastSig) return;
    lastSig = sig;
    document.dispatchEvent(
      new CustomEvent(EVENT, {
        bubbles: true,
        composed: true,
        detail,
      })
    );
  }

  document.addEventListener("yt-navigate-finish", () => {
    lastSig = "";
    setTimeout(tryEmit, 50);
    setTimeout(tryEmit, 600);
    setTimeout(tryEmit, 2000);
  });

  let t = 0;
  const obs = new MutationObserver(() => {
    clearTimeout(t);
    t = setTimeout(tryEmit, 400);
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });

  tryEmit();
  setTimeout(tryEmit, 800);
  setTimeout(tryEmit, 2500);
})();
