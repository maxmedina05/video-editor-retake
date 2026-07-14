import { execa } from "execa";
import { platform } from "node:os";
import { hasBinary } from "../core/binaries.js";

/**
 * Server-side native OS file dialog. The server runs on the user's own machine,
 * so "open a file" spawns the platform picker and returns the chosen path.
 *
 * Not unit-tested (it spawns a GUI); the rest of the open flow (validation,
 * sessions, recents) is pure and tested.
 */

export type PickerKind = "osascript" | "zenity" | "kdialog";

export interface PickResult {
  /** absolute path chosen by the user */
  path?: string;
  /** user closed/cancelled the dialog — not an error */
  cancelled?: boolean;
}

/** Detect an available native file-dialog tool, or null if none. */
export async function detectPicker(): Promise<PickerKind | null> {
  if (platform() === "darwin") {
    return (await hasBinary("osascript")) ? "osascript" : null;
  }
  if (platform() === "linux") {
    if (await hasBinary("zenity")) return "zenity";
    if (await hasBinary("kdialog")) return "kdialog";
    return null;
  }
  return null;
}

/** Spawn the native picker and return the chosen path (or cancelled). */
export async function pickVideo(kind: PickerKind): Promise<PickResult> {
  if (kind === "osascript") {
    // AppleScript `choose file` throws (exit 1, "User canceled.") on cancel.
    const res = await execa(
      "osascript",
      ["-e", 'POSIX path of (choose file of type {"public.movie"})'],
      { reject: false },
    );
    const path = String(res.stdout ?? "").trim();
    if (res.exitCode === 0 && path) return { path };
    return { cancelled: true };
  }

  if (kind === "zenity") {
    const res = await execa("zenity", ["--file-selection"], { reject: false });
    const path = String(res.stdout ?? "").trim();
    if (res.exitCode === 0 && path) return { path };
    return { cancelled: true };
  }

  // kdialog
  const res = await execa("kdialog", ["--getopenfilename"], { reject: false });
  const path = String(res.stdout ?? "").trim();
  if (res.exitCode === 0 && path) return { path };
  return { cancelled: true };
}
