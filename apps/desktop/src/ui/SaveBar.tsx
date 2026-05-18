import { useState } from "react";

type SaveBarProps = {
  onSave: (url: string) => Promise<void>;
};

export function SaveBar({ onSave }: SaveBarProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const trimmed = value.trim();
    if (trimmed === "") return;
    setPending(true);
    try {
      await onSave(trimmed);
      setValue("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="save-bar" onSubmit={handleSubmit}>
      <input
        type="url"
        placeholder="Paste a URL to save"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        autoFocus
      />
      <button type="submit" disabled={pending || value.trim() === ""}>
        Save
      </button>
      {error ? <span className="danger">{error}</span> : null}
    </form>
  );
}
