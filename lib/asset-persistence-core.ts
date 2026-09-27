export interface AssetSaveSagaSteps {
  stage: () => Promise<void>;
  promote: () => Promise<void>;
  persist: () => Promise<void>;
  /**
   * Riconcilia un errore ambiguo di commit. Deve restituire true solo quando
   * il record realmente salvato punta agli asset appena promossi.
   */
  isPersisted: () => Promise<boolean>;
  rollbackAssets: () => Promise<void>;
}

export interface AssetDeleteSagaSteps {
  stageAssets: () => Promise<void>;
  deleteRecord: () => Promise<void>;
  /**
   * Riconcilia un errore ambiguo di commit. Deve restituire true solo quando
   * il record non esiste piu nel database.
   */
  isDeleted: () => Promise<boolean>;
  restoreAssets: () => Promise<void>;
  finalizeAssets: () => Promise<void>;
}

export interface AssetDeleteResult {
  cleanupPending: boolean;
}

export interface AssetBatchDeleteSagaSteps<TItem, TToken> {
  items: readonly TItem[];
  stageItem: (item: TItem) => Promise<TToken | null>;
  deleteRecords: () => Promise<void>;
  areDeleted: () => Promise<boolean>;
  restoreItem: (token: TToken) => Promise<void>;
  finalizeItem: (token: TToken) => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function rollbackThenThrow(
  originalError: unknown,
  rollback: () => Promise<void>
): Promise<never> {
  try {
    await rollback();
  } catch (rollbackError) {
    throw new Error(
      `${errorMessage(originalError)}; rollback asset fallito: ${errorMessage(rollbackError)}`,
      { cause: originalError }
    );
  }
  throw originalError;
}

/**
 * Saga file + database:
 * staging -> promozione versionata -> commit DB.
 *
 * Il DB viene scritto solo dopo la promozione. Se l'esito del commit e
 * ambiguo, prima di compensare viene riletto lo stato persistito.
 */
export async function runAssetSaveSaga(steps: AssetSaveSagaSteps): Promise<void> {
  try {
    await steps.stage();
    await steps.promote();
  } catch (error) {
    return rollbackThenThrow(error, steps.rollbackAssets);
  }

  try {
    await steps.persist();
  } catch (error) {
    let persisted = false;
    try {
      persisted = await steps.isPersisted();
    } catch {
      // Stato DB incerto: non cancellare asset che potrebbero essere vivi.
      throw error;
    }
    if (persisted) return;
    return rollbackThenThrow(error, steps.rollbackAssets);
  }
}

/**
 * Saga di eliminazione:
 * spostamento reversibile -> commit DB -> cleanup idempotente.
 *
 * Un cleanup post-commit fallito non fa riapparire il record: resta lavoro
 * recuperabile allo startup e viene segnalato con cleanupPending.
 */
export async function runAssetDeleteSaga(
  steps: AssetDeleteSagaSteps
): Promise<AssetDeleteResult> {
  try {
    await steps.stageAssets();
  } catch (error) {
    return rollbackThenThrow(error, steps.restoreAssets);
  }

  try {
    await steps.deleteRecord();
  } catch (error) {
    let deleted = false;
    try {
      deleted = await steps.isDeleted();
    } catch {
      // Stato DB incerto: preserva lo staging e lascia decidere al recovery.
      throw error;
    }
    if (!deleted) {
      return rollbackThenThrow(error, steps.restoreAssets);
    }
  }

  try {
    await steps.finalizeAssets();
    return { cleanupPending: false };
  } catch {
    return { cleanupPending: true };
  }
}

async function restoreBatch<TToken>(
  tokens: readonly TToken[],
  restoreItem: (token: TToken) => Promise<void>
): Promise<void> {
  let firstError: unknown;
  for (const token of [...tokens].reverse()) {
    try {
      await restoreItem(token);
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}

export async function runAssetBatchDeleteSaga<TItem, TToken>(
  steps: AssetBatchDeleteSagaSteps<TItem, TToken>
): Promise<AssetDeleteResult> {
  const tokens: TToken[] = [];
  try {
    for (const item of steps.items) {
      const token = await steps.stageItem(item);
      if (token != null) tokens.push(token);
    }
  } catch (error) {
    try {
      await restoreBatch(tokens, steps.restoreItem);
    } catch (restoreError) {
      throw new Error(
        `${errorMessage(error)}; rollback batch fallito: ${errorMessage(restoreError)}`,
        { cause: error }
      );
    }
    throw error;
  }

  try {
    await steps.deleteRecords();
  } catch (error) {
    let deleted = false;
    try {
      deleted = await steps.areDeleted();
    } catch {
      // Commit incerto: preserva il trash per il recovery.
      throw error;
    }
    if (!deleted) {
      try {
        await restoreBatch(tokens, steps.restoreItem);
      } catch (restoreError) {
        throw new Error(
          `${errorMessage(error)}; rollback batch fallito: ${errorMessage(restoreError)}`,
          { cause: error }
        );
      }
      throw error;
    }
  }

  let cleanupPending = false;
  for (const token of tokens) {
    try {
      await steps.finalizeItem(token);
    } catch {
      cleanupPending = true;
    }
  }
  return { cleanupPending };
}
