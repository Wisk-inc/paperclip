// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nativeHaptic = vi.hoisted(() => vi.fn(() => false));
vi.mock("./automa-native", () => ({ automaNative: { haptic: nativeHaptic } }));

const { haptic } = await import("./haptics");

/** A touch phone's browser: coarse pointer, with `userActivation` saying whether the page was touched yet. */
function phoneBrowser(options: { touched?: boolean; activationApi?: boolean } = {}) {
  const vibrate = vi.fn(() => true);
  Object.defineProperty(window, "matchMedia", { configurable: true, value: (query: string) => ({ matches: query === "(pointer: coarse)" }) });
  Object.defineProperty(navigator, "vibrate", { configurable: true, value: vibrate });
  Object.defineProperty(navigator, "userActivation", {
    configurable: true,
    value: options.activationApi === false ? undefined : { hasBeenActive: options.touched ?? true, isActive: false },
  });
  return vibrate;
}

beforeEach(() => {
  nativeHaptic.mockReset();
  nativeHaptic.mockReturnValue(false);
});
afterEach(() => {
  Reflect.deleteProperty(navigator, "vibrate");
  Reflect.deleteProperty(navigator, "userActivation");
  Reflect.deleteProperty(window, "matchMedia");
});

describe("haptic", () => {
  it("vibrates in a phone browser once the page has been touched", () => {
    const vibrate = phoneBrowser({ touched: true });
    haptic("success");
    expect(vibrate).toHaveBeenCalledWith([8, 56, 16]);
  });

  it("does not ask the browser to vibrate before the first touch", () => {
    // Chrome blocks the call and logs an error ("Blocked call to navigator.vibrate
    // because user hasn't tapped on the frame"): a haptic played as a screen appears.
    const vibrate = phoneBrowser({ touched: false });
    haptic("success");
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("still vibrates where the browser has no user-activation API", () => {
    const vibrate = phoneBrowser({ activationApi: false });
    haptic("tick");
    expect(vibrate).toHaveBeenCalledWith(8);
  });

  it("uses the app's own haptics when they are there, touched or not", () => {
    const vibrate = phoneBrowser({ touched: false });
    nativeHaptic.mockReturnValue(true);
    haptic("warning");
    expect(nativeHaptic).toHaveBeenCalledWith("warning");
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("does nothing on a desktop pointer", () => {
    const vibrate = phoneBrowser({ touched: true });
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false }) });
    haptic("tick");
    expect(vibrate).not.toHaveBeenCalled();
  });
});
