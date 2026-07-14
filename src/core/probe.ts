import { runBinary, type Runner } from "./binaries.js";
import type { MediaInfo } from "./types.js";

/**
 * ffprobe wrapper. The binary call is isolated in `probe`; the parsing logic
 * (`parseProbeJson`) is pure and unit tested.
 */

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
}

interface FfprobeFormat {
  duration?: string;
}

interface FfprobeJson {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

function parseFrameRate(raw?: string): number | undefined {
  if (!raw) return undefined;
  const [num, den] = raw.split("/");
  const n = Number(num);
  const d = den === undefined ? 1 : Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return undefined;
  const fps = n / d;
  return fps > 0 ? fps : undefined;
}

/** Pure: turn ffprobe -print_format json output into MediaInfo. */
export function parseProbeJson(json: string): MediaInfo {
  const data = JSON.parse(json) as FfprobeJson;
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");

  let duration = Number(data.format?.duration);
  if (!Number.isFinite(duration)) {
    // fall back to the max stream duration
    duration = streams
      .map((s) => Number(s.duration))
      .filter((n) => Number.isFinite(n))
      .reduce((a, b) => Math.max(a, b), 0);
  }

  const info: MediaInfo = {
    duration: Number.isFinite(duration) ? duration : 0,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
  };
  if (video) {
    if (typeof video.width === "number") info.width = video.width;
    if (typeof video.height === "number") info.height = video.height;
    const fps = parseFrameRate(video.avg_frame_rate ?? video.r_frame_rate);
    if (fps !== undefined) info.fps = fps;
    if (video.codec_name) info.videoCodec = video.codec_name;
  }
  if (audio && audio.codec_name) info.audioCodec = audio.codec_name;
  return info;
}

export async function probe(
  input: string,
  runner: Runner = runBinary,
): Promise<MediaInfo> {
  const { stdout, stderr, exitCode } = await runner("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    input,
  ]);
  if (exitCode !== 0) {
    throw new Error(`ffprobe failed for ${input}: ${stderr.trim() || "unknown error"}`);
  }
  return parseProbeJson(stdout);
}
