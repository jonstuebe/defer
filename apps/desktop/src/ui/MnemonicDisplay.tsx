import { useEffect, useRef, useState } from "react";

import { copyWithAutoClear, type ClipboardClearHandle } from "../clipboard/auto-clear.js";
import { webClipboardDeps } from "../runtime/web-clipboard.js";

type MnemonicDisplayProps = {
  mnemonic: string;
  onContinue: () => void;
};

export function MnemonicDisplay({ mnemonic, onContinue }: MnemonicDisplayProps) {
  const words = mnemonic.trim().split(/\s+/);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const handleRef = useRef<ClipboardClearHandle | null>(null);

  useEffect(() => {
    return () => {
      // Cancel any pending auto-clear timer when we navigate away. The
      // mnemonic itself is in-memory state owned by the parent flow, so
      // dropping the timer is the right cleanup boundary.
      handleRef.current?.cancel();
    };
  }, []);

  async function handleCopy() {
    if (handleRef.current) handleRef.current.cancel();
    handleRef.current = await copyWithAutoClear(mnemonic, webClipboardDeps, 60_000);
    setCopyState("copied");
    // Reset the label after the auto-clear window so a returning user
    // doesn't think the clipboard still holds their key.
    setTimeout(() => setCopyState("idle"), 60_000);
  }

  return (
    <div className="screen col">
      <h1>Your recovery mnemonic</h1>
      <p>
        These 24 words are the only way to recover your vault on a new device. Write them down or
        save them somewhere safe — this is the only time we'll show them.
      </p>
      <div className="card">
        <div className="mnemonic-grid" aria-label="Recovery mnemonic">
          {words.map((word, index) => (
            <div key={index} className="mnemonic-word">
              <span className="position">{index + 1}.</span>
              <span className="word">{word}</span>
            </div>
          ))}
        </div>
        <div className="row">
          <button className="secondary" onClick={handleCopy}>
            {copyState === "copied" ? "Copied (auto-clears in 60s)" : "Copy to clipboard"}
          </button>
          <span className="muted" style={{ fontSize: 12 }}>
            Clipboard auto-clears 60 seconds after copying.
          </span>
        </div>
      </div>
      <div className="row">
        <button onClick={onContinue}>I've saved my mnemonic</button>
      </div>
    </div>
  );
}
