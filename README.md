# audiomark

Annotate audio by talking. Drop a file in, it plays with a waveform and spectrogram. Press
<kbd>Space</kbd> to pause and speak a note, <kbd>Space</kbd> again to save it and keep listening.
Notes are transcribed (Chinese, English, Japanese, … ) by a local Whisper model.

## Run

```sh
pnpm install
(cd server && uv sync)
pnpm dev
```

Open http://localhost:5173. The first server start downloads the Whisper model (~1.6 GB).

| Key   | Action                                       |
| ----- | -------------------------------------------- |
| Space | Pause and record a note / save it and resume |
| Esc   | Discard the note being recorded              |
| ← →   | Skip 5 s                                     |

Each note covers the stretch you listened to before pausing. Click a note's time to move the
playhead there; click a marker on the waveform to select its note. **Copy all** copies every
transcribed note as `[start–end] text` lines; **Export JSON** saves them with timestamps.

## Whisper backends

On Apple Silicon the server uses `mlx-whisper` (`mlx-community/whisper-large-v3-turbo`). Elsewhere
it uses `faster-whisper` (`large-v3-turbo`). Override with `WHISPER_BACKEND=mlx|faster` and
`WHISPER_MODEL=<name or path>`.
