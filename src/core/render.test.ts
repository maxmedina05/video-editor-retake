import { describe, expect, it } from "vitest";
import { buildFilterComplex, buildRenderArgs, escapeSubtitlesPath } from "./render.js";
import type { KeepSegment } from "./types.js";

const keep: KeepSegment[] = [
  { start: 0, end: 2 },
  { start: 5, end: 8.5 },
];

describe("buildFilterComplex", () => {
  it("builds one trim/atrim chain per segment plus a concat", () => {
    const g = buildFilterComplex({ input: "in.mp4", output: "out.mp4", keep });
    expect(g).toContain("[0:v]trim=start=0.000:end=2.000,setpts=PTS-STARTPTS[v0]");
    expect(g).toContain("[0:a]atrim=start=0.000:end=2.000,asetpts=PTS-STARTPTS[a0]");
    expect(g).toContain("[0:v]trim=start=5.000:end=8.500,setpts=PTS-STARTPTS[v1]");
    expect(g).toContain("[0:a]atrim=start=5.000:end=8.500,asetpts=PTS-STARTPTS[a1]");
    expect(g).toContain("[v0][a0][v1][a1]concat=n=2:v=1:a=1[vcat][acat]");
  });

  it("scales to large cut plans without expression nesting", () => {
    const many: KeepSegment[] = Array.from({ length: 200 }, (_, i) => ({
      start: i * 2,
      end: i * 2 + 1,
    }));
    const g = buildFilterComplex({ input: "in.mp4", output: "out.mp4", keep: many });
    expect(g).toContain("concat=n=200:v=1:a=1");
    expect(g).not.toContain("between(");
    expect(g).not.toContain("select=");
  });

  it("uses input #1 for a denoised audio track", () => {
    const g = buildFilterComplex({ input: "in.mp4", output: "out.mp4", keep, audioInput: "d.wav" });
    expect(g).toContain("[1:a]atrim=");
    expect(g).not.toContain("[0:a]");
  });

  it("adds a subtitles filter on the concatenated video when burning", () => {
    const g = buildFilterComplex({
      input: "in.mp4",
      output: "out.mp4",
      keep,
      burnSubtitles: "/tmp/out.srt",
    });
    expect(g).toContain("[vcat]subtitles=/tmp/out.srt[vout]");
  });

  it("omits the video chain when there is no video", () => {
    const g = buildFilterComplex({ input: "a.wav", output: "o.m4a", keep, hasVideo: false });
    expect(g).not.toContain("[0:v]");
    expect(g).toContain("atrim=");
    expect(g).toContain("concat=n=2:v=0:a=1[acat]");
  });

  it("throws on empty keep-list", () => {
    expect(() => buildFilterComplex({ input: "in.mp4", output: "out.mp4", keep: [] })).toThrow();
  });
});

describe("buildRenderArgs", () => {
  it("references the filtergraph script, maps vcat/acat and sets encoder options", () => {
    const args = buildRenderArgs(
      { input: "in.mp4", output: "out.mp4", keep, crf: 18, preset: "fast" },
      "/tmp/graph.txt",
    );
    const joined = args.join(" ");
    expect(joined).toContain("-filter_complex_script /tmp/graph.txt");
    expect(joined).toContain("-map [vcat] -map [acat]");
    expect(joined).toContain("-c:v libx264 -preset fast -crf 18");
    expect(joined).toContain("-c:a aac -b:a 192k");
    expect(args[args.length - 1]).toBe("out.mp4");
  });

  it("adds a second -i for denoised audio and maps [vout] when burning", () => {
    const args = buildRenderArgs(
      {
        input: "in.mp4",
        output: "out.mp4",
        keep,
        audioInput: "d.wav",
        burnSubtitles: "s.srt",
      },
      "/tmp/graph.txt",
    );
    const joined = args.join(" ");
    expect(joined).toContain("-i in.mp4 -i d.wav");
    expect(joined).toContain("-map [vout]");
  });

  it("embeds a mov_text subtitle stream from the SRT as the last input", () => {
    const args = buildRenderArgs(
      { input: "in.mp4", output: "out.mp4", keep, embedCaptions: "cut.srt" },
      "/tmp/graph.txt",
    );
    const joined = args.join(" ");
    // no denoised audio -> SRT is input #1
    expect(joined).toContain("-i in.mp4 -i cut.srt");
    expect(joined).toContain("-map [vcat] -map [acat] -map 1:s:0");
    expect(joined).toContain("-c:s mov_text");
    expect(joined).toContain("-metadata:s:s:0 language=und");
    expect(joined).toContain("-disposition:s:0 default");
    // subtitle stream must not break faststart
    expect(joined).toContain("-movflags +faststart");
  });

  it("puts the embedded SRT after a denoised audio input (index 2)", () => {
    const args = buildRenderArgs(
      { input: "in.mp4", output: "out.mp4", keep, audioInput: "d.wav", embedCaptions: "cut.srt" },
      "/tmp/graph.txt",
    );
    const joined = args.join(" ");
    expect(joined).toContain("-i in.mp4 -i d.wav -i cut.srt");
    expect(joined).toContain("-map 2:s:0");
  });

  it("can both burn and embed captions in one pass", () => {
    const args = buildRenderArgs(
      { input: "in.mp4", output: "out.mp4", keep, burnSubtitles: "s.srt", embedCaptions: "cut.srt" },
      "/tmp/graph.txt",
    );
    const joined = args.join(" ");
    expect(joined).toContain("-map [vout]");
    expect(joined).toContain("-map 1:s:0");
    expect(joined).toContain("-c:s mov_text");
  });
});

describe("escapeSubtitlesPath", () => {
  it("escapes colons, backslashes and quotes", () => {
    // input:  C : \ a ' b . s r t
    // \ -> \\, : -> \:, ' -> \'
    expect(escapeSubtitlesPath("C:\\a'b.srt")).toBe("C\\:\\\\a\\'b.srt");
  });
});
