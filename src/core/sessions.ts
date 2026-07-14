import { randomUUID } from "node:crypto";
import type { MediaInfo } from "./types.js";

/**
 * In-memory registry of open-file sessions. A session is created when a video
 * is opened (via file dialog, pasted path, or a recent); every media/analyze/
 * render request references a session by id so the browser never sends raw
 * filesystem paths to those endpoints. Multiple sessions can coexist.
 */

export interface Session {
  id: string;
  path: string;
  mediaInfo: MediaInfo;
  /** absolute path to the last successfully rendered output (set by /api/render) */
  renderedVideo?: string;
  /** absolute path to the caption sidecar for that render */
  renderedSrt?: string;
}

export interface SessionRegistry {
  /** Create and store a new session, returning it. */
  create(path: string, mediaInfo: MediaInfo): Session;
  /** Look up a session by id (undefined if unknown/forged). */
  get(id: string): Session | undefined;
  /** Whether a session id is registered. */
  has(id: string): boolean;
  /** All sessions, insertion order. */
  list(): Session[];
  /** Remove a session; returns true if one was removed. */
  remove(id: string): boolean;
}

/**
 * @param genId injectable id generator (tests pass a deterministic one).
 */
export function createSessionRegistry(genId: () => string = randomUUID): SessionRegistry {
  const map = new Map<string, Session>();
  return {
    create(path, mediaInfo) {
      const session: Session = { id: genId(), path, mediaInfo };
      map.set(session.id, session);
      return session;
    },
    get(id) {
      return map.get(id);
    },
    has(id) {
      return map.has(id);
    },
    list() {
      return [...map.values()];
    },
    remove(id) {
      return map.delete(id);
    },
  };
}
