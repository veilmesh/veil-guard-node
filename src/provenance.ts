export interface SlsaProvenance {
  builder: { id: string };
  build_type: string;
  invocation: {
    config_source: {
      uri: string;
      digest: { sha256: string };
      entry_point: string;
    };
    environment: Record<string, string>;
  };
}

export function provenanceFromEnv(): SlsaProvenance | null {
  // GitHub Actions
  if (process.env.GITHUB_ACTIONS) {
    return {
      builder: {
        id: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      },
      build_type: 'https://slsa.dev/provenance/v1',
      invocation: {
        config_source: {
          uri: `git+${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`,
          digest: { sha256: process.env.GITHUB_SHA ?? '' },
          entry_point: process.env.GITHUB_WORKFLOW_REF ?? '',
        },
        environment: {
          github_run_id: process.env.GITHUB_RUN_ID ?? '',
          github_run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? '',
          github_commit: process.env.GITHUB_SHA ?? '',
          github_ref: process.env.GITHUB_REF ?? '',
        },
      },
    };
  }

  // GitLab CI
  if (process.env.GITLAB_CI) {
    return {
      builder: {
        id: `${process.env.CI_PROJECT_URL}/-/pipelines/${process.env.CI_PIPELINE_ID}`
      },
      build_type: 'https://slsa.dev/provenance/v1',
      invocation: {
        config_source: {
          uri: `git+${process.env.CI_PROJECT_URL}`,
          digest: { sha256: process.env.CI_COMMIT_SHA ?? '' },
          entry_point: process.env.CI_CONFIG_PATH ?? '.gitlab-ci.yml',
        },
        environment: {
          gitlab_pipeline_id: process.env.CI_PIPELINE_ID ?? '',
          gitlab_commit: process.env.CI_COMMIT_SHA ?? '',
          gitlab_ref: process.env.CI_COMMIT_REF_NAME ?? '',
        },
      },
    };
  }

  return null;
}
