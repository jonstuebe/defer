import { useState } from "react";

import { parsePairingQrPayload } from "../vault/pairing-qr.js";
import type { PairingTarget } from "../vault/pairing-existing-device.js";

type PairDeviceProps = {
  onCancel: () => void;
  onConfirm: (target: PairingTarget) => Promise<void>;
};

/**
 * Pair-a-new-device UI (PRD US #16, #17). Two input paths:
 *
 * - Scan a QR with the system camera. Tauri v2's camera plugin lands
 *   in a later iteration; until then, the camera button surfaces a
 *   helpful message pointing at the typed-code fallback.
 * - Paste the JSON payload (or a typed 6-char code wrapping it in a
 *   future iteration) into the text area. The new device's display
 *   shows the exact string a user can paste.
 *
 * After parsing, the user confirms the displayed device name + type
 * before any network call. `onConfirm` runs the full `executePairing`
 * handshake (slice #57's `pairing-existing-device.ts`).
 */
export function PairDevice({ onCancel, onConfirm }: PairDeviceProps) {
  const [payloadText, setPayloadText] = useState("");
  const [target, setTarget] = useState<PairingTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function handleParse() {
    setError(null);
    try {
      setTarget(parsePairingQrPayload(payloadText));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not parse pairing payload");
    }
  }

  async function handleConfirm() {
    if (target === null) return;
    setPending(true);
    setError(null);
    try {
      await onConfirm(target);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Pairing failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="screen col">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Pair a new device</h1>
        <button className="secondary" onClick={onCancel}>
          Close
        </button>
      </div>

      {target === null ? (
        <section className="card col">
          <p>
            On the new device, generate a pairing code. Paste the JSON payload it shows below — or
            use the camera modal (coming in a follow-up iteration).
          </p>
          <textarea
            value={payloadText}
            onChange={(e) => setPayloadText(e.target.value)}
            rows={4}
            placeholder='{"version":1,"recipientPubkey":"…","pairingToken":"…"}'
            style={{
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 12,
              padding: 8,
              background: "var(--card)",
              color: "var(--fg)",
              border: "1px solid var(--border)",
              borderRadius: 6,
            }}
            aria-label="Pairing payload"
          />
          {error ? <p className="danger">{error}</p> : null}
          <div className="row">
            <button onClick={handleParse} disabled={payloadText.trim() === ""}>
              Parse pairing code
            </button>
          </div>
        </section>
      ) : (
        <section className="card col">
          <h2 style={{ marginTop: 0 }}>Confirm pairing</h2>
          <p>You're about to grant this vault to:</p>
          <div className="muted" style={{ fontSize: 14 }}>
            <strong>{target.suggestedDeviceName}</strong> ({target.suggestedDeviceType})
          </div>
          {error ? <p className="danger">{error}</p> : null}
          <div className="row">
            <button
              className="secondary"
              onClick={() => {
                setTarget(null);
                setError(null);
              }}
              disabled={pending}
            >
              Back
            </button>
            <button onClick={handleConfirm} disabled={pending}>
              {pending ? "Pairing…" : "Confirm pair"}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
