import { describe, expect, it, vi } from "vitest";

import { buildKeydownHandler } from "./use-keyboard-shortcuts.js";

function makeEvent(key: string, opts: Partial<KeyboardEvent> = {}): KeyboardEvent {
  // Minimal KeyboardEvent surface — we don't need a real DOM; the
  // handler only reads `key`, `metaKey`, `ctrlKey`, `target`, and the
  // `preventDefault` method.
  let defaultPrevented = false;
  return {
    key,
    metaKey: opts.metaKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    target: opts.target ?? null,
    preventDefault() {
      defaultPrevented = true;
    },
    get defaultPrevented() {
      return defaultPrevented;
    },
  } as unknown as KeyboardEvent;
}

function freshHandlers() {
  return {
    onEnter: vi.fn(),
    onSpace: vi.fn(),
    onFindFocus: vi.fn(),
    onMoveUp: vi.fn(),
    onMoveDown: vi.fn(),
  };
}

describe("buildKeydownHandler", () => {
  it("fires onEnter on ⏎ when target is not editable", () => {
    const handlers = freshHandlers();
    const handler = buildKeydownHandler(handlers, () => false);
    handler(makeEvent("Enter"));
    expect(handlers.onEnter).toHaveBeenCalledOnce();
  });

  it("fires onSpace on Space", () => {
    const handlers = freshHandlers();
    const handler = buildKeydownHandler(handlers, () => false);
    handler(makeEvent(" "));
    expect(handlers.onSpace).toHaveBeenCalledOnce();
  });

  it("fires onFindFocus on ⌘+F even when target is editable", () => {
    const handlers = freshHandlers();
    const handler = buildKeydownHandler(handlers, () => true);
    handler(makeEvent("f", { metaKey: true }));
    expect(handlers.onFindFocus).toHaveBeenCalledOnce();
  });

  it("also fires onFindFocus on Ctrl+F (Linux/Windows convenience)", () => {
    const handlers = freshHandlers();
    const handler = buildKeydownHandler(handlers, () => false);
    handler(makeEvent("F", { ctrlKey: true }));
    expect(handlers.onFindFocus).toHaveBeenCalledOnce();
  });

  it("ignores Enter/Space/Arrows when target is editable", () => {
    const handlers = freshHandlers();
    const handler = buildKeydownHandler(handlers, () => true);
    handler(makeEvent("Enter"));
    handler(makeEvent(" "));
    handler(makeEvent("ArrowUp"));
    handler(makeEvent("ArrowDown"));
    expect(handlers.onEnter).not.toHaveBeenCalled();
    expect(handlers.onSpace).not.toHaveBeenCalled();
    expect(handlers.onMoveUp).not.toHaveBeenCalled();
    expect(handlers.onMoveDown).not.toHaveBeenCalled();
  });

  it("fires onMoveUp / onMoveDown on arrow keys", () => {
    const handlers = freshHandlers();
    const handler = buildKeydownHandler(handlers, () => false);
    handler(makeEvent("ArrowUp"));
    handler(makeEvent("ArrowDown"));
    expect(handlers.onMoveUp).toHaveBeenCalledOnce();
    expect(handlers.onMoveDown).toHaveBeenCalledOnce();
  });
});
