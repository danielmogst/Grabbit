import { del, head } from "@vercel/blob";
import { Sandbox } from "@vercel/sandbox";
import { config } from "./config";
import { classifyJobError } from "./errors";
import {
  deleteJobRecord,
  listJobs,
  listOutputs,
  readJob,
  readWorkerState,
  writeJob,
  writeWorkerState,
} from "./jobs";
import { isTerminal, type Job, type WorkerReport } from "./types";
import {
  BOOTSTRAP_SH,
  REPORT_MJS,
  RUN_JOB_SH,
  SANDBOX_JOB_DIR,
  SANDBOX_SCRIPTS_DIR,
  SANDBOX_START,
  START_SH,
  buildCurrentEnv,
} from "./worker-scripts";

export interface TickResult {
  action: "idle" | "dispatched" | "reconciled" | "finalized" | "still-running";
  jobId?: string;
}

export interface CleanupResult {
  jobsDeleted: number;
  outputsDeleted: number;
  sandboxDeleted: boolean;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function tailLines(text: string, count: number): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-count).join("\n");
}

function mapProgress(
  stage: string | undefined,
  percent: number | undefined,
): number {
  switch (stage) {
    case "queued":
      return 0;
    case "preparing":
      return 2;
    case "downloading":
      return clamp((percent ?? 0) * 0.9, 0, 90);
    case "processing":
      return 93;
    case "uploading":
      return 96;
    case "completed":
      return 100;
    default:
      return clamp(percent ?? 0, 0, 100);
  }
}

// ---------------------------------------------------------------------------
// Sandbox lifecycle
// ---------------------------------------------------------------------------

export async function getExistingSandbox(): Promise<Sandbox | null> {
  try {
    return await Sandbox.get({ name: config.sandboxName, resume: false });
  } catch {
    return null;
  }
}

export async function ensureWorkerSandbox(): Promise<Sandbox> {
  const existing = await getExistingSandbox();
  if (existing) {
    try {
      await existing.update({ timeout: config.sandboxTimeoutMs });
    } catch {
      // Plan caps (for example 45 minutes on Hobby) are enforced at session start.
    }
    return existing;
  }

  const create = (timeout: number) =>
    Sandbox.create({
      name: config.sandboxName,
      image: config.sandboxImage,
      timeout,
      persistent: true,
      snapshotExpiration: config.snapshotExpirationMs,
      keepLastSnapshots: { count: 1, deleteEvicted: true },
      tags: { app: "grabbit" },
    });

  try {
    return await create(config.sandboxTimeoutMs);
  } catch (error) {
    if (config.sandboxTimeoutMs > config.hobbySandboxTimeoutMs) {
      try {
        return await create(config.hobbySandboxTimeoutMs);
      } catch {
        // Fall through to the original error below.
      }
    }
    throw error;
  }
}

export async function stopSandboxQuietly(): Promise<void> {
  const sandbox = await getExistingSandbox();
  if (!sandbox) return;
  try {
    if (sandbox.status === "running") await sandbox.stop();
  } catch {
    // The session may already be gone; stopping is best effort.
  }
}

async function killJobCommand(sandbox: Sandbox, job: Job): Promise<void> {
  if (!job.cmdId) return;
  try {
    const command = await sandbox.getCommand(job.cmdId);
    await command.kill("SIGKILL");
  } catch {
    // Command already exited or the session ended.
  }
}

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

async function markWorkerBusy(jobId: string): Promise<void> {
  await writeWorkerState({
    currentJobId: jobId,
    sandboxName: config.sandboxName,
    lastActivityAt: Date.now(),
    updatedAt: Date.now(),
  });
}

async function markWorkerIdle(): Promise<void> {
  await writeWorkerState({
    currentJobId: null,
    sandboxName: config.sandboxName,
    lastActivityAt: Date.now(),
    updatedAt: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Status application and finalization
// ---------------------------------------------------------------------------

async function headWithRetry(pathname: string, attempts = 5) {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await head(pathname);
    } catch (error) {
      lastError = error;
      await sleep(1000 * (i + 1));
    }
  }
  throw lastError;
}

async function finalizeCompleted(
  job: Job,
  outputPathname: string,
  reportedSize?: number,
): Promise<void> {
  let url: string | undefined;
  let downloadUrl: string | undefined;
  let size = reportedSize;
  try {
    const meta = await headWithRetry(outputPathname);
    url = meta.url;
    downloadUrl = meta.downloadUrl;
    size = meta.size || reportedSize;
  } catch (error) {
    console.error("Could not read uploaded blob metadata", error);
  }
  const now = Date.now();
  job.status = "completed";
  job.progress = 100;
  job.outputPathname = outputPathname;
  job.outputUrl = url;
  job.downloadUrl = downloadUrl;
  if (size && size > 0) job.sizeBytes = size;
  job.error = undefined;
  job.finishedAt = now;
  job.expiresAt = now + config.outputTtlMs;
  job.updatedAt = now;
  job.lastSyncedAt = now;
  await writeJob(job);
}

/**
 * Apply a worker report to a job. Returns whether the job reached a terminal
 * (completed, failed, or requeued for retry) state.
 */
export async function applyWorkerStatus(
  job: Job,
  report: WorkerReport,
): Promise<{ finalized: boolean }> {
  const now = Date.now();

  if (report.stage === "completed" && report.outputPathname) {
    await finalizeCompleted(job, report.outputPathname, report.sizeBytes);
    return { finalized: true };
  }

  if (report.stage === "failed") {
    const classified = classifyJobError(report.error);
    if (classified.retryable && job.attempts < job.maxAttempts) {
      job.status = "queued";
      job.progress = 0;
      job.error = classified.message;
      job.nextAttemptAt = now + config.retryDelayMs;
    } else {
      job.status = "failed";
      job.error = classified.message;
      job.finishedAt = now;
      job.expiresAt = now + config.outputTtlMs;
    }
    job.updatedAt = now;
    job.lastSyncedAt = now;
    await writeJob(job);
    return { finalized: true };
  }

  if (report.stage) job.status = report.stage;
  if (typeof report.percent === "number") {
    job.progress = mapProgress(report.stage ?? job.status, report.percent);
  }
  if (report.speed) job.speed = report.speed;
  if (report.eta) job.eta = report.eta;
  if (report.title) job.title = report.title;
  if (typeof report.durationSec === "number" && report.durationSec > 0) {
    job.durationSec = report.durationSec;
  }
  if (typeof report.sizeBytes === "number" && report.sizeBytes > 0) {
    job.sizeBytes = report.sizeBytes;
  }
  job.updatedAt = now;
  job.lastSyncedAt = now;
  await writeJob(job);
  return { finalized: false };
}

async function settleFailure(job: Job, rawError: string): Promise<void> {
  const classified = classifyJobError(rawError);
  const now = Date.now();
  job.error = classified.message;
  if (classified.retryable && job.attempts < job.maxAttempts) {
    job.status = "queued";
    job.progress = 0;
    job.nextAttemptAt = now + config.retryDelayMs;
  } else {
    job.status = "failed";
    job.finishedAt = now;
    job.expiresAt = now + config.outputTtlMs;
  }
  job.updatedAt = now;
  job.lastSyncedAt = now;
  await writeJob(job);
  await markWorkerIdle();
  await stopSandboxQuietly();
}

async function readWorkerStatusFile(
  sandbox: Sandbox,
  jobId: string,
): Promise<WorkerReport | null> {
  try {
    const buffer = await sandbox.readFileToBuffer({
      path: `${SANDBOX_JOB_DIR}/status.json`,
    });
    if (!buffer) return null;
    const parsed = JSON.parse(buffer.toString("utf8")) as WorkerReport;
    if (parsed.jobId !== jobId) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function launchJob(
  sandbox: Sandbox,
  job: Job,
  fresh: boolean,
): Promise<void> {
  if (fresh) {
    await sandbox.runCommand({
      cmd: "bash",
      args: [
        "-lc",
        "rm -rf /vercel/sandbox/current-job && mkdir -p /vercel/sandbox/current-job /vercel/sandbox/grabbit",
      ],
    });
  }
  await sandbox.writeFiles([
    {
      path: `${SANDBOX_SCRIPTS_DIR}/bootstrap.sh`,
      content: BOOTSTRAP_SH,
      mode: 0o755,
    },
    {
      path: `${SANDBOX_SCRIPTS_DIR}/run-job.sh`,
      content: RUN_JOB_SH,
      mode: 0o755,
    },
    {
      path: `${SANDBOX_SCRIPTS_DIR}/start.sh`,
      content: START_SH,
      mode: 0o755,
    },
    {
      path: `${SANDBOX_SCRIPTS_DIR}/report.mjs`,
      content: REPORT_MJS,
      mode: 0o644,
    },
    {
      path: `${SANDBOX_SCRIPTS_DIR}/current.env`,
      content: buildCurrentEnv(job, job.appBaseUrl),
      mode: 0o600,
    },
  ]);

  const now = Date.now();
  job.attempts += 1;
  job.status = "preparing";
  job.progress = 0;
  job.sandboxName = config.sandboxName;
  job.startedAt = job.startedAt ?? now;
  job.updatedAt = now;
  job.lastSyncedAt = now;
  delete job.nextAttemptAt;
  await writeJob(job);
  await markWorkerBusy(job.id);

  const command = await sandbox.runCommand({
    cmd: "bash",
    args: [SANDBOX_START],
    detached: true,
  });
  job.cmdId = command.cmdId;
  await writeJob(job);
}

async function startFreshJob(job: Job): Promise<void> {
  try {
    const sandbox = await ensureWorkerSandbox();
    await launchJob(sandbox, job, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await settleFailure(job, message);
  }
}

async function reconcileActiveJob(jobId: string): Promise<TickResult> {
  const job = await readJob(jobId);
  if (!job) {
    await markWorkerIdle();
    return { action: "finalized", jobId };
  }
  if (isTerminal(job.status)) {
    await markWorkerIdle();
    await stopSandboxQuietly();
    return { action: "finalized", jobId };
  }

  const sandbox = await getExistingSandbox();
  if (!sandbox) {
    await settleFailure(job, "The worker sandbox is no longer available.");
    return { action: "finalized", jobId };
  }

  let sandboxStatus: string;
  try {
    sandboxStatus = sandbox.status;
  } catch {
    sandboxStatus = "unknown";
  }

  if (sandboxStatus === "running") {
    const report = await readWorkerStatusFile(sandbox, job.id);
    if (report) {
      const { finalized } = await applyWorkerStatus(job, report);
      if (finalized) {
        await markWorkerIdle();
        await stopSandboxQuietly();
        return { action: "finalized", jobId };
      }
    }

    if (job.cmdId) {
      try {
        const command = await sandbox.getCommand(job.cmdId);
        if (
          command.exitCode !== null &&
          command.exitCode !== undefined &&
          command.exitCode !== 0
        ) {
          const stderr = await command.stderr().catch(() => "");
          await settleFailure(
            job,
            tailLines(stderr, 5) || "The worker process exited before finishing.",
          );
          return { action: "finalized", jobId };
        }
      } catch {
        // Command lookup failed; stall detection below handles it.
      }
    }

    if (Date.now() - job.updatedAt > config.stallMs) {
      await killJobCommand(sandbox, job);
      if (job.attempts < job.maxAttempts) {
        try {
          await launchJob(sandbox, job, false);
          return { action: "reconciled", jobId };
        } catch (error) {
          await settleFailure(
            job,
            error instanceof Error ? error.message : String(error),
          );
          return { action: "finalized", jobId };
        }
      }
      await settleFailure(job, "The conversion stopped responding.");
      return { action: "finalized", jobId };
    }

    return { action: "still-running", jobId };
  }

  // The session ended while the job was unfinished. Resume from the snapshot
  // and continue, relying on yt-dlp --continue to pick up partial downloads.
  if (job.attempts < job.maxAttempts) {
    try {
      const resumed = await ensureWorkerSandbox();
      await launchJob(resumed, job, false);
      return { action: "reconciled", jobId };
    } catch (error) {
      await settleFailure(
        job,
        error instanceof Error ? error.message : String(error),
      );
      return { action: "finalized", jobId };
    }
  }
  await settleFailure(job, "The worker stopped before finishing.");
  return { action: "finalized", jobId };
}

async function recoverOrphans(): Promise<void> {
  const worker = await readWorkerState();
  if (worker.currentJobId) return;
  const jobs = await listJobs();
  const now = Date.now();
  for (const job of jobs) {
    if (isTerminal(job.status)) continue;

    if (now - job.createdAt > config.jobMaxAgeMs) {
      job.status = "failed";
      job.error = "This job timed out before it finished.";
      job.finishedAt = now;
      job.expiresAt = now + config.outputTtlMs;
    } else if (now - job.updatedAt > config.stallMs) {
      const classified = classifyJobError("The worker state was lost before finishing.");
      job.error = classified.message;
      if (job.attempts < job.maxAttempts) {
        job.status = "queued";
        job.progress = 0;
        job.nextAttemptAt = now + config.retryDelayMs;
      } else {
        job.status = "failed";
        job.finishedAt = now;
        job.expiresAt = now + config.outputTtlMs;
      }
    } else {
      continue;
    }
    job.updatedAt = now;
    job.lastSyncedAt = now;
    await writeJob(job);
  }
}

async function findNextQueuedJob(): Promise<Job | null> {
  const now = Date.now();
  const jobs = await listJobs();
  const queued = jobs
    .filter(
      (job) =>
        job.status === "queued" &&
        (!job.nextAttemptAt || job.nextAttemptAt <= now),
    )
    .sort((a, b) => a.createdAt - b.createdAt);
  return queued[0] ?? null;
}

/**
 * One scheduler pass: reconcile the active job, recover orphans, then start
 * the oldest queued job if the worker is free. Safe to call repeatedly.
 */
export async function runTick(): Promise<TickResult> {
  const worker = await readWorkerState();
  if (worker.currentJobId) {
    const result = await reconcileActiveJob(worker.currentJobId);
    if (result.action === "still-running") return result;
  }

  await recoverOrphans();
  const next = await findNextQueuedJob();
  if (!next) return { action: "idle" };
  await startFreshJob(next);
  return { action: "dispatched", jobId: next.id };
}

/**
 * Read the sandbox status file without resuming a stopped session. Used by
 * the status endpoint so progress stays fresh even if callbacks fail.
 */
export async function syncJobFromSandbox(job: Job): Promise<Job> {
  const sandbox = await getExistingSandbox();
  if (!sandbox || sandbox.status !== "running") {
    job.lastSyncedAt = Date.now();
    await writeJob(job);
    return job;
  }
  const report = await readWorkerStatusFile(sandbox, job.id);
  if (!report) {
    // No status yet: if the detached command already died, fail fast instead
    // of leaving the user at 0% until the next cron pass.
    if (job.cmdId) {
      try {
        const command = await sandbox.getCommand(job.cmdId);
        if (
          command.exitCode !== null &&
          command.exitCode !== undefined &&
          command.exitCode !== 0
        ) {
          const stderr = await command.stderr().catch(() => "");
          await settleFailure(
            job,
            tailLines(stderr, 5) || "The worker process exited before finishing.",
          );
          return job;
        }
      } catch {
        // Command lookup failed; the stall watchdog handles it.
      }
    }
    job.lastSyncedAt = Date.now();
    await writeJob(job);
    return job;
  }
  const { finalized } = await applyWorkerStatus(job, report);
  if (finalized) {
    await markWorkerIdle();
    await stopSandboxQuietly();
  }
  return job;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export async function cleanupExpired(): Promise<CleanupResult> {
  const now = Date.now();
  const result: CleanupResult = {
    jobsDeleted: 0,
    outputsDeleted: 0,
    sandboxDeleted: false,
  };

  const jobs = await listJobs();
  const activeOutputs = new Set(
    jobs
      .filter((job) => !isTerminal(job.status) && job.outputPathname)
      .map((job) => job.outputPathname as string),
  );

  for (const job of jobs) {
    if (job.expiresAt && job.expiresAt < now) {
      if (job.outputPathname && !activeOutputs.has(job.outputPathname)) {
        try {
          await del(job.outputPathname);
        } catch {
          // Already gone.
        }
      }
      try {
        await deleteJobRecord(job.id);
        result.jobsDeleted += 1;
      } catch {
        // Already gone.
      }
    }
  }

  const outputBlobs = await listOutputs();
  for (const blob of outputBlobs) {
    const age = now - new Date(blob.uploadedAt).getTime();
    if (age > config.outputTtlMs + 3_600_000 && !activeOutputs.has(blob.pathname)) {
      try {
        await del(blob.url);
        result.outputsDeleted += 1;
      } catch {
        // Already gone.
      }
    }
  }

  const worker = await readWorkerState();
  if (!worker.currentJobId) {
    const idleSince = worker.lastActivityAt || 0;
    if (idleSince > 0 && now - idleSince > config.sandboxIdleDeleteMs) {
      const sandbox = await getExistingSandbox();
      if (sandbox) {
        try {
          await sandbox.delete({ deleteOrphanSnapshots: true });
          result.sandboxDeleted = true;
        } catch {
          // Already gone.
        }
      }
    }
  }

  return result;
}
