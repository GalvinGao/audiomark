"""HTTP API that turns short voice notes into text with Whisper.

Two backends, picked at startup:
  mlx      mlx-whisper on Apple Silicon (fast, Metal GPU)
  faster   faster-whisper / CTranslate2 everywhere else

Environment:
  WHISPER_BACKEND       mlx | faster (default: mlx when it is installed)
  WHISPER_MODEL         model name, HF repo, or path
                        (default: mlx-community/whisper-large-v3-turbo or large-v3-turbo)
  WHISPER_DEVICE        faster only: cpu | cuda | auto (default: auto)
  WHISPER_COMPUTE_TYPE  faster only: int8, float16, ... (default: int8)
"""

import importlib.util
import os
import tempfile
import threading
import time
from contextlib import asynccontextmanager
from typing import Callable

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from faster_whisper import decode_audio

BACKEND = os.environ.get(
    "WHISPER_BACKEND", "mlx" if importlib.util.find_spec("mlx_whisper") else "faster"
)
MODEL_NAME = os.environ.get(
    "WHISPER_MODEL",
    "mlx-community/whisper-large-v3-turbo" if BACKEND == "mlx" else "large-v3-turbo",
)

# Whisper tends to answer Mandarin in Traditional characters; a Simplified
# prompt nudges it back. Only used once the note is known to be Chinese.
ZH_PROMPT = "以下是普通话的句子，使用简体中文。"

# (audio, language or None) -> (text, detected language)
Transcriber = Callable[[np.ndarray, str | None], tuple[str, str]]

_transcriber: Transcriber | None = None
_load_error: str | None = None
_loaded = threading.Event()
# Neither backend is safe to share across concurrent transcribe calls.
_lock = threading.Lock()


def _mlx_transcriber() -> Transcriber:
    import mlx_whisper

    def run(audio: np.ndarray, language: str | None) -> tuple[str, str]:
        result = mlx_whisper.transcribe(audio, path_or_hf_repo=MODEL_NAME, language=language)
        detected = result["language"]
        if detected == "zh" and language is None:
            # Language was unknown on the first pass, so it ran without the
            # Simplified prompt. A second pass is cheap on the GPU.
            result = mlx_whisper.transcribe(
                audio, path_or_hf_repo=MODEL_NAME, language="zh", initial_prompt=ZH_PROMPT
            )
        return result["text"], detected

    # Warm up: downloads the weights on first run and compiles the graph.
    run(np.zeros(16000, dtype=np.float32), "en")
    return run


def _faster_transcriber() -> Transcriber:
    from faster_whisper import WhisperModel

    model = WhisperModel(
        MODEL_NAME,
        device=os.environ.get("WHISPER_DEVICE", "auto"),
        compute_type=os.environ.get("WHISPER_COMPUTE_TYPE", "int8"),
    )

    def run(audio: np.ndarray, language: str | None) -> tuple[str, str]:
        if language is None:
            # Detect first so the Simplified prompt is only used for Chinese
            # notes; a Chinese prompt on English audio invites mixups.
            language, _, _ = model.detect_language(audio, vad_filter=True)
        segments, _ = model.transcribe(
            audio,
            language=language,
            initial_prompt=ZH_PROMPT if language == "zh" else None,
            vad_filter=True,
            beam_size=5,
        )
        return "".join(s.text for s in segments), language

    return run


def _load() -> None:
    global _transcriber, _load_error
    try:
        _transcriber = _mlx_transcriber() if BACKEND == "mlx" else _faster_transcriber()
    except Exception as exc:  # surfaced through /api/health
        _load_error = f"{type(exc).__name__}: {exc}"
    finally:
        _loaded.set()


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Load in the background so the server answers /api/health while the
    # model downloads on first run.
    threading.Thread(target=_load, daemon=True).start()
    yield


app = FastAPI(title="audiomark", lifespan=lifespan)


@app.get("/api/health")
def health():
    return {
        "backend": BACKEND,
        "model": MODEL_NAME,
        "ready": _transcriber is not None,
        "loading": not _loaded.is_set(),
        "error": _load_error,
    }


def _transcribe(path: str, language: str | None) -> dict:
    assert _transcriber is not None
    started = time.perf_counter()
    audio = decode_audio(path)
    with _lock:
        text, detected = _transcriber(audio, language)
    return {
        "text": text.strip(),
        "language": detected,
        "duration": len(audio) / 16000,
        "elapsed": time.perf_counter() - started,
    }


@app.post("/api/transcribe")
async def transcribe(file: UploadFile = File(...), language: str = Form("")):
    if not await run_in_threadpool(_loaded.wait, 900):
        raise HTTPException(503, "Model is still loading")
    if _transcriber is None:
        raise HTTPException(500, f"Model failed to load: {_load_error}")

    suffix = os.path.splitext(file.filename or "")[1] or ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix) as tmp:
        tmp.write(await file.read())
        tmp.flush()
        try:
            return await run_in_threadpool(_transcribe, tmp.name, language or None)
        except Exception as exc:
            raise HTTPException(422, f"Could not transcribe audio: {exc}") from exc
