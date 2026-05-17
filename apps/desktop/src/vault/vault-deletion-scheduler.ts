import { envelopeForSigning, signWithVaultKey, verifyVaultKeySignature } from "@defer/core/crypto";
import type { Event, VaultDeletionScheduled } from "@defer/core";

import { base64UrlToBytes, bytesToBase64Url, randomClientNonceBase64Url } from "../util/base64.js";
import type { StoragePort } from "../storage/index.js";
import type { VaultProjectionStore } from "./projection-store.js";
import { encodePendingEvent } from "./wire-codec.js";
import type { PendingEventQueue } from "@defer/core/pending-event-queue";

const SETTING_VAULT_KEY = "vault.keyBase64Url";
const SCHEDULE_DELAY_MS = 48 * 60 * 60 * 1000;

export type ScheduleDeletionDeps = {
  storage: StoragePort;
  projection: VaultProjectionStore;
  pendingQueue: PendingEventQueue;
  deviceId: string;
  now: () => number;
  onPersisted?: () => void;
};

/**
 * Schedules vault deletion (PRD US #10, #11). Emits a
 * `VaultDeletionScheduled` event signed with the vault key — ADR-0005
 * pins the 48-hour grace window. Cancellation lands in `cancelDeletion`
 * below.
 *
 * Why this lives outside `VaultCommands`: vault-key-MAC'd events need
 * the vault key, which `VaultCommands` doesn't currently hold (its
 * design predates the deletion slice). Rather than thread the vault
 * key through every command, deletion gets its own scheduler module
 * that reads the key from storage at emit-time.
 */
export async function scheduleVaultDeletion(deps: ScheduleDeletionDeps): Promise<void> {
  const vaultKeyB64 = await deps.storage.getSetting(SETTING_VAULT_KEY);
  if (!vaultKeyB64) {
    throw new Error("scheduleVaultDeletion: vault not initialized");
  }
  const vaultKey = base64UrlToBytes(vaultKeyB64);

  const timestamp = deps.now();
  const scheduledFor = timestamp + SCHEDULE_DELAY_MS;
  const clientNonce = randomClientNonceBase64Url();
  const unsigned = {
    type: "VaultDeletionScheduled" as const,
    deviceId: deps.deviceId,
    timestamp,
    clientNonce,
    data: { scheduledFor },
  };
  const signature = bytesToBase64Url(
    signWithVaultKey(vaultKey, envelopeForSigning(unsigned as unknown as Record<string, unknown>)),
  );
  const pendingEvent = { ...unsigned, signature };

  // Apply locally with synthetic seq=0; reducer doesn't read seq.
  const localEvent = { ...pendingEvent, seq: 0 } as Event;
  deps.projection.apply(localEvent);

  await deps.storage.appendEvent({
    seq: null,
    type: pendingEvent.type,
    deviceId: pendingEvent.deviceId,
    clientNonce: pendingEvent.clientNonce,
    timestamp: pendingEvent.timestamp,
    payload: JSON.stringify(pendingEvent),
  });

  await deps.pendingQueue.enqueue(encodePendingEvent(pendingEvent));
  deps.onPersisted?.();
}

/**
 * Cancels a pending vault deletion (PRD US #13). Same shape as schedule
 * but emits `VaultDeletionCancelled` and clears the projection's
 * `scheduledDeletion` slot. Caller checks that there IS a scheduled
 * deletion before invoking — calling on an empty state is a no-op at
 * the reducer level but wastes an event.
 */
export async function cancelVaultDeletion(deps: ScheduleDeletionDeps): Promise<void> {
  const vaultKeyB64 = await deps.storage.getSetting(SETTING_VAULT_KEY);
  if (!vaultKeyB64) {
    throw new Error("cancelVaultDeletion: vault not initialized");
  }
  const vaultKey = base64UrlToBytes(vaultKeyB64);

  const timestamp = deps.now();
  const clientNonce = randomClientNonceBase64Url();
  const unsigned = {
    type: "VaultDeletionCancelled" as const,
    deviceId: deps.deviceId,
    timestamp,
    clientNonce,
    data: {},
  };
  const signature = bytesToBase64Url(
    signWithVaultKey(vaultKey, envelopeForSigning(unsigned as unknown as Record<string, unknown>)),
  );
  const pendingEvent = { ...unsigned, signature };

  const localEvent = { ...pendingEvent, seq: 0 } as Event;
  deps.projection.apply(localEvent);

  await deps.storage.appendEvent({
    seq: null,
    type: pendingEvent.type,
    deviceId: pendingEvent.deviceId,
    clientNonce: pendingEvent.clientNonce,
    timestamp: pendingEvent.timestamp,
    payload: JSON.stringify(pendingEvent),
  });
  await deps.pendingQueue.enqueue(encodePendingEvent(pendingEvent));
  deps.onPersisted?.();
}

/**
 * Verifies a `VaultDeletionScheduled` event's MAC against the held
 * vault key. Used by the banner UI when an event arrives via inbound
 * sync from another device — we display the countdown only if the
 * event actually came from someone holding the vault key (defends
 * against a malicious relay synthesising a phantom deletion banner).
 */
export function verifyVaultDeletionScheduled(
  vaultKey: Uint8Array,
  event: VaultDeletionScheduled,
): boolean {
  const {
    signature,
    seq: _seq,
    ...rest
  } = event as VaultDeletionScheduled & {
    seq?: number;
  };
  void _seq;
  const sigBytes = base64UrlToBytes(signature);
  return verifyVaultKeySignature(
    vaultKey,
    envelopeForSigning(rest as unknown as Record<string, unknown>),
    sigBytes,
  );
}
