export type JobFormat = "mp4" | "mp3";

export type JobStatus =
  | "queued"
  | "preparing"
  | "downloading"
  | "processing"
  | "uploading"
  | "completed"
  | "failed"
  | "canceled";

export type WorkerStage =
  | "preparing"
  | "downloading"
  | "processing"
  | "uploading"
  | "completed"
  | "failed";

export interface Job {
  id: string;
  url: string;
  videoId: string;
  format: JobFormat;
  quality: string;
  status: JobStatus;
  /** Overall completion, 0 to 100. */
  progress: number;
  /** Download speed reported by yt-dlp, for display only. */
  speed?: string;
  /** Remaining time reported by yt-dlp, for display only. */
  eta?: string;
  title?: string;
  durationSec?: number;
  sizeBytes?: number;
  outputPathname?: string;
  outputUrl?: string;
  downloadUrl?: string;
  error?: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt?: number;
  appBaseUrl: string;
  sandboxName?: string;
  cmdId?: string;
  createdAt: number;
  updatedAt: number;
  lastSyncedAt: number;
  startedAt?: number;
  finishedAt?: number;
  expiresAt?: number;
}

/** The subset of a job that is safe to return to the browser. */
export interface ClientJob {
  id: string;
  url: string;
  format: JobFormat;
  quality: string;
  status: JobStatus;
  progress: number;
  speed?: string;
  eta?: string;
  title?: string;
  durationSec?: number;
  sizeBytes?: number;
  downloadUrl?: string;
  error?: string;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  expiresAt?: number;
}

export interface WorkerState {
  currentJobId: string | null;
  sandboxName: string;
  lastActivityAt: number;
  updatedAt: number;
}

export interface WorkerReport {
  jobId: string;
  stage?: WorkerStage;
  percent?: number;
  speed?: string;
  eta?: string;
  title?: string;
  durationSec?: number;
  sizeBytes?: number;
  outputPathname?: string;
  error?: string;
}

export interface QualityOption {
  value: string;
  label: string;
}

export const MP4_QUALITIES: QualityOption[] = [
  { value: "best", label: "Best available" },
  { value: "1080", label: "1080p" },
  { value: "720", label: "720p" },
  { value: "480", label: "480p" },
];

export const MP3_QUALITIES: QualityOption[] = [
  { value: "320", label: "320 kbps" },
  { value: "256", label: "256 kbps" },
  { value: "192", label: "192 kbps" },
  { value: "128", label: "128 kbps" },
];

export const DEFAULT_QUALITY: Record<JobFormat, string> = {
  mp4: "best",
  mp3: "128",
};

export function qualitiesFor(format: JobFormat): QualityOption[] {
  return format === "mp3" ? MP3_QUALITIES : MP4_QUALITIES;
}

export function formatExtension(format: JobFormat): string {
  return format === "mp3" ? "mp3" : "mp4";
}

export function formatContentType(format: JobFormat): string {
  return format === "mp3" ? "audio/mpeg" : "video/mp4";
}

export function isTerminal(status: JobStatus): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

export function isActive(status: JobStatus): boolean {
  return !isTerminal(status);
}
