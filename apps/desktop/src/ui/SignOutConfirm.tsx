import { useState } from "react";

type SignOutConfirmProps = {
  isLastDevice: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
};

/**
 * Confirmation dialog before "Remove this device" actually runs.
 * Shows the last-paired-device warning (PRD US #24) when this is the
 * only device still on the device list — the user needs their mnemonic
 * to ever access the vault again after.
 */
export function SignOutConfirm({ isLastDevice, onCancel, onConfirm }: SignOutConfirmProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setPending(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-out failed");
      setPending(false);
    }
  }

  return (
    <div className="screen col">
      <h1>Remove this device</h1>
      <div className="card col">
        <p>
          This will revoke this device's access to your vault and wipe its local data. Other paired
          devices keep working.
        </p>
        {isLastDevice ? (
          <p className="danger">
            <strong>This is your last paired device.</strong> After removal you'll need your
            recovery mnemonic to access this vault again.
          </p>
        ) : null}
        {error ? <p className="danger">{error}</p> : null}
        <div className="row">
          <button className="secondary" onClick={onCancel} disabled={pending}>
            Cancel
          </button>
          <button
            style={{ background: "var(--danger)" }}
            onClick={handleConfirm}
            disabled={pending}
          >
            {pending ? "Removing…" : "Remove this device"}
          </button>
        </div>
      </div>
    </div>
  );
}
