import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';

export interface BundleBuildRequest {
  entryPath: string;
  outputPath: string;
  alias: Record<string, string>;
  define: Record<string, string>;
}

export interface BundleChildResult {
  status: number | null;
  error?: Error;
}

export interface BundledScriptAdapters {
  createTempDirectory(prefix: string): Promise<string>;
  buildBundle(request: BundleBuildRequest): Promise<void>;
  bundleExists(bundlePath: string): boolean;
  runChild(
    bundlePath: string,
    childArgs: readonly string[],
    stdio: 'inherit' | 'pipe',
    sourceDirectory: string
  ): BundleChildResult;
  removeTempDirectory(directory: string): Promise<void>;
}

export interface BundledScriptOptions {
  entryPath: string;
  childArgs?: string[];
  alias?: Record<string, string>;
  define?: Record<string, string>;
  stdio?: 'inherit' | 'pipe';
  adapters?: Partial<BundledScriptAdapters>;
  onTempDirectory?: (directory: string) => void;
  onBundleReady?: (bundlePath: string) => void;
}

export interface BundledScriptResult {
  exitCode: 0 | 1;
  stage:
    | 'completed'
    | 'build_failed'
    | 'bundle_missing'
    | 'child_failed'
    | 'cleanup_failed';
  childExitCode: number | null;
  error?: unknown;
}

const defaultAdapters: BundledScriptAdapters = {
  createTempDirectory: (prefix) => mkdtemp(prefix),
  async buildBundle(request) {
    await esbuild.build({
      entryPoints: [request.entryPath],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile: request.outputPath,
      alias: request.alias,
      define: request.define,
      absWorkingDir: process.cwd(),
      logLevel: 'silent',
    });
  },
  bundleExists: existsSync,
  runChild(bundlePath, childArgs, stdio, sourceDirectory) {
    const child = spawnSync(process.execPath, [bundlePath, ...childArgs], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio,
      env: {
        ...process.env,
        BUSINESS_SCANNER_BUNDLED_SOURCE_DIR: sourceDirectory,
      },
    });
    return {
      status: child.status,
      error: child.error,
    };
  },
  removeTempDirectory: (directory) =>
    rm(directory, { recursive: true, force: true }),
};

export async function runBundledScript(
  options: BundledScriptOptions
): Promise<BundledScriptResult> {
  const adapters: BundledScriptAdapters = {
    ...defaultAdapters,
    ...options.adapters,
  };
  let tempDirectory: string | undefined;
  let result: BundledScriptResult = {
    exitCode: 1,
    stage: 'build_failed',
    childExitCode: null,
  };
  let buildSucceeded = false;

  try {
    tempDirectory = await adapters.createTempDirectory(
      path.join(tmpdir(), 'business-scanner-test-')
    );
    options.onTempDirectory?.(tempDirectory);
    const bundlePath = path.join(tempDirectory, 'bundle.mjs');

    try {
      await adapters.buildBundle({
        entryPath: path.resolve(options.entryPath),
        outputPath: bundlePath,
        alias: options.alias ?? {},
        define: options.define ?? {},
      });
      buildSucceeded = true;
    } catch (error) {
      result = {
        exitCode: 1,
        stage: 'build_failed',
        childExitCode: null,
        error,
      };
    }

    if (buildSucceeded && !adapters.bundleExists(bundlePath)) {
      result = {
        exitCode: 1,
        stage: 'bundle_missing',
        childExitCode: null,
        error: new Error(`bundle non generato: ${bundlePath}`),
      };
    }

    if (buildSucceeded && result.stage !== 'bundle_missing') {
      options.onBundleReady?.(bundlePath);
      const child = adapters.runChild(
        bundlePath,
        options.childArgs ?? [],
        options.stdio ?? 'inherit',
        path.dirname(path.resolve(options.entryPath))
      );
      if (child.error || child.status !== 0) {
        result = {
          exitCode: 1,
          stage: 'child_failed',
          childExitCode: child.status,
          error: child.error,
        };
      } else {
        result = {
          exitCode: 0,
          stage: 'completed',
          childExitCode: 0,
        };
      }
    }
  } catch (error) {
    result = {
      exitCode: 1,
      stage: 'build_failed',
      childExitCode: null,
      error,
    };
  } finally {
    if (tempDirectory) {
      try {
        await adapters.removeTempDirectory(tempDirectory);
      } catch (error) {
        result = {
          exitCode: 1,
          stage: 'cleanup_failed',
          childExitCode: result.childExitCode,
          error,
        };
      }
    }
  }

  return result;
}
