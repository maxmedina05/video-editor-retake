import type { Cut } from "./types";

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

/** Validate + open a path server-side, creating a session. Throws on invalid path. */
export async function openPath(path: string): Promise<SessionInfo> {
  const res = await fetch("/api/open", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  const data = (await res.json()) as { session?: SessionInfo; error?: string };
  if (!res.ok || !data.session) throw new Error(data.error ?? `open failed: ${res.status}`);
  return data.session;
}

/** URL for the <video> element of a given session (source, or rendered output). */
export function mediaUrl(sessionId: string, variant?: "rendered"): string {
  const base = `/api/media?session=${encodeURIComponent(sessionId)}`;
  return variant ? `${base}&variant=${variant}` : base;
}

export interface SSEHandlers {
  onProgress?: (stage: string, detail?: string) => void;
  onResult?: (data: unknown) => void;
  onError?: (message: string) => void;
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
      handlers.onError?.(String(parsed.message ?? "unknown error"));
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
