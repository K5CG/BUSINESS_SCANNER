import { runBundledScript } from '../lib/bundled-script-runner';

interface ParsedArguments {
  entryPath: string;
  childArgs: string[];
  alias: Record<string, string>;
  define: Record<string, string>;
}

function parseKeyValue(
  raw: string,
  prefix: string
): { key: string; value: string } | null {
  if (!raw.startsWith(prefix)) return null;
  const assignment = raw.slice(prefix.length);
  const separator = assignment.indexOf('=');
  if (separator <= 0) return null;
  return {
    key: assignment.slice(0, separator),
    value: assignment.slice(separator + 1),
  };
}

export function parseBundledScriptArguments(argv: string[]): ParsedArguments {
  const [entryPath, ...rest] = argv;
  if (!entryPath) {
    throw new Error(
      'uso: npm run run:bundled -- <entry> [--alias:key=value] [--define:key=value] [-- child args]'
    );
  }

  const alias: Record<string, string> = {};
  const define: Record<string, string> = {};
  const childArgs: string[] = [];
  let childOnly = false;

  for (const argument of rest) {
    if (argument === '--') {
      childOnly = true;
      continue;
    }
    if (!childOnly) {
      const aliasEntry = parseKeyValue(argument, '--alias:');
      if (aliasEntry) {
        alias[aliasEntry.key] = aliasEntry.value;
        continue;
      }
      const defineEntry = parseKeyValue(argument, '--define:');
      if (defineEntry) {
        define[defineEntry.key] = defineEntry.value;
        continue;
      }
    }
    childArgs.push(argument);
  }

  return { entryPath, childArgs, alias, define };
}

async function main() {
  try {
    const args = parseBundledScriptArguments(process.argv.slice(2));
    const result = await runBundledScript({
      ...args,
      stdio: 'inherit',
    });
    if (result.exitCode !== 0) {
      const detail =
        result.error instanceof Error ? `: ${result.error.message}` : '';
      console.error(
        `bundled runner failed at ${result.stage} (child=${String(
          result.childExitCode
        )})${detail}`
      );
    }
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

void main();
