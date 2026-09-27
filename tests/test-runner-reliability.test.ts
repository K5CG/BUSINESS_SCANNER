import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { runBundledScript } from '../lib/bundled-script-runner';
import {
  collectExpectedEmptyFailures,
  executeContractSuite,
  hasDeclaredExpectedAssertion,
  parseReplayAuditRows,
  parseStrictSemicolonCsvRows,
  summarizeReplayCoverage,
  summarizeContractSuite,
  writeReplayReport,
} from '../lib/test-suite-contract';

const fixturePath = path.resolve('scripts/test-runner-fixture.mjs');

function spawnFixture(mode: string) {
  return spawnSync(process.execPath, [fixturePath, mode], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

function spawnNpm(args: string[]) {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, 'npm_execpath deve essere disponibile nei meta-test');
  return spawnSync(process.execPath, [npmCli, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

test('6A-01 subprocess riuscito termina con exit 0', () => {
  assert.equal(spawnFixture('success').status, 0);
});

test('6A-02 asserzione fallita termina con exit non-zero', () => {
  assert.notEqual(spawnFixture('assertion').status, 0);
});

test('6A-03 eccezione inattesa termina con exit non-zero', () => {
  assert.notEqual(spawnFixture('throw').status, 0);
});

test('6A-04 promise rifiutata termina con exit non-zero', () => {
  assert.notEqual(spawnFixture('reject').status, 0);
});

test('6A-05 expectEmpty legge davvero il campo e rileva il valore', () => {
  const reads: string[] = [];
  const failures = collectExpectedEmptyFailures(
    ['firstName', 'lastName'],
    (field) => {
      reads.push(field);
      return field === 'lastName' ? 'Valore inatteso' : '';
    }
  );
  assert.deepEqual(reads, ['firstName', 'lastName']);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /lastName/);
});

test('6A-06 conteggio atteso diverso da scoperto invalida la suite', () => {
  const summary = summarizeContractSuite('count', 'regression', 2, [
    { id: 'only', status: 'passed' },
  ]);
  assert.equal(summary.ok, false);
  assert.equal(summary.exitCode, 1);
  assert.match(summary.violations.join('\n'), /attesi 2/);
});

test('6A-07 skip motivato è contato e accettato', () => {
  const summary = summarizeContractSuite('skip', 'regression', 1, [
    {
      id: 'device-only',
      status: 'skipped',
      skipReason: 'richiede fotocamera reale',
    },
  ]);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.ok, true);
});

test('6A-08 skip non motivato invalida la suite', () => {
  const summary = summarizeContractSuite('skip', 'regression', 1, [
    { id: 'silent', status: 'skipped' },
  ]);
  assert.equal(summary.ok, false);
  assert.match(summary.violations.join('\n'), /skip senza motivo/);
});

test('6A-09 un crash nello smoke immagini fallisce la suite', async () => {
  const { summary } = await executeContractSuite({
    name: 'image smoke',
    kind: 'smoke',
    expectedCount: 1,
    cases: [
      {
        id: 'image-01',
        run: () => {
          throw new Error('decoder crash');
        },
      },
    ],
  });
  assert.equal(summary.failed, 1);
  assert.equal(summary.exitCode, 1);
});

test('6A-10 un errore fra più immagini impedisce il falso verde', async () => {
  const { summary } = await executeContractSuite({
    name: 'image smoke',
    kind: 'smoke',
    expectedCount: 3,
    cases: [
      { id: 'image-01', run: () => undefined },
      {
        id: 'image-02',
        run: () => {
          throw new Error('single crash');
        },
      },
      { id: 'image-03', run: () => undefined },
    ],
  });
  assert.deepEqual(
    [summary.passed, summary.failed, summary.executed],
    [2, 1, 3]
  );
  assert.equal(summary.ok, false);
});

test('6A-11 smoke senza expected è valido e non è accuracy', async () => {
  const { summary } = await executeContractSuite({
    name: 'smoke',
    kind: 'smoke',
    expectedCount: 1,
    cases: [{ id: 'no-crash', run: () => undefined }],
  });
  assert.equal(summary.kind, 'smoke');
  assert.equal(summary.ok, true);
});

test('6A-12 accuracy con expected dichiarato è valida', async () => {
  const { summary } = await executeContractSuite({
    name: 'accuracy',
    kind: 'accuracy',
    expectedCount: 1,
    cases: [
      {
        id: 'with-expected',
        expectedDeclared: true,
        run: () => assert.equal('actual', 'actual'),
      },
    ],
  });
  assert.equal(summary.ok, true);
});

test('6A-13 bundle mancante viene rigenerato prima del figlio', async () => {
  let tempDirectory = '';
  let readyBundle = '';
  const result = await runBundledScript({
    entryPath: fixturePath,
    childArgs: ['success'],
    stdio: 'pipe',
    onTempDirectory(directory) {
      tempDirectory = directory;
      assert.equal(existsSync(path.join(directory, 'bundle.mjs')), false);
    },
    onBundleReady(bundlePath) {
      readyBundle = bundlePath;
      assert.equal(existsSync(bundlePath), true);
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(path.dirname(readyBundle), tempDirectory);
});

test('6A-14 bundle corrotto produce exit non-zero', async () => {
  const result = await runBundledScript({
    entryPath: fixturePath,
    stdio: 'pipe',
    adapters: {
      async buildBundle(request) {
        writeFileSync(
          request.outputPath,
          'this is intentionally not valid javascript !!!',
          'utf8'
        );
      },
    },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stage, 'child_failed');
});

test('6A-15 la directory bundle viene rimossa anche dopo esecuzione', async () => {
  let tempDirectory = '';
  const result = await runBundledScript({
    entryPath: fixturePath,
    childArgs: ['success'],
    stdio: 'pipe',
    onTempDirectory(directory) {
      tempDirectory = directory;
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(existsSync(tempDirectory), false);
});

test('6A-16 nessun bundle generato entra nel TypeScript generale', () => {
  const tsconfig = JSON.parse(readFileSync('tsconfig.json', 'utf8')) as {
    include: string[];
    exclude: string[];
  };
  const gitignore = readFileSync('.gitignore', 'utf8');
  assert.ok(tsconfig.exclude.includes('scripts/camera-review-bundle'));
  assert.match(gitignore, /\/scripts\/camera-review-bundle\//);
  assert.match(gitignore, /\/scripts\/\.\*-bundle\.mjs/);

  const tscPath = path.resolve('node_modules/typescript/bin/tsc');
  const shown = spawnSync(process.execPath, [tscPath, '--showConfig'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: 'pipe',
  });
  assert.equal(shown.status, 0, shown.stderr);
  const effectiveConfig = JSON.parse(shown.stdout) as { files?: string[] };
  const files = effectiveConfig.files ?? [];
  assert.equal(
    files.some((file) => /camera-review-bundle/i.test(file)),
    false
  );
  assert.equal(files.some((file) => /-bundle\.mjs/i.test(file)), false);
});

test('6A-17 errore di scrittura replay è un fallimento esplicito', () => {
  const result = writeReplayReport('/read-only/report.json', { fixed: 12 }, () => {
    throw new Error('read only');
  });
  assert.equal(result.status, 'write_failed');
});

test('6A-18 metriche replay restano disponibili se il report non è scritto', () => {
  const metrics = { fixed: 12, total: 54, percent: 22.2 };
  const result = writeReplayReport('/read-only/report.json', metrics, () => {
    throw new Error('cannot write');
  });
  assert.deepEqual(metrics, { fixed: 12, total: 54, percent: 22.2 });
  assert.equal(result.status, 'write_failed');
});

test('6A-19 EPERM replay è distinto dal risultato di accuratezza', () => {
  const error = Object.assign(new Error('operation not permitted'), {
    code: 'EPERM',
  });
  const result = writeReplayReport('/protected/report.json', {}, () => {
    throw error;
  });
  assert.deepEqual(result, {
    status: 'write_failed',
    errorCode: 'EPERM',
    message: 'operation not permitted',
  });
});

test('6A-20 confronto QA senza target non può risultare verde', () => {
  const child = spawnNpm(['run', 'compare:qa', '--silent']);
  assert.notEqual(child.status, 0);
  assert.match(`${child.stdout}\n${child.stderr}`, /target|argomento|uso/i);
});

test('6A-21 accuracy senza expected è rifiutata', async () => {
  const { summary } = await executeContractSuite({
    name: 'false accuracy',
    kind: 'accuracy',
    expectedCount: 1,
    cases: [{ id: 'missing-expected', run: () => undefined }],
  });
  assert.equal(summary.exitCode, 1);
  assert.match(summary.violations.join('\n'), /accuracy senza expected/);
});

test('6A-22 errore di build non avvia il figlio e resta non-zero', async () => {
  let childRuns = 0;
  const result = await runBundledScript({
    entryPath: fixturePath,
    stdio: 'pipe',
    adapters: {
      async buildBundle() {
        throw new Error('intentional build failure');
      },
      runChild() {
        childRuns += 1;
        return { status: 0 };
      },
    },
  });
  assert.equal(result.stage, 'build_failed');
  assert.equal(result.exitCode, 1);
  assert.equal(childRuns, 0);
});

test('6A-23 replay con zero casi non può risultare verde', () => {
  const summary = summarizeReplayCoverage(0, 0, 0);
  assert.equal(summary.exitCode, 1);
  assert.match(summary.violations.join('\n'), /audit replay vuoto/);
});

test('6A-24 replay parziale non può risultare verde', () => {
  const summary = summarizeReplayCoverage(12, 11, 0);
  assert.equal(summary.exitCode, 1);
  assert.match(summary.violations.join('\n'), /attesi 12, eseguiti 11/);
});

test('6A-25 strumenti QA non dipendono da bundle persistenti', () => {
  const compareSource = readFileSync('scripts/compare-qa-bulk.mjs', 'utf8');
  const fixSource = readFileSync('scripts/fix-qa-export.mjs', 'utf8');
  assert.doesNotMatch(compareSource, /\.test-v5-bundle/);
  assert.doesNotMatch(fixSource, /\.test-v5-bundle/);
  assert.match(compareSource, /parser-v5\/engine\.ts/);
  assert.match(fixSource, /parser-v5\/engine\.ts/);
});

test('6A-26 fix QA senza target fallisce dopo aver caricato il parser', () => {
  const child = spawnNpm(['run', 'fix:qa-export', '--silent']);
  assert.notEqual(child.status, 0);
  assert.match(`${child.stdout}\n${child.stderr}`, /Usage: npm run fix:qa-export/);
  assert.doesNotMatch(`${child.stdout}\n${child.stderr}`, /ERR_MODULE_NOT_FOUND/);
});

test('6A-27 il replay contabilizza tutti i campi presenti nel CSV', () => {
  const csv = [
    'id;title;field;actual;expected;note;owner;severity',
    '1;Contatto A;address;Via Uno;Via Uno;;;high',
    '2;Contatto A;company;Prima Srl;Dopo Srl;;;medium',
    '3;Contatto B;emails;prima@example.com;dopo@example.com;;;low',
  ].join('\n');

  const rows = parseReplayAuditRows(csv);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => row.field),
    ['address', 'company', 'emails']
  );
});

test('6A-28 il replay completo esegue tutte le 54 righe non-address', () => {
  const tempDirectory = mkdtempSync(
    path.join(tmpdir(), 'business-scanner-replay-')
  );
  const rawTextDirectory = path.join(tempDirectory, 'raw-text');
  const auditPath = path.join(tempDirectory, 'audit.csv');

  try {
    mkdirSync(rawTextDirectory);
    writeFileSync(
      path.join(tempDirectory, 'contacts.json'),
      JSON.stringify([{ id: 'contact-a', title: 'Contatto A' }]),
      'utf8'
    );
    writeFileSync(
      path.join(rawTextDirectory, 'contact-a.txt'),
      'SAMPLE CARD',
      'utf8'
    );
    const auditRows = Array.from(
      { length: 54 },
      (_, index) => `${index + 1};Contatto A;emails;;;;;low`
    );
    writeFileSync(
      auditPath,
      [
        'id;title;field;actual;expected;note;owner;severity',
        ...auditRows,
      ].join('\n'),
      'utf8'
    );

    const child = spawnNpm([
      'run',
      'replay:parser:v5',
      '--silent',
      '--',
      tempDirectory,
      auditPath,
    ]);
    const output = `${child.stdout}\n${child.stderr}`;
    assert.equal(child.status, 0, output);
    assert.match(output, /Replay accounting: 54\/54 casi eseguiti/);
  } finally {
    assert.ok(tempDirectory.startsWith(path.resolve(tmpdir())));
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('6A-29 il CSV replay distingue delimitatori quotati e righe malformate', () => {
  const parsed = parseStrictSemicolonCsvRows(
    [
      'id;title;field;actual;expected;severity;class;note',
      '1;Contatto;company;Prima;"Nome atteso; non categoria";high;wrong;"Nota; dettaglio"',
      '2;Riga;con;sole;cinque',
    ].join('\n'),
    8
  );

  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].cells[4], 'Nome atteso; non categoria');
  assert.equal(parsed.rows[0].cells[7], 'Nota; dettaglio');
  assert.deepEqual(
    parsed.malformed.map((row) => [row.lineNumber, row.cells.length]),
    [[3, 5]]
  );
});

test('6A-30 expected accuracy è dichiarato solo da asserzioni riconosciute', () => {
  const recognized = ['firstName', 'companyContains'];
  const recognizedEmpty = ['firstName', 'lastName'];
  assert.equal(hasDeclaredExpectedAssertion({}, recognized), false);
  assert.equal(
    hasDeclaredExpectedAssertion({ typoExpectation: 'x' }, recognized),
    false
  );
  assert.equal(
    hasDeclaredExpectedAssertion(
      { firstName: 'Mario', typoExpectation: 'x' },
      recognized
    ),
    false
  );
  assert.equal(
    hasDeclaredExpectedAssertion(
      { firstName: 'Mario', expectEmpty: ['lastName'] },
      recognized
    ),
    false
  );
  assert.equal(
    hasDeclaredExpectedAssertion({ firstName: '' }, recognized),
    true
  );
  assert.equal(
    hasDeclaredExpectedAssertion(
      {},
      recognized,
      ['lastName'],
      recognizedEmpty
    ),
    true
  );
  assert.equal(
    hasDeclaredExpectedAssertion(
      { firstName: 'Mario' },
      recognized,
      ['firstNmae'],
      recognizedEmpty
    ),
    false
  );
});

test('6A-31 il runner parser reale verifica expected e accounting', () => {
  const child = spawnNpm(['run', 'test:parser:v5', '--silent']);
  const output = `${child.stdout}\n${child.stderr}`;
  assert.match(output, /119\/119 scoperti/);
  assert.doesNotMatch(output, /CONTRACT ERROR/);
});

test('6A-32 il replay 70 classifica esattamente tutte le 54 righe', () => {
  const child = spawnNpm(['run', 'replay:audit:70', '--silent']);
  const output = `${child.stdout}\n${child.stderr}`;
  assert.match(output, /Audit rows: 54/);
  assert.match(output, /Replay accounting: 54\/54 righe classificate/);
  assert.doesNotMatch(output, /REPLAY_CONTRACT_FAILED/);
});
