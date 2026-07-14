import { useEffect, useState } from "react";
import Home from "./components/Home";
import Editor from "./components/Editor";
import { fetchConfig, fetchRecents, type RecentView, type SessionInfo } from "./api";

/**
 * Router between the home screen (pick any video) and the editor (one active
 * session). Switching video returns home and drops the previous editor state.
 */
export default function App() {
  const [loaded, setLoaded] = useState(false);
  const [pickerAvailable, setPickerAvailable] = useState(false);
  const [mediaRoot, setMediaRoot] = useState(false);
  const [hasSubtitlesFilter, setHasSubtitlesFilter] = useState(false);
  const [recents, setRecents] = useState<RecentView[]>([]);
  const [session, setSession] = useState<SessionInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchConfig()
      .then((c) => {
        if (cancelled) return;
        setPickerAvailable(c.pickerAvailable);
        setMediaRoot(c.mediaRoot);
        setHasSubtitlesFilter(c.hasSubtitlesFilter);
        setRecents(c.recents);
        if (c.initialSession) setSession(c.initialSession); // launched with a file arg
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const goHome = () => {
    setSession(null);
    // refresh recents so the just-edited file shows at the top
    fetchRecents().then(setRecents).catch(() => {});
  };

  if (!loaded) return null;

  if (session) {
    return (
      <Editor
        key={session.id}
        session={session}
        initialHasSubtitlesFilter={hasSubtitlesFilter}
        onHome={goHome}
      />
    );
  }

  return (
    <Home
      pickerAvailable={pickerAvailable}
      mediaRoot={mediaRoot}
      recents={recents}
      onRecents={setRecents}
      onOpened={setSession}
    />
  );
}
