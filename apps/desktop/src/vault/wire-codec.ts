import type { PendingEvent } from "@defer/core";

/**
 * Wire-shape codec for the pending-event queue. Slice #46 ships UTF-8 JSON
 * of the `PendingEvent` envelope; a later slice may swap this for an AEAD-
 * encrypted bundle once the relay's wire format settles on ciphertext (the
 * end-to-end test already exercises the encrypt-side via `crypto.aead` but
 * the on-the-wire shape is still plaintext envelopes today).
 *
 * Centralising encode/decode here means slice #45's `vaultCommands.save()`
 * and the new `outboundFlush` both go through one source of truth — if the
 * wire format changes, both flip atomically.
 */
export function encodePendingEvent(event: PendingEvent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(event));
}

export function decodePendingEvent(bytes: Uint8Array): PendingEvent {
  const decoded = JSON.parse(new TextDecoder().decode(bytes));
  return decoded as PendingEvent;
}
