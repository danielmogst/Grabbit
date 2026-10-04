import { after } from "next/server";
import { config } from "@/lib/config";
import { readJob, writeWorkerState } from "@/lib/jobs";
import { applyWorkerStatus, runTick, stopSandboxQuietly } from "@/lib/sandbox";
import { isTerminal, type WorkerReport } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  if (
    !config.workerSecret ||
    request.headers.get("x-worker-secret") !== config.workerSecret
  ) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  let body: WorkerReport;
  try {
    body = (await request.json()) as WorkerReport;
  } catch {
    return Response.json({ error: "Invalid body." }, { status: 400 });
  }
  if (typeof body?.jobId !== "string") {
    return Response.json({ error: "Missing jobId." }, { status: 400 });
  }

  const job = await readJob(body.jobId);
  if (!job) {
    return Response.json({ error: "Job not found." }, { status: 404 });
  }
  if (isTerminal(job.status)) {
    return Response.json({ ok: true, terminal: true });
  }

  const { finalized } = await applyWorkerStatus(job, body);

  if (finalized) {
    const now = Date.now();
    await writeWorkerState({
      currentJobId: null,
      sandboxName: config.sandboxName,
      lastActivityAt: now,
      updatedAt: now,
    });
    await stopSandboxQuietly();
    after(async () => {
      try {
        await runTick();
      } catch (error) {
        console.error("Tick after finalize failed", error);
      }
    });
  }

  return Response.json({ ok: true, finalized });
}
