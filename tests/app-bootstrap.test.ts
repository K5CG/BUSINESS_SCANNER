import assert from 'node:assert/strict';
import test from 'node:test';
import {
  runAppBootstrap,
  type AppBootstrapDependencies,
} from '../lib/app-bootstrap';

type MarkerState = string | undefined;
type FailureStep = 'initDatabase' | 'getSavedLocale' | 'changeLanguage' | 'loadContacts';

interface PersistentFixture {
  migrationMarker: MarkerState;
  contacts: string[];
  documents: string[];
  imageFiles: string[];
}

interface BootstrapHarness {
  persistent: PersistentFixture;
  calls: string[];
  loadedContacts: string[];
  setFailureStep: (step: FailureStep | null) => void;
  dependencies: AppBootstrapDependencies;
}

const VALID_LEGACY_MARKER = 'business-scanner-data-reset-v1';

function clonePersistent(value: PersistentFixture): PersistentFixture {
  return {
    migrationMarker: value.migrationMarker,
    contacts: [...value.contacts],
    documents: [...value.documents],
    imageFiles: [...value.imageFiles],
  };
}

function createHarness(
  marker: MarkerState,
  options: { savedLocale?: string; currentLocale?: string } = {}
): BootstrapHarness & { currentLocale: string } {
  const persistent: PersistentFixture = {
    migrationMarker: marker,
    contacts: ['contact-existing'],
    documents: ['document-existing'],
    imageFiles: [
      'scans/contact-existing/page-0.jpg',
      'scans/document-existing/page-0.jpg',
    ],
  };
  const calls: string[] = [];
  const loadedContacts: string[] = [];
  let failureStep: FailureStep | null = null;
  let currentLocale = options.currentLocale ?? 'it';
  const savedLocale = options.savedLocale ?? 'it';

  const failIfRequested = (step: FailureStep) => {
    if (failureStep === step) {
      throw new Error(`interrupted:${step}`);
    }
  };

  const dependencies: AppBootstrapDependencies = {
    initDatabase: async () => {
      calls.push('initDatabase');
      failIfRequested('initDatabase');
    },
    getSavedLocale: async () => {
      calls.push('getSavedLocale');
      failIfRequested('getSavedLocale');
      return savedLocale;
    },
    changeLanguage: async (locale) => {
      calls.push(`changeLanguage:${locale}`);
      failIfRequested('changeLanguage');
      currentLocale = locale;
    },
    loadContacts: async () => {
      calls.push('loadContacts');
      failIfRequested('loadContacts');
      loadedContacts.splice(0, loadedContacts.length, ...persistent.contacts);
    },
  };

  return {
    persistent,
    calls,
    loadedContacts,
    currentLocale,
    setFailureStep: (step) => {
      failureStep = step;
    },
    dependencies,
  };
}

test('primo avvio: inizializza e carica senza creare marker o cancellare dati', async () => {
  const harness = createHarness(undefined);
  harness.persistent.contacts = [];
  harness.persistent.documents = [];
  harness.persistent.imageFiles = [];
  const before = clonePersistent(harness.persistent);

  await runAppBootstrap(harness.dependencies, harness.currentLocale);

  assert.deepEqual(harness.persistent, before);
  assert.deepEqual(harness.calls, ['initDatabase', 'getSavedLocale', 'loadContacts']);
  assert.deepEqual(harness.loadedContacts, []);
});

for (const scenario of [
  { name: 'marker legacy presente', marker: VALID_LEGACY_MARKER },
  { name: 'marker legacy mancante', marker: undefined },
  { name: 'marker legacy corrotto', marker: 'marker-corrotto-o-incompleto' },
] satisfies Array<{ name: string; marker: MarkerState }>) {
  test(`${scenario.name}: DB e immagini preesistenti restano invariati`, async () => {
    const harness = createHarness(scenario.marker);
    const before = clonePersistent(harness.persistent);

    await runAppBootstrap(harness.dependencies, harness.currentLocale);

    assert.deepEqual(harness.persistent, before);
    assert.deepEqual(harness.loadedContacts, before.contacts);
    assert.deepEqual(harness.calls, ['initDatabase', 'getSavedLocale', 'loadContacts']);
  });
}

test('interruzione e riavvio: DB, immagini e marker restano invariati', async () => {
  const harness = createHarness('marker-corrotto-o-incompleto', {
    currentLocale: 'en',
    savedLocale: 'it',
  });
  const before = clonePersistent(harness.persistent);

  harness.setFailureStep('changeLanguage');
  await assert.rejects(
    runAppBootstrap(harness.dependencies, harness.currentLocale),
    /interrupted:changeLanguage/
  );
  assert.deepEqual(harness.persistent, before);
  assert.deepEqual(harness.loadedContacts, []);

  harness.setFailureStep(null);
  harness.calls.splice(0, harness.calls.length);
  await runAppBootstrap(harness.dependencies, harness.currentLocale);

  assert.deepEqual(harness.persistent, before);
  assert.deepEqual(harness.loadedContacts, before.contacts);
  assert.deepEqual(harness.calls, [
    'initDatabase',
    'getSavedLocale',
    'changeLanguage:it',
    'loadContacts',
  ]);
});

for (const failureStep of [
  'initDatabase',
  'getSavedLocale',
  'loadContacts',
] satisfies FailureStep[]) {
  test(`interruzione in ${failureStep}: nessuna mutazione persistente`, async () => {
    const harness = createHarness(undefined);
    const before = clonePersistent(harness.persistent);
    harness.setFailureStep(failureStep);

    await assert.rejects(
      runAppBootstrap(harness.dependencies, harness.currentLocale),
      new RegExp(`interrupted:${failureStep}`)
    );

    assert.deepEqual(harness.persistent, before);
  });
}
