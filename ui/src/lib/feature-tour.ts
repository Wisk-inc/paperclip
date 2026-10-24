/**
 * The feature tour: one card per section of Automa, shown once after
 * onboarding and again whenever someone asks for it from their account sheet.
 * The request is a flag plus an event, so the wizard (which closes itself) and
 * the tour (which lives in the shell) never need to know about each other.
 */
export const FEATURE_TOUR_PENDING_KEY = "automa.tour.pending";
export const FEATURE_TOUR_SEEN_KEY = "automa.tour.seen";
export const FEATURE_TOUR_EVENT = "automa:feature-tour";

export function requestFeatureTour() {
  try {
    localStorage.setItem(FEATURE_TOUR_PENDING_KEY, "1");
  } catch {
    // Storage may be unavailable; the event alone still opens the tour now.
  }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(FEATURE_TOUR_EVENT));
}

export function featureTourPending(): boolean {
  try {
    return localStorage.getItem(FEATURE_TOUR_PENDING_KEY) === "1";
  } catch {
    return false;
  }
}

export function featureTourSeen(): boolean {
  try {
    return localStorage.getItem(FEATURE_TOUR_SEEN_KEY) !== null;
  } catch {
    return false;
  }
}

export function markFeatureTourDone() {
  try {
    localStorage.removeItem(FEATURE_TOUR_PENDING_KEY);
    localStorage.setItem(FEATURE_TOUR_SEEN_KEY, new Date().toISOString());
  } catch {
    // Ignore storage failures.
  }
}
