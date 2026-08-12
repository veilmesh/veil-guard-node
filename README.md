# @veilmesh/veil-guard

Node bindings for the [`veil-guard`](https://github.com/veilmesh/veil-guard) CLI, and
the Vite plugin built on them.

Requires the `veil-guard` binary on `PATH`, or a path in `binPath`.

```bash
npm install --save-dev @veilmesh/veil-guard
```

## Vite

```js
import { defineConfig } from 'vite'
import { veilGuardPlugin } from '@veilmesh/veil-guard/vite'

export default defineConfig({
  plugins: [
    veilGuardPlugin({
      trustRootPath: 'trust-root.json',
      keyPath: ['.keys/build-1.key.json', '.keys/build-2.key.json'],
      exclude: ['/api/'],
    }),
  ],
})
```

On `closeBundle` this writes `veil-guard-sw.js` and `veil-guard-loader.js` into the
build output, signs it, and verifies the result. Reference the loader from your HTML
and it picks up an `integrity` attribute like any other script:

```html
<script src="/veil-guard-loader.js"></script>
```

`vite` is an optional peer dependency: only this entry point needs it, and only for
its types.

### Static site generators

**`veilGuardPlugin` refuses to run under vite-ssg on purpose.** A generator built on
Vite renders its pages *after* the inner `vite build` returns, so `closeBundle` fires
while the output directory holds one HTML file out of however many will ship.
Signing there yields a manifest that looks complete and covers the entry point alone
— on a 17-page site, measured, the hook fires twice and sees one page each time.

Sign from the generator's own hook instead:

```js
import { veilGuardSign } from '@veilmesh/veil-guard/vite'

export default defineConfig({
  ssgOptions: {
    onFinished: () => veilGuardSign({
      dist: 'dist',
      trustRootPath: 'trust-root.json',
      keyPath: ['.keys/build-1.key.json', '.keys/build-2.key.json'],
    }),
  },
})
```

## Direct CLI use

```js
import { sign, runtime, verify, provenanceFromEnv } from '@veilmesh/veil-guard'

await runtime({ out: 'dist', trustRoot: 'trust-root.json' })
await sign({
  dist: 'dist',
  trustRoot: 'trust-root.json',
  keys: ['.keys/build-1.key.json', '.keys/build-2.key.json'],
  excludes: ['/api/'],
  cspSources: ['https://www.googletagmanager.com'],
})
await verify({ dist: 'dist', trustRoot: 'trust-root.json' })
```

Point `runtime` at the build output rather than `public/`. The worker only has to
reach the site root, and writing it there after the build means `sign` sees it — so
the worker itself ends up covered by the manifest.

`verify` after `sign` is not redundant. It is what catches a later build step writing
into the output directory once the signature already exists, which otherwise surfaces
as a browser refusing the page.

## SLSA provenance

`sign` embeds provenance detected from the CI environment unless
`embedProvenance: false`. `provenanceFromEnv()` handles GitHub Actions and GitLab CI
and returns `null` elsewhere.

This is a claim by the signer, not an attestation by a builder — the manifest is
signed by the same key that asserts it. See `SPEC.md` §1 and §6.3; do not read it as
SLSA compliance.

## Licence

MIT or Apache-2.0.
