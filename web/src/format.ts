export function formatTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = Math.floor(s % 60);
  return `${m}:${rest.toString().padStart(2, "0")}`;
}

/** `1:02.3` — used for the live playhead, where whole seconds feel laggy. */
export function formatTimePrecise(seconds: number): string {
  const s = Math.max(0, seconds);
  const tenths = Math.floor((s % 1) * 10);
  return `${formatTime(s)}.${tenths}`;
}
