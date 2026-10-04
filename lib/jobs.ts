import { randomBytes } from "node:crypto";
import { del, get, list, put } from "@vercel/blob";
import { config } from "./config";
import type { ClientJob, Job, WorkerState } from "./types";

const JSON_CACHE_SECONDS = 60;

function jobPath(id: string): string {
  return `${config.paths.jobs}${id}.json`;
}

async function readJson<T>(pathname: string): Promise<T | null> {
  const result = await get(pathname, {
    access: config.blobAccess,
    useCache: false,
  });
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  const text = await new Response(result.stream).text();
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function newJobId(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

export async function writeJob(job: Job): Promise<void> {
  await put(jobPath(job.id), JSON.stringify(job), {
    access: config.blobAccess,
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: JSON_CACHE_SECONDS,
  });
}

export async function readJob(id: string): Promise<Job | null> {
  return readJson<Job>(jobPath(id));
}

export async function deleteJobRecord(id: string): Promise<void> {
  await del(jobPath(id));
}

export async function listJobs(): Promise<Job[]> {
  const result = await list({ prefix: config.paths.jobs, limit: 1000 });
  const jobs = await Promise.all(
    result.blobs
      .filter((blob) => blob.pathname.endsWith(".json"))
      .map((blob) => readJson<Job>(blob.pathname)),
  );
  return jobs.filter((job): job is Job => job !== null);
}

export async function listOutputs() {
  const result = await list({ prefix: config.paths.outputs, limit: 1000 });
  return result.blobs;
}

const IDLE_WORKER: Omit<WorkerState, "sandboxName"> = {
  currentJobId: null,
  lastActivityAt: 0,
  updatedAt: 0,
};

export async function readWorkerState(): Promise<WorkerState> {
  const stored = await readJson<WorkerState>(config.paths.workerState);
  if (!stored) {
    return { ...IDLE_WORKER, sandboxName: config.sandboxName };
  }
  return { ...stored, sandboxName: stored.sandboxName || config.sandboxName };
}

export async function writeWorkerState(state: WorkerState): Promise<void> {
  await put(config.paths.workerState, JSON.stringify(state), {
    access: config.blobAccess,
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: JSON_CACHE_SECONDS,
  });
}

export function publicJob(job: Job): ClientJob {
  return {
    id: job.id,
    url: job.url,
    format: job.format,
    quality: job.quality,
    status: job.status,
    progress: job.progress,
    speed: job.speed,
    eta: job.eta,
    title: job.title,
    durationSec: job.durationSec,
    sizeBytes: job.sizeBytes,
    downloadUrl: job.downloadUrl,
    error: job.error,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    expiresAt: job.expiresAt,
  };
}
