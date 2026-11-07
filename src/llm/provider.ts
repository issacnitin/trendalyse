import { spawnSync } from 'node:child_process';

export const PROVIDERS = ['openai', 'github-models', 'deepseek'] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export interface ProviderModels {
  readonly extraction: string;
  readonly analysis: string;
  readonly ideas: string;
  readonly ranking: string;
}

export interface ProviderSpec {
  readonly label: string;
  readonly defaultBaseUrl: string;
  readonly defaultModels: ProviderModels;
  /** Checked in order; the first non-empty value wins. */
  readonly credentialEnvVars: readonly string[];
  readonly setupHint: string;
}

export const PROVIDER_SPECS: Record<ProviderId, ProviderSpec> = {
  deepseek: {
    label: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModels: {
      extraction: 'deepseek-flash',
      analysis: 'deepseek-flash',
      ideas: 'deepseek-flash',
      ranking: 'deepseek-flash',
    },
    credentialEnvVars: ['DEEPSEEK_API_KEY'],
    setupHint: 'Set DEEPSEEK_API_KEY on the server. Never put it in browser code.',
  },
  openai: {
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModels: {
      extraction: 'gpt-4o-mini',
      analysis: 'gpt-4o-mini',
      ideas: 'gpt-4o-mini',
      ranking: 'gpt-4o',
    },
    credentialEnvVars: ['OPENAI_API_KEY'],
    setupHint: 'Set OPENAI_API_KEY, or switch providers with LLM_PROVIDER=github-models.',
  },
  'github-models': {
    label: 'GitHub Models',
    defaultBaseUrl: 'https://models.github.ai/inference',
    // GitHub Models requires publisher-qualified model identifiers.
    defaultModels: {
      extraction: 'openai/gpt-4o-mini',
      analysis: 'openai/gpt-4o-mini',
      ideas: 'openai/gpt-4o-mini',
      ranking: 'openai/gpt-4o',
    },
    credentialEnvVars: ['GITHUB_TOKEN', 'GH_TOKEN'],
    setupHint:
      'Run `gh auth login` (GitHub CLI), or set GITHUB_TOKEN to a token with the "models:read" scope.',
  },
};

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDERS as readonly string[]).includes(value);
}

export interface CommandResult {
  status: number | null;
  stdout: string;
}
export type CommandRunner = (command: string, args: readonly string[]) => CommandResult;

const defaultRunner: CommandRunner = (command, args) => {
  // No shell: arguments are fixed, and this avoids any shell-quoting surface.
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  });
  return { status: result.status, stdout: result.stdout ?? '' };
};

/**
 * Finds the credential for a provider: explicit environment variables first, then the GitHub
 * CLI's existing login for GitHub Models. The `gh` fallback is what removes the need to manage
 * a separate API key — the user is already authenticated for their normal GitHub work.
 */
export function discoverCredential(
  provider: ProviderId,
  env: NodeJS.ProcessEnv,
  runner: CommandRunner = defaultRunner,
): string | undefined {
  for (const name of PROVIDER_SPECS[provider].credentialEnvVars) {
    const value = env[name]?.trim();
    if (value) return value;
  }

  if (provider === 'github-models') {
    try {
      const result = runner('gh', ['auth', 'token']);
      const token = result.stdout.trim();
      if (result.status === 0 && token) return token;
    } catch {
      // gh is not installed or not on PATH; treated as "no credential found".
    }
  }

  return undefined;
}
