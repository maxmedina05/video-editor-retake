#!/usr/bin/env tsx
/**
 * Fetch the platform/arch-matching DeepFilterNet `deep-filter` release binary
 * into <pkgRoot>/bin/deep-filter-<platform>-<arch> so the same checkout works
 * on macOS and Ubuntu.
 *
 * Run:  npm run fetch-binaries
 *
 * Idempotent: if the target file already exists and `--version` runs, it skips
 * the download. Optional denoiser — a failure here is not fatal to the app
 * (it falls back to ffmpeg afftdn), but this script exits non-zero so CI/setup
 * scripts can notice.
 */
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DF_VERSION = "0.5.6";
const BASE_URL = `https://github.com/Rikorose/DeepFilterNet/releases/download/v${DF_VERSION}`;

/** process.platform + process.arch -> DeepFilterNet release target triple. */
const TARGETS: Record<string, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-gnu",
};

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function binPath(platform: string, arch: string): string {
  return join(PKG_ROOT, "bin", `deep-filter-${platform}-${arch}`);
}

/** true if the given executable answers `--version` without throwing. */
function works(file: string): boolean {
  try {
    execFileSync(file, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url); // fetch follows GitHub's redirect to the asset store
  if (!res.ok || !res.body) {
    throw new Error(`download failed (${res.status} ${res.statusText}): ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
}

async function main(): Promise<void> {
  const { platform, arch } = process;
  const key = `${platform}-${arch}`;
  const target = TARGETS[key];
  if (!target) {
    console.error(
      `fetch-binaries: no deep-filter ${DF_VERSION} build for ${key}.\n` +
        `  Supported: ${Object.keys(TARGETS).join(", ")}.\n` +
        `  clean-video still works — it falls back to ffmpeg's afftdn denoiser.`,
    );
    process.exit(1);
  }

  const dest = binPath(platform, arch);

  if (existsSync(dest) && works(dest)) {
    console.log(`fetch-binaries: ${dest} already present and working — skipping.`);
    return;
  }

  const url = `${BASE_URL}/deep-filter-${DF_VERSION}-${target}`;
  console.log(`fetch-binaries: downloading ${url}`);
  mkdirSync(dirname(dest), { recursive: true });
  await download(url, dest);
  chmodSync(dest, 0o755);

  if (!works(dest)) {
    throw new Error(
      `downloaded ${dest} but \`--version\` failed to run — the binary may be corrupt ` +
        `or incompatible with this system.`,
    );
  }
  const version = execFileSync(dest, ["--version"], { encoding: "utf8" }).trim();
  console.log(`fetch-binaries: installed ${dest}\n  ${version}`);
}

main().catch((err: unknown) => {
  console.error(`fetch-binaries: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
