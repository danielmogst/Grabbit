import { after } from "next/server";
import { config } from "@/lib/config";
import { publicJob, readJob } from "@/lib/jobs";
import { runTick, syncJobFromSandbox } from "@/lib/sandbox";
import { isTerminal } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const job = await readJob(id);
  if (!job) {
    return Response.json({ error: "Job not found." }, { status: 404 });
  }

  if (
    !isTerminal(job.status) &&
    Date.now() - job.lastSyncedAt > config.syncMinIntervalMs
  ) {
    const wasActive = !isTerminal(job.status);
    try {
      await syncJobFromSandbox(job);
    } catch (error) {
      console.error("Sandbox sync failed", error);
    }
    if (wasActive && isTerminal(job.status)) {
      after(async () => {
        try {
          await runTick();
        } catch (error) {
          console.error("Tick after sync finalize failed", error);
        }
      });
    }
  }

  return Response.json({ job: publicJob(job) });
}
