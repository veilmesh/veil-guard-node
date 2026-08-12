import { test } from 'node:test';
import assert from 'node:assert';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import { writeFile, mkdir, rm, readFile, realpath } from 'fs/promises';
import { exec } from 'child_process';
import util from 'util';
import { build } from 'vite';
import { veilGuardPlugin, veilGuardSign } from '../vite.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const execAsync = util.promisify(exec);

const BIN = join(__dirname, '../../../veil-guard/target/debug/veil-guard');

/** A throwaway Vite project with one entry, one key and a 1-of-1 trust root. */
async function fixture() {
  const dir = await realpath(
    await mkdir(join(tmpdir(), `vg-vite-${randomBytes(6).toString('hex')}`), {
      recursive: true,
    }).then((p) => p!),
  );

  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(
    join(dir, 'index.html'),
    '<!doctype html><html><head>' +
      '<script src="/veil-guard-loader.js"></script>' +
      '</head><body><script type="module" src="/src/main.js"></script></body></html>',
  );
  await writeFile(join(dir, 'src/main.js'), 'console.log("hello world");');

  const keysDir = join(dir, 'keys');
  await mkdir(keysDir, { recursive: true });
  await execAsync(`"${BIN}" keygen --out-dir "${keysDir}" --name build-key --role build`);
  const keyPath = join(keysDir, 'build-key.key.json');

  const trustRootPath = join(dir, 'trust-root.json');
  await execAsync(
    `"${BIN}" trust-root --key "${keyPath}" --threshold 1 --out "${trustRootPath}"`,
  );

  return { dir, keyPath, trustRootPath, outDir: join(dir, 'dist') };
}

test('signs a single-page build, emits the runtime, and verifies it', async () => {
  const { dir, keyPath, trustRootPath, outDir } = await fixture();
  try {
    await build({
      root: dir,
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true },
      plugins: [
        veilGuardPlugin({
          trustRootPath,
          keyPath: [keyPath],
          binPath: BIN,
          version: 99988877,
          exclude: ['/api/'],
          cspSources: ['https://www.googletagmanager.com'],
          headersOut: join(dir, 'headers'),
        }),
      ],
    });

    const manifest = JSON.parse(await readFile(join(outDir, 'veil-guard-manifest.json'), 'utf8'));
    assert.strictEqual(manifest.version, 99988877);
    assert.strictEqual(manifest.trust_root.threshold, 1);

    const paths: string[] = manifest.assets.map((a: { path: string }) => a.path);
    assert.ok(paths.includes('/index.html'), 'must include index.html');

    // The runtime has to be in the signed output, not merely somewhere on disk:
    // a worker nobody signed is a worker the worker itself would refuse to serve.
    assert.ok(paths.includes('/veil-guard-sw.js'), 'the Service Worker must be signed');
    assert.ok(paths.includes('/veil-guard-loader.js'), 'the loader must be signed');

    // Options that exist on the wrapper have to actually reach the CLI.
    assert.deepStrictEqual(manifest.scope.exclude, ['/api/'], '--exclude must be passed through');
    const headers = await readFile(join(dir, 'headers/_headers'), 'utf8');
    assert.ok(
      headers.includes('https://www.googletagmanager.com'),
      '--csp-source must reach the generated policy',
    );

    // And the loader referenced from index.html must have picked up SRI, which only
    // happens if the runtime landed before signing rather than after.
    const html = await readFile(join(outDir, 'index.html'), 'utf8');
    assert.match(
      html,
      /veil-guard-loader\.js" integrity="sha384-/,
      'the loader reference must carry an integrity attribute',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('navigationHtmlFallback reaches the manifest scope', async () => {
  const { dir, keyPath, trustRootPath, outDir } = await fixture();
  try {
    await build({
      root: dir,
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true },
      plugins: [
        veilGuardPlugin({
          trustRootPath,
          keyPath: [keyPath],
          binPath: BIN,
          navigationHtmlFallback: true,
        }),
      ],
    });
    const manifest = JSON.parse(await readFile(join(outDir, 'veil-guard-manifest.json'), 'utf8'));
    assert.strictEqual(manifest.scope.html_extension, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The regression this plugin exists to avoid. vite-ssg renders its pages after the
// inner `vite build` has finished, so `closeBundle` sees one HTML file out of
// however many will ship. Signing there is worse than not signing: it produces a
// manifest that looks complete and covers the entry point alone.
test('refuses to sign a vite-ssg project instead of signing it incompletely', async () => {
  const { dir, keyPath, trustRootPath, outDir } = await fixture();
  try {
    await assert.rejects(
      build({
        root: dir,
        logLevel: 'silent',
        build: { outDir, emptyOutDir: true },
        // What vite-ssg reads its own settings from, and therefore the signal that
        // this build is only the first half of one.
        ssgOptions: { dirStyle: 'flat' },
        plugins: [
          veilGuardPlugin({ trustRootPath, keyPath: [keyPath], binPath: BIN }),
        ],
      } as Parameters<typeof build>[0]),
      /vite-ssg/,
      'the build must fail loudly rather than sign a partial tree',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The path a static-site generator takes: build first, sign from the post-render
// hook once every page is on disk.
test('veilGuardSign works standalone, the way an SSG hook would call it', async () => {
  const { dir, keyPath, trustRootPath, outDir } = await fixture();
  try {
    await build({
      root: dir,
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true },
    });
    // Stand in for the pages a generator would have written after the build.
    await writeFile(join(outDir, 'about.html'), '<!doctype html><html><body>about</body></html>');

    await veilGuardSign(
      { dist: outDir, trustRootPath, keyPath: [keyPath], binPath: BIN },
      () => {},
    );

    const manifest = JSON.parse(await readFile(join(outDir, 'veil-guard-manifest.json'), 'utf8'));
    const paths: string[] = manifest.assets.map((a: { path: string }) => a.path);
    assert.ok(paths.includes('/about.html'), 'pages written after the build must be signed');
    assert.ok(paths.includes('/veil-guard-sw.js'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing output directory is an error, not a silent skip', async () => {
  const { dir, keyPath, trustRootPath } = await fixture();
  try {
    await assert.rejects(
      veilGuardSign(
        {
          dist: join(dir, 'no-such-dir'),
          trustRootPath,
          keyPath: [keyPath],
          binPath: BIN,
        },
        () => {},
      ),
      /does not exist/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
