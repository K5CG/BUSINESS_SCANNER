/** Runtime trial accounting gate — updated by LicenseProvider on refresh. */
let skipTrialScanAccounting = false;

export function setTrialScanAccountingEnabled(enabled: boolean): void {
  skipTrialScanAccounting = !enabled;
}

export function shouldSkipTrialScanAccounting(): boolean {
  return skipTrialScanAccounting;
}
