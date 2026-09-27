/** Pure helper — prevents async hydration from undoing an in-flight accept. */
export function resolveHydratedAccepted(
  currentAccepted: boolean,
  acceptInFlight: boolean,
  storedAccepted: boolean,
): boolean {
  if (acceptInFlight) {
    return true;
  }
  if (currentAccepted) {
    return true;
  }
  return storedAccepted;
}

/** Mirrors PrivacyConsentGate — privacy screen when hydration finished and not accepted. */
export function shouldShowPrivacyConsentScreen(loading: boolean, accepted: boolean): boolean {
  return !loading && !accepted;
}
