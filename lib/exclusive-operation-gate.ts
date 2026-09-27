import { createGuardedOperationId } from './guarded-operation';

export interface ExclusiveOperationLease {
  readonly operationId: string;
  isOwner(): boolean;
  release(): boolean;
}

export interface ExclusiveOperationGate {
  tryAcquire(): ExclusiveOperationLease | null;
  isLocked(): boolean;
  invalidateCurrent(): boolean;
  release(lease: ExclusiveOperationLease): boolean;
  dispose(): void;
}

interface ExclusiveOperationState {
  active: boolean;
  lease: ExclusiveOperationLease;
}

/**
 * Lock sincrono, non accodante e ownership-safe per gli handler UI.
 *
 * Il secondo ingresso riceve subito null. Una finally tardiva può rilasciare
 * soltanto la propria lease e non può quindi aprire il gate posseduto da un
 * retry più recente.
 */
export function createExclusiveOperationGate(
  idFactory: () => string = () => createGuardedOperationId('exclusive')
): ExclusiveOperationGate {
  let current: ExclusiveOperationState | null = null;
  let disposed = false;
  let localSequence = 0;

  const gate: ExclusiveOperationGate = {
    tryAcquire(): ExclusiveOperationLease | null {
      if (disposed || current?.active) return null;

      localSequence += 1;
      const baseId = idFactory().trim() || 'exclusive';
      const operationId = `${baseId}-${localSequence.toString(36)}`;
      const state = {} as ExclusiveOperationState;
      const lease: ExclusiveOperationLease = {
        operationId,
        isOwner: () =>
          !disposed && current === state && state.active,
        release: () => gate.release(lease),
      };
      Object.assign(state, { active: true, lease });
      current = state;
      return lease;
    },

    isLocked(): boolean {
      return Boolean(!disposed && current?.active);
    },

    invalidateCurrent(): boolean {
      if (!current?.active) return false;
      current.active = false;
      current = null;
      return true;
    },

    release(lease): boolean {
      if (
        disposed ||
        !current?.active ||
        current.lease !== lease
      ) {
        return false;
      }
      current.active = false;
      current = null;
      return true;
    },

    dispose(): void {
      if (disposed) return;
      if (current) current.active = false;
      current = null;
      disposed = true;
    },
  };

  return gate;
}
