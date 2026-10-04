import { config } from "./config";
import type { Job } from "./types";

export const SANDBOX_SCRIPTS_DIR = "/vercel/sandbox/grabbit";
export const SANDBOX_JOB_DIR = "/vercel/sandbox/current-job";
export const SANDBOX_START = `${SANDBOX_SCRIPTS_DIR}/start.sh`;

/**
 * Installs the pinned yt-dlp binary and ffmpeg. The worker sandbox is
 * persistent, so this normally runs once and survives later sessions.
 */
export const BOOTSTRAP_SH = String.raw`#!/usr/bin/env bash
# Installs media tools inside the Vercel Sandbox. Written by the Grabbit app.
set -uo pipefail

if [ -z "$YTDLP_VERSION" ]; then
  echo "YTDLP_VERSION is not set" >&2
  exit 3
fi

if [ "$(id -u)" = "0" ]; then
  SUDO=""
else
  SUDO="sudo -n"
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "installing ffmpeg"
  $SUDO apt-get update -qq
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg ca-certificates curl
fi

CURRENT=""
if command -v yt-dlp >/dev/null 2>&1; then
  CURRENT="$(yt-dlp --version 2>/dev/null || true)"
fi

if [ "$CURRENT" != "$YTDLP_VERSION" ]; then
  echo "installing yt-dlp $YTDLP_VERSION"
  curl -fsSL --retry 5 --retry-connrefused -o /tmp/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/download/$YTDLP_VERSION/yt-dlp_linux"
  chmod +x /tmp/yt-dlp
  $SUDO mv /tmp/yt-dlp /usr/local/bin/yt-dlp
fi

ffmpeg -version 2>/dev/null | head -n 1
yt-dlp --version
`;

/**
 * Serializes one job into shell variable assignments sourced by start.sh.
 * Values are single-quote escaped so titles and URLs cannot break out.
 */
export function buildCurrentEnv(job: Job, appBaseUrl: string): string {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const lines = [
    `JOB_ID=${quote(job.id)}`,
    `VIDEO_URL=${quote(job.url)}`,
    `APP_BASE_URL=${quote(appBaseUrl)}`,
    `WORKER_SECRET=${quote(config.workerSecret)}`,
    `FORMAT=${quote(job.format)}`,
    `QUALITY=${quote(job.quality)}`,
    `MAX_DURATION_MINUTES=${quote(String(config.maxDurationMinutes))}`,
    `YTDLP_VERSION=${quote(config.ytdlpVersion)}`,
    `JOB_DIR=${quote(SANDBOX_JOB_DIR)}`,
    "",
  ];
  return lines.join("\n");
}

/**
 * Acquires the single-worker lock and runs one job. Non-blocking: a second
 * dispatch exits immediately instead of queuing a duplicate run.
 */
export const START_SH = String.raw`#!/usr/bin/env bash
# Single-worker entrypoint. Written by the Grabbit app.
set -uo pipefail

SCRIPT_DIR=/vercel/sandbox/grabbit
set -a
# shellcheck source=/dev/null
source "$SCRIPT_DIR/current.env"
set +a
export JOB_DIR
export SCRIPT_DIR

flock -n /vercel/sandbox/worker.lock bash -c 'bash /vercel/sandbox/grabbit/bootstrap.sh && bash /vercel/sandbox/grabbit/run-job.sh'
exit $?
`;

/**
 * The conversion pipeline. Probes metadata, downloads with format
 * preferences that avoid re-encoding, converts MP3 with ffmpeg through
 * yt-dlp, then uploads the result with a presigned URL so no Blob
 * credentials ever enter the sandbox.
 */
export const RUN_JOB_SH = String.raw`#!/usr/bin/env bash
# Runs one conversion job inside the Vercel Sandbox. Written by the Grabbit app.
set -uo pipefail

SCRIPT_DIR=/vercel/sandbox/grabbit
JOB_DIR="$JOB_DIR"
if [ -z "$JOB_DIR" ]; then JOB_DIR=/vercel/sandbox/current-job; fi
LOG="$JOB_DIR/run.log"
ERROR_LOG="$JOB_DIR/error.log"
mkdir -p "$JOB_DIR/downloads"

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >>"$LOG"; }
die() {
  log "FATAL: $1"
  node "$SCRIPT_DIR/report.mjs" fail "$1" >>"$LOG" 2>&1
  exit 3
}

run_ytdlp() {
  yt-dlp \
    --no-playlist \
    --newline \
    --no-warnings \
    --retries 10 \
    --fragment-retries 10 \
    --file-access-retries 3 \
    --socket-timeout 30 \
    --concurrent-fragments 4 \
    --continue \
    --paths "$JOB_DIR/downloads" \
    --output "%(title).100B [%(id)s].%(ext)s" \
    --progress-template "download:PROGRESS %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s" \
    --print-to-file "after_move:filepath" "$JOB_DIR/filepath.txt" \
    "$@"
}

# Parse yt-dlp output while it runs, reporting progress at most every 4 seconds.
run_and_parse() {
  LAST_REPORT=0
  : >"$ERROR_LOG"
  set -o pipefail
  "$@" 2>&1 | tee -a "$LOG" | while IFS= read -r line; do
    case "$line" in
      PROGRESS\ *)
        pct="$(printf '%s' "$line" | cut -d'|' -f1 | sed 's/^PROGRESS //; s/[ %]//g')"
        speed="$(printf '%s' "$line" | cut -d'|' -f2)"
        eta="$(printf '%s' "$line" | cut -d'|' -f3)"
        now="$(date +%s)"
        if [ "$((now - LAST_REPORT))" -ge 4 ] || [ "$pct" = "100" ] || [ "$pct" = "100.0" ]; then
          LAST_REPORT="$now"
          if [ -z "$pct" ]; then pct=0; fi
          node "$SCRIPT_DIR/report.mjs" status downloading "$pct" "$speed" "$eta" >>"$LOG" 2>&1
        fi
        ;;
      *"[Merger]"*|*"[ExtractAudio]"*|*"[VideoRemuxer]"*|*"[FixupM3u8]"*)
        node "$SCRIPT_DIR/report.mjs" status processing 93 >>"$LOG" 2>&1
        ;;
      *"ERROR:"*)
        printf '%s\n' "$line" >>"$ERROR_LOG"
        ;;
    esac
  done
  return "$?"
}

# A previous session may have finished the upload before the app recorded it.
if node "$SCRIPT_DIR/report.mjs" resume >>"$LOG" 2>&1; then
  log "previous run already completed; re-reported"
  exit 0
fi

log "starting job id=$JOB_ID format=$FORMAT quality=$QUALITY"
node "$SCRIPT_DIR/report.mjs" status downloading 0 >>"$LOG" 2>&1

# 1. Probe first: live or over-long videos fail fast, and the UI gets a title.
if ! yt-dlp --no-playlist --skip-download --no-warnings --socket-timeout 30 --dump-single-json "$VIDEO_URL" >"$JOB_DIR/probe.json" 2>>"$LOG"; then
  ERR="$(grep -E 'ERROR:' "$LOG" | tail -n 1 | sed 's/^.*ERROR: //' | cut -c1-300)"
  die "$ERR"
fi

if ! node "$SCRIPT_DIR/report.mjs" meta >>"$LOG" 2>&1; then
  # meta already recorded a friendly failure (live stream or too long)
  exit 0
fi

# 2. Download and convert. MP4 prefers mp4/m4a streams and only merges or
#    remuxes. MP3 extracts the best audio track and encodes it.
if [ "$FORMAT" = "mp3" ]; then
  log "downloading and extracting mp3 at $QUALITY kbps"
  run_and_parse run_ytdlp --format "ba/b" --extract-audio --audio-format mp3 --audio-quality "$QUALITY"K --embed-metadata "$VIDEO_URL"
  RC=$?
else
  case "$QUALITY" in
    best) SELECTOR="bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b" ;;
    *) SELECTOR="bv*[height<=$QUALITY][ext=mp4]+ba[ext=m4a]/b[height<=$QUALITY][ext=mp4]/bv*[height<=$QUALITY]+ba/b[height<=$QUALITY]/b[height<=$QUALITY]" ;;
  esac
  log "downloading mp4 with selector $SELECTOR"
  run_and_parse run_ytdlp --format "$SELECTOR" --merge-output-format mp4 --remux-video mp4 "$VIDEO_URL"
  RC=$?
fi

if [ "$RC" -ne 0 ]; then
  ERR="$(cat "$ERROR_LOG" 2>/dev/null | tail -n 1 | sed 's/^.*ERROR: //' | cut -c1-300)"
  die "$ERR"
fi

FINAL_FILE="$(tail -n 1 "$JOB_DIR/filepath.txt" 2>/dev/null)"
if [ -z "$FINAL_FILE" ] || [ ! -f "$FINAL_FILE" ]; then
  FINAL_FILE="$(find "$JOB_DIR/downloads" -type f \( -name '*.mp4' -o -name '*.mp3' \) -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n 1 | cut -d' ' -f2-)"
fi
if [ -z "$FINAL_FILE" ] || [ ! -f "$FINAL_FILE" ]; then
  die "The converted file could not be located."
fi

SIZE="$(stat -c%s "$FINAL_FILE")"
log "download finished: $FINAL_FILE ($SIZE bytes)"

# 3. Upload with a short-lived presigned URL. The sandbox holds no Blob token.
node "$SCRIPT_DIR/report.mjs" status uploading 96 >>"$LOG" 2>&1
UPLOAD_JSON="$(node "$SCRIPT_DIR/report.mjs" upload-url "$SIZE" 2>>"$LOG")"
if [ -z "$UPLOAD_JSON" ]; then
  die "Could not get an upload link."
fi

PRESIGNED_URL="$(node -e 'const r=JSON.parse(process.argv[1]);process.stdout.write(r.presignedUrl)' "$UPLOAD_JSON" 2>>"$LOG")"
PATHNAME="$(node -e 'const r=JSON.parse(process.argv[1]);process.stdout.write(r.pathname)' "$UPLOAD_JSON" 2>>"$LOG")"
CONTENT_TYPE="$(node -e 'const r=JSON.parse(process.argv[1]);process.stdout.write(r.contentType)' "$UPLOAD_JSON" 2>>"$LOG")"
if [ -z "$PRESIGNED_URL" ] || [ -z "$PATHNAME" ] || [ -z "$CONTENT_TYPE" ]; then
  die "The upload link was invalid."
fi

if ! curl -fsS --retry 5 --retry-delay 5 --retry-connrefused -H "content-type: $CONTENT_TYPE" -T "$FINAL_FILE" "$PRESIGNED_URL" >>"$LOG" 2>&1; then
  die "Uploading the finished file failed."
fi

node "$SCRIPT_DIR/report.mjs" done "$PATHNAME" "$SIZE" >>"$LOG" 2>&1
log "job complete"
rm -rf "$JOB_DIR/downloads" 2>/dev/null || true
exit 0
`;

/**
 * Small Node helper the shell script uses to write status.json atomically
 * and to POST the same update to the app. Kept free of template literals
 * and object spread so it can live in a raw string safely.
 */
export const REPORT_MJS = String.raw`import fs from "node:fs";
import path from "node:path";

const jobDir = process.env.JOB_DIR || "/vercel/sandbox/current-job";
const statusPath = path.join(jobDir, "status.json");
const base = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
const jobId = process.env.JOB_ID || "";
const secret = process.env.WORKER_SECRET || "";

function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(statusPath, "utf8"));
  } catch {
    return {};
  }
}

function writeStatus(patch) {
  const next = Object.assign({}, readStatus(), patch, {
    jobId: jobId,
    updatedAt: Date.now(),
  });
  const tmp = statusPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(next));
  fs.renameSync(tmp, statusPath);
}

async function post(body) {
  if (!base || !jobId) return;
  try {
    const res = await fetch(base + "/api/worker/report", {
      method: "POST",
      headers: { "content-type": "application/json", "x-worker-secret": secret },
      body: JSON.stringify(Object.assign({ jobId: jobId }, body)),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("report failed " + res.status + ": " + text);
    }
  } catch (error) {
    console.error("report failed: " + (error && error.message ? error.message : String(error)));
  }
}

async function requestUploadUrl(sizeBytes) {
  const res = await fetch(base + "/api/worker/upload-url", {
    method: "POST",
    headers: { "content-type": "application/json", "x-worker-secret": secret },
    body: JSON.stringify({ jobId: jobId, sizeBytes: sizeBytes }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error("upload-url responded " + res.status + ": " + text);
  }
  return res.json();
}

const args = process.argv.slice(2);
const action = args[0] || "";

if (action === "resume") {
  const status = readStatus();
  if (status.stage === "completed" && status.outputPathname) {
    await post({
      stage: "completed",
      outputPathname: status.outputPathname,
      sizeBytes: status.sizeBytes,
    });
    process.exit(0);
  }
  process.exit(1);
} else if (action === "status" || action === "progress") {
  const stage = args[1] || "downloading";
  const percent = Number.parseFloat(args[2] || "");
  const speed = args[3];
  const eta = args[4];
  const patch = { stage: stage };
  if (Number.isFinite(percent)) patch.percent = percent;
  if (speed && speed !== "N/A" && speed !== "Unknown") patch.speed = speed;
  if (eta && eta !== "N/A" && eta !== "Unknown") patch.eta = eta;
  writeStatus(patch);
  await post(patch);
  process.exit(0);
} else if (action === "meta") {
  let probe;
  try {
    probe = JSON.parse(fs.readFileSync(path.join(jobDir, "probe.json"), "utf8"));
  } catch {
    await post({ stage: "failed", error: "Could not read video metadata." });
    process.exit(4);
  }
  if (
    probe.is_live === true ||
    probe.live_status === "is_live" ||
    probe.live_status === "is_upcoming"
  ) {
    const error = "Live streams are not supported.";
    writeStatus({ stage: "failed", error: error });
    await post({ stage: "failed", error: error });
    process.exit(2);
  }
  const durationSec = Math.round(Number(probe.duration) || 0);
  const maxMinutes = Number(process.env.MAX_DURATION_MINUTES || "0");
  if (maxMinutes > 0 && durationSec > maxMinutes * 60) {
    const error =
      "This video is about " +
      Math.round(durationSec / 60) +
      " minutes long, past the " +
      maxMinutes +
      "-minute limit.";
    writeStatus({ stage: "failed", error: error });
    await post({ stage: "failed", error: error });
    process.exit(3);
  }
  const title = typeof probe.title === "string" ? probe.title : undefined;
  writeStatus({ stage: "downloading", percent: 0, title: title, durationSec: durationSec });
  await post({ stage: "downloading", title: title, durationSec: durationSec });
  process.exit(0);
} else if (action === "upload-url") {
  const sizeBytes = Number(args[1] || "0") || 0;
  try {
    const data = await requestUploadUrl(sizeBytes);
    process.stdout.write(JSON.stringify(data));
    process.exit(0);
  } catch (error) {
    console.error(error && error.message ? error.message : String(error));
    process.exit(1);
  }
} else if (action === "done") {
  const outputPathname = args[1] || "";
  const sizeBytes = Number(args[2] || "0") || 0;
  writeStatus({
    stage: "completed",
    percent: 100,
    outputPathname: outputPathname,
    sizeBytes: sizeBytes,
  });
  await post({
    stage: "completed",
    outputPathname: outputPathname,
    sizeBytes: sizeBytes,
  });
  process.exit(0);
} else if (action === "fail") {
  const error = (args.slice(1).join(" ") || "The conversion failed.").slice(0, 600);
  writeStatus({ stage: "failed", error: error });
  await post({ stage: "failed", error: error });
  process.exit(0);
} else {
  console.error("unknown action: " + action);
  process.exit(1);
}
`;
