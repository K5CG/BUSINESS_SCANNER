import assert from 'node:assert/strict';

async function main() {
  const mode = process.argv[2] ?? 'success';
  switch (mode) {
    case 'success':
      return;
    case 'assertion':
      assert.equal(1, 2, 'intentional assertion failure');
      return;
    case 'throw':
      throw new Error('intentional unexpected exception');
    case 'reject':
      await Promise.reject(new Error('intentional rejected promise'));
      return;
    default:
      throw new Error(`unknown fixture mode: ${mode}`);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
