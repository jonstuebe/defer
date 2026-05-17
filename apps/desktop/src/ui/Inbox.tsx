import { useSyncExternalStore } from "react";
import type { Item } from "@defer/core";

import type { VaultProjectionStore } from "../vault/projection-store.js";
import type { VaultCommands } from "../vault/commands.js";
import { openExternalUrl } from "../runtime/url-opener.js";
import { SaveBar } from "./SaveBar.js";
import { ItemRow } from "./ItemRow.js";
import { EmptyInbox } from "./EmptyInbox.js";

type InboxProps = {
  projection: VaultProjectionStore;
  commands: VaultCommands;
};

export function Inbox({ projection, commands }: InboxProps) {
  const items = useProjectionItems(projection);

  async function handleSave(url: string) {
    await commands.save(url);
  }

  function handleOpen(item: Item) {
    void openExternalUrl(item.url);
  }

  return (
    <div className="screen col">
      <h1>Inbox</h1>
      <SaveBar onSave={handleSave} />
      {items.length === 0 ? (
        <EmptyInbox onContinue={() => void 0} />
      ) : (
        <ul className="item-list">
          {items
            .filter((item) => item.state === "inbox")
            .map((item) => (
              <ItemRow key={item.id} item={item} onOpen={() => handleOpen(item)} />
            ))}
        </ul>
      )}
    </div>
  );
}

function useProjectionItems(projection: VaultProjectionStore): readonly Item[] {
  return useSyncExternalStore(
    (listener) => projection.subscribe(listener),
    () => projection.getItemsSortedBySavedAtDesc(),
    () => projection.getItemsSortedBySavedAtDesc(),
  );
}
