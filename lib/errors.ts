interface ErrorRule {
  test: RegExp;
  message: string;
  retryable?: boolean;
}

const RULES: ErrorRule[] = [
  {
    test: /OIDC|VERCEL_OIDC_TOKEN|not authenticated|Failed to authenticate|credentials.*(missing|invalid)|token.*(missing|expired)/i,
    message:
      "The worker could not authenticate with Vercel Sandbox. Link the project and pull environment variables, or check the deployment settings.",
  },
  {
    test: /Sign in to confirm your age|age-restricted|inappropriate for some users/i,
    message:
      "This video is age-restricted, so YouTube will not serve it without a signed-in session.",
  },
  {
    test: /Private video/i,
    message: "This video is private.",
  },
  {
    test: /members-only|Join this channel to get access/i,
    message: "This video is only available to channel members.",
  },
  {
    test: /This video is unavailable|Video unavailable|removed by the uploader|account associated with this video has been terminated/i,
    message: "This video is unavailable. It may have been removed.",
  },
  {
    test: /Video has not been made available|not available in your country|blocked it on copyright grounds/i,
    message: "This video is blocked in the region the worker runs in.",
  },
  {
    test: /premieres in|is not yet available|upcoming/i,
    message: "This video has not premiered yet. Try again after it goes live.",
  },
  {
    test: /Requested format is not available/i,
    message:
      "YouTube did not offer a stream matching that quality. Try Best available.",
  },
  {
    test: /HTTP Error 403|403 Forbidden|Unable to download video data/i,
    message:
      "YouTube denied the download (HTTP 403). This is usually temporary; try again in a few minutes.",
    retryable: true,
  },
  {
    test: /HTTP Error 429|Too Many Requests/i,
    message: "YouTube is rate limiting downloads right now. Try again shortly.",
    retryable: true,
  },
  {
    test: /Unable to download webpage|getaddrinfo|ENOTFOUND|ECONNRESET|ETIMEDOUT|Temporary failure in name resolution|Network is unreachable/i,
    message: "The worker lost its network connection. Retrying usually fixes this.",
    retryable: true,
  },
  {
    test: /Unable to connect to database|ssl|CERTIFICATE_VERIFY_FAILED/i,
    message: "The worker had a network problem reaching YouTube.",
    retryable: true,
  },
  {
    test: /Uploading the finished file failed|Could not get an upload link|upload-url/i,
    message: "Uploading the finished file failed. It will be retried.",
    retryable: true,
  },
  {
    test: /No space left on device/i,
    message: "The worker ran out of disk space. Try a shorter video or lower quality.",
  },
  {
    test: /ffmpeg|ffprobe/i,
    message:
      "The media tools in the worker were unavailable. The next run reinstalls them automatically.",
    retryable: true,
  },
  {
    test: /not a valid URL|Unsupported URL|Incomplete YouTube ID/i,
    message: "YouTube did not accept that link. Copy the share link again.",
  },
];

const FALLBACK =
  "The conversion failed. Check the link, then try again.";

const OVERRIDES: Record<string, { message: string; retryable: boolean }> = {
  live: {
    message: "Live streams are not supported.",
    retryable: false,
  },
  "too-long": {
    message: "This video is longer than the configured limit.",
    retryable: false,
  },
};

export function classifyJobError(raw: string | undefined): {
  message: string;
  retryable: boolean;
} {
  const text = (raw ?? "").trim();
  if (!text) return { message: FALLBACK, retryable: true };

  for (const rule of RULES) {
    if (rule.test.test(text)) {
      return { message: rule.message, retryable: rule.retryable === true };
    }
  }

  const firstError = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const short = firstError ? firstError.slice(0, 220) : FALLBACK;
  return { message: short, retryable: true };
}

export function overrideForError(code: keyof typeof OVERRIDES) {
  return OVERRIDES[code];
}
