export interface TranscribeResult {
  text: string;
  language: string;
  duration: number;
  elapsed: number;
}

export interface Health {
  backend: string;
  model: string;
  ready: boolean;
  loading: boolean;
  error: string | null;
}

function extensionFor(mimeType: string): string {
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("ogg")) return "ogg";
  return "webm";
}

export async function transcribe(blob: Blob, language: string): Promise<TranscribeResult> {
  const body = new FormData();
  body.append("file", blob, `note.${extensionFor(blob.type)}`);
  body.append("language", language);
  const res = await fetch("/api/transcribe", { method: "POST", body });
  if (!res.ok) {
    const payload = await res.json().catch(() => null);
    throw new Error(payload?.detail ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export async function fetchHealth(): Promise<Health> {
  const res = await fetch("/api/health");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
