/** Identificativo build parser — incrementare ad ogni hardening significativo. */
// Questo ID viene anche inserito nel bundle Android. Incrementarlo rende
// verificabile che l'APK contenga davvero l'ultima logica TypeScript.
export const PARSER_BUILD_ID = 'v101-phone-filter-role-garbage-2026-09-27';

export function parserBuildLabel(): string {
  return PARSER_BUILD_ID;
}
