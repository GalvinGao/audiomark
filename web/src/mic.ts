export interface Recording {
  blob: Blob;
  /** Milliseconds between start() and stop(). */
  duration: number;
}

const MIME_TYPES = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"];

/**
 * Keeps one microphone stream open for the whole session so that starting a
 * note is instant; each note is its own MediaRecorder run on that stream.
 */
export class MicRecorder {
  private stream: MediaStream | null = null;
  private streamPromise: Promise<MediaStream> | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private samples: Float32Array<ArrayBuffer> | null = null;
  /** Bumped by every start/stop so a slow start() can tell it was superseded. */
  private generation = 0;

  /** Opens the mic. Call early (on file drop) so the permission prompt is out of the way. */
  ensureStream(): Promise<MediaStream> {
    this.streamPromise ??= navigator.mediaDevices
      .getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      .then((stream) => {
        this.stream = stream;
        const ctx = new AudioContext();
        this.audioContext = ctx;
        this.analyser = ctx.createAnalyser();
        this.analyser.fftSize = 1024;
        this.samples = new Float32Array(this.analyser.fftSize);
        ctx.createMediaStreamSource(stream).connect(this.analyser);
        return stream;
      })
      .catch((error: unknown) => {
        // Let a later call retry, e.g. after the user fixes the permission.
        this.streamPromise = null;
        throw error;
      });
    return this.streamPromise;
  }

  async start(): Promise<void> {
    const generation = ++this.generation;
    const stream = this.stream ?? (await this.ensureStream());
    if (generation !== this.generation) return;
    // Created outside a gesture, the context may start suspended; the level
    // meter reads silence until it resumes.
    void this.audioContext?.resume();

    const mimeType = MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    this.chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    recorder.start();
    this.recorder = recorder;
    this.startedAt = performance.now();
  }

  /** Resolves with the note, or null when nothing was recording. */
  stop(): Promise<Recording | null> {
    this.generation++;
    const recorder = this.recorder;
    this.recorder = null;
    if (!recorder || recorder.state === "inactive") return Promise.resolve(null);

    const duration = performance.now() - this.startedAt;
    const chunks = this.chunks;
    return new Promise((resolve) => {
      recorder.onstop = () =>
        resolve({ blob: new Blob(chunks, { type: recorder.mimeType }), duration });
      recorder.stop();
    });
  }

  get elapsed(): number {
    return this.recorder ? performance.now() - this.startedAt : 0;
  }

  /** RMS input level, roughly 0..1. */
  level(): number {
    if (!this.analyser || !this.samples) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const sample of this.samples) sum += sample * sample;
    return Math.min(1, Math.sqrt(sum / this.samples.length) * 4);
  }
}
