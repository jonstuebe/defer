import { useEffect, useState } from "react";
import { PendingEventQueue } from "@defer/core/pending-event-queue";

import type { StoragePort } from "../storage/index.js";
import { VaultProjectionStore } from "../vault/projection-store.js";
import { VaultCommands } from "../vault/commands.js";
import { SqlitePendingQueueStorage } from "../vault/pending-queue-adapter.js";
import {
  createVault,
  persistVault,
  loadVault,
  defaultDeviceName,
  type CreatedVault,
} from "../onboarding/index.js";

import { Welcome } from "./Welcome.js";
import { MnemonicDisplay } from "./MnemonicDisplay.js";
import { MnemonicVerification } from "./MnemonicVerification.js";
import { EmptyInbox } from "./EmptyInbox.js";
import { Inbox } from "./Inbox.js";

type Screen =
  | { name: "loading" }
  | { name: "welcome" }
  | { name: "create-mnemonic-display"; vault: CreatedVault }
  | { name: "create-mnemonic-verification"; vault: CreatedVault }
  | { name: "empty-inbox" }
  | { name: "inbox" };

type AppProps = {
  storage: StoragePort;
};

export function App({ storage }: AppProps) {
  const [screen, setScreen] = useState<Screen>({ name: "loading" });
  const [services, setServices] = useState<{
    projection: VaultProjectionStore;
    commands: VaultCommands;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const existing = await loadVault(storage);
      if (cancelled) return;
      if (existing) {
        const services = await buildServices(storage, existing.deviceId);
        if (cancelled) return;
        setServices(services);
        setScreen({ name: "inbox" });
      } else {
        setScreen({ name: "welcome" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storage]);

  if (screen.name === "loading") {
    return <div className="screen">Loading…</div>;
  }
  if (screen.name === "welcome") {
    return (
      <Welcome
        onCreateNewVault={async () => {
          const vault = await createVault();
          setScreen({ name: "create-mnemonic-display", vault });
        }}
        onRestore={() => {
          // Restore flow ships in slice #54. Acknowledge the click without
          // pretending we have an implementation.
          alert("Vault restoration ships in a later slice (#54).");
        }}
      />
    );
  }
  if (screen.name === "create-mnemonic-display") {
    return (
      <MnemonicDisplay
        mnemonic={screen.vault.mnemonic}
        onContinue={() => setScreen({ name: "create-mnemonic-verification", vault: screen.vault })}
      />
    );
  }
  if (screen.name === "create-mnemonic-verification") {
    return (
      <MnemonicVerification
        mnemonic={screen.vault.mnemonic}
        onBack={() => setScreen({ name: "create-mnemonic-display", vault: screen.vault })}
        onVerified={async () => {
          const deviceName = defaultDeviceName();
          await persistVault(storage, screen.vault, deviceName);
          const built = await buildServices(storage, screen.vault.deviceId);
          setServices(built);
          setScreen({ name: "empty-inbox" });
        }}
      />
    );
  }
  if (screen.name === "empty-inbox") {
    return <EmptyInbox onContinue={() => setScreen({ name: "inbox" })} />;
  }
  if (services === null) {
    return <div className="screen">Loading…</div>;
  }
  return <Inbox projection={services.projection} commands={services.commands} />;
}

async function buildServices(
  storage: StoragePort,
  deviceId: string,
): Promise<{ projection: VaultProjectionStore; commands: VaultCommands }> {
  const projection = new VaultProjectionStore(storage);
  await projection.hydrate();
  const pendingQueue = new PendingEventQueue(new SqlitePendingQueueStorage(storage));
  const commands = new VaultCommands({
    storage,
    projection,
    pendingQueue,
    deviceId,
    now: Date.now,
  });
  return { projection, commands };
}
