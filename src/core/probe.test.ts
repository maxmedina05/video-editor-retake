import { describe, expect, it } from "vitest";
import { parseProbeJson } from "./probe.js";

describe("parseProbeJson", () => {
  it("extracts duration, resolution, fps, codecs", () => {
    const json = JSON.stringify({
      format: { duration: "12.5" },
      streams: [
        { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, r_frame_rate: "30/1" },
        { codec_type: "audio", codec_name: "aac" },
      ],
    });
    const info = parseProbeJson(json);
    expect(info).toMatchObject({
      duration: 12.5,
      hasVideo: true,
      hasAudio: true,
      width: 1920,
      height: 1080,
      fps: 30,
      videoCodec: "h264",
      audioCodec: "aac",
    });
  });

  it("handles fractional frame rate", () => {
    const json = JSON.stringify({
      format: { duration: "1" },
      streams: [{ codec_type: "video", avg_frame_rate: "30000/1001" }],
    });
    expect(parseProbeJson(json).fps).toBeCloseTo(29.97, 2);
  });

  it("falls back to stream duration when format duration missing", () => {
    const json = JSON.stringify({
      streams: [{ codec_type: "audio", codec_name: "aac", duration: "8.25" }],
    });
    const info = parseProbeJson(json);
    expect(info.duration).toBe(8.25);
    expect(info.hasVideo).toBe(false);
    expect(info.hasAudio).toBe(true);
  });

  it("treats 0/0 frame rate as unknown", () => {
    const json = JSON.stringify({
      format: { duration: "1" },
      streams: [{ codec_type: "video", avg_frame_rate: "0/0" }],
    });
    expect(parseProbeJson(json).fps).toBeUndefined();
  });
});
