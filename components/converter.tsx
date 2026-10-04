"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  CheckCircle,
  Clock,
  CloudArrowUp,
  DownloadSimple,
  FilmSlate,
  MusicNotes,
  Prohibit,
  SpinnerGap,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { formatBytes, formatDuration, statusLabel } from "@/lib/format";
import {
  DEFAULT_QUALITY,
  isTerminal,
  qualitiesFor,
  type ClientJob,
  type JobFormat,
  type JobStatus,
} from "@/lib/types";
import { validateYouTubeUrl } from "@/lib/youtube";

const STORAGE_KEY = "grabbit:last-job-id";
const POLL_INTERVAL_MS = 2500;

function iconTone(status: JobStatus): string {
  switch (status) {
    case "completed":
      return "text-emerald-600 dark:text-emerald-400";
    case "failed":
      return "text-red-600 dark:text-red-400";
    case "canceled":
      return "text-zinc-500 dark:text-zinc-400";
    default:
      return "text-zinc-700 dark:text-zinc-300";
  }
}

function StatusIcon({
  status,
  className = "",
}: {
  status: JobStatus;
  className?: string;
}) {
  const size = 18;
  switch (status) {
    case "queued":
      return <Clock size={size} weight="bold" className={className} />;
    case "downloading":
      return <DownloadSimple size={size} weight="bold" className={className} />;
    case "processing":
      return (
        <SpinnerGap
          size={size}
          weight="bold"
          className={`animate-spin motion-reduce:animate-none ${className}`}
        />
      );
    case "uploading":
      return <CloudArrowUp size={size} weight="bold" className={className} />;
    case "completed":
      return <CheckCircle size={size} weight="fill" className={className} />;
    case "failed":
      return <WarningCircle size={size} weight="fill" className={className} />;
    case "canceled":
      return <Prohibit size={size} weight="bold" className={className} />;
  }
}

function formatQuality(job: ClientJob): string {
  if (job.format === "mp3") return `${job.quality} kbps`;
  return job.quality === "best" ? "Best available" : `${job.quality}p`;
}

function optionClass(selected: boolean, disabled: boolean): string {
  const base =
    "flex h-10 cursor-pointer items-center justify-center gap-2 rounded-lg border px-3 text-sm font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white focus-visible:outline-none dark:focus-visible:ring-offset-zinc-900";
  const state = selected
    ? "border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-800 active:bg-zinc-700 dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white dark:active:bg-zinc-300"
    : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50 active:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:border-zinc-600 dark:hover:bg-zinc-900 dark:active:bg-zinc-800";
  const off = disabled ? "cursor-not-allowed opacity-60" : "";
  return `${base} ${state} ${off}`;
}

function MetaItem({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  if (!value) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[11px] tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
        {label}
      </dt>
      <dd className="font-mono text-xs text-zinc-800 tabular-nums dark:text-zinc-200">
        {value}
      </dd>
    </div>
  );
}

export function Converter() {
  const prefersReduced = useReducedMotion();
  const [url, setUrl] = useState("");
  const [format, setFormat] = useState<JobFormat>("mp4");
  const [mp4Quality, setMp4Quality] = useState(DEFAULT_QUALITY.mp4);
  const [mp3Quality, setMp3Quality] = useState(DEFAULT_QUALITY.mp3);
  const [job, setJob] = useState<ClientJob | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [canceling, setCanceling] = useState(false);

  const quality = format === "mp4" ? mp4Quality : mp3Quality;
  const qualities = qualitiesFor(format);
  const isActive = job !== null && !isTerminal(job.status);
  const formLocked = isActive || submitting;

  function setQuality(value: string) {
    if (format === "mp4") setMp4Quality(value);
    else setMp3Quality(value);
  }

  useEffect(() => {
    let alive = true;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return;
    (async () => {
      try {
        const response = await fetch(`/api/jobs/${stored}`, {
          cache: "no-store",
        });
        if (!alive) return;
        if (response.ok) {
          const data = (await response.json()) as { job: ClientJob };
          setJob(data.job);
        } else if (response.status === 404) {
          window.localStorage.removeItem(STORAGE_KEY);
        }
      } catch {
        // Offline or transient; the form still works.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!job || isTerminal(job.status)) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/jobs/${job.id}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) return;
        const data = (await response.json()) as { job: ClientJob };
        setJob(data.job);
      } catch {
        // The next poll retries.
      }
    }, POLL_INTERVAL_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [job]);

  async function startJob(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitError(null);
    const validation = validateYouTubeUrl(url);
    if (!validation.ok) {
      setFieldError(validation.error);
      return;
    }
    setFieldError(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, format, quality }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        job?: ClientJob;
        error?: string;
      };
      if (!response.ok || !data.job) {
        throw new Error(data.error || "Could not start the conversion.");
      }
      window.localStorage.setItem(STORAGE_KEY, data.job.id);
      setJob(data.job);
    } catch (error) {
      setSubmitError(
        error instanceof Error
          ? error.message
          : "Could not start the conversion.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelJob() {
    if (!job || isTerminal(job.status)) return;
    setCanceling(true);
    try {
      const response = await fetch(`/api/jobs/${job.id}/cancel`, {
        method: "POST",
      });
      if (response.ok) {
        const data = (await response.json()) as { job: ClientJob };
        setJob(data.job);
      }
    } catch {
      // The poll will pick up the real state.
    } finally {
      setCanceling(false);
    }
  }

  function reset() {
    window.localStorage.removeItem(STORAGE_KEY);
    setJob(null);
    setSubmitError(null);
    setFieldError(null);
  }

  const expiresInHours = job?.expiresAt
    ? Math.max(1, Math.round((job.expiresAt - Date.now()) / 3_600_000))
    : null;

  return (
    <div className="flex flex-col gap-5">
      <form
        onSubmit={startJob}
        className="rounded-xl border border-zinc-200 bg-white p-5 shadow-[0_1px_2px_rgb(24_24_27_/_0.04)] sm:p-6 dark:border-zinc-800 dark:bg-zinc-900 dark:shadow-none"
      >
        <div className="flex flex-col gap-2">
          <label htmlFor="video-url" className="text-sm font-medium">
            Video link
          </label>
          <input
            id="video-url"
            name="url"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              if (fieldError) setFieldError(null);
            }}
            disabled={formLocked}
            placeholder="https://www.youtube.com/watch?v=..."
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? "video-url-error" : undefined}
            className="h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 transition outline-none placeholder:text-zinc-500 focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-400 dark:focus:border-emerald-500 dark:focus:ring-emerald-500/20"
          />
          {fieldError ? (
            <p
              id="video-url-error"
              className="text-sm text-red-600 dark:text-red-400"
            >
              {fieldError}
            </p>
          ) : null}
        </div>

        <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2">
          <fieldset disabled={formLocked}>
            <legend className="text-sm font-medium">Format</legend>
            <div
              className="mt-2 grid grid-cols-2 gap-2"
              role="radiogroup"
              aria-label="Output format"
            >
              {(["mp4", "mp3"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={format === value}
                  onClick={() => setFormat(value)}
                  className={optionClass(format === value, formLocked)}
                >
                  {value === "mp4" ? (
                    <FilmSlate size={16} weight="bold" />
                  ) : (
                    <MusicNotes size={16} weight="bold" />
                  )}
                  {value.toUpperCase()}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset disabled={formLocked}>
            <legend className="text-sm font-medium">
              {format === "mp4" ? "Max resolution" : "Bitrate"}
            </legend>
            <div
              className="mt-2 grid grid-cols-2 gap-2"
              role="radiogroup"
              aria-label={
                format === "mp4" ? "Maximum resolution" : "Audio bitrate"
              }
            >
              {qualities.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={quality === option.value}
                  onClick={() => setQuality(option.value)}
                  className={optionClass(quality === option.value, formLocked)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>
        </div>

        <button
          type="submit"
          disabled={formLocked}
          className="mt-5 flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-zinc-900 text-sm font-medium text-white transition-colors hover:bg-zinc-700 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white focus-visible:outline-none active:bg-zinc-600 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300 dark:focus-visible:ring-offset-zinc-900 dark:active:bg-zinc-400"
        >
          {submitting ? (
            <SpinnerGap
              size={18}
              weight="bold"
              className="animate-spin motion-reduce:animate-none"
            />
          ) : format === "mp4" ? (
            <FilmSlate size={18} weight="bold" />
          ) : (
            <MusicNotes size={18} weight="bold" />
          )}
          {format === "mp4" ? "Convert to MP4" : "Convert to MP3"}
        </button>

        {submitError ? (
          <p
            className="mt-3 text-sm text-red-600 dark:text-red-400"
            role="alert"
          >
            {submitError}
          </p>
        ) : null}
      </form>

      <AnimatePresence initial={false}>
        {job ? (
          <motion.section
            key={job.id}
            initial={prefersReduced ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={prefersReduced ? undefined : { opacity: 0, y: -8 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            aria-live="polite"
            className="rounded-xl border border-zinc-200 bg-white p-5 shadow-[0_1px_2px_rgb(24_24_27_/_0.04)] sm:p-6 dark:border-zinc-800 dark:bg-zinc-900 dark:shadow-none"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 items-center gap-2.5">
                <StatusIcon
                  status={job.status}
                  className={iconTone(job.status)}
                />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {statusLabel(job.status)}
                  </p>
                  <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                    {job.title || job.url}
                  </p>
                </div>
              </div>
              <span className="shrink-0 font-mono text-xs text-zinc-500 tabular-nums dark:text-zinc-400">
                {Math.round(job.progress)}%
              </span>
            </div>

            <div
              className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(job.progress)}
              aria-label="Conversion progress"
            >
              <div
                className="h-full rounded-full bg-emerald-600 transition-[width] duration-500 ease-out motion-reduce:transition-none dark:bg-emerald-500"
                style={{ width: `${job.progress}%` }}
              />
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
              <MetaItem
                label={job.format === "mp3" ? "Bitrate" : "Output"}
                value={`${job.format.toUpperCase()}, ${formatQuality(job)}`}
              />
              <MetaItem
                label="Duration"
                value={formatDuration(job.durationSec)}
              />
              <MetaItem
                label="Speed"
                value={job.status === "downloading" ? job.speed : null}
              />
              <MetaItem
                label="Time left"
                value={job.status === "downloading" ? job.eta : null}
              />
              <MetaItem label="Size" value={formatBytes(job.sizeBytes)} />
            </dl>

            {job.error ? (
              <div
                className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
                role="alert"
              >
                <div className="flex items-start gap-2">
                  <WarningCircle
                    size={16}
                    weight="fill"
                    className="mt-0.5 shrink-0"
                  />
                  <p>{job.error}</p>
                </div>
                {job.status === "queued" && job.attempts > 0 ? (
                  <p className="mt-1 pl-6 text-xs opacity-80">
                    Retrying, attempt {job.attempts} of {job.maxAttempts}.
                  </p>
                ) : null}
              </div>
            ) : null}

            {job.status === "completed" && expiresInHours ? (
              <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">
                The file is removed automatically in about{" "}
                {expiresInHours === 1 ? "1 hour" : `${expiresInHours} hours`}.
                Download it before then.
              </p>
            ) : null}

            <div className="mt-5 flex flex-col gap-2 sm:flex-row">
              {job.status === "completed" ? (
                <a
                  href={`/api/jobs/${job.id}/download`}
                  className="flex h-11 flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg bg-emerald-700 text-sm font-medium text-white transition-colors hover:bg-emerald-800 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white focus-visible:outline-none active:bg-emerald-900 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400 dark:focus-visible:ring-offset-zinc-900 dark:active:bg-emerald-300"
                >
                  <DownloadSimple size={18} weight="bold" />
                  Download {job.format.toUpperCase()}
                </a>
              ) : null}

              {!isTerminal(job.status) ? (
                <button
                  type="button"
                  onClick={cancelJob}
                  disabled={canceling}
                  className="flex h-11 cursor-pointer items-center justify-center gap-2 rounded-lg border border-zinc-200 bg-white px-4 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white focus-visible:outline-none active:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900 dark:active:bg-zinc-800 dark:focus-visible:ring-offset-zinc-900"
                >
                  {canceling ? (
                    <SpinnerGap
                      size={16}
                      weight="bold"
                      className="animate-spin motion-reduce:animate-none"
                    />
                  ) : (
                    <X size={16} weight="bold" />
                  )}
                  Cancel
                </button>
              ) : (
                <button
                  type="button"
                  onClick={reset}
                  className="flex h-11 cursor-pointer items-center justify-center gap-2 rounded-lg border border-zinc-200 bg-white px-4 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 focus-visible:ring-offset-white focus-visible:outline-none active:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900 dark:active:bg-zinc-800 dark:focus-visible:ring-offset-zinc-900"
                >
                  Convert another link
                </button>
              )}
            </div>
          </motion.section>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
