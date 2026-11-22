// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "./sheet";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("the X on a sheet and on a dialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const sheet = (props: { showCloseButton?: boolean; onOpenChange?: (open: boolean) => void } = {}) => (
    <Sheet open onOpenChange={props.onOpenChange}>
      <SheetContent side="bottom" showCloseButton={props.showCloseButton}>
        <SheetTitle>Checkpoints</SheetTitle>
        <SheetDescription>Go back to any of these.</SheetDescription>
      </SheetContent>
    </Sheet>
  );
  const dialog = (props: { showCloseButton?: boolean; onOpenChange?: (open: boolean) => void } = {}) => (
    <Dialog open onOpenChange={props.onOpenChange}>
      <DialogContent showCloseButton={props.showCloseButton}>
        <DialogTitle>App settings</DialogTitle>
        <DialogDescription>Name and run command.</DialogDescription>
      </DialogContent>
    </Dialog>
  );

  it.each([
    ["sheet", "sheet-content", "sheet-close", sheet],
    ["dialog", "dialog-content", "dialog-close", dialog],
  ] as const)("is a 44 px target with the X in its middle on a touch screen (%s)", async (_name, contentSlot, closeSlot, render) => {
    const onOpenChange = vi.fn();
    await act(async () => root.render(render({ onOpenChange })));
    const content = document.querySelector(`[data-slot="${contentSlot}"]`)!;
    const close = content.querySelector<HTMLButtonElement>(`:scope > button[data-slot="${closeSlot}"]`)!;
    expect(close.textContent).toBe("Close");
    const classes = close.className.split(/\s+/);
    // The X in the middle of the target, whatever size the target is.
    expect(classes).toEqual(expect.arrayContaining(["absolute", "inline-flex", "items-center", "justify-center"]));
    // For a mouse the X is 16 px in from the corner. Under a finger the target is 44 px
    // and 2 px in, which leaves the X where it was and the target inside the sheet.
    expect(classes).toEqual(expect.arrayContaining(["top-4", "end-4", "pointer-coarse:top-0.5", "pointer-coarse:end-0.5", "pointer-coarse:size-11"]));
    await act(async () => close.click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("is left out when the sheet or dialog draws its own", async () => {
    await act(async () => root.render(sheet({ showCloseButton: false })));
    expect(document.querySelector('[data-slot="sheet-content"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="sheet-close"]')).toBeNull();
    await act(async () => root.render(dialog({ showCloseButton: false })));
    expect(document.querySelector('[data-slot="dialog-content"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="dialog-close"]')).toBeNull();
  });
});
