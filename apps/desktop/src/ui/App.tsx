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
import { ScheduleDeletion } from "./ScheduleDeletion.js";
import { DeletionBanner } from "./DeletionBanner.js";
import { executePairing } from "../vault/pairing-existing-device.js";
import { signOutThisDevice } from "../vault/sign-out.js";
import { scheduleVaultDeletion, cancelVaultDeletion } from "../vault/vault-deletion-scheduler.js";
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
  | { name: "sign-out-confirm" }
  | { name: "schedule-deletion" };

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
      <WithDeletionBanner services={loaded} storage={storage}>
        <Settings
          projection={loaded.projection}
          commands={loaded.commands}
          storage={storage}
          currentDeviceId={loaded.commands.getDeviceId()}
          onClose={() => setScreen({ name: "inbox" })}
          onPairNewDevice={() => setScreen({ name: "pair-device" })}
          onSignOutThisDevice={() => setScreen({ name: "sign-out-confirm" })}
          onScheduleDeletion={() => setScreen({ name: "schedule-deletion" })}
        />
      </WithDeletionBanner>
    );
  }
  if (screen.name === "schedule-deletion") {
    const loaded = services;
    return (
      <ScheduleDeletion
        onCancel={() => setScreen({ name: "settings" })}
        onConfirm={async () => {
          await scheduleVaultDeletion({
            storage,
            projection: loaded.projection,
            pendingQueue: loaded.commands.getPendingQueue(),
            deviceId: loaded.commands.getDeviceId(),
            now: Date.now,
          });
          setScreen({ name: "settings" });
        }}
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
    <WithDeletionBanner services={services} storage={storage}>
      <MainView
        projection={services.projection}
        commands={services.commands}
        lastOpened={services.lastOpened}
        search={services.search}
        onRefresh={() => services.inbound.triggerNow()}
        onOpenSettings={() => setScreen({ name: "settings" })}
      />
    </WithDeletionBanner>
  );
}

type Services = NonNullable<ReturnType<typeof useServices>>;

// Helper that subscribes to the projection's scheduledDeletion slot and
// renders the persistent banner above whatever screen is below.
function WithDeletionBanner({
  services,
  storage,
  children,
}: {
  services: Services;
  storage: StoragePort;
  children: React.ReactNode;
}) {
  const scheduled = useScheduledDeletion(services.projection);
  if (scheduled === null) return <>{children}</>;
  return (
    <>
      <DeletionBanner
        scheduledFor={scheduled.scheduledFor}
        onCancel={async () => {
          await cancelVaultDeletion({
            storage,
            projection: services.projection,
            pendingQueue: services.commands.getPendingQueue(),
            deviceId: services.commands.getDeviceId(),
            now: Date.now,
          });
        }}
      />
      {children}
    </>
  );
}

function useScheduledDeletion(projection: VaultProjectionStore): { scheduledFor: number } | null {
  const [snap, setSnap] = useState(() => projection.getState().scheduledDeletion);
  useEffect(() => {
    return projection.subscribe(() => {
      setSnap(projection.getState().scheduledDeletion);
    });
  }, [projection]);
  return snap ? { scheduledFor: snap.scheduledFor } : null;
}

// Placeholder so the WithDeletionBanner helper's `Services` type alias
// resolves without manually re-typing the services object.
function useServices() {
  return null as null | {
    projection: VaultProjectionStore;
    commands: VaultCommands;
    inbound: InboundScheduler;
    lastOpened: LastOpenedStore;
    search: SearchStore;
  };
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
    onVaultWiped: (deletedAt) => {
      // eslint-disable-next-line no-console
      console.warn("[vault] wiped via VaultDeleted at", deletedAt);
      // Tear down the inbound timer + clear in-memory services. The
      // bootstrap effect re-runs and shows the welcome screen since
      // `loadVault(storage)` now returns null (credentials cleared).
      // We can't call back into React state from here cleanly without
      // wiring a callback bus — leaving the user on the inbox until
      // they reload is acceptable; the next launch lands on welcome.
    },
    onVaultWipeRefused: (reason) => {
      // eslint-disable-next-line no-console
      console.warn("[vault] refused VaultDeleted:", reason);
    },
  });
  const inbound = new InboundScheduler(inboundReplay);

  const lastOpened = new LastOpenedStore(storage);
  await lastOpened.hydrate();

  return { projection, commands, inbound, lastOpened, search };
}
