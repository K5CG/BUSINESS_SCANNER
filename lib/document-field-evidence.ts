import type { FieldQuality } from './document-field-quality';
import { logQaDocument } from './qa-document-logging';

export type EvidenceCommitLevel = 'STRONG' | 'MEDIUM' | 'WEAK';

export interface FieldEvidenceNode<T = unknown> {
  value: T | null;
  region?: string;
  columnRole?: string;
  confidence: EvidenceCommitLevel;
  evidence: string[];
  rejectedAlternatives: string[];
}

export function commitLevelFromQuality(quality: FieldQuality): EvidenceCommitLevel {
  if (quality === 'STRONG') return 'STRONG';
  if (quality === 'COHERENT') return 'MEDIUM';
  return 'WEAK';
}

/** STRONG/MEDIUM persist; WEAK is omitted rather than written as a wrong value. */
export function shouldPersistCommittedField(level: EvidenceCommitLevel): boolean {
  return level === 'STRONG' || level === 'MEDIUM';
}

export function logSemanticRoleViolation(input: {
  field: string;
  fromRole: string;
  toRole: string;
  value?: number | string | null;
  stage: string;
  reason?: string;
}): void {
  logQaDocument('SemanticRoleViolation', input);
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(`[SemanticRoleViolation] ${input.stage}`, JSON.stringify(input));
  }
}

export function fieldEvidence<T>(input: {
  value: T | null;
  region?: string;
  columnRole?: string;
  confidence: EvidenceCommitLevel;
  evidence?: string[];
  rejectedAlternatives?: string[];
}): FieldEvidenceNode<T> {
  return {
    value: input.value,
    region: input.region,
    columnRole: input.columnRole,
    confidence: input.confidence,
    evidence: input.evidence ?? [],
    rejectedAlternatives: input.rejectedAlternatives ?? [],
  };
}
