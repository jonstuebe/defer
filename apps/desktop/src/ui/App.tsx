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
import { RestoreFlow } from "./RestoreFlow.js";
import { Settings } from "./Settings.js";
import { PairDevice } from "./PairDevice.js";
import { SignOutConfirm } from "./SignOutConfirm.js";
import { executePairing } from "../vault/pairing-existing-device.js";
import { signOutThisDevice } from "../vault/sign-out.js";
import { restoreFromMnemonic } from "../onboarding/restore-vault.js";

type Screen =
  | { name: "loading" }
  | { name: "welcome" }
  | { name: "create-mnemonic-display"; vault: CreatedVault }
  | { name: "create-mnemonic-verification"; vault: CreatedVault }
  | { name: "restore" }
  | { name: "empty-inbox" }
  | { name: "inbox" }
  | { name: "settings" }
  | { name: "pair-device" }
  | { name: "sign-out-confirm" };

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
        onRestore={() => setScreen({ name: "restore" })}
      />
    );
  }
  if (screen.name === "create-mnemonic-display") {
    return (
      <MnemonicDisplay
        mnemonic={screen.vault.mnemonic}
        vaultIdBytes={screen.vault.vaultId}
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
  if (screen.name === "restore") {
    return (
      <RestoreFlow
        onBack={() => setScreen({ name: "welcome" })}
        onRestore={async (mnemonic) => {
          const baseUrl = await getRelayBaseUrl(storage);
          const { vault } = await restoreFromMnemonic(mnemonic, {
            storage,
            relayBaseUrl: baseUrl,
          });
          const built = await buildServices(storage, vault.deviceId);
          built.inbound.start();
          // Trigger an immediate pull to begin replay; the scheduler's
          // `start()` already kicked one, but `triggerNow()` queues a
          // trailing pull in case the first request was issued before
          // the device-auth-token persisted (race-safe).
          built.inbound.triggerNow();
          setServices(built);
          setScreen({ name: "inbox" });
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
  if (screen.name === "settings") {
    const loaded = services;
    return (
      <Settings
        projection={loaded.projection}
        commands={loaded.commands}
        storage={storage}
        currentDeviceId={loaded.commands.getDeviceId()}
        onClose={() => setScreen({ name: "inbox" })}
        onPairNewDevice={() => setScreen({ name: "pair-device" })}
        onSignOutThisDevice={() => setScreen({ name: "sign-out-confirm" })}
      />
    );
  }
  if (screen.name === "sign-out-confirm") {
    const loaded = services;
    const devices = loaded.projection.getState().devices;
    const isLastDevice = devices.size <= 1;
    return (
      <SignOutConfirm
        isLastDevice={isLastDevice}
        onCancel={() => setScreen({ name: "settings" })}
        onConfirm={async () => {
          const baseUrl = await getRelayBaseUrl(storage);
          await signOutThisDevice({
            storage,
            commands: loaded.commands,
            relayBaseUrl: baseUrl,
            currentDeviceId: loaded.commands.getDeviceId(),
          });
          loaded.inbound.stop();
          setServices(null);
          setScreen({ name: "welcome" });
        }}
      />
    );
  }
  if (screen.name === "pair-device") {
    return (
      <PairDevice
        onCancel={() => setScreen({ name: "settings" })}
        onConfirm={async (target) => {
          const baseUrl = await getRelayBaseUrl(storage);
          const currentDeviceAuthToken = await ensureDeviceAuthToken(storage);
          await executePairing(target, {
            storage,
            relayBaseUrl: baseUrl,
            currentDeviceAuthToken,
          });
          setScreen({ name: "settings" });
        }}
      />
    );
  }
  return (
    <MainView
      projection={services.projection}
      commands={services.commands}
      lastOpened={services.lastOpened}
      search={services.search}
      onRefresh={() => services.inbound.triggerNow()}
      onOpenSettings={() => setScreen({ name: "settings" })}
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
