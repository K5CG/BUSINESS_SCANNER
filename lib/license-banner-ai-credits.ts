/** Informational home-banner display only — does not gate cloud AI features. */
export function resolveLicenseBannerAiCredits(
  aiCreditsRemaining: unknown
): number | null {
  return typeof aiCreditsRemaining === 'number' ? aiCreditsRemaining : null;
}
