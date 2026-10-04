import { cleanupExpired, runTick } from "@/lib/sandbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const authorization = request.headers.get("authorization");
    if (authorization !== `Bearer ${secret}`) {
      return Response.json({ error: "Unauthorized." }, { status: 401 });
    }
  }

  const tick = await runTick();
  const cleanup = await cleanupExpired();
  return Response.json({ ok: true, tick, cleanup });
}
