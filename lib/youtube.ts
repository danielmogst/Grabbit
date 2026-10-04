const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "youtu.be",
]);

export type UrlValidation =
  | { ok: true; videoId: string; canonicalUrl: string }
  | { ok: false; error: string };

function fail(error: string): UrlValidation {
  return { ok: false, error };
}

/**
 * Validate a pasted YouTube link and normalize it to a canonical watch URL.
 * Accepts watch, share (youtu.be), shorts, embed, and music links. Rejects
 * playlists, channels, live streams, and anything that is not a single video.
 */
export function validateYouTubeUrl(input: string): UrlValidation {
  const raw = input.trim();
  if (!raw) return fail("Paste a YouTube link to get started.");

  let url: URL;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
      ? raw
      : `https://${raw}`;
    url = new URL(withScheme);
  } catch {
    return fail("That does not look like a valid link.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return fail("Only http and https links are supported.");
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!YOUTUBE_HOSTS.has(host)) {
    return fail("Only YouTube links are supported.");
  }

  const segments = url.pathname.split("/").filter(Boolean);
  let videoId: string | null = null;

  if (host === "youtu.be") {
    videoId = segments[0] ?? null;
  } else if (segments[0] === "watch") {
    videoId = url.searchParams.get("v");
  } else if (
    segments[0] === "shorts" ||
    segments[0] === "embed" ||
    segments[0] === "v"
  ) {
    videoId = segments[1] ?? null;
  } else if (segments[0] === "live") {
    return fail(
      "Live streams are not supported. Wait until the stream ends and try again.",
    );
  } else if (segments[0] === "playlist") {
    return fail("Playlists are not supported. Paste a link to a single video.");
  } else if (segments.length === 0) {
    return fail("Paste a link to a single YouTube video.");
  } else {
    return fail("That YouTube link does not point to a video.");
  }

  if (!videoId) {
    if (url.searchParams.has("list")) {
      return fail(
        "Playlists are not supported. Paste a link to a single video.",
      );
    }
    return fail("That YouTube link does not point to a video.");
  }

  if (!VIDEO_ID_PATTERN.test(videoId)) {
    return fail("That video ID looks invalid. Copy the link again from YouTube.");
  }

  return {
    ok: true,
    videoId,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };
}
