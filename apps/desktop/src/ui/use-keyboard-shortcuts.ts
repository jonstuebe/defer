import { useEffect } from "react";

export type KeyboardHandlers = {
  /** ⏎ on selected row — PRD US #44. */
  onEnter: () => void;
  /** Space on selected row — toggles the detail pane. PRD US #44. */
  onSpace: () => void;
  /** ⌘F / Ctrl+F — focuses search. Noop if no search input is mounted. */
  onFindFocus: () => void;
  /** ↑ — move selection one row up. */
  onMoveUp: () => void;
  /** ↓ — move selection one row down. */
  onMoveDown: () => void;
};

/**
 * Builds the pure keydown handler used by both the React hook below and
 * the unit tests. Extracting it keeps the hook a one-liner and lets the
 * tests assert on behaviour without a DOM-test-renderer dep.
 *
 * `getEditableFlag` reads the event's target — overridable so tests can
 * simulate "this came from an input" without constructing a real input.
 */
export function buildKeydownHandler(
  handlers: KeyboardHandlers,
  getEditableFlag: (event: KeyboardEvent) => boolean = isEditableTarget,
): (event: KeyboardEvent) => void {
  return (event: KeyboardEvent) => {
    const meta = event.metaKey || event.ctrlKey;
    if (meta && event.key.toLowerCase() === "f") {
      event.preventDefault();
      handlers.onFindFocus();
      return;
    }

    if (getEditableFlag(event)) return;

    switch (event.key) {
      case "Enter":
        event.preventDefault();
        handlers.onEnter();
        break;
      case " ":
        event.preventDefault();
        handlers.onSpace();
        break;
      case "ArrowUp":
        event.preventDefault();
        handlers.onMoveUp();
        break;
      case "ArrowDown":
        event.preventDefault();
        handlers.onMoveDown();
        break;
    }
  };
}

function isEditableTarget(event: KeyboardEvent): boolean {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Registers `buildKeydownHandler` on the document for the lifetime of
 * the component. ⌘F bypasses the editable-target guard (users expect it
 * to work from inside the search input). All other shortcuts ignore the
 * keystroke when the user is typing into a form field.
 */
export function useKeyboardShortcuts(handlers: KeyboardHandlers): void {
  useEffect(() => {
    const handler = buildKeydownHandler(handlers);
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [handlers]);
}
