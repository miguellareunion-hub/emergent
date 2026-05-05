/**
 * Tiny pub/sub for runtime errors coming from the preview iframe.
 * Allows the AgentChat to consume errors that occurred *after* it pushed
 * code, so a "fixer" agent can be triggered automatically.
 */

export type RuntimeError = { level: string; msg: string; ts: number };

type Listener = (err: RuntimeError) => void;

const listeners = new Set<Listener>();
let buffer: RuntimeError[] = [];

const MAX_BUFFER = 50;

export function pushRuntimeError(err: RuntimeError) {
  buffer.push(err);
  if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
  listeners.forEach((l) => l(err));
}

export function subscribeRuntimeErrors(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Drain (and clear) errors collected since the last drain. */
export function drainRuntimeErrors(sinceTs = 0): RuntimeError[] {
  const out = buffer.filter((e) => e.ts >= sinceTs);
  return out;
}

export function clearRuntimeErrors() {
  buffer = [];
}
