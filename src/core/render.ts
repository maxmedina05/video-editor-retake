import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBinary, type Runner } from "./binaries.js";
import type { KeepSegment } from "./types.js";

/**
 * Single-pass, frame-accurate render from a keep-list using per-segment
 * trim/atrim + concat (one re-encode, no chained passes). The graph/arg
 * builders are pure and unit tested; only `render` touches the binary.
 *
 * We deliberately do NOT use select/aselect with a summed between() expression:
 * ffmpeg's expression parser recurses per `+` term and fails with
 * "Cannot allocate memory" once a real cut plan reaches ~100 spans. A
 * trim-per-segment graph has no expression nesting and scales linearly, and
 * the graph is passed via -filter_complex_script to stay clear of argv limits.
 */

function fmt(n: number): string {
  return n.toFixed(3);
}

/**
 * Escape a path for use as an UNQUOTED value in ffmpeg's subtitles filter.
 * Wrapping in single quotes is a parse error inside -filter_complex, so we
 * backslash-escape every char with meaning to the filtergraph parser and the
 * filter's option parser instead.
 */
export function escapeSubtitlesPath(p: string): string {
  return p
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

export interface RenderPlan {
  input: string;
  output: string;
  keep: KeepSegment[];
  /** optional denoised wav to use as the audio source (added as input #1) */
  audioInput?: string;
  /** optional SRT path to burn into the video (must be on the OUTPUT timeline) */
  burnSubtitles?: string;
  /**
   * optional SRT path to MUX as a soft, toggleable mov_text subtitle stream
   * (must be on the OUTPUT timeline). Works with any ffmpeg build — no libass
   * needed. Added as an extra input, no second encode pass.
   */
  embedCaptions?: string;
  hasVideo?: boolean;
  hasAudio?: boolean;
  crf?: number;
  preset?: string;
}

/** Build the ffmpeg filtergraph: one trim/atrim chain per keep-segment, then concat. Pure. */
export function buildFilterComplex(plan: RenderPlan): string {
  const hasVideo = plan.hasVideo ?? true;
  const hasAudio = plan.hasAudio ?? true;
  if (plan.keep.length === 0) throw new Error("cannot render from an empty keep-list");
  if (!hasVideo && !hasAudio) throw new Error("nothing to render: no video and no audio");

  const asrc = plan.audioInput ? "[1:a]" : "[0:a]";
  const parts: string[] = [];
  const concatIn: string[] = [];

  plan.keep.forEach((k, i) => {
    if (hasVideo) {
      parts.push(`[0:v]trim=start=${fmt(k.start)}:end=${fmt(k.end)},setpts=PTS-STARTPTS[v${i}]`);
      concatIn.push(`[v${i}]`);
    }
    if (hasAudio) {
      parts.push(`${asrc}atrim=start=${fmt(k.start)}:end=${fmt(k.end)},asetpts=PTS-STARTPTS[a${i}]`);
      concatIn.push(`[a${i}]`);
    }
  });

  const outLabels = `${hasVideo ? "[vcat]" : ""}${hasAudio ? "[acat]" : ""}`;
  parts.push(
    `${concatIn.join("")}concat=n=${plan.keep.length}:v=${hasVideo ? 1 : 0}:a=${hasAudio ? 1 : 0}${outLabels}`,
  );

  if (hasVideo && plan.burnSubtitles) {
    parts.push(`[vcat]subtitles=${escapeSubtitlesPath(plan.burnSubtitles)}[vout]`);
  }
  return parts.join(";");
}

/**
 * Build the full ffmpeg argv. Pure. The filtergraph itself is referenced via
 * -filter_complex_script (a real cut plan produces a graph far too large for
 * a comfortable command line).
 */
export function buildRenderArgs(plan: RenderPlan, filterScriptPath: string): string[] {
  const hasVideo = plan.hasVideo ?? true;
  const hasAudio = plan.hasAudio ?? true;
  const args = ["-hide_banner", "-nostats", "-y", "-i", plan.input];
  if (plan.audioInput) args.push("-i", plan.audioInput);
  // The soft-subtitle SRT is muxed straight through (already on the output
  // timeline), so it goes in as the LAST input to keep [0:...]/[1:a] filtergraph
  // stream indices stable. Its input index is derived accordingly.
  const embedInputIndex = plan.embedCaptions ? 1 + (plan.audioInput ? 1 : 0) : -1;
  if (plan.embedCaptions) args.push("-i", plan.embedCaptions);

  args.push("-filter_complex_script", filterScriptPath);

  if (hasVideo) {
    args.push("-map", plan.burnSubtitles ? "[vout]" : "[vcat]");
  }
  if (hasAudio) {
    args.push("-map", "[acat]");
  }
  if (plan.embedCaptions) {
    args.push("-map", `${embedInputIndex}:s:0`);
  }

  if (hasVideo) {
    args.push("-c:v", "libx264", "-preset", plan.preset ?? "medium", "-crf", String(plan.crf ?? 20));
  }
  if (hasAudio) {
    args.push("-c:a", "aac", "-b:a", "192k");
  }
  if (plan.embedCaptions) {
    // mov_text is the mp4-native subtitle codec; und language + default
    // disposition so players surface a toggleable caption track.
    args.push(
      "-c:s",
      "mov_text",
      "-metadata:s:s:0",
      "language=und",
      "-disposition:s:0",
      "default",
    );
  }
  args.push("-movflags", "+faststart", plan.output);
  return args;
}

/**
 * Whether this ffmpeg build exposes a given filter (e.g. "subtitles", which
 * requires libass). Used to fail fast on `--burn` with a helpful message.
 */
export async function hasFfmpegFilter(name: string, runner: Runner = runBinary): Promise<boolean> {
  const { stdout } = await runner("ffmpeg", ["-hide_banner", "-filters"]);
  const re = new RegExp(`^\\s*\\S+\\s+${name}\\s`, "m");
  return re.test(stdout);
}

export async function render(plan: RenderPlan, runner: Runner = runBinary): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), "clean-video-render-"));
  const scriptPath = join(workDir, "filtergraph.txt");
  try {
    await writeFile(scriptPath, buildFilterComplex(plan), "utf8");
    const args = buildRenderArgs(plan, scriptPath);
    const { stderr, exitCode } = await runner("ffmpeg", args);
    if (exitCode !== 0) {
      throw new Error(`ffmpeg render failed: ${stderr.trim() || "unknown error"}`);
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
