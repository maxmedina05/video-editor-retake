import { execa } from "execa";
import { accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Thin adapter over external binaries so the rest of the core can be unit
 * tested without touching real ffmpeg/whisper/etc.
 */

/** Package root (this file lives at <root>/src/core or <root>/dist/core). */
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Injectable dependencies for {@link resolveBinary}, so resolution order is unit-testable. */
export interface ResolveBinaryDeps {
  /** true when `path` exists and is executable */
  isExecutable: (path: string) => boolean;
  /** process.platform, e.g. "darwin" | "linux" */
  platform: NodeJS.Platform;
  /** process.arch, e.g. "arm64" | "x64" */
  arch: string;
  /** package root under which the `bin/` directory lives */
  pkgRoot: string;
}

export const defaultResolveBinaryDeps: ResolveBinaryDeps = {
  isExecutable: (p) => {
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  platform: process.platform,
  arch: process.arch,
  pkgRoot: PKG_ROOT,
};

/**
 * Resolve a binary name to a vendored executable when one exists, preferring
 * a platform/arch-specific build so the same checkout works on macOS and Linux.
 *
 * Resolution order:
 *   1. <pkgRoot>/bin/<name>-<platform>-<arch>  (e.g. deep-filter-linux-x64)
 *   2. <pkgRoot>/bin/<name>                      (legacy unsuffixed vendored file)
 *   3. <name>                                    (bare name; PATH resolution)
 */
export function resolveBinary(name: string, deps: ResolveBinaryDeps = defaultResolveBinaryDeps): string {
  const suffixed = join(deps.pkgRoot, "bin", `${name}-${deps.platform}-${deps.arch}`);
  if (deps.isExecutable(suffixed)) return suffixed;
  const legacy = join(deps.pkgRoot, "bin", name);
  if (deps.isExecutable(legacy)) return legacy;
  return name;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type Runner = (
  file: string,
  args: string[],
  opts?: { input?: string; cwd?: string },
) => Promise<RunResult>;

/** Default runner backed by execa. `reject: false` so we can inspect stderr. */
export const runBinary: Runner = async (file, args, opts) => {
  const result = await execa(resolveBinary(file), args, {
    input: opts?.input,
    cwd: opts?.cwd,
    reject: false,
    all: false,
    encoding: "utf8",
  });
  let stderr = typeof result.stderr === "string" ? result.stderr : "";
  // A binary that never spawned (e.g. missing: ENOENT) has no exit code and no
  // stderr; surface execa's short message so callers can say WHY it failed
  // ("spawn ffmpeg ENOENT") instead of "unknown error".
  if (result.exitCode === undefined && !stderr) {
    const r = result as { shortMessage?: string; message?: string };
    stderr = r.shortMessage ?? r.message ?? "";
  }
  return {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr,
    exitCode: result.exitCode ?? 1,
  };
};

/** Returns true if a binary is resolvable on PATH or vendored in <pkgRoot>/bin. */
export async function hasBinary(name: string): Promise<boolean> {
  try {
    const result = await execa(resolveBinary(name), ["--version"], { reject: false });
    // Some tools (whisper-cli) exit non-zero on --version but still exist;
    // execa only throws (caught below) when the binary can't be spawned.
    return result.exitCode !== undefined;
  } catch {
    return false;
  }
}

export interface BinaryRequirement {
  name: string;
  required: boolean;
  install: { brew?: string; apt?: string; note?: string };
}

export const REQUIREMENTS: Record<string, BinaryRequirement> = {
  ffmpeg: {
    name: "ffmpeg",
    required: true,
    install: { brew: "brew install ffmpeg", apt: "sudo apt install ffmpeg" },
  },
  ffprobe: {
    name: "ffprobe",
    required: true,
    install: { brew: "brew install ffmpeg", apt: "sudo apt install ffmpeg" },
  },
  "whisper-cli": {
    name: "whisper-cli",
    required: true,
    install: {
      brew: "brew install whisper-cpp",
      apt: "build whisper.cpp from source: https://github.com/ggerganov/whisper.cpp",
      note: "provides the `whisper-cli` binary and needs a model (see README).",
    },
  },
  "deep-filter": {
    name: "deep-filter",
    required: false,
    install: {
      note: "optional DeepFilterNet denoiser: https://github.com/Rikorose/DeepFilterNet (falls back to ffmpeg afftdn if absent).",
    },
  },
  claude: {
    name: "claude",
    required: false,
    install: {
      note: "optional, only for --smart filler detection: Claude Code CLI.",
    },
  },
};

export function formatMissing(req: BinaryRequirement): string {
  const lines = [`  - ${req.name}${req.required ? " (required)" : " (optional)"}`];
  if (req.install.brew) lines.push(`      macOS:  ${req.install.brew}`);
  if (req.install.apt) lines.push(`      Linux:  ${req.install.apt}`);
  if (req.install.note) lines.push(`      note:   ${req.install.note}`);
  return lines.join("\n");
}
