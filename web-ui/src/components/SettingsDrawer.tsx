import { useState } from "react";
import { MODE_BLURB, type Mode, type Settings } from "../types";

interface Props {
  open: boolean;
  settings: Settings;
  analyzing: boolean;
  /** advanced fields the user has explicitly overridden */
  overrides: Set<keyof Settings>;
  /** force a fresh analyze (ignore the on-disk cache) */
  fresh: boolean;
  onModeChange: (mode: Mode) => void;
  onChange: (patch: Partial<Settings>) => void;
  onFreshChange: (fresh: boolean) => void;
  onReset: () => void;
  onClose: () => void;
  onReanalyze: () => void;
}

const MODES: { key: Mode; label: string }[] = [
  { key: "conservative", label: "Conservative" },
  { key: "balanced", label: "Balanced" },
  { key: "aggressive", label: "Aggressive" },
];

type NumField = { key: keyof Settings; label: string; step: number; min: number };

/** Plan-only knobs — editing these re-plans instantly (no progress modal). */
const INSTANT_FIELDS: NumField[] = [
  { key: "maxPause", label: "Max pause left (s)", step: 0.05, min: 0 },
  { key: "maxCutPerSilence", label: "Max cut per silence (s, 0 = uncapped)", step: 0.5, min: 0 },
  { key: "minKeep", label: "Min keep / anti-flicker (s)", step: 0.05, min: 0 },
  { key: "padding", label: "Padding (s)", step: 0.05, min: 0 },
];

/** Detection knobs — changing these needs a full Re-analyze. */
const REANALYZE_FIELDS: NumField[] = [
  { key: "minSilence", label: "Min silence (s)", step: 0.1, min: 0 },
  { key: "threshold", label: "Silence threshold (dB)", step: 1, min: -90 },
];

const MODELS = ["tiny.en", "base.en", "small.en", "medium.en", "large-v3"];

/**
 * Parse a numeric field value locale-safely: accept a comma decimal separator
 * (some OS locales render/emit "1,2"), normalise to a dot, and reject non-finite
 * input so a stray value never reaches the analyze request as NaN.
 */
function parseDecimal(raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export default function SettingsDrawer({
  open,
  settings,
  analyzing,
  overrides,
  fresh,
  onModeChange,
  onChange,
  onFreshChange,
  onReset,
  onClose,
  onReanalyze,
}: Props) {
  // Advanced section open/closed state persists while the drawer stays mounted.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const hasOverrides = overrides.size > 0;

  const ovrTag = (key: keyof Settings) =>
    overrides.has(key) ? <span className="ovr-tag">overridden</span> : null;

  const renderNum = (f: NumField) => (
    <label key={f.key} className="field">
      <span>
        {f.label} {ovrTag(f.key)}
      </span>
      <input
        type="number"
        inputMode="decimal"
        step={f.step}
        min={f.min}
        data-testid={`field-${f.key}`}
        value={settings[f.key] as number}
        onChange={(e) => {
          const n = parseDecimal(e.target.value);
          if (n !== null) onChange({ [f.key]: n } as Partial<Settings>);
        }}
      />
    </label>
  );

  return (
    <aside className={`drawer ${open ? "open" : ""}`} data-testid="settings-drawer">
      <div className="drawer-head">
        <h2>Settings</h2>
        <button className="icon-btn" onClick={onClose} aria-label="close settings">
          ×
        </button>
      </div>

      <div className="drawer-body">
        <label className="field">
          <span>Mode</span>
          <select
            data-testid="mode-select"
            value={settings.mode}
            onChange={(e) => onModeChange(e.target.value as Mode)}
          >
            {MODES.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <p className="hint" data-testid="mode-blurb">
          {MODE_BLURB[settings.mode]} · applies instantly
        </p>

        <details
          className="advanced"
          data-testid="advanced"
          open={advancedOpen}
          onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary className="advanced-summary">
            Advanced
            {hasOverrides && <span className="ovr-count"> · {overrides.size} overridden</span>}
          </summary>

          <div className="advanced-body">
            {hasOverrides && (
              <button
                type="button"
                className="link-btn"
                data-testid="reset-overrides"
                onClick={onReset}
              >
                Reset to mode defaults
              </button>
            )}

            <p className="group-head" data-testid="instant-group">
              Applies instantly
              <span className="group-sub">reshapes the plan — no re-analyze</span>
            </p>

            {INSTANT_FIELDS.map(renderNum)}

            <label className="field">
              <span>Filler words (comma-separated) {ovrTag("fillerWords")}</span>
              <input
                type="text"
                value={settings.fillerWords}
                onChange={(e) => onChange({ fillerWords: e.target.value })}
              />
            </label>

            <label className="field-row">
              <input
                type="checkbox"
                data-testid="fillers-toggle"
                checked={settings.fillers}
                onChange={(e) => onChange({ fillers: e.target.checked })}
              />
              <span>Remove filler words {ovrTag("fillers")}</span>
            </label>

            <p className="group-head" data-testid="reanalyze-group">
              Needs re-analysis
              <span className="group-sub">re-runs detection — click Re-analyze below</span>
            </p>

            {REANALYZE_FIELDS.map(renderNum)}

            <label className="field">
              <span>Whisper model {ovrTag("model")}</span>
              <select
                value={settings.model}
                onChange={(e) => onChange({ model: e.target.value })}
              >
                {MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>

            <label className="field-row">
              <input
                type="checkbox"
                checked={settings.smart}
                onChange={(e) => onChange({ smart: e.target.checked })}
              />
              <span>Smart cuts (Claude) — filler / false-start / ramble {ovrTag("smart")}</span>
            </label>

            <label className="field-row">
              <input
                type="checkbox"
                data-testid="fresh-toggle"
                checked={fresh}
                onChange={(e) => onFreshChange(e.target.checked)}
              />
              <span>Fresh analysis (ignore cache) — re-run everything from scratch</span>
            </label>
          </div>
        </details>

        <button
          className="btn primary"
          data-testid="reanalyze-btn"
          disabled={analyzing}
          onClick={onReanalyze}
        >
          {analyzing ? "Analyzing…" : "Re-analyze"}
        </button>
      </div>
    </aside>
  );
}
