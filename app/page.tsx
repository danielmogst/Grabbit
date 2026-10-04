import { Converter } from "@/components/converter";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-2xl flex-col px-4 py-10 sm:px-6 sm:py-14">
      <header className="flex flex-col gap-3">
        <p className="font-mono text-xs tracking-widest text-emerald-700 uppercase dark:text-emerald-400">
          Grabbit
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          YouTube to MP4 or MP3
        </h1>
        <p className="max-w-[52ch] text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
          Paste a link, pick a format and quality, then leave it. Long videos
          are fine. Files are removed automatically after a day.
        </p>
      </header>

      <div className="mt-8">
        <Converter requiresAccessCode={config.accessCode.length > 0} />
      </div>

      <footer className="mt-auto pt-10 text-center text-xs leading-relaxed text-zinc-500 dark:text-zinc-500">
        You can close this tab while a conversion runs. Jobs continue in the
        background.
      </footer>
    </main>
  );
}
