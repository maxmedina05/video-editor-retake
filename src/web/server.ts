import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { basename, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, cleanup, finalize, type AnalyzeResult } from "../core/pipeline.js";
import { planFromCuts } from "../core/cutlist.js";
import { rebuildPlan } from "../core/replan.js";
import { hasFfmpegFilter } from "../core/render.js";
import { validateVideoPath } from "../core/openfile.js";
import { createSessionRegistry, type Session } from "../core/sessions.js";
import {
  loadRecents,
  removeRecentByPath,
  saveRecents,
  upsertRecent,
  type RecentEntry,
} from "../core/recents.js";
import { detectPicker, pickVideo, type PickerKind } from "./pick.js";
import { browse, BrowseError } from "./browse.js";
import { modeDefaults, type Mode } from "../core/modes.js";
import { mapError } from "../core/errors.js";
import { cacheDir, createCache, fileIdentity, waveformKey } from "../core/cache.js";
import { extractWaveformPeaks, WAVEFORM_BUCKETS } from "../core/waveform.js";
import type { DenoiseMethod } from "../core/denoise.js";
import type { Cut } from "../core/types.js";

/**
 * Local HTTP API wrapping the core pipeline for the web UI.
 *
 * Persistent + multi-file: the browser opens the home screen, picks any video
 * (native dialog / pasted path / recent), and each open creates a server-side
 * SESSION ({id, path, mediaInfo}). All media/analyze/render endpoints reference
 * a session by id — the browser never sends raw filesystem paths to them, so a
 * malicious page can't turn this localhost server into an arbitrary-file reader.
 *
 * Defence in depth: bound to 127.0.0.1 only, and any request carrying an
 * Origin header that is not a localhost origin is rejected.
 */

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

const VIDEO_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".m4v": "video/x-m4v",
};

/** Per-session analysis state (kept out of the Session shape itself). */
interface AnalysisState {
  result: AnalyzeResult | null;
  lastMinKeep: number;
}

function uiDistDir(): string {
  const here = fileURLToPath(new URL(".", import.meta.url)); // dist/web/
  return resolve(here, "..", "..", "web-ui", "dist");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

function sseInit(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
}

function sseSend(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Send an SSE error event with the raw error mapped to a human message + fix
 * hint (P3-2). The raw text rides along for anyone who needs the gory detail.
 */
function sseError(res: ServerResponse, err: unknown): void {
  const raw = err instanceof Error ? err.message : String(err);
  const friendly = mapError(raw);
  sseSend(res, "error", {
    message: friendly.message,
    ...(friendly.hint ? { hint: friendly.hint } : {}),
    ...(friendly.message !== raw ? { raw } : {}),
  });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

/**
 * Reject requests whose Origin header is present and not a localhost origin.
 * A missing Origin (same-origin navigation, curl, the <video> element) is fine.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

interface AnalyzeBody {
  sessionId?: string;
  denoise?: string;
  /** aggressiveness preset; drives the activity policy (static/active silences) */
  mode?: Mode;
  smart?: boolean;
  /** run heuristic filler-word removal (default true) */
  fillers?: boolean;
  model?: string;
  language?: string;
  minSilence?: number;
  padding?: number;
  maxPause?: number;
  /** cap on seconds removed from a single silence gap (0 = uncapped) */
  maxCutPerSilence?: number;
  minKeep?: number;
  threshold?: number;
  fillerWords?: string[];
  /** force a fresh analyze, ignoring the on-disk cache */
  noCache?: boolean;
}

async function handleAnalyze(
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
  aState: AnalysisState,
  hasSubtitlesFilter: boolean,
  body: AnalyzeBody,
): Promise<void> {
  sseInit(res);
  try {
    // free any previous analysis workDir before re-analyzing
    if (aState.result) {
      await cleanup(aState.result.workDir).catch(() => {});
      aState.result = null;
    }
    const minKeep = body.minKeep ?? 0.4;
    aState.lastMinKeep = minKeep;
    // Numeric knobs come from the settings form; the activity POLICY (whether
    // active silences are cut, and how gently) is a characteristic of the mode.
    const md = modeDefaults(body.mode ?? "balanced");
    const result = await analyze(session.path, {
      denoise: (body.denoise as DenoiseMethod) ?? "deep-filter",
      cache: !body.noCache,
      smart: Boolean(body.smart),
      fillers: body.fillers ?? md.fillers,
      activity: md.activity,
      ...(body.model ? { model: body.model } : {}),
      ...(body.language ? { language: body.language } : {}),
      ...(body.minSilence !== undefined ? { minSilence: body.minSilence } : {}),
      ...(body.padding !== undefined ? { padding: body.padding } : {}),
      ...(body.maxPause !== undefined ? { maxPause: body.maxPause } : {}),
      // Explicit override wins; otherwise the mode derives the cap.
      maxCutPerSilence: body.maxCutPerSilence ?? md.maxCutPerSilence,
      minKeep,
      ...(body.threshold !== undefined ? { thresholdDb: body.threshold } : {}),
      ...(body.fillerWords ? { fillerWords: body.fillerWords } : {}),
      onProgress: (stage, detail) => sseSend(res, "progress", { stage, detail }),
    });
    aState.result = result;
    sseSend(res, "result", {
      info: result.info,
      transcript: result.transcript,
      plan: result.plan,
      warnings: result.warnings,
      denoiseMethod: result.denoise.method,
      hasSubtitlesFilter,
      cache: result.cache,
    });
  } catch (err) {
    sseError(res, err);
  } finally {
    res.end();
  }
}

interface PlanBody {
  sessionId?: string;
  mode?: Mode;
  /** filter floor on the cached silence gaps (drop gaps shorter than this) */
  minSilence?: number;
  maxPause?: number;
  maxCutPerSilence?: number;
  minKeep?: number;
  padding?: number;
  fillers?: boolean;
  fillerWords?: string[];
}

/**
 * Cheap re-plan: reshape the cut list from the session's CACHED analysis
 * artifacts (transcript + silence/freeze detections) with new plan-only knobs.
 * Never re-runs whisper or ffmpeg — it is a pure recompute, so it responds with
 * plain JSON (no progress stream). Changes that invalidate detection
 * (threshold, min-silence-below-analyze, model, smart, fresh) still go through
 * /api/analyze.
 */
function handlePlan(res: ServerResponse, aState: AnalysisState, body: PlanBody): void {
  if (!aState.result) {
    sendJson(res, 409, { error: "no analysis yet; run /api/analyze first" });
    return;
  }
  const minKeep = body.minKeep ?? aState.lastMinKeep;
  // Keep lastMinKeep in sync so a subsequent /api/render rebuilds keep-segments
  // with the same anti-flicker floor the user just previewed.
  aState.lastMinKeep = minKeep;
  const { info, transcript, silenceGaps, frozenSpans } = aState.result;
  const plan = rebuildPlan(
    {
      sourceDuration: info.duration,
      words: transcript.words,
      silenceGaps,
      frozenSpans,
    },
    {
      mode: body.mode ?? "balanced",
      ...(body.minSilence !== undefined ? { minSilence: body.minSilence } : {}),
      ...(body.maxPause !== undefined ? { maxPause: body.maxPause } : {}),
      ...(body.maxCutPerSilence !== undefined ? { maxCutPerSilence: body.maxCutPerSilence } : {}),
      minKeep,
      ...(body.padding !== undefined ? { padding: body.padding } : {}),
      ...(body.fillers !== undefined ? { fillers: body.fillers } : {}),
      ...(body.fillerWords ? { fillerWords: body.fillerWords } : {}),
    },
  );
  sendJson(res, 200, { plan });
}

interface RenderBody {
  sessionId?: string;
  cuts?: Cut[];
  burn?: boolean;
  embed?: boolean;
  crf?: number;
  preset?: string;
}

async function handleRender(
  res: ServerResponse,
  session: Session,
  aState: AnalysisState,
  hasSubtitlesFilter: boolean,
  body: RenderBody,
): Promise<void> {
  sseInit(res);
  try {
    if (!aState.result) throw new Error("no analysis available; run /api/analyze first");
    const { info, transcript, denoise } = aState.result;
    const cuts = (body.cuts ?? []).map((c) => ({ ...c }));
    const plan = planFromCuts(cuts, info.duration, { minKeep: aState.lastMinKeep });
    if (plan.keep.length === 0) throw new Error("nothing left to render (all content cut)");

    const ext = extname(session.path);
    const name = basename(session.path, ext);
    const dir = resolve(session.path, "..");
    const outputVideo = join(dir, `${name}.cleaned.mp4`);
    const srtPath = join(dir, `${name}.cleaned.srt`);
    const vttPath = join(dir, `${name}.cleaned.vtt`);
    const cutplanPath = join(dir, `${name}.cutplan.json`);

    const { cues } = await finalize({
      input: session.path,
      plan,
      transcript,
      info,
      denoise,
      outputVideo,
      srtPath,
      vttPath,
      cutplanPath,
      burn: Boolean(body.burn) && hasSubtitlesFilter,
      embed: Boolean(body.embed),
      ...(body.crf !== undefined ? { crf: body.crf } : {}),
      ...(body.preset !== undefined ? { preset: body.preset } : {}),
      onProgress: (stage, detail) => sseSend(res, "progress", { stage, detail }),
    });

    // Record the output on the session so it can be streamed back for preview
    // (variant=rendered). Re-rendering overwrites this.
    session.renderedVideo = outputVideo;
    session.renderedSrt = srtPath;

    sseSend(res, "result", {
      video: outputVideo,
      srt: srtPath,
      vtt: vttPath,
      cutplan: cutplanPath,
      sourceDuration: plan.sourceDuration,
      outputDuration: plan.outputDuration,
      removedDuration: plan.removedDuration,
      // OUTPUT-timeline caption cues (identical to the emitted .srt), for the
      // in-app "Watch result" preview.
      cues,
    });
  } catch (err) {
    sseError(res, err);
  } finally {
    res.end();
  }
}

async function streamFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
): Promise<void> {
  const info = await stat(file);
  const size = info.size;
  const type = VIDEO_MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.range;

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = match && match[1] ? parseInt(match[1], 10) : 0;
    const end = match && match[2] ? parseInt(match[2], 10) : size - 1;
    const safeStart = Math.max(0, Math.min(start, size - 1));
    const safeEnd = Math.max(safeStart, Math.min(end, size - 1));
    res.writeHead(206, {
      "content-type": type,
      "content-range": `bytes ${safeStart}-${safeEnd}/${size}`,
      "accept-ranges": "bytes",
      "content-length": safeEnd - safeStart + 1,
    });
    createReadStream(file, { start: safeStart, end: safeEnd }).pipe(res);
  } else {
    res.writeHead(200, {
      "content-type": type,
      "content-length": size,
      "accept-ranges": "bytes",
    });
    createReadStream(file).pipe(res);
  }
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const dist = uiDistDir();
  const rel = urlPath === "/" ? "index.html" : normalize(urlPath).replace(/^(\.\.[/\\])+/, "").replace(/^\/+/, "");
  const filePath = join(dist, rel);
  if (!filePath.startsWith(dist)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const data = await readFile(filePath);
    const type = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type, "content-length": data.length });
    res.end(data);
  } catch {
    // SPA fallback: serve index.html for unknown non-API routes
    try {
      const html = await readFile(join(dist, "index.html"));
      res.writeHead(200, { "content-type": MIME[".html"]!, "content-length": html.length });
      res.end(html);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end(
        "UI not built. Run `npm run build:ui` (or `npm --prefix web-ui run build`) first.",
      );
    }
  }
}

/** Public view of a recent entry, augmented with a liveness flag. */
interface RecentView extends RecentEntry {
  exists: boolean;
}

function recentsView(list: readonly RecentEntry[]): RecentView[] {
  return list.map((e) => ({ ...e, exists: existsSync(e.path) }));
}

export interface StartServerOptions {
  port?: number;
  host?: string;
  /** optional file to pre-open (jumps the UI straight into the editor) */
  initialInput?: string;
  /**
   * When set, enables the server-side directory browser rooted here (for
   * environments with no native dialog, e.g. Docker). Absolute path.
   */
  mediaRoot?: string;
}

export async function startServer(
  opts: StartServerOptions = {},
): Promise<{ port: number; url: string; close: () => Promise<void> }> {
  const host = opts.host ?? "127.0.0.1";
  const mediaRoot = opts.mediaRoot ? resolve(opts.mediaRoot) : undefined;
  const sessions = createSessionRegistry();
  const analysisState = new Map<string, AnalysisState>();
  /** sessionId → waveform peaks (memo over the per-identity disk artifact) */
  const waveforms = new Map<string, number[]>();
  let recents = await loadRecents();
  const hasSubtitlesFilter = await hasFfmpegFilter("subtitles").catch(() => false);
  const picker: PickerKind | null = await detectPicker().catch(() => null);

  /** Validate + open a path: create a session and record it in recents. */
  async function openPath(rawPath: string): Promise<Session> {
    const abs = resolve(rawPath);
    const v = await validateVideoPath(abs);
    if (!v.ok) throw new Error(v.error);
    const session = sessions.create(abs, v.info);
    analysisState.set(session.id, { result: null, lastMinKeep: 0.4 });
    recents = upsertRecent(recents, {
      path: abs,
      name: basename(abs),
      duration: v.info.duration,
      lastOpened: Date.now(),
    });
    await saveRecents(recents).catch(() => {});
    return session;
  }

  const sessionDto = (s: Session) => ({
    id: s.id,
    name: basename(s.path),
    path: s.path,
    duration: s.mediaInfo.duration,
  });

  let initialSession: Session | undefined;
  if (opts.initialInput) {
    initialSession = await openPath(opts.initialInput);
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    const run = async (): Promise<void> => {
      if (path.startsWith("/api/") && !isAllowedOrigin(req.headers.origin)) {
        return sendJson(res, 403, { error: "cross-origin request rejected" });
      }

      if (path === "/api/config" && method === "GET") {
        return sendJson(res, 200, {
          pickerAvailable: picker !== null,
          hasSubtitlesFilter,
          mediaRoot: mediaRoot !== undefined,
          recents: recentsView(recents),
          ...(initialSession ? { initialSession: sessionDto(initialSession) } : {}),
        });
      }

      if (path === "/api/recents" && method === "GET") {
        return sendJson(res, 200, { recents: recentsView(recents) });
      }

      if (path === "/api/recents/remove" && method === "POST") {
        const body = (await readBody(req)) as { path?: string };
        if (body.path) {
          recents = removeRecentByPath(recents, body.path);
          await saveRecents(recents).catch(() => {});
        }
        return sendJson(res, 200, { recents: recentsView(recents) });
      }

      if (path === "/api/pick" && method === "POST") {
        if (!picker) return sendJson(res, 200, { available: false });
        const result = await pickVideo(picker);
        if (result.cancelled || !result.path) return sendJson(res, 200, { cancelled: true });
        return sendJson(res, 200, { path: result.path });
      }

      if (path === "/api/browse" && method === "GET") {
        if (!mediaRoot) return sendJson(res, 404, { error: "media browser disabled" });
        const dir = url.searchParams.get("dir") ?? "";
        try {
          return sendJson(res, 200, await browse(mediaRoot, dir));
        } catch (err) {
          const status = err instanceof BrowseError ? 400 : 500;
          return sendJson(res, status, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (path === "/api/open" && method === "POST") {
        const body = (await readBody(req)) as { path?: string };
        if (!body.path) return sendJson(res, 400, { error: "path required" });
        try {
          const session = await openPath(body.path);
          return sendJson(res, 200, { session: sessionDto(session) });
        } catch (err) {
          const friendly = mapError(err instanceof Error ? err.message : String(err));
          return sendJson(res, 400, {
            error: friendly.message,
            ...(friendly.hint ? { hint: friendly.hint } : {}),
          });
        }
      }

      if (path === "/api/analyze" && method === "POST") {
        const body = (await readBody(req)) as AnalyzeBody;
        const session = body.sessionId ? sessions.get(body.sessionId) : undefined;
        if (!session) return sendJson(res, 404, { error: "unknown session" });
        const aState = analysisState.get(session.id)!;
        return handleAnalyze(req, res, session, aState, hasSubtitlesFilter, body);
      }

      if (path === "/api/plan" && method === "POST") {
        const body = (await readBody(req)) as PlanBody;
        const session = body.sessionId ? sessions.get(body.sessionId) : undefined;
        if (!session) return sendJson(res, 404, { error: "unknown session" });
        const aState = analysisState.get(session.id)!;
        return handlePlan(res, aState, body);
      }

      if (path === "/api/render" && method === "POST") {
        const body = (await readBody(req)) as RenderBody;
        const session = body.sessionId ? sessions.get(body.sessionId) : undefined;
        if (!session) return sendJson(res, 404, { error: "unknown session" });
        const aState = analysisState.get(session.id)!;
        return handleRender(res, session, aState, hasSubtitlesFilter, body);
      }

      if (path === "/api/waveform" && method === "GET") {
        const session = sessions.get(url.searchParams.get("session") ?? "");
        if (!session) return sendJson(res, 404, { error: "unknown session" });
        const cached = waveforms.get(session.id);
        if (cached) {
          return sendJson(res, 200, { peaks: cached, duration: session.mediaInfo.duration });
        }
        try {
          // Per-identity disk artifact, like the other analysis passes: computed
          // once per file (not per open), instant on every reopen.
          const cache = createCache(cacheDir());
          const st = await stat(session.path);
          const identity = fileIdentity({
            path: session.path,
            size: st.size,
            mtimeMs: st.mtimeMs,
          });
          const key = waveformKey(identity, { buckets: WAVEFORM_BUCKETS });
          const hit = await cache.readJson<number[]>(key);
          let peaks = hit.kind === "hit" ? hit.value : null;
          if (!peaks) {
            peaks = await extractWaveformPeaks(session.path);
            await cache.writeJson(key, peaks).catch(() => {});
          }
          waveforms.set(session.id, peaks);
          return sendJson(res, 200, { peaks, duration: session.mediaInfo.duration });
        } catch (err) {
          const friendly = mapError(err instanceof Error ? err.message : String(err));
          return sendJson(res, 500, {
            error: friendly.message,
            ...(friendly.hint ? { hint: friendly.hint } : {}),
          });
        }
      }

      if (path === "/api/media" && method === "GET") {
        const session = sessions.get(url.searchParams.get("session") ?? "");
        if (!session) return sendJson(res, 404, { error: "unknown session" });
        if (url.searchParams.get("variant") === "rendered") {
          if (!session.renderedVideo || !existsSync(session.renderedVideo)) {
            return sendJson(res, 404, { error: "not rendered yet" });
          }
          return streamFile(req, res, session.renderedVideo);
        }
        return streamFile(req, res, session.path);
      }

      if (path.startsWith("/api/")) return sendJson(res, 404, { error: "not found" });
      return serveStatic(res, path);
    };

    run().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) sendJson(res, 500, { error: message });
      else res.end();
    });
  });

  const port = await new Promise<number>((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => {
      const addr = server.address();
      resolvePort(typeof addr === "object" && addr ? addr.port : 0);
    });
  });

  return {
    port,
    url: `http://${host}:${port}`,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
      }),
  };
}
