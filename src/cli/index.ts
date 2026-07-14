#!/usr/bin/env node
import { basename, extname, join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { Command } from "commander";
import { formatMissing, hasBinary, REQUIREMENTS } from "../core/binaries.js";
import { analyze, cleanup, finalize } from "../core/pipeline.js";
import { removeCutsByIndex } from "../core/cutlist.js";
import { hasFfmpegFilter } from "../core/render.js";
import { startServer } from "../web/server.js";
import { modeDefaults, MODES_LIST, type Mode } from "../core/modes.js";
import type { DenoiseMethod } from "../core/denoise.js";
import type { CutPlan } from "../core/types.js";

/** Open a URL in the default browser (macOS `open` / Linux `xdg-open`). */
function openBrowser(url: string): void {
  const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? "cmd" : "xdg-open";
  const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

async function runUi(argv: string[]): Promise<void> {
  const program = new Command();
  program
    .name("clean-video ui")
    .description("Start the local web editor. Runs persistently; open videos from the browser.")
    .argument("[input]", "optional video to open straight into the editor")
    .option("--port <n>", "port to bind (default: random free port)")
    .option("--host <addr>", "address to bind (default: 127.0.0.1; use 0.0.0.0 in containers)")
    .option(
      "--media-root <dir>",
      "enable the in-app directory browser rooted at <dir> (for no-dialog environments)",
    )
    .option("--no-open", "do not auto-open the browser")
    .parse(argv, { from: "user" });

  const opts = program.opts();
  const input = program.args[0] ? resolve(program.args[0]) : undefined;
  // Flags win over env; env lets the Docker image default host to 0.0.0.0.
  const host = opts.host ?? process.env.HOST ?? undefined;
  const mediaRoot = opts.mediaRoot ?? process.env.MEDIA_ROOT ?? undefined;
  const port = opts.port ?? process.env.PORT ?? undefined;

  await preflight(false, false);

  const server = await startServer({
    ...(port ? { port: Number(port) } : {}),
    ...(host ? { host } : {}),
    ...(mediaRoot ? { mediaRoot: resolve(mediaRoot) } : {}),
    ...(input ? { initialInput: input } : {}),
  });
  console.log(`\nclean-video editor running at ${server.url}`);
  console.log(input ? `Opening: ${input}` : "Open a video from the browser home screen.");
  console.log("Press Ctrl+C to stop.\n");
  if (opts.open !== false) openBrowser(server.url);

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function clock(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = (s % 60).toFixed(1).padStart(4, "0");
  return `${m}:${rest}`;
}

function truncate(text: string, max = 60): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Single cut longer than this gets a ⚠ so the user eyeballs it. */
const BIG_CUT_SEC = 10;

function printPlan(plan: CutPlan): void {
  console.log("\nProposed cuts:");
  if (plan.cuts.length === 0) {
    console.log("  (none — nothing to trim)");
  }
  let bigCuts = 0;
  plan.cuts.forEach((cut, i) => {
    const len = cut.end - cut.start;
    const dur = len.toFixed(1);
    const big = len > BIG_CUT_SEC;
    if (big) bigCuts++;
    const flag = big ? "⚠ " : "  ";
    const reason =
      cut.reason === "silence" && cut.activity === "active" ? "silence (active video)" : cut.reason;
    const label = `${flag}[${String(i + 1).padStart(2)}] ${clock(cut.start)}–${clock(cut.end)}  (-${dur}s)  ${reason}`;
    console.log(label);
    if (cut.snippet) console.log(`         "${truncate(cut.snippet)}"`);
  });
  if (bigCuts > 0) {
    console.log(`\n⚠ ${bigCuts} cut(s) longer than ${BIG_CUT_SEC}s — review before approving.`);
  }
  console.log(
    `\nSource ${clock(plan.sourceDuration)}  ->  output ${clock(plan.outputDuration)}  ` +
      `(removing ${plan.removedDuration.toFixed(1)}s across ${plan.cuts.length} cut(s))`,
  );
  const s = plan.stats;
  console.log(
    `  ${s.silenceShortenedSeconds.toFixed(1)}s from shortening silence · ` +
      `${s.deletedSeconds.toFixed(1)}s deleted (fillers/false-starts/rambles/manual)`,
  );
  if (s.silenceGaps) {
    const g = s.silenceGaps;
    const parts = [`${g.shortened} shortened`, `${g.untouched} left as-is`];
    if (g.activeExempt > 0) parts.push(`${g.activeExempt} exempt (active video)`);
    console.log(`  silences: ${g.total} detected — ${parts.join(", ")}`);
  }
}

async function preflight(smart: boolean, burn: boolean): Promise<void> {
  const missing: string[] = [];
  for (const key of ["ffmpeg", "ffprobe", "whisper-cli"]) {
    const req = REQUIREMENTS[key]!;
    if (!(await hasBinary(req.name))) missing.push(formatMissing(req));
  }
  if (missing.length > 0) {
    console.error("clean-video: missing required tools:\n" + missing.join("\n"));
    process.exit(1);
  }
  if (burn && !(await hasFfmpegFilter("subtitles"))) {
    console.error(
      "clean-video: --burn needs an ffmpeg built with libass (the 'subtitles' filter),\n" +
        "which this ffmpeg lacks. Re-run without --burn — SRT/VTT sidecar files are written\n" +
        "by default — or install an ffmpeg with libass support.",
    );
    process.exit(1);
  }
  if (!(await hasBinary("deep-filter"))) {
    console.error("note: deep-filter not found — will denoise with ffmpeg afftdn.");
  }
  if (smart && !(await hasBinary("claude"))) {
    console.error("note: --smart requested but `claude` not found — heuristic filler detection only.");
  }
}

async function askApproval(
  initial: CutPlan,
  duration: number,
  minKeep: number,
): Promise<CutPlan | null> {
  const rl = createInterface({ input: stdin, output: stdout });
  let plan = initial;
  try {
    for (;;) {
      const answer = (await rl.question("\nRender with these cuts? [y]es / [n]o / [e]dit: "))
        .trim()
        .toLowerCase();
      if (answer === "y" || answer === "yes") return plan;
      if (answer === "n" || answer === "no") return null;
      if (answer === "e" || answer === "edit") {
        const raw = await rl.question(
          "Enter cut numbers to KEEP in the video (exclude from cutting), space/comma separated: ",
        );
        const exclude = raw
          .split(/[\s,]+/)
          .map((t) => Number(t) - 1)
          .filter((n) => Number.isInteger(n) && n >= 0 && n < plan.cuts.length);
        plan = removeCutsByIndex(plan.cuts, exclude, duration, { minKeep });
        printPlan(plan);
      }
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("clean-video")
    .description("Local video cleanup: denoise, cut silence/fillers, auto captions.")
    .argument("<input>", "input video file")
    .option("-o, --out <dir>", "output directory (default: alongside input)")
    .option("--denoise <method>", "denoise method: deep-filter | afftdn | none", "deep-filter")
    .option(
      "--mode <name>",
      `aggressiveness preset: ${MODES_LIST.join(" | ")} (sets defaults; explicit flags win)`,
      "balanced",
    )
    .option("--smart", "use Claude for smarter filler/false-start detection", false)
    .option("--no-fillers", "disable heuristic filler-word removal")
    .option("--model <name>", "whisper model name", "base.en")
    .option("--model-path <path>", "explicit path to a whisper .bin model")
    .option("--language <lang>", "language hint (e.g. en); omit to auto-detect")
    .option("--min-silence <sec>", "min silence duration to cut", "1.2")
    .option("--padding <sec>", "min breathing room kept around speech", "0.15")
    .option("--max-pause <sec>", "natural pause left in place of a silence", "0.75")
    .option(
      "--max-cut-per-silence <sec>",
      "cap seconds removed from any one silence (0 = uncapped)",
      "0",
    )
    .option("--min-keep <sec>", "absorb kept slivers shorter than this (anti-flicker)", "0.4")
    .option("--threshold <db>", "silence threshold in dB", "-30")
    .option("--burn", "burn captions into the video (hard subs; needs ffmpeg libass)", false)
    .option("--embed", "embed captions as a soft, toggleable subtitle track (any ffmpeg)", false)
    .option("--crf <n>", "x264 CRF quality (lower = better)", "20")
    .option("--preset <name>", "x264 preset", "medium")
    .option("-y, --yes", "skip interactive approval", false)
    .option("--no-cache", "ignore the analysis cache and force a fresh analyze")
    .parse();

  const opts = program.opts();
  const inputArg = program.args[0]!;
  const input = resolve(inputArg);

  // Resolve mode defaults; any explicitly-passed flag (source 'cli') wins.
  const mode = (opts.mode ?? "balanced") as Mode;
  if (!MODES_LIST.includes(mode)) {
    console.error(`clean-video: unknown --mode "${opts.mode}" (use ${MODES_LIST.join(" | ")})`);
    process.exit(1);
  }
  const md = modeDefaults(mode);
  const fromCli = (name: string): boolean => program.getOptionValueSource(name) === "cli";
  const minSilence = fromCli("minSilence") ? Number(opts.minSilence) : md.minSilence;
  const maxPause = fromCli("maxPause") ? Number(opts.maxPause) : md.maxPause;
  const maxCutPerSilence = fromCli("maxCutPerSilence")
    ? Number(opts.maxCutPerSilence)
    : md.maxCutPerSilence;
  const smart = fromCli("smart") ? Boolean(opts.smart) : md.smart;
  const fillers = fromCli("fillers") ? Boolean(opts.fillers) : md.fillers;

  await preflight(smart, Boolean(opts.burn));

  const ext = extname(input);
  const name = basename(input, ext);
  const outDir = opts.out ? resolve(opts.out) : resolve(input, "..");
  if (opts.out) await mkdir(outDir, { recursive: true });

  const outputVideo = join(outDir, `${name}.cleaned.mp4`);
  const srtPath = join(outDir, `${name}.cleaned.srt`);
  const vttPath = join(outDir, `${name}.cleaned.vtt`);
  const cutplanPath = join(outDir, `${name}.cutplan.json`);

  console.error(
    `Analyzing [${mode}] (denoise → silence${md.activity.aware ? " → activity" : ""} → ` +
      `transcribe → cut plan)…`,
  );
  const result = await analyze(input, {
    denoise: opts.denoise as DenoiseMethod,
    cache: opts.cache !== false,
    smart,
    fillers,
    activity: md.activity,
    model: opts.model,
    ...(opts.modelPath ? { modelPath: opts.modelPath } : {}),
    ...(opts.language ? { language: opts.language } : {}),
    minSilence,
    padding: Number(opts.padding),
    maxPause,
    maxCutPerSilence,
    minKeep: Number(opts.minKeep),
    thresholdDb: Number(opts.threshold),
  });

  for (const w of result.warnings) console.error(`warning: ${w}`);
  const cachedParts = Object.entries(result.cache)
    .filter(([, hit]) => hit)
    .map(([k]) => k);
  if (cachedParts.length > 0) {
    console.error(`cache: reused ${cachedParts.join(", ")} from a previous analyze.`);
  }
  console.log(
    `\nInput: ${result.info.width ?? "?"}x${result.info.height ?? "?"} ` +
      `${result.info.fps ? result.info.fps.toFixed(2) + "fps " : ""}` +
      `${clock(result.info.duration)}  |  ${result.transcript.words.length} words  |  ` +
      `denoise: ${result.denoise.method}`,
  );
  printPlan(result.plan);

  let approved: CutPlan | null = result.plan;
  if (!opts.yes) {
    approved = await askApproval(result.plan, result.info.duration, Number(opts.minKeep));
    if (!approved) {
      console.error("Aborted — no files written.");
      await cleanup(result.workDir);
      process.exit(0);
    }
  }

  if (approved.keep.length === 0) {
    console.error("Nothing left to render (all content would be cut). Aborting.");
    await cleanup(result.workDir);
    process.exit(1);
  }

  console.error(`\nRendering ${outputVideo}…`);
  try {
    await finalize({
      input,
      plan: approved,
      transcript: result.transcript,
      info: result.info,
      denoise: result.denoise,
      outputVideo,
      srtPath,
      vttPath,
      cutplanPath,
      burn: Boolean(opts.burn),
      embed: Boolean(opts.embed),
      crf: Number(opts.crf),
      preset: opts.preset,
    });
  } finally {
    await cleanup(result.workDir);
  }

  console.log("\nDone:");
  console.log(`  video:   ${outputVideo}`);
  console.log(`  srt:     ${srtPath}`);
  console.log(`  vtt:     ${vttPath}`);
  console.log(`  cutplan: ${cutplanPath}`);
}

const entry = process.argv[2] === "ui" ? runUi(process.argv.slice(3)) : main();
entry.catch((err: unknown) => {
  console.error(`clean-video: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
