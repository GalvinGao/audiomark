# audiomark

Audio annotation by voice. Drop an audio file into the web app and it plays with a waveform and a
spectrogram. Space pauses and records a spoken note from the microphone; Space again saves the note
and resumes playback. Notes are transcribed by a local Whisper server in the background.

## Layout

- `web/` — Vite + React + TypeScript. All UI lives in `web/src/App.tsx`.
  - `mic.ts` keeps one microphone stream open; each note is one `MediaRecorder` run.
  - `api.ts` talks to the server through the Vite proxy (`/api` → `127.0.0.1:8787`).
  - wavesurfer.js v8 with the regions, timeline, and spectrogram plugins.
- `server/` — Python (uv) FastAPI app in `server/audiomark_server/app.py`.
  - Backend `mlx` (mlx-whisper, Apple Silicon) when installed, else `faster` (faster-whisper).
  - Env: `WHISPER_BACKEND`, `WHISPER_MODEL`, `WHISPER_DEVICE`, `WHISPER_COMPUTE_TYPE`.

## Commands

- `pnpm install` and `cd server && uv sync` — install.
- `pnpm dev` — web (5173) and server (8787) together. `pnpm dev:web` / `pnpm dev:server` alone.
- `pnpm build` — typecheck and build the web app.
- `pnpm lint`, `pnpm fmt` — oxlint and oxfmt for the whole repo.

## Behavior contract

- Modes: `idle` (paused), `playing`, `recording` (paused with the mic open).
- Space: playing → recording; recording → save note and play; idle → play. Esc discards a note.
- Each note has `start` (where the listening stretch began) and `time` (where playback paused).
  A play or a seek during playback starts a new stretch.
- Moving the playhead never changes play/pause state and never moves the anchor of the note
  being recorded. After the note is saved, playback resumes from wherever the playhead now is.
- Transcription never blocks the player. "Copy all" shows a spinner while any note transcribes.
- Notes (text only) persist in `localStorage` per file name + size; note audio is memory-only.

## Gotchas

- faster-whisper 1.2 needs `av<16` (it passes `metadata_errors`, which PyAV 16 removed).
- wavesurfer renders into a shadow root: style its regions with `::part(...)`, or inline.
- wavesurfer's default `sampleRate` (8 kHz) caps the spectrogram at 4 kHz; the app uses 32 kHz.
- Run binaries with `pnpm exec`, not `npx`: `devEngines` makes npm refuse to run here.

## Code style

- No `as` casts. Use a type annotation or `satisfies`. `as const` is allowed.
- No nested ternaries.
- A `switch` holds at most 3 cases. Use `match` from ts-pattern for anything wider.
