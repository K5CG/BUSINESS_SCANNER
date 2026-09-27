/** Pure contract for tests — exit must never wipe durable app state. */
export function exitAppSessionSideEffects(): {
  clearsLocalData: false;
  clearsSecureStore: false;
  resetsTrial: false;
  resetsLicense: false;
  resetsPrivacyConsent: false;
} {
  return {
    clearsLocalData: false,
    clearsSecureStore: false,
    resetsTrial: false,
    resetsLicense: false,
    resetsPrivacyConsent: false,
  };
}
