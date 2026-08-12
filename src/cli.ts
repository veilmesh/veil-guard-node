import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { provenanceFromEnv, type SlsaProvenance } from './provenance.js';
import type { KmsConfig } from './kms.js';

const execFileAsync = promisify(execFile);

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
    const { stdout } = await execFileAsync(bin, args);
    return stdout;
  } finally {
    if (tmpProvFile) {
      await unlink(tmpProvFile).catch(() => {});
    }
  }
}
