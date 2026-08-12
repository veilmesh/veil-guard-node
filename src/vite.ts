// The Vite entry point of `@veilmesh/veil-guard`, reached as
// `@veilmesh/veil-guard/vite`.
//
// It lives in the same package as the CLI wrapper it is built on rather than in one
// of its own: the two are always used together and always released together, and a
// separate package would only add a publish ordering to get wrong and a version pair
// to drift apart.
//
// `vite` is an optional peer dependency — importing this module is what requires it,
// and nothing else in the package touches it.
import type { Plugin, ResolvedConfig } from 'vite';
import { resolve } from 'path';
import { stat } from 'fs/promises';
import { sign, runtime, verify, type SignOptions } from './cli.js';
import type { SlsaProvenance } from './provenance.js';
import type { KmsConfig } from './kms.js';

export interface VeilGuardOptions {
  /** Path to the trust root clients pin. Required. */
  trustRootPath: string;
  /** Private key file(s), enough of them to meet the trust root's threshold. */
  keyPath: string | string[];

  /**
   * Build output directory.
   *
   * Optional inside the plugin, which takes it from Vite's own resolved config.
   * Required when calling {@link veilGuardSign} directly.
   */
  dist?: string;

  /**
   * Path prefixes the Service Worker must leave alone, e.g. `['/api/']`.
   *
   * Everything same-origin is an allowlist, so a dynamic endpoint with no file
   * behind it is refused unless it is carved out here.
   */
  exclude?: string[];

  /**
   * Extra `script-src` sources for the generated CSP, e.g. a tag manager host.
   *
   * A build directory cannot reveal that an inline bootstrap will go on to inject a
   * script from somewhere else, so those hosts have to be named.
   */
  cspSources?: string[];

  /**
   * Resolve an extensionless navigation against `<path>.html` (SPEC §7.1.1).
   *
   * Turn this on only if the host really serves `/faq` from `faq.html`. Under a
   * single-page-app fallback it answers with `index.html`, and the worker would
   * compare those bytes against `faq.html` and block a healthy deployment.
   */
  navigationHtmlFallback?: boolean;

  /** Directory for the generated Nginx / Caddy / Netlify header snippets. */
  headersOut?: string;
  /** Emit an enforcing Integrity-Policy instead of report-only. */
  enforceHeaders?: boolean;
  /** Skip SRI injection and leave the built HTML untouched. */
  noSri?: boolean;

  /** Git commit for `source.commit`; defaults to GITHUB_SHA / CI_COMMIT_SHA. */
  sourceCommit?: string;
  /** Manifest validity window in days. Default: 180. */
  notAfterDays?: number;
  /** Override the manifest version (Unix seconds). */
  version?: number;

  /** Embed SLSA provenance detected from the CI environment. Default: true. */
  embedProvenance?: boolean;
  /** Supply provenance directly instead of detecting it. */
  provenance?: SlsaProvenance;

  /** KMS configuration for signers whose P-256 half is remote. */
  kms?: KmsConfig;
  /** Path to the `veil-guard` binary; PATH is searched otherwise. */
  binPath?: string;

  /**
   * Emit the Service Worker and loader into the output directory. Default: true.
   *
   * Written straight into the build output rather than `public/`: the worker only
   * has to reach the site root, and putting it there after the build means `sign`
   * sees it and the loader gets an integrity attribute like any other script.
   */
  emitRuntime?: boolean;

  /** Re-verify the signed output. Default: true. */
  verify?: boolean;
}

/**
 * Emit the runtime, sign the build, verify the result.
 *
 * Exported separately from the plugin because static-site generators do their page
 * rendering *after* Vite's build hooks have all run — see the note on
 * {@link veilGuardPlugin}. For those, call this from the generator's own
 * post-render hook:
 *
 * ```js
 * ssgOptions: {
 *   onFinished: () => veilGuardSign({ dist: 'dist', trustRootPath: …, keyPath: … }),
 * }
 * ```
 */
export async function veilGuardSign(
  options: VeilGuardOptions & { dist: string },
  log: (msg: string) => void = console.log,
): Promise<void> {
  const dist = options.dist;

  const exists = await stat(dist).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!exists) {
    throw new Error(
      `[veil-guard] build output directory "${dist}" does not exist — nothing to sign`,
    );
  }

  const keys = Array.isArray(options.keyPath) ? options.keyPath : [options.keyPath];

  if (options.emitRuntime !== false) {
    await runtime({
      out: dist,
      trustRoot: options.trustRootPath,
      binPath: options.binPath,
    });
  }

  const signOptions: SignOptions = {
    dist,
    trustRoot: options.trustRootPath,
    keys,
    excludes: options.exclude,
    cspSources: options.cspSources,
    navigationHtmlFallback: options.navigationHtmlFallback,
    headersOut: options.headersOut,
    enforceHeaders: options.enforceHeaders,
    noSri: options.noSri,
    sourceCommit:
      options.sourceCommit ?? process.env.GITHUB_SHA ?? process.env.CI_COMMIT_SHA,
    notAfterDays: options.notAfterDays,
    version: options.version,
    embedProvenance: options.embedProvenance,
    provenance: options.provenance,
    kms: options.kms,
    binPath: options.binPath,
  };

  log('[veil-guard] signing asset manifest…');
  const out = await sign(signOptions);
  log(out.trim());

  // Not redundant with the signature that was just written. This is what catches a
  // later build step writing into the output directory after signing — the failure
  // mode that otherwise surfaces as a browser refusing the page.
  if (options.verify !== false) {
    await verify({
      dist,
      trustRoot: options.trustRootPath,
      binPath: options.binPath,
    });
    log('[veil-guard] verified');
  }
}

/**
 * Sign a Vite build on `closeBundle`.
 *
 * **Single-page applications only.** A static-site generator built on Vite —
 * vite-ssg, and anything else that drives `vite build` itself — renders its pages
 * *after* the inner build has finished, so `closeBundle` fires while the output
 * directory still holds one HTML file out of however many will ship. Signing there
 * produces a manifest that covers the entry point and nothing else, and leaves every
 * generated page without an integrity attribute.
 *
 * That case is detected and refused rather than signed; use {@link veilGuardSign}
 * from the generator's post-render hook instead.
 */
export function veilGuardPlugin(options: VeilGuardOptions): Plugin {
  let config: ResolvedConfig;

  return {
    name: 'vite-plugin-veil-guard',
    apply: 'build',

    configResolved(resolved) {
      config = resolved;
    },

    async closeBundle() {
      // A generator's server pass writes an intermediate bundle to a temp
      // directory. Nothing there ships.
      if (config.build.ssr) return;

      // `ssgOptions` on the resolved config is how vite-ssg finds its own settings,
      // which makes it a direct signal rather than a guess at one.
      const ssg =
        (config as unknown as { ssgOptions?: unknown }).ssgOptions !== undefined ||
        process.env.VITE_SSG === 'true';
      if (ssg) {
        throw new Error(
          '[veil-guard] this looks like a vite-ssg project, and `closeBundle` runs ' +
            'before its pages are rendered — signing here would cover the entry point ' +
            'and leave every generated page unsigned.\n\n' +
            'Remove veilGuardPlugin() and sign from the generator hook instead:\n\n' +
            "  import { veilGuardSign } from 'vite-plugin-veil-guard'\n\n" +
            '  ssgOptions: {\n' +
            '    onFinished: () => veilGuardSign({ dist: "dist", ...options }),\n' +
            '  }\n',
        );
      }

      // `build.outDir` is relative to `root`, which is not necessarily the working
      // directory — resolving it against `cwd` signs the wrong place, or nothing.
      const dist = resolve(config.root, config.build.outDir);

      try {
        await veilGuardSign({ ...options, dist }, (m) => config.logger.info(m));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        config.logger.error(`[veil-guard] ${msg}`);
        throw err;
      }
    },
  };
}

export type { SlsaProvenance, KmsConfig };
