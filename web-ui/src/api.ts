import type { Cut, CutPlan } from "./types";

export interface SessionInfo {
  id: string;
  name: string;
  path: string;
  duration: number;
}

export interface RecentView {
  path: string;
  name: string;
  duration: number;
  lastOpened: number;
  exists: boolean;
}

export interface ConfigResponse {
  pickerAvailable: boolean;
  hasSubtitlesFilter: boolean;
  /** true when the server exposes the in-app directory browser (--media-root) */
  mediaRoot: boolean;
  recents: RecentView[];
  initialSession?: SessionInfo;
}

export interface BrowseEntry {
  name: string;
  kind: "dir" | "video";
  rel: string;
  abs: string;
}

export interface BrowseResult {
  dir: string;
  parent: string | null;
  entries: BrowseEntry[];
}

/** List directories + video files under the server's media root. */
export async function browse(dir: string): Promise<BrowseResult> {
  const res = await fetch(`/api/browse?dir=${encodeURIComponent(dir)}`);
  const data = (await res.json()) as BrowseResult & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `browse failed: ${res.status}`);
  return data;
}

export async function fetchConfig(): Promise<ConfigResponse> {
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error(`config failed: ${res.status}`);
  return (await res.json()) as ConfigResponse;
}

export async function fetchRecents(): Promise<RecentView[]> {
  const res = await fetch("/api/recents");
  if (!res.ok) throw new Error(`recents failed: ${res.status}`);
  return ((await res.json()) as { recents: RecentView[] }).recents;
}

export async function removeRecent(path: string): Promise<RecentView[]> {
  const res = await fetch("/api/recents/remove", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error(`remove failed: ${res.status}`);
  return ((await res.json()) as { recents: RecentView[] }).recents;
}

/** Spawn the server-side native file dialog. */
export async function pickFile(): Promise<{ path?: string; cancelled?: boolean; available?: boolean }> {
  const res = await fetch("/api/pick", { method: "POST" });
  if (!res.ok) throw new Error(`pick failed: ${res.status}`);
  return (await res.json()) as { path?: string; cancelled?: boolean; available?: boolean };
}

/** Error carrying an optional server-provided fix hint (install command, etc). */
export class ApiError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    if (hint) this.hint = hint;
  }
}

/** Validate + open a path server-side, creating a session. Throws on invalid path. */
export async function openPath(path: string): Promise<SessionInfo> {
  const res = await fetch("/api/open", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  const data = (await res.json()) as { session?: SessionInfo; error?: string; hint?: string };
  if (!res.ok || !data.session) {
    throw new ApiError(data.error ?? `open failed: ${res.status}`, data.hint);
  }
  return data.session;
}

/** Fetch the cached waveform peaks (0..1) for a session's source audio. */
export async function getWaveform(
  sessionId: string,
): Promise<{ peaks: number[]; duration: number }> {
  const res = await fetch(`/api/waveform?session=${encodeURIComponent(sessionId)}`);
  const data = (await res.json()) as { peaks?: number[]; duration?: number; error?: string };
  if (!res.ok || !data.peaks) throw new Error(data.error ?? `waveform failed: ${res.status}`);
  return { peaks: data.peaks, duration: data.duration ?? 0 };
}

/** URL for the <video> element of a given session (source, or rendered output). */
export function mediaUrl(sessionId: string, variant?: "rendered"): string {
  const base = `/api/media?session=${encodeURIComponent(sessionId)}`;
  return variant ? `${base}&variant=${variant}` : base;
}

export interface SSEHandlers {
  onProgress?: (stage: string, detail?: string) => void;
  onResult?: (data: unknown) => void;
  /** `hint` is the server's fix suggestion for known failures (P3-2) */
  onError?: (message: string, hint?: string) => void;
}

/**
 * POST a JSON body and consume a Server-Sent-Events response stream.
 * (EventSource is GET-only, so we parse the stream from fetch ourselves.)
 */
export async function streamSSE(
  url: string,
  body: unknown,
  handlers: SSEHandlers,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.body) throw new Error("no response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const dispatch = (block: string): void => {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    const parsed = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
    if (event === "progress") {
      handlers.onProgress?.(String(parsed.stage ?? ""), parsed.detail as string | undefined);
    } else if (event === "result") {
      handlers.onResult?.(parsed);
    } else if (event === "error") {
      handlers.onError?.(
        String(parsed.message ?? "unknown error"),
        typeof parsed.hint === "string" ? parsed.hint : undefined,
      );
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (block.trim()) dispatch(block);
    }
  }
  if (buffer.trim()) dispatch(buffer);
}

export interface AnalyzePayload {
  mode: string;
  minSilence: number;
  maxPause: number;
  maxCutPerSilence: number;
  minKeep: number;
  padding: number;
  threshold: number;
  model: string;
  smart: boolean;
  fillers: boolean;
  fillerWords?: string[];
}

export interface RenderPayload {
  cuts: Cut[];
  burn: boolean;
  embed: boolean;
}

/** Plan-only knobs for the cheap re-plan (no whisper / ffmpeg). */
export interface PlanPayload {
  sessionId: string;
  mode: string;
  minSilence: number;
  maxPause: number;
  maxCutPerSilence: number;
  minKeep: number;
  padding: number;
  fillers: boolean;
  fillerWords?: string[];
}

export interface CaptionsResult {
  srt: string;
  vtt: string;
  cueCount: number;
}

/**
 * Subtitles-only: write .srt/.vtt for the original video from the cached
 * transcript, skipping the ffmpeg render. Plain JSON (no progress stream).
 */
export async function postCaptions(sessionId: string): Promise<CaptionsResult> {
  const res = await fetch("/api/captions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  const data = (await res.json()) as Partial<CaptionsResult> & { error?: string; hint?: string };
  if (!res.ok || !data.srt || !data.vtt) {
    throw new ApiError(data.error ?? `captions failed: ${res.status}`, data.hint);
  }
  return { srt: data.srt, vtt: data.vtt, cueCount: data.cueCount ?? 0 };
}

/**
 * Cheap re-plan: reshape the cut list server-side from cached analysis
 * artifacts. Fast, so it's a plain JSON round-trip (no progress stream).
 */
export async function postPlan(payload: PlanPayload): Promise<{ plan: CutPlan }> {
  const res = await fetch("/api/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await res.json()) as { plan?: CutPlan; error?: string };
  if (!res.ok || !data.plan) throw new Error(data.error ?? `plan failed: ${res.status}`);
  return { plan: data.plan };
}
