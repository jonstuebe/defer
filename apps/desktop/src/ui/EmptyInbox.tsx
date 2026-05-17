type EmptyInboxProps = {
  onContinue: () => void;
};

export function EmptyInbox({ onContinue }: EmptyInboxProps) {
  return (
    <div className="screen col">
      <h1>Your vault is ready</h1>
      <p>Welcome to defer. Your inbox is empty.</p>
      <div className="empty-inbox-hint">
        Save a link from the Chrome extension, or paste a URL here to get started.
      </div>
      <div className="row">
        <button onClick={onContinue}>Go to my inbox</button>
      </div>
    </div>
  );
}
