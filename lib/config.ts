function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  workerSecret: process.env.WORKER_CALLBACK_SECRET ?? "",
  blobAccess: (process.env.BLOB_ACCESS === "private" ? "private" : "public") as
    | "public"
    | "private",
  sandboxName: process.env.SANDBOX_NAME || "grabbit-worker",
  sandboxImage: "vercel/sandbox/universal",
  sandboxTimeoutMs: intEnv("SANDBOX_TIMEOUT_MINUTES", 1440) * 60_000,
  /** Sessions on the Hobby plan are capped at 45 minutes. */
  hobbySandboxTimeoutMs: 45 * 60_000,
  snapshotExpirationMs: intEnv("SNAPSHOT_TTL_DAYS", 7) * 86_400_000,
  ytdlpVersion: process.env.YTDLP_VERSION || "2026.08.19",
  outputTtlMs: intEnv("OUTPUT_TTL_HOURS", 24) * 3_600_000,
  maxDurationMinutes: intEnv("MAX_DURATION_MINUTES", 720),
  maxAttempts: intEnv("MAX_ATTEMPTS", 3),
  maxOutputBytes: intEnv("MAX_OUTPUT_GB", 40) * 1_000_000_000,
  /** If set, submitting a job requires this shared code. */
  accessCode: process.env.APP_ACCESS_CODE ?? "",
  /** Maximum jobs in flight, running plus waiting. */
  maxPendingJobs: intEnv("MAX_PENDING_JOBS", 2),
  stallMs: intEnv("STALL_MINUTES", 10) * 60_000,
  syncMinIntervalMs: intEnv("SYNC_MIN_INTERVAL_SECONDS", 4) * 1000,
  sandboxIdleDeleteMs: intEnv("SANDBOX_IDLE_DELETE_HOURS", 24) * 3_600_000,
  retryDelayMs: 60_000,
  /** Jobs that never reach a terminal state are failed after this long. */
  jobMaxAgeMs: 48 * 3_600_000,
  uploadUrlTtlMs: 6 * 3_600_000,
  paths: {
    jobs: "jobs/",
    outputs: "outputs/",
    workerState: "state/worker.json",
  },
} as const;

/**
 * Resolve the public base URL the sandbox worker should call back on.
 * Order: explicit override, the production domain Vercel exposes, the
 * deployment origin of the current request.
 */
export function resolveAppBaseUrl(requestUrl: string): string {
  const explicit = process.env.APP_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const production = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (production) {
    return production.startsWith("http")
      ? production.replace(/\/+$/, "")
      : `https://${production.replace(/\/+$/, "")}`;
  }
  try {
    return new URL(requestUrl).origin;
  } catch {
    return "";
  }
}
