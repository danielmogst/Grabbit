import type { JobStatus } from "./types";

export function formatBytes(bytes: number | undefined): string | null {
  if (!bytes || bytes <= 0) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatDuration(seconds: number | undefined): string | null {
  if (!seconds || seconds <= 0) return null;
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

export function sanitizeFilename(input: string): string {
  const cleaned = input
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N} ._-]/gu, "")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .trim();
  const truncated = cleaned.slice(0, 80).trim();
  return truncated || "video";
}

const STATUS_LABELS: Record<JobStatus, string> = {
  queued: "Queued",
  preparing: "Preparing worker",
  downloading: "Downloading",
  processing: "Converting",
  uploading: "Uploading",
  completed: "Ready to download",
  failed: "Failed",
  canceled: "Canceled",
};

export function statusLabel(status: JobStatus): string {
  return STATUS_LABELS[status];
}
