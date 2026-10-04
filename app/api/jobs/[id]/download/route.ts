import { issueSignedToken, presignUrl } from "@vercel/blob";
import { config } from "@/lib/config";
import { readJob } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const job = await readJob(id);
  if (!job) {
    return Response.json({ error: "Job not found." }, { status: 404 });
  }
  if (job.status !== "completed" || !job.outputPathname) {
    return Response.json(
      { error: "This job is not ready to download yet." },
      { status: 409 },
    );
  }
  if (job.expiresAt && job.expiresAt < Date.now()) {
    return Response.json(
      { error: "This download has expired and the file was removed." },
      { status: 410 },
    );
  }

  let target = job.downloadUrl;
  if (config.blobAccess === "private") {
    const signed = await issueSignedToken({
      pathname: job.outputPathname,
      operations: ["get"],
      validUntil: Date.now() + 60 * 60 * 1000,
    });
    const { presignedUrl } = await presignUrl(signed, {
      operation: "get",
      pathname: job.outputPathname,
      access: "private",
    });
    target = presignedUrl;
  }

  if (!target) {
    return Response.json(
      { error: "The file link is not available right now. Try again in a moment." },
      { status: 503 },
    );
  }

  return Response.redirect(target, 302);
}
