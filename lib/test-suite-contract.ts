export type TestSuiteKind =
  | 'unit'
  | 'smoke'
  | 'accuracy'
  | 'regression'
  | 'integration'
  | 'replay';

export type ContractCaseStatus = 'passed' | 'failed' | 'skipped';

export interface ContractCaseResult {
  id: string;
  status: ContractCaseStatus;
  expectedDeclared?: boolean;
  skipReason?: string;
  error?: unknown;
}

export interface SuiteContractSummary {
  name: string;
  kind: TestSuiteKind;
  expected: number;
  discovered: number;
  executed: number;
  passed: number;
  failed: number;
  skipped: number;
  violations: string[];
  ok: boolean;
  exitCode: 0 | 1;
}

export interface ContractTestCase {
  id: string;
  run?: () => unknown | Promise<unknown>;
  skip?: boolean;
  skipReason?: string;
  expectedDeclared?: boolean;
}

export interface ContractSuite {
  name: string;
  kind: TestSuiteKind;
  expectedCount: number;
  cases: ContractTestCase[];
}

export function summarizeContractSuite(
  name: string,
  kind: TestSuiteKind,
  expectedCount: number,
  results: readonly ContractCaseResult[]
): SuiteContractSummary {
  const passed = results.filter((result) => result.status === 'passed').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  const skipped = results.filter((result) => result.status === 'skipped').length;
  const executed = passed + failed;
  const violations: string[] = [];

  if (results.length !== expectedCount) {
    violations.push(
      `conteggio casi: attesi ${expectedCount}, scoperti ${results.length}`
    );
  }
  if (executed + skipped !== expectedCount) {
    violations.push(
      `accounting casi: attesi ${expectedCount}, eseguiti ${executed}, skipped ${skipped}`
    );
  }

  for (const result of results) {
    if (
      result.status === 'skipped' &&
      (!result.skipReason || result.skipReason.trim().length === 0)
    ) {
      violations.push(`skip senza motivo: ${result.id}`);
    }
    if (
      kind === 'accuracy' &&
      result.status !== 'skipped' &&
      result.expectedDeclared !== true
    ) {
      violations.push(`accuracy senza expected dichiarato: ${result.id}`);
    }
  }

  const ok = failed === 0 && violations.length === 0;
  return {
    name,
    kind,
    expected: expectedCount,
    discovered: results.length,
    executed,
    passed,
    failed,
    skipped,
    violations,
    ok,
    exitCode: ok ? 0 : 1,
  };
}

export async function executeContractSuite(
  suite: ContractSuite
): Promise<{
  results: ContractCaseResult[];
  summary: SuiteContractSummary;
}> {
  const results: ContractCaseResult[] = [];

  for (const testCase of suite.cases) {
    if (testCase.skip) {
      results.push({
        id: testCase.id,
        status: 'skipped',
        skipReason: testCase.skipReason,
        expectedDeclared: testCase.expectedDeclared,
      });
      continue;
    }

    try {
      if (!testCase.run) {
        throw new Error(`caso ${testCase.id} privo di funzione run`);
      }
      await testCase.run();
      results.push({
        id: testCase.id,
        status: 'passed',
        expectedDeclared: testCase.expectedDeclared,
      });
    } catch (error) {
      results.push({
        id: testCase.id,
        status: 'failed',
        expectedDeclared: testCase.expectedDeclared,
        error,
      });
    }
  }

  return {
    results,
    summary: summarizeContractSuite(
      suite.name,
      suite.kind,
      suite.expectedCount,
      results
    ),
  };
}

export function collectExpectedEmptyFailures(
  fields: readonly string[],
  readValue: (field: string) => unknown
): string[] {
  const failures: string[] = [];
  for (const field of fields) {
    const value = readValue(field);
    if (value !== undefined && value !== null && value !== '') {
      failures.push(`${field}: atteso VUOTO → "${String(value)}"`);
    }
  }
  return failures;
}

export function hasDeclaredExpectedAssertion(
  expected: unknown,
  recognizedKeys: readonly string[],
  expectedEmptyFields: readonly string[] = [],
  recognizedExpectedEmptyFields: readonly string[] = []
): boolean {
  const expectedKeys =
    typeof expected === 'object' && expected !== null
      ? Object.keys(expected)
      : [];
  const recognizedKeySet = new Set(recognizedKeys);
  const recognizedEmptyFieldSet = new Set(recognizedExpectedEmptyFields);
  const declaredEmptyFields = expectedEmptyFields.filter(
    (field) => field.trim().length > 0
  );

  if (expectedKeys.some((key) => !recognizedKeySet.has(key))) {
    return false;
  }
  if (
    declaredEmptyFields.some(
      (field) => !recognizedEmptyFieldSet.has(field)
    )
  ) {
    return false;
  }

  return expectedKeys.length > 0 || declaredEmptyFields.length > 0;
}

export interface ReplayReportWriteResult {
  status: 'written' | 'write_failed';
  errorCode?: string;
  message?: string;
}

function nodeErrorCode(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return 'UNKNOWN';
}

export function writeReplayReport(
  reportPath: string,
  payload: unknown,
  writeFile: (path: string, contents: string) => void
): ReplayReportWriteResult {
  try {
    writeFile(reportPath, JSON.stringify(payload, null, 2));
    return { status: 'written' };
  } catch (error) {
    return {
      status: 'write_failed',
      errorCode: nodeErrorCode(error),
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface ReplayCoverageSummary {
  expected: number;
  executed: number;
  regressions: number;
  violations: string[];
  ok: boolean;
  exitCode: 0 | 1;
}

export function summarizeReplayCoverage(
  expected: number,
  executed: number,
  regressions: number
): ReplayCoverageSummary {
  const violations: string[] = [];
  if (expected <= 0) {
    violations.push('audit replay vuoto: nessun caso atteso');
  }
  if (executed !== expected) {
    violations.push(
      `accounting replay: attesi ${expected}, eseguiti ${executed}`
    );
  }
  if (regressions > 0) {
    violations.push(`regressioni replay: ${regressions}`);
  }
  const ok = violations.length === 0;
  return {
    expected,
    executed,
    regressions,
    violations,
    ok,
    exitCode: ok ? 0 : 1,
  };
}

export interface ReplayAuditRow {
  title: string;
  field: string;
  actual: string;
  expected: string;
  severity: string;
}

export function parseSemicolonCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const character of line) {
    if (character === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (character === ';' && !inQuotes) {
      cells.push(current);
      current = '';
      continue;
    }
    current += character;
  }

  cells.push(current);
  return cells;
}

export interface StrictSemicolonCsvRow {
  lineNumber: number;
  cells: string[];
}

export interface StrictSemicolonCsvParseResult {
  rows: StrictSemicolonCsvRow[];
  malformed: StrictSemicolonCsvRow[];
}

export function parseStrictSemicolonCsvRows(
  csvText: string,
  expectedColumns: number
): StrictSemicolonCsvParseResult {
  const rows: StrictSemicolonCsvRow[] = [];
  const malformed: StrictSemicolonCsvRow[] = [];
  const lines = csvText.split(/\r?\n/);

  for (let index = 1; index < lines.length; index += 1) {
    if (!lines[index].trim()) {
      continue;
    }
    const row = {
      lineNumber: index + 1,
      cells: parseSemicolonCsvLine(lines[index]),
    };
    if (row.cells.length === expectedColumns) {
      rows.push(row);
    } else {
      malformed.push(row);
    }
  }

  return { rows, malformed };
}

function stripCsvCell(value: string): string {
  return value.replace(/^"+|"+$/g, '').trim();
}

export function parseReplayAuditRows(csvText: string): ReplayAuditRow[] {
  const lines = csvText.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const rows: ReplayAuditRow[] = [];

  for (let index = 1; index < lines.length; index += 1) {
    const cells = parseSemicolonCsvLine(lines[index]);
    if (cells.length < 5) {
      continue;
    }

    const field = stripCsvCell(cells[2] ?? '');
    if (!field) {
      continue;
    }

    rows.push({
      title: stripCsvCell(cells[1] ?? ''),
      field,
      actual: stripCsvCell(cells[3] ?? ''),
      expected: stripCsvCell(cells[4] ?? ''),
      severity: stripCsvCell(cells[7] ?? 'medium') || 'medium',
    });
  }

  return rows;
}
