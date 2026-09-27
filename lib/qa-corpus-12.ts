export const QA_CORPUS_DIRS = [
  'test-data/qa-2026-08-15T08-57-56',
  'test-data/qa-2026-08-15T15-30-54',
  'test-data/qa-2026-08-15T18-40-36',
  'test-data/qa-2026-08-16T07-18-17',
  'test-data/qa-2026-08-16T08-56-11',
  'test-data/qa-2026-08-16T12-51-38',
  'test-data/qa-2026-08-16T14-43-59',
  'test-data/qa-2026-08-16T16-29-54',
  'test-data/qa-2026-08-16T17-54-51',
  'test-data/qa-2026-08-16T18-53-14',
  'test-data/qa-2026-08-17T07-53-04',
  'test-data/qa-2026-08-17T13-30-03',
  'test-data/qa-2026-08-17T16-05-06',
  'test-data/qa-2026-08-17T18-07-01',
] as const;

export interface QaCorpusEntry {
  qaDir: string;
  id: string;
  title: string;
}
