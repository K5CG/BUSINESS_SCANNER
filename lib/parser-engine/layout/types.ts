export type BlockKind =
  | 'identity'
  | 'company'
  | 'role'
  | 'address'
  | 'contact'
  | 'tax'
  | 'noise'
  | 'unknown';

export interface LayoutLine {
  text: string;
  confidence: number;
  lineIndex: number;
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
  centerX: number;
  centerY: number;
  numericDensity: number;
  uppercaseRatio: number;
}

export interface BlockFeatureVector {
  lineCount: number;
  avgConfidence: number;
  avgNumericDensity: number;
  avgUppercaseRatio: number;
  hasEmail: boolean;
  hasPhone: boolean;
  hasWebsite: boolean;
  hasAddressHints: boolean;
  hasPostalCode: boolean;
  hasProvinceHint: boolean;
  hasLegalForm: boolean;
  hasRoleHints: boolean;
  hasCatalogNoise: boolean;
  verticalRank: number;
}

export interface LayoutBlock {
  id: string;
  pageIndex: number;
  lines: LayoutLine[];
  sourceLineIndices: number[];
  x: number;
  y: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
  kind: BlockKind;
  confidence: number;
  reasons: string[];
  features: BlockFeatureVector;
}

export interface BlockDetectionResult {
  lines: LayoutLine[];
  blocks: LayoutBlock[];
  possibleCompanyBlockId?: string;
  possibleIdentityBlockId?: string;
  possibleContactBlockId?: string;
}
