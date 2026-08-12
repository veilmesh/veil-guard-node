import { test } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { writeFile, mkdir, rm, readFile } from 'fs/promises';
import { exec } from 'child_process';
import util from 'util';
import { provenanceFromEnv } from '../provenance.js';
import { sign } from '../cli.js';

test('provenanceFromEnv - GitHub Actions detection', () => {
  // Save original env
  const origGithub = process.env.GITHUB_ACTIONS;
  const origServer = process.env.GITHUB_SERVER_URL;
  const origRepo = process.env.GITHUB_REPOSITORY;
  const origRunId = process.env.GITHUB_RUN_ID;
  const origSha = process.env.GITHUB_SHA;

  try {
    process.env.GITHUB_ACTIONS = 'true';
    process.env.GITHUB_SERVER_URL = 'https://github.com';
    process.env.GITHUB_REPOSITORY = 'veilmesh/test';
    process.env.GITHUB_RUN_ID = '12345';
    process.env.GITHUB_SHA = 'abcdef1234567890';
    process.env.GITHUB_WORKFLOW_REF = '.github/workflows/ci.yml@refs/heads/main';

    // Clear GitLab variables to avoid confusion
    delete process.env.GITLAB_CI;

    const prov = provenanceFromEnv();
    assert.ok(prov, 'provenance must be generated');
    assert.strictEqual(prov.builder.id, 'https://github.com/veilmesh/test/actions/runs/12345');
    assert.strictEqual(prov.invocation.config_source.digest.sha256, 'abcdef1234567890');
    assert.strictEqual(prov.invocation.config_source.entry_point, '.github/workflows/ci.yml@refs/heads/main');
  } finally {
    // Restore original env
    process.env.GITHUB_ACTIONS = origGithub;
    process.env.GITHUB_SERVER_URL = origServer;
    process.env.GITHUB_REPOSITORY = origRepo;
    process.env.GITHUB_RUN_ID = origRunId;
    process.env.GITHUB_SHA = origSha;
  }
});

test('provenanceFromEnv - GitLab CI detection', () => {
  const origGitlab = process.env.GITLAB_CI;
  const origProjUrl = process.env.CI_PROJECT_URL;
  const origPipelineId = process.env.CI_PIPELINE_ID;
  const origCommitSha = process.env.CI_COMMIT_SHA;

  try {
    // Clear GitHub variables
    delete process.env.GITHUB_ACTIONS;

    process.env.GITLAB_CI = 'true';
    process.env.CI_PROJECT_URL = 'https://gitlab.com/veilmesh/test';
    process.env.CI_PIPELINE_ID = '98765';
    process.env.CI_COMMIT_SHA = 'fedcba6543210';
    process.env.CI_CONFIG_PATH = '.gitlab-ci.yml';

    const prov = provenanceFromEnv();
    assert.ok(prov, 'provenance must be generated');
    assert.strictEqual(prov.builder.id, 'https://gitlab.com/veilmesh/test/-/pipelines/98765');
    assert.strictEqual(prov.invocation.config_source.digest.sha256, 'fedcba6543210');
  } finally {
    process.env.GITLAB_CI = origGitlab;
    process.env.CI_PROJECT_URL = origProjUrl;
    process.env.CI_PIPELINE_ID = origPipelineId;
    process.env.CI_COMMIT_SHA = origCommitSha;
  }
});

import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

test('sign CLI execution E2E test', async () => {
  // Skip if we can't find the target debug binary
  const binPath = join(__dirname, '../../../veil-guard/target/debug/veil-guard');
  
  // Create a temp directory for build files
  const tmpDir = join(tmpdir(), `vg-node-test-${randomBytes(6).toString('hex')}`);
  await mkdir(tmpDir, { recursive: true });

  try {
    // 1. Create a dummy HTML file in dist
    const distDir = join(tmpDir, 'dist');
    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, 'index.html'), '<!doctype html><html></html>');

    // 2. Generate a keypair using CLI
    const keysDir = join(tmpDir, 'keys');
    await mkdir(keysDir, { recursive: true });

    // Use our wrapper or direct CLI call. We call cli to generate a key
    const execAsync = util.promisify(exec);
    
    // keygen
    await execAsync(`"${binPath}" keygen --out-dir "${keysDir}" --name alice --role build`);
    const keyPath = join(keysDir, 'alice.key.json');

    // trustroot
    const trustRootPath = join(tmpDir, 'trust-root.json');
    await execAsync(`"${binPath}" trust-root --key "${keyPath}" --threshold 1 --out "${trustRootPath}"`);

    // 3. Sign the build using the wrapper
    // Set environment variable for provenance
    process.env.GITHUB_ACTIONS = 'true';
    process.env.GITHUB_SERVER_URL = 'https://github.com';
    process.env.GITHUB_REPOSITORY = 'veilmesh/test';
    process.env.GITHUB_RUN_ID = '12345';
    process.env.GITHUB_SHA = 'abcdef1234567890';
    process.env.GITHUB_WORKFLOW_REF = '.github/workflows/ci.yml';

    const output = await sign({
      dist: distDir,
      trustRoot: trustRootPath,
      keys: [keyPath],
      binPath,
      version: 12345678,
    });

    assert.ok(output.includes('manifest'), 'output must confirm manifest signing');
    
    // Verify that the manifest contains the slsa_provenance field
    const manifestContent = await readFile(join(distDir, 'veil-guard-manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestContent);
    assert.strictEqual(manifest.version, 12345678);
    assert.ok(manifest.source.slsa_provenance, 'manifest must contain slsa_provenance');
    assert.strictEqual(
      manifest.source.slsa_provenance.builder.id,
      'https://github.com/veilmesh/test/actions/runs/12345'
    );
  } finally {
    // Cleanup
    await rm(tmpDir, { recursive: true, force: true });
    delete process.env.GITHUB_ACTIONS;
  }
});
