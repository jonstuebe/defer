import { useState } from "react";

type ScheduleDeletionProps = {
  onCancel: () => void;
  onConfirm: () => Promise<void>;
};

/**
 * Screen that walks the user through PRD US #10's "type DEFER" gate.
 * The confirm button stays disabled until the user types exactly
 * `DEFER` (case-sensitive). On submit, emits `VaultDeletionScheduled`
 * which kicks off the 48-hour grace window from ADR-0005.
 */
export function ScheduleDeletion({ onCancel, onConfirm }: ScheduleDeletionProps) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = draft === "DEFER";

  async function handleConfirm() {
    if (!ready) return;
    setPending(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not schedule deletion");
      setPending(false);
    }
  }

  return (
    <div className="screen col">
      <h1>Schedule vault deletion</h1>
      <div className="card col">
        <p>
          Scheduling deletion gives you a <strong>48-hour grace window</strong> during which any
          paired device can cancel. After the window, your local data is wiped and the relay
          tombstone is permanent.
        </p>
        <p>
          Type <code>DEFER</code> (uppercase) to confirm:
        </p>
        <input
          type="text"
          className="danger-confirm-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoCapitalize="characters"
          placeholder="DEFER"
        />
        {error ? <p className="danger">{error}</p> : null}
        <div className="row">
          <button className="secondary" onClick={onCancel} disabled={pending}>
            Cancel
          </button>
          <button
            style={{ background: "var(--danger)" }}
            disabled={!ready || pending}
            onClick={handleConfirm}
          >
            {pending ? "Scheduling…" : "Schedule deletion"}
          </button>
        </div>
      </div>
    </div>
  );
}
