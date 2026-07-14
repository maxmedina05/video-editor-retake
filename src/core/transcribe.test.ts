import { describe, expect, it } from "vitest";
import { parseWhisperJson, resolveModelPath } from "./transcribe.js";

describe("parseWhisperJson", () => {
  it("parses word segments (ms offsets -> seconds)", () => {
    const json = JSON.stringify({
      result: { language: "en" },
      transcription: [
        { text: " Hello", offsets: { from: 0, to: 500 } },
        { text: " world", offsets: { from: 520, to: 1000 } },
      ],
    });
    const t = parseWhisperJson(json);
    expect(t.language).toBe("en");
    expect(t.words).toEqual([
      { text: "Hello", start: 0, end: 0.5 },
      { text: "world", start: 0.52, end: 1 },
    ]);
  });

  it("averages token probabilities when present", () => {
    const json = JSON.stringify({
      transcription: [
        { text: "hi", offsets: { from: 0, to: 100 }, tokens: [{ p: 0.8 }, { p: 0.6 }] },
      ],
    });
    expect(parseWhisperJson(json).words[0]!.probability).toBeCloseTo(0.7, 5);
  });

  it("skips non-speech tokens and blanks", () => {
    const json = JSON.stringify({
      transcription: [
        { text: "[BLANK_AUDIO]", offsets: { from: 0, to: 100 } },
        { text: "  ", offsets: { from: 100, to: 200 } },
        { text: "(music)", offsets: { from: 200, to: 300 } },
        { text: "ok", offsets: { from: 300, to: 400 } },
      ],
    });
    expect(parseWhisperJson(json).words.map((w) => w.text)).toEqual(["ok"]);
  });

  it("skips segments with invalid timing", () => {
    const json = JSON.stringify({
      transcription: [{ text: "bad", offsets: { from: 500, to: 100 } }],
    });
    expect(parseWhisperJson(json).words).toEqual([]);
  });
});

describe("resolveModelPath", () => {
  it("prefers explicit modelPath", () => {
    expect(resolveModelPath({ modelPath: "/x/ggml.bin" })).toBe("/x/ggml.bin");
  });
  it("builds ggml-<model>.bin in modelDir", () => {
    expect(resolveModelPath({ model: "small.en", modelDir: "/models" })).toBe(
      "/models/ggml-small.en.bin",
    );
  });
});
