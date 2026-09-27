import { pickOrganizationHeaderFromEvidence } from '../company';

/**
 * Checks whether the OCR raw text provides an organization header that can serve as evidence
 * for the given company value. It leverages the existing heuristic `pickOrganizationHeaderFromEvidence`.
 */
export function hasCompanyEvidence(company: string, rawText: string, emails: string[] = []): boolean {
  const header = pickOrganizationHeaderFromEvidence(rawText, emails);
  return !!header;
}
