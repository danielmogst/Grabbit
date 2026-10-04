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

  // A queued job whose retry delay has passed may need a nudge if callbacks
  // are unavailable (for example during local development).
  if (
    job.status === "queued" &&
    (!job.nextAttemptAt || job.nextAttemptAt <= Date.now())
  ) {
    after(async () => {
      try {
        await runTick();
      } catch (error) {
        console.error("Tick after queued poll failed", error);
      }
    });
  }

  // A job that has not reported progress for a long time may be stuck. Let
  // the scheduler restart or fail it, even without a frequent cron.
  if (!isTerminal(job.status) && Date.now() - job.updatedAt > config.stallMs) {
    after(async () => {
      try {
        await runTick();
      } catch (error) {
        console.error("Tick after stale poll failed", error);
      }
    });
  }

  return Response.json({ job: publicJob(job) });
}
