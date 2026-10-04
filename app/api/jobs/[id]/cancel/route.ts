import { after } from "next/server";
import { config } from "@/lib/config";
import { publicJob, readJob, writeJob, writeWorkerState } from "@/lib/jobs";
import { getExistingSandbox, runTick, stopSandboxQuietly } from "@/lib/sandbox";
import { isTerminal } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const job = await readJob(id);
  if (!job) {
    return Response.json({ error: "Job not found." }, { status: 404 });
  }
  if (isTerminal(job.status)) {
    return Response.json({ job: publicJob(job) });
  }

  if (job.cmdId) {
    const sandbox = await getExistingSandbox();
    if (sandbox && sandbox.status === "running") {
      try {
        const command = await sandbox.getCommand(job.cmdId);
        await command.kill("SIGKILL");
      } catch {
        // Command already gone.
      }
    }
  }

  const now = Date.now();
  job.status = "canceled";
  job.error = undefined;
  job.finishedAt = now;
  job.expiresAt = now + 10 * 60_000;
  job.updatedAt = now;
  job.lastSyncedAt = now;
  await writeJob(job);

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
      console.error("Tick after cancel failed", error);
    }
  });

  return Response.json({ job: publicJob(job) });
}
