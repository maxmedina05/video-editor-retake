import { useEffect, useRef, useState, type RefObject } from "react";
import type { Range } from "../types";
import { vttBlobUrl } from "../captions";
import { clock, toEditedTime } from "../util";

interface Props {
  videoRef: RefObject<HTMLVideoElement>;
  src: string;
  playEdited: boolean;
  ranges: Range[];
  /** WebVTT text to attach as a captions track, or null for none */
  vtt: string | null;
  /** whether captions are currently shown */
  captionsOn: boolean;
  onToggleCaptions: () => void;
  onTime: (t: number) => void;
  onDuration: (d: number) => void;
}

const ENTER_EPS = 0.02; // treat as inside a cut slightly early
const EXIT_EPS = 0.05; // don't re-trigger right at the far edge

export default function VideoPlayer({
  videoRef,
  src,
  playEdited,
  ranges,
  vtt,
  captionsOn,
  onToggleCaptions,
  onTime,
  onDuration,
}: Props) {
  // Keep the latest ranges/flag in refs so the rAF loop reads fresh values
  // without re-subscribing every render.
  const rangesRef = useRef(ranges);
  rangesRef.current = ranges;
  const editRef = useRef(playEdited);
  editRef.current = playEdited;
  const trackRef = useRef<HTMLTrackElement>(null);

  // Position/duration mirrored into state for the edited-time overlay only.
  const [now, setNow] = useState(0);
  const [dur, setDur] = useState(0);

  // Turn the VTT string into a Blob URL for the <track>. Revoke the old one on
  // change/unmount so we don't leak object URLs across edit/result switches.
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!vtt) {
      setBlobUrl(null);
      return;
    }
    const url = vttBlobUrl(vtt);
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [vtt]);

  // Drive the TextTrack's visibility imperatively — the native `default`
  // attribute alone isn't a reliable on/off switch across reloads.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const apply = () => {
      const tt = v.textTracks[0];
      if (tt) tt.mode = captionsOn && blobUrl ? "showing" : "hidden";
    };
    apply();
    const track = trackRef.current;
    track?.addEventListener("load", apply);
    return () => track?.removeEventListener("load", apply);
  }, [captionsOn, blobUrl, videoRef]);

  /** If t is inside an enabled cut range, jump to its end. Returns true if it jumped. */
  const skipIfNeeded = (): boolean => {
    const video = videoRef.current;
    if (!video || !editRef.current) return false;
    const t = video.currentTime;
    for (const r of rangesRef.current) {
      if (t >= r.start - ENTER_EPS && t < r.end - EXIT_EPS) {
        video.currentTime = r.end;
        return true;
      }
    }
    return false;
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const report = (t: number) => {
      onTime(t);
      setNow(t);
    };
    let raf = 0;
    const tick = () => {
      report(video.currentTime);
      skipIfNeeded();
      if (!video.paused && !video.ended) raf = requestAnimationFrame(tick);
    };
    const onPlay = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    };
    const onPause = () => cancelAnimationFrame(raf);
    const onTimeUpdate = () => report(video.currentTime);
    const onSeeked = () => {
      // handle seeking directly into a cut range
      if (!skipIfNeeded()) report(video.currentTime);
    };
    const onLoaded = () => {
      onDuration(video.duration);
      setDur(video.duration);
    };

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("loadedmetadata", onLoaded);
    if (video.readyState >= 1) onLoaded();

    return () => {
      cancelAnimationFrame(raf);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("loadedmetadata", onLoaded);
    };
  }, [videoRef, onTime, onDuration]);

  // When "play edited" is toggled on while sitting inside a cut, jump out now.
  useEffect(() => {
    if (playEdited) skipIfNeeded();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playEdited]);

  return (
    <div className="player">
      <video ref={videoRef} src={src} controls playsInline crossOrigin="anonymous">
        {blobUrl && (
          <track
            key={blobUrl}
            ref={trackRef}
            kind="captions"
            src={blobUrl}
            srcLang="en"
            label="Captions"
            default
          />
        )}
      </video>
      {playEdited && dur > 0 && (
        <div className="edited-clock" data-testid="edited-clock" title="Time on the edited (post-cut) timeline">
          {clock(toEditedTime(now, ranges))} / {clock(toEditedTime(dur, ranges))}
          <span>edited</span>
        </div>
      )}
      {blobUrl && (
        <button
          type="button"
          className={`cc-toggle ${captionsOn ? "on" : ""}`}
          data-testid="cc-toggle"
          aria-pressed={captionsOn}
          title={captionsOn ? "Hide captions" : "Show captions"}
          onClick={onToggleCaptions}
        >
          CC
        </button>
      )}
    </div>
  );
}
