// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FEATURE_TOUR_EVENT, FEATURE_TOUR_PENDING_KEY, featureTourPending, markFeatureTourDone, requestFeatureTour } from "./feature-tour";

describe("feature tour flag", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  it("is pending after a request and cleared once done", () => {
    const listener = vi.fn();
    window.addEventListener(FEATURE_TOUR_EVENT, listener);
    expect(featureTourPending()).toBe(false);
    requestFeatureTour();
    expect(featureTourPending()).toBe(true);
    expect(localStorage.getItem(FEATURE_TOUR_PENDING_KEY)).toBe("1");
    expect(listener).toHaveBeenCalledTimes(1);
    markFeatureTourDone();
    expect(featureTourPending()).toBe(false);
    window.removeEventListener(FEATURE_TOUR_EVENT, listener);
  });
});
