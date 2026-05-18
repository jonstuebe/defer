import { useEffect, useState } from "react";

type DeletionBannerProps = {
  scheduledFor: number;
  onCancel: () => Promise<void>;
};

/**
 * Persistent banner shown across every main screen while a vault
 * deletion is scheduled (PRD US #12). Counts down to the scheduledFor
 * timestamp; the cancel button emits `VaultDeletionCancelled` and the
 * banner unmounts when the projection's `scheduledDeletion` clears.
 */
export function DeletionBanner({ scheduledFor, onCancel }: DeletionBannerProps) {
  const [remaining, setRemaining] = useState(scheduledFor - Date.now());
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setRemaining(scheduledFor - Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, [scheduledFor]);

  async function handleCancel() {
    setPending(true);
    try {
      await onCancel();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="deletion-banner" role="alert">
      <div className="col" style={{ gap: 2 }}>
        <strong>Vault deletion scheduled</strong>
        <span style={{ fontSize: 12 }}>
          {remaining > 0
            ? `Deletes in ${formatRemaining(remaining)}`
            : "Deletion alarm fired; wiping…"}
        </span>
      </div>
      <button
        type="button"
        onClick={handleCancel}
        disabled={pending}
        style={{ background: "white", color: "var(--danger)", fontWeight: 600 }}
      >
        {pending ? "Cancelling…" : "Cancel deletion"}
      </button>
    </div>
  );
}

function formatRemaining(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remSeconds = seconds % 60;
  return `${hours}h ${minutes}m ${remSeconds}s`;
}
