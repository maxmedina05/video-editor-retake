import { describe, expect, it } from "vitest";
import { ERROR_RULES, mapError } from "./errors.js";

/** raw error → expected rule id (representative raw strings from the pipeline) */
const CASES: Array<{ raw: string; rule: string }> = [
  {
    raw: "Command failed with ENOENT: ffmpeg -hide_banner\nspawn ffmpeg ENOENT",
    rule: "ffmpeg-missing",
  },
  {
    raw: "ffprobe failed for /x.mp4: Command failed with ENOENT: ffprobe\nspawn ffprobe ENOENT",
    rule: "ffprobe-missing",
  },
  {
    raw: "whisper-cli failed: Command failed with ENOENT: whisper-cli\nspawn whisper-cli ENOENT",
    rule: "whisper-missing",
  },
  {
    raw: "whisper-cli failed: whisper_init_from_file_with_params_no_state: failed to load model\nModel not found at /Users/x/.cache/whisper/ggml-base.en.bin. See README for how to download it.",
    rule: "model-missing",
  },
  {
    // real whisper.cpp output for a missing model file (no "error:" prefix)
    raw: "whisper-cli failed: whisper_init_from_file_with_params_no_state: failed to open '/models/ggml-base.en.bin'\nerror: failed to initialize whisper context",
    rule: "model-missing",
  },
  {
    raw: "whisper-cli failed: some other whisper explosion",
    rule: "whisper-failed",
  },
  {
    raw: "whisper-cli exited 0 but wrote no JSON output.\nLast output:\nusage: ...",
    rule: "whisper-failed",
  },
  {
    raw: "ffprobe failed for /x.mp4: Invalid data found when processing input",
    rule: "probe-failed",
  },
  {
    raw: "audio extraction failed: Output file does not contain any stream",
    rule: "audio-extract-failed",
  },
  {
    raw: "ffmpeg waveform extraction failed: Output file does not contain any stream",
    rule: "audio-extract-failed",
  },
  {
    raw: "ffmpeg render failed: Error while filtering: Invalid argument",
    rule: "render-failed",
  },
  {
    raw: "ffmpeg silencedetect failed: unknown error",
    rule: "silence-failed",
  },
  {
    raw: "nothing left to render (all content cut)",
    rule: "nothing-to-render",
  },
];

describe("mapError", () => {
  it.each(CASES)("maps $rule", ({ raw, rule }) => {
    const expected = ERROR_RULES.find((r) => r.id === rule)!;
    const out = mapError(raw, "darwin");
    expect(out.message).toBe(expected.message);
    if (expected.hint) expect(out.hint).toBe(expected.hint("darwin"));
    else expect(out.hint).toBeUndefined();
  });

  it("first match wins: a missing whisper-cli is diagnosed as missing, not generic failure", () => {
    const out = mapError("whisper-cli failed: spawn whisper-cli ENOENT", "darwin");
    expect(out.message).toContain("not installed");
  });

  it("gives platform-appropriate install hints", () => {
    const raw = "spawn ffmpeg ENOENT";
    expect(mapError(raw, "darwin").hint).toBe("brew install ffmpeg");
    expect(mapError(raw, "linux").hint).toBe("sudo apt install ffmpeg");
  });

  it("passes unknown errors through verbatim with no hint", () => {
    const out = mapError("some totally novel explosion", "darwin");
    expect(out).toEqual({ message: "some totally novel explosion" });
  });

  it("model hint points at the README download command", () => {
    const out = mapError("Model not found at /models/ggml-base.en.bin", "linux");
    expect(out.hint).toContain("ggml-base.en.bin");
    expect(out.hint).toContain("huggingface.co");
  });
});
