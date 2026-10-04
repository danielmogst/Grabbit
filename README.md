# Grabbit

Single-page YouTube to MP4/MP3 converter. Jobs run in a persistent Vercel
Sandbox worker, upload to Vercel Blob, and clean up after themselves.

Built with Next.js 16, TypeScript, Tailwind CSS 4, `@vercel/sandbox`,
`@vercel/blob`, `yt-dlp`, and `ffmpeg`.

## How it works

- `POST /api/jobs` validates the link, stores a job record in Blob, and
  returns. The browser polls `GET /api/jobs/:id` for state.
- A single persistent sandbox (`grabbit-worker`) processes one job at a time,
  serialized with `flock`. Processing runs as a detached command, so no HTTP
  request stays open.
- The worker installs pinned `yt-dlp` and `ffmpeg`, probes metadata, downloads,
  converts, and uploads with a single-use presigned URL. Blob credentials never
  enter the sandbox.
- If a session ends mid-job (45 min on Hobby, 24 h on Pro), the scheduler
  resumes the snapshot and continues with `yt-dlp --continue`. Transient
  failures retry up to `MAX_ATTEMPTS`.
- Finished files and job records expire after `OUTPUT_TTL_HOURS`; the idle
  sandbox and orphaned blobs are removed automatically.

MP4 merges/remuxes compatible streams without re-encoding. MP3 extracts audio
with ffmpeg at the selected bitrate.

## Requirements

- Node.js 20.9+ and npm
- Vercel account and project
- Vercel Blob store connected to the project

Pro plan is recommended for unattended multi-hour jobs (see
[Plan limits](#plan-limits-and-cron)).

## Setup

1. **Install**

   ```bash
   npm install
   ```

2. **Create a Blob store.** In the Vercel dashboard open the project, go to
   Storage, create a Blob store, and connect it. Choose **Public** access so
   finished files can be served directly with `?download=1`. For a Private
   store, set `BLOB_ACCESS=private`; downloads then use short-lived signed URLs.

3. **Configure environment.** Copy `.env.example` to `.env.local`. Generate
   the one required secret:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   Set it as `WORKER_CALLBACK_SECRET` locally and in the Vercel project for
   Production, Preview, and Development. Blob variables are injected by Vercel.

4. **Link the project.** Vercel Sandbox authenticates with OIDC. Install the
   CLI if needed, sign in, then link:

   ```bash
   npm i -g vercel    # or prefix the following with npx
   vercel login
   vercel link
   vercel env pull .env.local
   ```

5. **Run locally to test**

   ```bash
   npm run dev
   ```

   The sandbox runs in the cloud and cannot reach `localhost`. For a full
   end-to-end conversion locally, expose the dev server through a tunnel
   (ngrok, cloudflared, or similar) and point the app at it:

   ```bash
   APP_BASE_URL=https://your-tunnel.example.com npm run dev
   ```

   Without a tunnel, progress is still visible while the page is open (the
   status endpoint reads it from the sandbox), but the job cannot finish: the
   final upload handshake needs an app URL the sandbox can reach.

6. **Deploy**

   ```bash
   vercel          # preview
   vercel --prod   # production
   ```

   Or connect the repository to the Vercel project and push.

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `WORKER_CALLBACK_SECRET` | Yes | none | Authenticates sandbox callbacks to `/api/worker/*`. |
| `BLOB_READ_WRITE_TOKEN` or `BLOB_STORE_ID` + `VERCEL_OIDC_TOKEN` | Yes | injected | Blob access for jobs and outputs. |
| `APP_BASE_URL` | No | Vercel production domain | Callback base URL. Set for tunnels or custom domains. |
| `BLOB_ACCESS` | No | `public` | `public` or `private` Blob store access. |
| `CRON_SECRET` | No | none | Protects `/api/cron/reconcile`. |
| `APP_ACCESS_CODE` | No | none | When set, the form asks for this shared code before creating a job. |
| `MAX_PENDING_JOBS` | No | `2` | Maximum jobs in flight (running plus waiting). Extra submissions get a busy response. |
| `SANDBOX_NAME` | No | `grabbit-worker` | Worker sandbox name. |
| `SANDBOX_TIMEOUT_MINUTES` | No | `1440` | Session timeout; falls back to 45 if the plan rejects it. |
| `YTDLP_VERSION` | No | pinned release | `yt-dlp` version installed in the sandbox. |
| `OUTPUT_TTL_HOURS` | No | `24` | Retention for finished files and job records. |
| `MAX_DURATION_MINUTES` | No | `720` | Reject videos longer than this (`0` disables). |
| `MAX_ATTEMPTS` | No | `3` | Attempts per job. |
| `MAX_OUTPUT_GB` | No | `40` | Maximum output size. |
| `STALL_MINUTES` | No | `10` | No progress for this long restarts the job. |
| `SYNC_MIN_INTERVAL_SECONDS` | No | `4` | Minimum gap between status reads while polling. |
| `SANDBOX_IDLE_DELETE_HOURS` | No | `24` | Delete the stopped sandbox after this much idle time. |
| `SNAPSHOT_TTL_DAYS` | No | `7` | Snapshot retention. |

## Plan limits and cron

`vercel.json` ships with a daily reconcile pass, valid on all plans:

```json
{ "crons": [{ "path": "/api/cron/reconcile", "schedule": "0 4 * * *" }] }
```

On **Hobby**, cron jobs may only run once per day and sandbox sessions cap at
45 minutes. Jobs start immediately and run unattended while they fit in one
session; an open tab also resumes interrupted sessions.

On **Pro**, use a per-minute schedule for unattended recovery of long jobs:

```json
{ "crons": [{ "path": "/api/cron/reconcile", "schedule": "* * * * *" }] }
```

Any external scheduler can call `/api/cron/reconcile` with
`Authorization: Bearer $CRON_SECRET` instead.

## API

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/jobs` | POST | Validate URL, create a queued job. |
| `/api/jobs/:id` | GET | Job state; syncs from the sandbox when stale. |
| `/api/jobs/:id/cancel` | POST | Kill the command and cancel the job. |
| `/api/jobs/:id/download` | GET | Redirect to the download URL. |
| `/api/worker/report` | POST | Worker progress updates (secret-protected). |
| `/api/worker/upload-url` | POST | Presigned upload URL (secret-protected). |
| `/api/cron/reconcile` | GET | Reconcile, dispatch, clean up. |

## Limitations

- Single videos only; playlists, channels, and live streams are rejected.
- Age-restricted and members-only videos fail without a signed-in session.
- One conversion runs at a time, by design, with a small pending cap.
- No accounts. Set `APP_ACCESS_CODE` before sharing the URL so only people you give the code to can submit jobs.

## Scripts

```bash
npm run dev        # local development
npm run build      # production build
npm run typecheck  # tsc --noEmit
```
