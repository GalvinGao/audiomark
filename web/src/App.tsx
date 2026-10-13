import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { match } from "ts-pattern";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";
import SpectrogramPlugin from "wavesurfer.js/dist/plugins/spectrogram.esm.js";
import TimelinePlugin from "wavesurfer.js/dist/plugins/timeline.esm.js";
import { type Health, fetchHealth, transcribe } from "./api";
import { formatTime, formatTimePrecise } from "./format";
import { MicRecorder } from "./mic";

/**
 * - idle: paused, not recording (before first play, after Esc, at the end)
 * - playing: listening
 * - recording: paused, mic open, a note is being spoken
 */
type Mode = "idle" | "playing" | "recording";

type Status = "transcribing" | "done" | "error";

interface Annotation {
  id: string;
  /** Where the listening stretch that led to this note began. */
  start: number;
  /** Where playback was paused to speak the note. The note's anchor. */
  time: number;
  createdAt: number;
  /** Length of the spoken note, in seconds. */
  noteDuration: number;
  status: Status;
  text: string;
  language?: string;
  error?: string;
}

interface PendingNote {
  start: number;
  time: number;
}

/** Shorter recordings are treated as an accidental double-tap and dropped. */
const MIN_NOTE_MS = 400;
const SKIP_SECONDS = 5;

const LANGUAGES = [
  { value: "", label: "Auto" },
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
  { value: "yue", label: "粵語" },
];

const COLORS = {
  wave: "#5b6170",
  progress: "#c7cbd6",
  cursor: "#f5f6f8",
  range: "rgba(124, 156, 255, 0.10)",
  marker: "rgba(124, 156, 255, 0.95)",
  markerSelected: "#ffd166",
  live: "#ff5d5d",
};

/**
 * A marker is only a border line, so its label needs its own fill. Styled
 * inline: it renders inside wavesurfer's shadow root, out of reach of CSS.
 */
function markerLabel(text: string, color: string) {
  // wavesurfer restyles the content element itself, so the visible pill is a child.
  const content = document.createElement("span");
  const pill = document.createElement("span");
  pill.textContent = text;
  Object.assign(pill.style, {
    display: "inline-block",
    padding: "1px 5px",
    borderRadius: "0 4px 4px 0",
    background: color,
    color: "#0b1020",
    whiteSpace: "nowrap",
  });
  content.append(pill);
  return content;
}

function storageKey(file: File) {
  return `audiomark:${file.name}:${file.size}`;
}

function loadSaved(file: File): Annotation[] {
  try {
    const raw = localStorage.getItem(storageKey(file));
    if (!raw) return [];
    const saved: Annotation[] = JSON.parse(raw);
    // The note audio lived in memory only, so an unfinished job cannot resume.
    return saved.map((a) =>
      a.status === "transcribing" ? { ...a, status: "error", error: "Interrupted by reload" } : a,
    );
  } catch {
    return [];
  }
}

function readStoredLanguage() {
  try {
    return localStorage.getItem("audiomark:language") ?? "";
  } catch {
    return "";
  }
}

function sortByTime(list: Annotation[]) {
  return list.toSorted((a, b) => a.time - b.time || a.createdAt - b.createdAt);
}

function toPlainText(list: Annotation[]) {
  return list
    .filter((a) => a.status === "done" && a.text)
    .map((a) => `[${formatTime(a.start)}–${formatTime(a.time)}] ${a.text}`)
    .join("\n");
}

function isTypingTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

export function App() {
  const [file, setFile] = useState<File | null>(null);
  const [ready, setReady] = useState(false);
  const [duration, setDuration] = useState(0);
  const [mode, setModeState] = useState<Mode>("idle");
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [pending, setPending] = useState<PendingNote | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [language, setLanguage] = useState(readStoredLanguage);
  const [micError, setMicError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [health, setHealth] = useState<Health | "offline" | null>(null);

  const waveRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null);
  const micRef = useRef(new MicRecorder());
  const blobsRef = useRef(new Map<string, Blob>());
  // Read from wavesurfer and keyboard callbacks, which outlive any one render.
  const modeRef = useRef<Mode>("idle");
  const pendingRef = useRef<PendingNote | null>(null);
  const segmentStartRef = useRef(0);
  const languageRef = useRef(language);
  languageRef.current = language;

  const setMode = useCallback((next: Mode) => {
    modeRef.current = next;
    setModeState(next);
  }, []);

  const sorted = useMemo(() => sortByTime(annotations), [annotations]);
  const transcribingCount = annotations.filter((a) => a.status === "transcribing").length;
  const doneCount = annotations.filter((a) => a.status === "done" && a.text).length;

  // --- server status -------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      let next: Health | "offline";
      try {
        next = await fetchHealth();
      } catch {
        next = "offline";
      }
      if (cancelled) return;
      setHealth(next);
      // Keep polling until the model is up; afterwards a failed transcription
      // is the signal that something went away.
      if (next === "offline" || !next.ready) timer = window.setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  // --- player --------------------------------------------------------------

  useEffect(() => {
    const container = waveRef.current;
    if (!file || !container) return;

    const regions = RegionsPlugin.create();
    const ws = WaveSurfer.create({
      container,
      height: 96,
      waveColor: COLORS.wave,
      progressColor: COLORS.progress,
      cursorColor: COLORS.cursor,
      cursorWidth: 2,
      barWidth: 2,
      barGap: 1,
      barRadius: 1,
      dragToSeek: true,
      // The spectrogram is computed from the decoded buffer; the default 8 kHz
      // would cap it at 4 kHz.
      sampleRate: 32000,
      plugins: [
        regions,
        TimelinePlugin.create({
          height: 18,
          insertPosition: "beforebegin",
          style: { color: "#8a8f9c", fontSize: "11px" },
        }),
        SpectrogramPlugin.create({
          height: 200,
          labels: true,
          labelsBackground: "rgba(14, 15, 18, 0.6)",
          labelsColor: "#8a8f9c",
          labelsHzColor: "#8a8f9c",
          scale: "mel",
          fftSamples: 1024,
          frequencyMax: 16000,
          useWebWorker: true,
        }),
      ],
    });
    wsRef.current = ws;
    regionsRef.current = regions;

    const updateClock = (t: number) => {
      if (timeRef.current) timeRef.current.textContent = formatTimePrecise(t);
    };

    ws.on("ready", (d) => {
      setDuration(d);
      setReady(true);
      // Starting right away is the point of dropping a file in. Autoplay rules
      // may still refuse; then Space starts it.
      ws.play().catch(() => {});
    });
    ws.on("error", (error) => setLoadError(error.message));
    ws.on("play", () => {
      segmentStartRef.current = ws.getCurrentTime();
      setMode("playing");
    });
    ws.on("pause", () => {
      // Recording pauses the player too; that is not a return to idle.
      if (modeRef.current === "playing") setMode("idle");
    });
    ws.on("finish", () => {
      if (modeRef.current === "playing") setMode("idle");
    });
    ws.on("seeking", (t) => {
      // A seek while listening starts a new listening stretch. While recording
      // or idle, the stretch is already fixed or starts on the next play.
      if (modeRef.current === "playing") segmentStartRef.current = t;
      updateClock(t);
    });
    ws.on("timeupdate", updateClock);
    regions.on("region-clicked", (region, event) => {
      if (!region.id.startsWith("marker:")) return;
      // Selecting a note is not a seek; the marker sits on top of the waveform.
      event.stopPropagation();
      const id = region.id.slice("marker:".length);
      setSelectedId(id);
      document
        .getElementById(`note-${id}`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });

    const url = URL.createObjectURL(file);
    ws.load(url).catch((error: unknown) => {
      setLoadError(error instanceof Error ? error.message : String(error));
    });

    return () => {
      ws.destroy();
      URL.revokeObjectURL(url);
      wsRef.current = null;
      regionsRef.current = null;
    };
  }, [file, setMode]);

  // Mirror notes onto the waveform: a faint band for the stretch that was
  // listened to, and a marker at the moment the note was spoken.
  useEffect(() => {
    const regions = regionsRef.current;
    if (!regions || !ready) return;
    regions.clearRegions();
    sorted.forEach((a, index) => {
      if (a.time - a.start > 0.05) {
        const band = regions.addRegion({
          id: `band:${a.id}`,
          start: a.start,
          end: a.time,
          color: a.id === selectedId ? "rgba(255, 209, 102, 0.12)" : COLORS.range,
          drag: false,
          resize: false,
        });
        // Bands overlap freely; they must not swallow clicks meant to seek.
        if (band.element) band.element.style.pointerEvents = "none";
      }
      const color = a.id === selectedId ? COLORS.markerSelected : COLORS.marker;
      regions.addRegion({
        id: `marker:${a.id}`,
        start: a.time,
        color,
        content: markerLabel(String(index + 1), color),
        drag: false,
        resize: false,
      });
    });
    if (pending) {
      regions.addRegion({
        id: "live",
        start: pending.time,
        color: COLORS.live,
        content: markerLabel("REC", COLORS.live),
        drag: false,
        resize: false,
      });
    }
  }, [sorted, pending, selectedId, ready]);

  // Persist notes per audio file. Audio blobs stay in memory.
  useEffect(() => {
    if (!file) return;
    try {
      localStorage.setItem(storageKey(file), JSON.stringify(annotations));
    } catch {
      // Storage full or blocked: export still works.
    }
  }, [file, annotations]);

  // --- notes ---------------------------------------------------------------

  const updateAnnotation = useCallback((id: string, patch: Partial<Annotation>) => {
    setAnnotations((list) => list.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }, []);

  const runTranscription = useCallback(
    (id: string, blob: Blob) => {
      updateAnnotation(id, { status: "transcribing", error: undefined });
      transcribe(blob, languageRef.current)
        .then((result) =>
          updateAnnotation(id, { status: "done", text: result.text, language: result.language }),
        )
        .catch((error: unknown) =>
          updateAnnotation(id, {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
    },
    [updateAnnotation],
  );

  const startRecording = useCallback(() => {
    const ws = wsRef.current;
    if (!ws) return;
    // Set before pausing so the pause handler does not drop back to idle.
    setMode("recording");
    ws.pause();
    const time = ws.getCurrentTime();
    const note = { start: Math.min(segmentStartRef.current, time), time };
    pendingRef.current = note;
    setPending(note);
    setMicError(null);
    micRef.current.start().catch((error: unknown) => {
      if (pendingRef.current !== note) return;
      pendingRef.current = null;
      setPending(null);
      setMode("idle");
      setMicError(error instanceof Error ? error.message : String(error));
    });
  }, [setMode]);

  /** Ends the note without waiting for the recorder; upload runs in the background. */
  const finishRecording = useCallback(
    (save: boolean) => {
      const note = pendingRef.current;
      pendingRef.current = null;
      setPending(null);
      setMode("idle");
      void micRef.current.stop().then((recording) => {
        if (!save || !note || !recording || recording.duration < MIN_NOTE_MS) return;
        const id = crypto.randomUUID();
        blobsRef.current.set(id, recording.blob);
        setAnnotations((list) => [
          ...list,
          {
            id,
            start: note.start,
            time: note.time,
            createdAt: Date.now(),
            noteDuration: recording.duration / 1000,
            status: "transcribing",
            text: "",
          },
        ]);
        runTranscription(id, recording.blob);
      });
    },
    [runTranscription, setMode],
  );

  const toggle = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || !ready) return;
    match(modeRef.current)
      .with("playing", () => startRecording())
      .with("recording", () => {
        finishRecording(true);
        void ws.play();
      })
      .with("idle", () => void ws.play())
      .exhaustive();
  }, [ready, startRecording, finishRecording]);

  const discard = useCallback(() => {
    if (modeRef.current === "recording") finishRecording(false);
  }, [finishRecording]);

  const seekTo = useCallback((time: number) => {
    // Moving the playhead never changes play/pause state, and never moves the
    // anchor of a note being recorded.
    wsRef.current?.setTime(time);
  }, []);

  const removeAnnotation = useCallback((id: string) => {
    blobsRef.current.delete(id);
    setAnnotations((list) => list.filter((a) => a.id !== id));
  }, []);

  // --- keyboard ------------------------------------------------------------

  const keyHandlers = useRef({ toggle, discard });
  keyHandlers.current = { toggle, discard };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) {
        // Esc leaves a transcript field so Space works again.
        if (event.key === "Escape" && event.target instanceof HTMLElement) event.target.blur();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.code === "Space") {
        event.preventDefault();
        // A focused button would also "click" on Space; Space belongs to the player.
        if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur();
        if (!event.repeat) keyHandlers.current.toggle();
      } else if (event.key === "Escape") {
        keyHandlers.current.discard();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        wsRef.current?.skip(-SKIP_SECONDS);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        wsRef.current?.skip(SKIP_SECONDS);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // --- file intake ---------------------------------------------------------

  const openFile = useCallback(
    (next: File) => {
      if (modeRef.current === "recording") finishRecording(false);
      setMode("idle");
      setReady(false);
      setLoadError(null);
      setSelectedId(null);
      blobsRef.current.clear();
      setAnnotations(loadSaved(next));
      setFile(next);
      micRef.current.ensureStream().catch((error: unknown) => {
        setMicError(error instanceof Error ? error.message : String(error));
      });
    },
    [finishRecording, setMode],
  );

  useEffect(() => {
    let depth = 0;
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;
    const onEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth++;
      setDragging(true);
    };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onOver = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault();
    };
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      depth = 0;
      setDragging(false);
      const dropped = [...(event.dataTransfer?.files ?? [])].find(
        (f) => f.type.startsWith("audio/") || f.type.startsWith("video/"),
      );
      if (dropped) openFileRef.current(dropped);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);
  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;

  // --- export --------------------------------------------------------------

  const exportJson = () => {
    if (!file) return;
    const data = {
      source: file.name,
      duration,
      exportedAt: new Date().toISOString(),
      annotations: sorted.map((a) => ({
        id: a.id,
        start: a.start,
        time: a.time,
        noteDuration: a.noteDuration,
        text: a.text,
        language: a.language,
        status: a.status,
      })),
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${file.name.replace(/\.[^.]+$/, "")}.annotations.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          audiomark
        </div>
        {file && (
          <div className="file-name" title={file.name}>
            {file.name}
          </div>
        )}
        <div className="topbar-actions">
          <ServerStatus health={health} />
          <label className="select">
            <span className="visually-hidden">Note language</span>
            <select
              value={language}
              onChange={(event) => {
                setLanguage(event.target.value);
                try {
                  localStorage.setItem("audiomark:language", event.target.value);
                } catch {
                  // Not remembered; still applies to this session.
                }
              }}
            >
              {LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          {file && (
            <>
              <CopyAllButton
                transcribing={transcribingCount}
                count={doneCount}
                getText={() => toPlainText(sorted)}
              />
              <button className="button" onClick={exportJson} disabled={annotations.length === 0}>
                Export JSON
              </button>
            </>
          )}
        </div>
      </header>

      {!file ? (
        <DropZone onFile={openFile} />
      ) : (
        <main className="workspace">
          <section className="player" aria-label="Audio">
            <div className="wave" ref={waveRef} />
            {!ready && !loadError && <div className="player-overlay">Decoding audio…</div>}
            {loadError && (
              <div className="player-overlay error">Could not open this file: {loadError}</div>
            )}
          </section>

          <Transport
            mode={mode}
            ready={ready}
            duration={duration}
            pending={pending}
            timeRef={timeRef}
            mic={micRef.current}
            micError={micError}
            onToggle={toggle}
            onDiscard={discard}
          />

          <section className="notes" aria-label="Notes">
            {sorted.length === 0 ? (
              <p className="notes-empty">
                Notes appear here. Press <kbd>Space</kbd> while listening, say what you think, and
                press <kbd>Space</kbd> again to keep listening.
              </p>
            ) : (
              <ol className="note-list">
                {sorted.map((a, index) => (
                  <NoteItem
                    key={a.id}
                    index={index + 1}
                    note={a}
                    selected={a.id === selectedId}
                    canRetry={blobsRef.current.has(a.id)}
                    blob={blobsRef.current.get(a.id)}
                    recording={mode === "recording"}
                    onSelect={() => setSelectedId(a.id)}
                    onSeek={() => {
                      setSelectedId(a.id);
                      seekTo(a.start);
                    }}
                    onChange={(text) => updateAnnotation(a.id, { text })}
                    onRetry={() => {
                      const blob = blobsRef.current.get(a.id);
                      if (blob) runTranscription(a.id, blob);
                    }}
                    onRemove={() => removeAnnotation(a.id)}
                  />
                ))}
              </ol>
            )}
          </section>
        </main>
      )}

      {dragging && (
        <div className="drag-veil" aria-hidden>
          <div>Drop audio to start</div>
        </div>
      )}
    </div>
  );
}

// --- pieces ------------------------------------------------------------------

function DropZone({ onFile }: { onFile: (file: File) => void }) {
  return (
    <main className="dropzone">
      <label className="dropzone-card">
        <input
          type="file"
          accept="audio/*,video/*"
          className="visually-hidden"
          onChange={(event) => {
            const picked = event.target.files?.[0];
            if (picked) onFile(picked);
          }}
        />
        <span className="dropzone-title">Drop an audio file</span>
        <span className="dropzone-sub">or click to choose. It starts playing right away.</span>
        <span className="dropzone-keys">
          <span>
            <kbd>Space</kbd> pause and speak a note · again to save and keep listening
          </span>
          <span>
            <kbd>Esc</kbd> discard the note · <kbd>←</kbd> <kbd>→</kbd> skip 5 s
          </span>
        </span>
      </label>
    </main>
  );
}

function ServerStatus({ health }: { health: Health | "offline" | null }) {
  const [label, tone, title] = useMemo((): [string, string, string] => {
    if (health === null) return ["Connecting…", "muted", ""];
    if (health === "offline") return ["Server offline", "error", "Start it with: pnpm dev:server"];
    if (health.error) return ["Model failed", "error", health.error];
    if (!health.ready) return ["Loading model…", "warn", health.model];
    return ["Whisper ready", "ok", `${health.backend} · ${health.model}`];
  }, [health]);
  return (
    <span className={`status status-${tone}`} title={title}>
      <span className="status-dot" aria-hidden />
      {label}
    </span>
  );
}

function Transport(props: {
  mode: Mode;
  ready: boolean;
  duration: number;
  pending: PendingNote | null;
  timeRef: React.RefObject<HTMLSpanElement | null>;
  mic: MicRecorder;
  micError: string | null;
  onToggle: () => void;
  onDiscard: () => void;
}) {
  const { mode, ready, duration, pending } = props;
  const label = match(mode)
    .with("playing", () => "Pause and speak")
    .with("recording", () => "Save note and play")
    .with("idle", () => "Play")
    .exhaustive();

  return (
    <div className={`transport transport-${mode}`}>
      <button
        className="transport-button"
        onClick={props.onToggle}
        disabled={!ready}
        aria-label={label}
        title={`${label} (Space)`}
      >
        {mode === "playing" ? <MicIcon /> : <PlayIcon />}
      </button>
      <div className="transport-clock">
        <span ref={props.timeRef}>0:00.0</span>
        <span className="transport-duration"> / {formatTime(duration)}</span>
      </div>
      <div className="transport-state">
        {mode === "recording" && pending ? (
          <RecordingState mic={props.mic} pending={pending} onDiscard={props.onDiscard} />
        ) : (
          <span className="transport-hint">
            {props.micError ? (
              <span className="error-text">Microphone unavailable: {props.micError}</span>
            ) : (
              match(mode)
                .with("playing", () => (
                  <>
                    Listening. <kbd>Space</kbd> to pause and speak a note.
                  </>
                ))
                .otherwise(() => (
                  <>
                    Paused. <kbd>Space</kbd> to play.
                  </>
                ))
            )}
          </span>
        )}
      </div>
    </div>
  );
}

function RecordingState({
  mic,
  pending,
  onDiscard,
}: {
  mic: MicRecorder;
  pending: PendingNote;
  onDiscard: () => void;
}) {
  const meterRef = useRef<HTMLSpanElement>(null);
  const elapsedRef = useRef<HTMLSpanElement>(null);

  // Drives the level meter and timer straight on the DOM; a React render per
  // frame would be wasted work.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      meterRef.current?.style.setProperty("--level", mic.level().toFixed(3));
      if (elapsedRef.current) elapsedRef.current.textContent = formatTime(mic.elapsed / 1000);
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [mic]);

  return (
    <span className="recording">
      <span className="recording-dot" aria-hidden />
      <span>
        Recording note at <strong>{formatTime(pending.time)}</strong>
        <span className="muted">
          {" "}
          · covers {formatTime(pending.start)}–{formatTime(pending.time)}
        </span>
      </span>
      <span className="meter" ref={meterRef} aria-hidden />
      <span className="recording-elapsed" ref={elapsedRef}>
        0:00
      </span>
      <span className="transport-hint">
        <kbd>Space</kbd> save and play · <kbd>Esc</kbd>{" "}
        <button className="link-button" onClick={onDiscard}>
          discard
        </button>
      </span>
    </span>
  );
}

function CopyAllButton({
  transcribing,
  count,
  getText,
}: {
  transcribing: number;
  count: number;
  getText: () => string;
}) {
  const [copied, copy] = useCopy();
  if (transcribing > 0) {
    return (
      <button className="button button-primary" disabled aria-busy>
        <Spinner />
        Transcribing {transcribing}…
      </button>
    );
  }
  return (
    <button
      className="button button-primary"
      disabled={count === 0}
      onClick={() => copy(getText())}
      title="Copy every transcribed note as text"
    >
      {copied ? "Copied" : `Copy all${count ? ` (${count})` : ""}`}
    </button>
  );
}

function NoteItem(props: {
  index: number;
  note: Annotation;
  selected: boolean;
  canRetry: boolean;
  blob: Blob | undefined;
  recording: boolean;
  onSelect: () => void;
  onSeek: () => void;
  onChange: (text: string) => void;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const { note } = props;
  const [copied, copy] = useCopy();

  return (
    <li
      id={`note-${note.id}`}
      className={`note${props.selected ? " note-selected" : ""}`}
      onClick={props.onSelect}
    >
      <div className="note-head">
        <span className="note-index">{props.index}</span>
        <button className="time-chip" onClick={props.onSeek} title="Move the playhead here">
          {formatTime(note.start)}–{formatTime(note.time)}
        </button>
        {note.language && <span className="note-lang">{note.language}</span>}
        <span className="note-actions">
          <NotePlayback blob={props.blob} disabled={props.recording} />
          <button
            className="icon-button"
            onClick={() => copy(note.text)}
            disabled={note.status !== "done" || !note.text}
            aria-busy={note.status === "transcribing"}
            title={note.status === "transcribing" ? "Transcribing…" : "Copy text"}
          >
            <CopyStateIcon busy={note.status === "transcribing"} copied={copied} />
          </button>
          <button className="icon-button" onClick={props.onRemove} title="Delete note">
            <TrashIcon />
          </button>
        </span>
      </div>
      {match(note.status)
        .with("transcribing", () => (
          <div className="note-skeleton" aria-label="Transcribing">
            <span />
            <span />
          </div>
        ))
        .with("error", () => (
          <div className="note-error">
            {note.error ?? "Transcription failed"}
            {props.canRetry && (
              <button className="link-button" onClick={props.onRetry}>
                Retry
              </button>
            )}
          </div>
        ))
        .with("done", () => (
          <textarea
            className="note-text"
            value={note.text}
            placeholder="No speech detected"
            rows={1}
            onChange={(event) => props.onChange(event.target.value)}
          />
        ))
        .exhaustive()}
    </li>
  );
}

function NotePlayback({ blob, disabled }: { blob: Blob | undefined; disabled: boolean }) {
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(
    () => () => {
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        URL.revokeObjectURL(audio.src);
      }
    },
    [],
  );

  if (!blob) return null;
  return (
    <button
      className="icon-button"
      disabled={disabled}
      title={playing ? "Stop" : "Play the spoken note"}
      onClick={() => {
        if (playing && audioRef.current) {
          audioRef.current.pause();
          audioRef.current.currentTime = 0;
          setPlaying(false);
          return;
        }
        if (!audioRef.current) {
          audioRef.current = new Audio(URL.createObjectURL(blob));
          audioRef.current.addEventListener("ended", () => setPlaying(false));
        }
        void audioRef.current.play();
        setPlaying(true);
      }}
    >
      {playing ? <StopIcon /> : <SpeakerIcon />}
    </button>
  );
}

function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);
  const copy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    });
  }, []);
  return [copied, copy];
}

// --- icons -------------------------------------------------------------------

function CopyStateIcon({ busy, copied }: { busy: boolean; copied: boolean }) {
  if (busy) return <Spinner />;
  return copied ? <CheckIcon /> : <CopyIcon />;
}

function Spinner() {
  return <span className="spinner" aria-hidden />;
}

const iconProps = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

function PlayIcon() {
  return (
    <svg {...iconProps} width={22} height={22}>
      <path d="M7 4.5v15l12-7.5z" fill="currentColor" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg {...iconProps} width={22} height={22}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg {...iconProps}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg {...iconProps}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg {...iconProps}>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
    </svg>
  );
}

function SpeakerIcon() {
  return (
    <svg {...iconProps}>
      <path d="M11 5L6 9H3v6h3l5 4z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg {...iconProps}>
      <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" />
    </svg>
  );
}
