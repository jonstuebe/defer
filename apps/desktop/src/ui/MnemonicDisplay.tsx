import { useEffect, useRef, useState } from "react";

import { copyWithAutoClear, type ClipboardClearHandle } from "../clipboard/auto-clear.js";
import { webClipboardDeps } from "../runtime/web-clipboard.js";
import { detectFileSave } from "../runtime/file-save-port.js";
import { detectKeychain } from "../runtime/keychain-port.js";
import { buildMnemonicPdf, buildMnemonicTxt } from "../onboarding/mnemonic-export.js";
import { bytesToBase64Url } from "../util/base64.js";

type MnemonicDisplayProps = {
  mnemonic: string;
  vaultIdBytes: Uint8Array;
  onContinue: () => void;
};

export function MnemonicDisplay({ mnemonic, vaultIdBytes, onContinue }: MnemonicDisplayProps) {
  const words = mnemonic.trim().split(/\s+/);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const [exportState, setExportState] = useState<string | null>(null);
  const [keychainState, setKeychainState] = useState<"idle" | "saved" | "unavailable">("idle");
  const handleRef = useRef<ClipboardClearHandle | null>(null);

  const fileSave = detectFileSave();
  const keychain = detectKeychain();

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

  async function handleExportTxt() {
    setExportState("Generating .txt…");
    const content = buildMnemonicTxt({ mnemonic, vaultIdBytes });
    await fileSave.saveText(
      { suggestedFileName: filenameFor(vaultIdBytes, "txt"), contentType: "text/plain" },
      content,
    );
    setExportState(".txt saved");
    setTimeout(() => setExportState(null), 2000);
  }

  async function handleExportPdf() {
    setExportState("Generating PDF…");
    const bytes = await buildMnemonicPdf({ mnemonic, vaultIdBytes });
    await fileSave.saveBytes(
      { suggestedFileName: filenameFor(vaultIdBytes, "pdf"), contentType: "application/pdf" },
      bytes,
    );
    setExportState("PDF saved");
    setTimeout(() => setExportState(null), 2000);
  }

  async function handleSaveToKeychain() {
    if (!keychain.isAvailable()) {
      setKeychainState("unavailable");
      return;
    }
    const account = bytesToBase64Url(vaultIdBytes).slice(0, 8);
    try {
      await keychain.save(account, mnemonic);
      setKeychainState("saved");
    } catch {
      setKeychainState("unavailable");
    }
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
        <div className="row" style={{ flexWrap: "wrap" }}>
          <button className="secondary" onClick={handleCopy}>
            {copyState === "copied" ? "Copied (auto-clears in 60s)" : "Copy to clipboard"}
          </button>
          <button className="secondary" onClick={handleExportTxt}>
            Save as .txt
          </button>
          <button className="secondary" onClick={handleExportPdf}>
            Save as PDF
          </button>
          {keychain.isAvailable() ? (
            <button className="secondary" onClick={handleSaveToKeychain}>
              {keychainState === "saved" ? "Saved to keychain" : "Save to system keychain"}
            </button>
          ) : null}
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Clipboard auto-clears 60 seconds after copying.
          {keychain.isAvailable()
            ? " Keychain copy is a convenience — your mnemonic is the source of truth."
            : ""}
          {exportState ? ` · ${exportState}` : ""}
          {keychainState === "unavailable" ? " · Keychain unavailable on this device." : ""}
        </p>
      </div>
      <div className="row">
        <button onClick={onContinue}>I've saved my mnemonic</button>
      </div>
    </div>
  );
}

function filenameFor(vaultIdBytes: Uint8Array, ext: "txt" | "pdf"): string {
  const short = bytesToBase64Url(vaultIdBytes).slice(0, 8);
  return `defer-mnemonic-${short}.${ext}`;
}
