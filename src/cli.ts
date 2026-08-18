import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { provenanceFromEnv, type SlsaProvenance } from './provenance.js';
import type { KmsConfig } from './kms.js';

const execFileAsync = promisify(execFile);

async function execCli(bin: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(bin, args);
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      throw new Error(
        `[veil-guard] Could not find the "${bin}" CLI binary in your PATH.\n` +
        `To install the veil-guard CLI:\n` +
        `  • Via Cargo:   cargo install veil-guard --features audit\n` +
        `  • Prebuilt:    https://github.com/veilmesh/veil-guard/releases\n` +
        `  • Or provide:  { binPath: "/path/to/veil-guard" } in plugin / sign options.`
      );
    }
    throw err;
  }
}

export interface SignOptions {
  dist: string;
  trustRoot: string;
  keys: string[];
  version?: number;
  notAfterDays?: number;
  noSri?: boolean;
  headersOut?: string;
  enforceHeaders?: boolean;
  sourceCommit?: string;
  navigationHtmlFallback?: boolean;
  cspSources?: string[];
  excludes?: string[];
  embedProvenance?: boolean;
  provenance?: SlsaProvenance;
  kms?: KmsConfig;
  binPath?: string;
}

export async function sign(options: SignOptions): Promise<string> {
  const bin = options.binPath || 'veil-guard';
  
  const args: string[] = [
    'sign',
    '--dist', options.dist,
    '--trust-root', options.trustRoot,
  ];

  for (const key of options.keys) {
    args.push('--key', key);
  }

  if (options.version !== undefined) {
    args.push('--version', String(options.version));
  }
  if (options.notAfterDays !== undefined) {
    args.push('--not-after-days', String(options.notAfterDays));
  }
  if (options.noSri) {
    args.push('--no-sri');
  }
  if (options.headersOut) {
    args.push('--headers-out', options.headersOut);
  }
  if (options.enforceHeaders) {
    args.push('--enforce-headers');
  }
  if (options.sourceCommit) {
    args.push('--source-commit', options.sourceCommit);
  }
  if (options.navigationHtmlFallback) {
    args.push('--navigation-html-fallback');
  }
  if (options.cspSources) {
    for (const source of options.cspSources) {
      args.push('--csp-source', source);
    }
  }
  if (options.excludes) {
    for (const exclude of options.excludes) {
      args.push('--exclude', exclude);
    }
  }
  if (options.kms) {
    args.push('--kms-key-id', options.kms.keyId);
    if (options.kms.provider) {
      args.push('--kms-provider', options.kms.provider);
    }
  }

  let tmpProvFile: string | null = null;
  const embedProv = options.embedProvenance !== false;
  if (embedProv) {
    const prov = options.provenance ?? provenanceFromEnv();
    if (prov) {
      tmpProvFile = join(tmpdir(), `vg-prov-${randomBytes(6).toString('hex')}.json`);
      await writeFile(tmpProvFile, JSON.stringify(prov, null, 2));
      args.push('--provenance-json', tmpProvFile);
    }
  }

  try {
    const { stdout } = await execCli(bin, args);
    return stdout;
  } finally {
    if (tmpProvFile) {
      await unlink(tmpProvFile).catch(() => {});
    }
  }
}

export interface RuntimeOptions {
  /** Where to write veil-guard-sw.js and veil-guard-loader.js. */
  out: string;
  trustRoot: string;
  binPath?: string;
}

/**
 * Emit the Tier 1 Service Worker and page loader.
 *
 * Point `out` at the build output directory, not `public/`. The worker only has to
 * end up at the site root, and writing it there directly after the build means it
 * does not have to survive a copy step — which also makes it visible to `sign`, so
 * the loader picks up an integrity attribute like any other script.
 */
export async function runtime(options: RuntimeOptions): Promise<string> {
  const { stdout } = await execCli(options.binPath || 'veil-guard', [
    'runtime',
    '--trust-root',
    options.trustRoot,
    '--out',
    options.out,
  ]);
  return stdout;
}

export interface VerifyOptions {
  dist: string;
  trustRoot: string;
  pinnedVersion?: number;
  binPath?: string;
}

/**
 * Re-check a signed build against its manifest.
 *
 * Worth running even immediately after `sign`: it is what catches a build step that
 * writes into the output directory *after* signing, which is otherwise invisible
 * until a browser refuses the page.
 */
export async function verify(options: VerifyOptions): Promise<string> {
  const args = ['verify', '--dist', options.dist, '--trust-root', options.trustRoot];
  if (options.pinnedVersion !== undefined) {
    args.push('--pinned-version', String(options.pinnedVersion));
  }
  const { stdout } = await execCli(options.binPath || 'veil-guard', args);
  return stdout;
}
