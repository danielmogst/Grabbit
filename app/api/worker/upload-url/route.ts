import { issueSignedToken, presignUrl } from "@vercel/blob";
import { config } from "@/lib/config";
import { sanitizeFilename } from "@/lib/format";
import { readJob } from "@/lib/jobs";
import {
  formatContentType,
  formatExtension,
  isActive,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  if (
    !config.workerSecret ||
    request.headers.get("x-worker-secret") !== config.workerSecret
  ) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  let body: { jobId?: unknown; sizeBytes?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid body." }, { status: 400 });
  }

  const jobId = typeof body.jobId === "string" ? body.jobId : "";
  const sizeBytes = typeof body.sizeBytes === "number" ? body.sizeBytes : 0;
  const job = await readJob(jobId);
  if (!job) {
    return Response.json({ error: "Job not found." }, { status: 404 });
  }
  if (!isActive(job.status)) {
    return Response.json({ error: "Job is not active." }, { status: 409 });
  }
  if (sizeBytes > config.maxOutputBytes) {
    return Response.json(
      { error: "The converted file is larger than the configured output limit." },
      { status: 413 },
    );
  }

  const extension = formatExtension(job.format);
  const contentType = formatContentType(job.format);
  const pathname = `${config.paths.outputs}${job.id}/${sanitizeFilename(
    job.title || "video",
  )}.${extension}`;

  const signed = await issueSignedToken({
    pathname,
    operations: ["put"],
    allowedContentTypes: [contentType],
    maximumSizeInBytes: config.maxOutputBytes,
    validUntil: Date.now() + config.uploadUrlTtlMs,
  });

  const { presignedUrl } = await presignUrl(signed, {
    operation: "put",
    pathname,
    access: config.blobAccess,
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60 * 60 * 24 * 7,
  });

  return Response.json({
    presignedUrl,
    pathname,
    contentType,
    maxBytes: config.maxOutputBytes,
  });
}
