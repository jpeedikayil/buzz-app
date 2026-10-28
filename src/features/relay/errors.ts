export type ReadErrorKind =
  | "cancelled"
  | "denied"
  | "unavailable"
  | "invalid-response";
export class ReadError extends Error {
  constructor(
    readonly kind: ReadErrorKind,
    message: string,
    readonly status?: number,
    /** Host API admission delay, not proof of history completeness or denial. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ReadError";
  }
}
/** HTTP statuses where the same request can succeed later unchanged. */
export function transientStatus(status: number) {
  return status === 408 || status === 429 || status >= 500;
}
export function httpReadError(status: number) {
  return new ReadError(
    status === 401 || status === 403 ? "denied" : "unavailable",
    `Relay read failed (${status})`,
    status,
  );
}
/** Shared taxonomy for broker, signed transport and query lifecycle. The exact
 * legacy fixture phrase is accepted during migration, not arbitrary status text. */
export function readErrorKind(error: unknown): ReadErrorKind {
  if (error instanceof ReadError) return error.kind;
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  if (
    error instanceof Error &&
    /^Relay read failed \((401|403)\)$/.test(error.message)
  )
    return "denied";
  return "unavailable";
}
/** The response was larger than the 8 MiB a read admits. Deterministic: a
 * caller that can asks for less rather than again. */
export const READ_BUDGET_EXCEEDED = "Relay response exceeds the read budget";
/** Native IPC rejects with plain strings, so its transport failures are known
 * by message (src-tauri/src/relay.rs `send` and `read_response`), plus the
 * NIP-11 discovery read that every native connection starts with. */
const NATIVE_TRANSIENT = new Set([
  "Relay request could not be confirmed",
  "Relay response was interrupted",
  "Community discovery failed",
  "network-unavailable",
  "network-timeout",
]);
const NATIVE_OVERSIZED = "Relay response is too large";
/** True when the relay's response was too large to admit: over the reader's
 * budget, or over the 16 MiB native reads at all (`read_response`), which
 * rejects before the reader can measure. The same request fails the same way
 * every time, so a caller asks for less rather than again. */
export function isOversizedResponse(error: unknown): boolean {
  if (error instanceof ReadError) return error.message === READ_BUDGET_EXCEEDED;
  return (
    error === NATIVE_OVERSIZED ||
    (error instanceof Error && error.message === NATIVE_OVERSIZED)
  );
}
/** True when trying the same read again can succeed without anyone acting:
 * the relay or network was unavailable, slow, or the read was cancelled. A
 * denial, an invalid response or a deterministic local check is not. */
export function isTransientFailure(error: unknown): boolean {
  if (error instanceof ReadError)
    return error.kind === "unavailable" || error.kind === "cancelled";
  if (typeof error === "string") return NATIVE_TRANSIENT.has(error);
  // fetch rejects with TypeError when the network is unreachable.
  if (
    error instanceof TypeError ||
    (error instanceof Error &&
      (error.name === "AbortError" ||
        error.name === "TimeoutError" ||
        NATIVE_TRANSIENT.has(error.message)))
  )
    return true;
  // A wrapper that only adds context (Preference decode: …) keeps its cause.
  return error instanceof Error && error.cause !== undefined
    ? isTransientFailure(error.cause)
    : false;
}
