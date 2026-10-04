import { after } from "next/server";
import { config, resolveAppBaseUrl } from "@/lib/config";
import { newJobId, publicJob, writeJob } from "@/lib/jobs";
import { runTick } from "@/lib/sandbox";
import {
  DEFAULT_QUALITY,
  qualitiesFor,
  type Job,
  type JobFormat,
} from "@/lib/types";
import { validateYouTubeUrl } from "@/lib/youtube";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  if (!config.workerSecret) {
    return Response.json(
      {
        error:
          "The server is missing WORKER_CALLBACK_SECRET. Add it to the environment before starting jobs.",
      },
      { status: 503 },
    );
  }

  let body: { url?: unknown; format?: unknown; quality?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const validation = validateYouTubeUrl(
    typeof body.url === "string" ? body.url : "",
  );
  if (!validation.ok) {
    return Response.json({ error: validation.error }, { status: 400 });
  }

  const format: JobFormat = body.format === "mp3" ? "mp3" : "mp4";
  const allowed = qualitiesFor(format);
  const quality = allowed.some((option) => option.value === body.quality)
    ? (body.quality as string)
    : DEFAULT_QUALITY[format];

  const now = Date.now();
  const job: Job = {
    id: newJobId(),
    url: validation.canonicalUrl,
    videoId: validation.videoId,
    format,
    quality,
    status: "queued",
    progress: 0,
    attempts: 0,
    maxAttempts: config.maxAttempts,
    appBaseUrl: resolveAppBaseUrl(request.url),
    createdAt: now,
    updatedAt: now,
    lastSyncedAt: 0,
  };

  try {
    await writeJob(job);
  } catch (error) {
    console.error("Failed to store job", error);
    return Response.json(
      { error: "Could not store the job. Check the Blob store connection." },
      { status: 503 },
    );
  }

  after(async () => {
    try {
      await runTick();
    } catch (error) {
      console.error("Dispatch tick failed", error);
    }
  });

  return Response.json({ job: publicJob(job) }, { status: 201 });
}
