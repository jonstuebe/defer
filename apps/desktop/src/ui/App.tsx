import { useEffect, useState } from "react";
import { PendingEventQueue } from "@defer/core/pending-event-queue";
import { RelayClient, RelayError } from "@defer/core/relay-client";
import { OutboundFlush } from "@defer/core/outbound-flush";

import type { StoragePort } from "../storage/index.js";
import { VaultProjectionStore } from "../vault/projection-store.js";
import { VaultCommands } from "../vault/commands.js";
import { SqlitePendingQueueStorage } from "../vault/pending-queue-adapter.js";
import { decodePendingEvent } from "../vault/wire-codec.js";
import { ensureDeviceAuthToken, getRelayBaseUrl } from "../vault/relay-config.js";
import { InboundScheduler, makeInboundReplay } from "../vault/inbound.js";
import { SearchStore } from "../vault/search-store.js";
import { LastOpenedStore } from "../runtime/last-opened-store.js";
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
import { MainView } from "./MainView.js";

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
    inbound: InboundScheduler;
    lastOpened: LastOpenedStore;
    search: SearchStore;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const existing = await loadVault(storage);
      if (cancelled) return;
      if (existing) {
        const services = await buildServices(storage, existing.deviceId);
        if (cancelled) {
          services.inbound.stop();
          return;
        }
        services.inbound.start();
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

  // Stop the inbound scheduler when the component unmounts so timers don't
  // leak in tests or when the user navigates between vaults.
  useEffect(() => {
    return () => {
      services?.inbound.stop();
    };
  }, [services]);

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
          built.inbound.start();
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
  return (
    <MainView
      projection={services.projection}
      commands={services.commands}
      lastOpened={services.lastOpened}
      search={services.search}
      onRefresh={() => services.inbound.triggerNow()}
    />
  );
}

async function buildServices(
  storage: StoragePort,
  deviceId: string,
): Promise<{
  projection: VaultProjectionStore;
  commands: VaultCommands;
  inbound: InboundScheduler;
  lastOpened: LastOpenedStore;
  search: SearchStore;
}> {
  const projection = new VaultProjectionStore(storage);
  await projection.hydrate();

  const search = new SearchStore();
  await search.hydrate(storage);

  const pendingQueue = new PendingEventQueue(new SqlitePendingQueueStorage(storage));

  const loaded = await loadVault(storage);
  const vaultIdBase64Url = loaded?.vaultIdBase64Url ?? "";
  const bearerToken = await ensureDeviceAuthToken(storage);
  const baseUrl = await getRelayBaseUrl(storage);

  const client = new RelayClient({ baseUrl, vaultIdBase64Url, bearerToken });
  const flush = new OutboundFlush({
    queue: pendingQueue,
    client,
    decode: decodePendingEvent,
    async onSeqAssigned(assignments) {
      for (const a of assignments) {
        await storage.stampEventSeq(a.deviceId, a.clientNonce, a.seq);
      }
    },
  });

  const commands = new VaultCommands({
    storage,
    projection,
    pendingQueue,
    searchStore: search,
    deviceId,
    now: Date.now,
    onPersisted: () => {
      // Fire-and-forget: kick a flush but surface relay errors to the
      // console (no toast wiring in this slice yet — landing in the
      // settings/error-surface slice). The queue retains failed events
      // for retry on the next save or app open.
      void flush.flush().catch((err: unknown) => {
        if (err instanceof RelayError) {
          // eslint-disable-next-line no-console
          console.warn("[relay]", err.code, err.requestId, err.envelope.error);
        } else {
          // eslint-disable-next-line no-console
          console.warn("[relay] transport error", err);
        }
      });
    },
  });

  const inboundReplay = makeInboundReplay({
    client,
    storage,
    projection,
    searchStore: search,
  });
  const inbound = new InboundScheduler(inboundReplay);

  const lastOpened = new LastOpenedStore(storage);
  await lastOpened.hydrate();

  return { projection, commands, inbound, lastOpened, search };
}
