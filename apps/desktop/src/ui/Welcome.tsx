type WelcomeProps = {
  onCreateNewVault: () => void;
  onRestore: () => void;
};

export function Welcome({ onCreateNewVault, onRestore }: WelcomeProps) {
  return (
    <div className="screen col">
      <h1>Welcome to defer</h1>
      <p className="muted">
        Defer is a local-first read-later queue. Your saved items are encrypted on your device and
        sync between your devices through a blind relay that never sees your URLs.
      </p>
      <div className="card col">
        <button onClick={onCreateNewVault}>Create new vault</button>
        <button className="secondary" onClick={onRestore}>
          I already have a vault — restore
        </button>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        Restore is coming in a later slice. For now, only vault creation is wired.
      </p>
    </div>
  );
}
