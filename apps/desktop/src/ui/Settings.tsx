import { useEffect, useState, useSyncExternalStore } from "react";
import type { DeviceRecord } from "@defer/core";

import type { VaultProjectionStore } from "../vault/projection-store.js";
import type { VaultCommands } from "../vault/commands.js";
import type { StoragePort } from "../storage/index.js";
import { getRelayBaseUrl, setRelayBaseUrl } from "../vault/relay-config.js";

type SettingsProps = {
  projection: VaultProjectionStore;
  commands: VaultCommands;
  storage: StoragePort;
  currentDeviceId: string;
  onClose: () => void;
  onPairNewDevice: () => void;
  onSignOutThisDevice: () => void;
  onScheduleDeletion: () => void;
};

/**
 * Settings page (PRD US #19, #20, #62). Slice #56 ships:
 * - Vault → Devices list, with "Remove this device" buttons for
 *   every NON-current device. Removing the current device — sign-out
 *   — is slice #58 because its crash-safety semantics warrant a
 *   dedicated flow.
 * - Relay → editable base URL (BYO relay deployments, PRD US #62).
 *
 * The Devices list reads from the projection's `devices` map. That
 * map is populated by `DeviceRegistered` events from the pairing flow
 * (slice #57) and the slice-#54 vault-restoration flow.
 */
export function Settings({
  projection,
  commands,
  storage,
  currentDeviceId,
  onClose,
  onPairNewDevice,
  onSignOutThisDevice,
  onScheduleDeletion,
}: SettingsProps) {
  const devices = useProjectionDevices(projection);
  const [relayBaseUrl, setRelayBaseUrlState] = useState<string | null>(null);
  const [relayDraft, setRelayDraft] = useState("");
  const [relaySaveState, setRelaySaveState] = useState<"idle" | "saved" | "error">("idle");
  const [relayError, setRelayError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const url = await getRelayBaseUrl(storage);
      if (cancelled) return;
      setRelayBaseUrlState(url);
      setRelayDraft(url);
    })();
    return () => {
      cancelled = true;
    };
  }, [storage]);

  async function handleSaveRelay() {
    setRelayError(null);
    try {
      await setRelayBaseUrl(storage, relayDraft.trim());
      setRelayBaseUrlState(relayDraft.trim());
      setRelaySaveState("saved");
      setTimeout(() => setRelaySaveState("idle"), 2000);
    } catch (err) {
      setRelaySaveState("error");
      setRelayError(err instanceof Error ? err.message : "Invalid URL");
    }
  }

  return (
    <div className="screen col">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Settings</h1>
        <button className="secondary" onClick={onClose}>
          Close
        </button>
      </div>

      <section className="card col">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ marginTop: 0 }}>Vault</h2>
          <button className="secondary" onClick={onPairNewDevice}>
            Pair a new device
          </button>
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
          Devices that have access to this vault.
        </p>
        {devices.length === 0 ? (
          <p className="muted">
            No devices have registered yet. Pair another device or restore from a mnemonic to
            populate this list.
          </p>
        ) : (
          <ul className="device-list">
            {devices.map(([deviceId, record]) => {
              const isCurrent = deviceId === currentDeviceId;
              return (
                <li key={deviceId} className="device-row">
                  <div className="col" style={{ gap: 2 }}>
                    <span>
                      <strong>{record.name || "(unnamed device)"}</strong>
                      {isCurrent ? <span className="muted"> · this device</span> : null}
                    </span>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {record.type} · registered {formatRegisteredAt(record.registeredAt)}
                    </span>
                  </div>
                  <button
                    className="secondary"
                    style={isCurrent ? { color: "var(--danger)" } : undefined}
                    onClick={() => {
                      if (isCurrent) onSignOutThisDevice();
                      else void commands.revokeDevice(deviceId);
                    }}
                  >
                    Remove this device
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card col">
        <h2 style={{ marginTop: 0, color: "var(--danger)" }}>Danger zone</h2>
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
          Scheduling deletion starts a 48-hour grace window. Any paired device can cancel before the
          window elapses.
        </p>
        <div className="row">
          <button style={{ background: "var(--danger)" }} onClick={onScheduleDeletion}>
            Schedule vault deletion
          </button>
        </div>
      </section>

      <section className="card col">
        <h2 style={{ marginTop: 0 }}>Relay</h2>
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
          The relay routes encrypted events between your devices. Override this if you've deployed
          your own relay Worker (PRD US #62).
        </p>
        <input
          type="url"
          value={relayDraft}
          onChange={(e) => setRelayDraft(e.target.value)}
          placeholder={relayBaseUrl ?? "https://your-relay.example"}
        />
        {relayError ? <p className="danger">{relayError}</p> : null}
        <div className="row">
          <button
            onClick={handleSaveRelay}
            disabled={relayDraft.trim() === "" || relayDraft.trim() === relayBaseUrl}
          >
            {relaySaveState === "saved" ? "Saved" : "Save relay URL"}
          </button>
          <span className="muted" style={{ fontSize: 12 }}>
            Takes effect on the next sync.
          </span>
        </div>
      </section>
    </div>
  );
}

function useProjectionDevices(projection: VaultProjectionStore): readonly [string, DeviceRecord][] {
  return useSyncExternalStore(
    (listener) => projection.subscribe(listener),
    () => getDevicesSnapshot(projection),
    () => getDevicesSnapshot(projection),
  );
}

const DEVICES_CACHE = new WeakMap<
  ReadonlyMap<string, DeviceRecord>,
  readonly [string, DeviceRecord][]
>();

function getDevicesSnapshot(projection: VaultProjectionStore): readonly [string, DeviceRecord][] {
  const devices = projection.getState().devices;
  const cached = DEVICES_CACHE.get(devices);
  if (cached !== undefined) return cached;
  const sorted = [...devices.entries()].sort(([, a], [, b]) => a.registeredAt - b.registeredAt);
  DEVICES_CACHE.set(devices, sorted);
  return sorted;
}

function formatRegisteredAt(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString();
  } catch {
    return "(unknown)";
  }
}
