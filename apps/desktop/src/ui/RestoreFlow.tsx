import { useMemo, useState } from "react";

import { suggestBip39Words } from "../onboarding/bip39-wordlist.js";
import type { RestorationStep } from "../onboarding/restore-vault.js";

type RestoreFlowProps = {
  onRestore: (mnemonic: string) => Promise<void>;
  onBack: () => void;
};

/**
 * 24-word recovery-mnemonic input with per-word BIP-39 autocomplete and
 * checksum-on-submit validation (PRD US #8, #9). The actual handshake +
 * replay live in `restoreFromMnemonic` (ADR-0008); this component is
 * pure UI and delegates the cryptographic work via `onRestore`.
 */
export function RestoreFlow({ onRestore, onBack }: RestoreFlowProps) {
  const [words, setWords] = useState<string[]>(() => Array(24).fill(""));
  const [step, setStep] = useState<
    RestorationStep | { kind: "idle" } | { kind: "error"; message: string }
  >({ kind: "idle" });

  const allFilled = words.every((w) => w.trim().length > 0);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const joined = words.map((w) => w.trim().toLowerCase()).join(" ");
    try {
      await onRestore(joined);
    } catch (err) {
      setStep({
        kind: "error",
        message:
          err instanceof Error
            ? err.message
            : "Unable to restore. Check the words match what you wrote down.",
      });
    }
  }

  return (
    <div className="screen col">
      <h1>Restore your vault</h1>
      <p>Enter your 24-word recovery mnemonic. Case-insensitive; the order matters.</p>

      <form onSubmit={handleSubmit} className="card col">
        <div className="restore-grid">
          {words.map((value, index) => (
            <RestoreWord
              key={index}
              position={index + 1}
              value={value}
              onChange={(next) => {
                setWords((prev) => {
                  const out = [...prev];
                  out[index] = next;
                  return out;
                });
              }}
            />
          ))}
        </div>

        {step.kind === "error" ? <p className="danger">{step.message}</p> : null}
        {step.kind !== "idle" && step.kind !== "error" ? (
          <p className="muted">{stepLabel(step)}</p>
        ) : null}

        <div className="row">
          <button type="button" className="secondary" onClick={onBack}>
            Back
          </button>
          <button type="submit" disabled={!allFilled || stepIsRunning(step)}>
            Restore
          </button>
        </div>
      </form>
    </div>
  );
}

function stepLabel(step: RestorationStep): string {
  switch (step.kind) {
    case "validating-mnemonic":
      return "Validating mnemonic…";
    case "requesting-challenge":
      return "Requesting recovery challenge from the relay…";
    case "claiming-device":
      return "Registering this device…";
    case "replaying":
      return `Replaying ${step.applied} events…`;
    case "complete":
      return "Done. Loading your vault…";
  }
}

function stepIsRunning(step: { kind: string }): boolean {
  return step.kind !== "idle" && step.kind !== "error";
}

type RestoreWordProps = {
  position: number;
  value: string;
  onChange: (next: string) => void;
};

function RestoreWord({ position, value, onChange }: RestoreWordProps) {
  const suggestions = useMemo(() => suggestBip39Words(value, 3), [value]);
  return (
    <div className="restore-word">
      <span className="position">{position}.</span>
      <div className="restore-word-input">
        <input
          type="text"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {suggestions.length > 0 && suggestions[0] !== value.trim().toLowerCase() ? (
          <div className="restore-suggestions" aria-label={`Suggestions for word ${position}`}>
            {suggestions.map((word) => (
              <button
                key={word}
                type="button"
                className="restore-suggestion"
                onClick={() => onChange(word)}
              >
                {word}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
