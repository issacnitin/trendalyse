import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ConfigError } from '../src/errors.js';
import { PROVIDER_SPECS, discoverCredential, isProviderId } from '../src/llm/provider.js';

const OPENAI_KEY = `sk-${'a'.repeat(40)}`;
const GH_TOKEN = `ghp_${'b'.repeat(36)}`;

const noRunner = () => {
  throw new Error('the GitHub CLI must not be invoked when a token is already present');
};

describe('isProviderId', () => {
  it('accepts supported providers and rejects others', () => {
    expect(isProviderId('openai')).toBe(true);
    expect(isProviderId('github-models')).toBe(true);
    expect(isProviderId('deepseek')).toBe(true);
    expect(isProviderId('copilot-internal')).toBe(false);
  });
});

describe('discoverCredential', () => {
  it('prefers an explicit environment variable', () => {
    expect(discoverCredential('github-models', { GITHUB_TOKEN: GH_TOKEN }, noRunner)).toBe(
      GH_TOKEN,
    );
  });

  it('accepts GH_TOKEN as an alias', () => {
    expect(discoverCredential('github-models', { GH_TOKEN: GH_TOKEN }, noRunner)).toBe(GH_TOKEN);
  });

  it('falls back to the GitHub CLI login', () => {
    const runner = vi.fn().mockReturnValue({ status: 0, stdout: `${GH_TOKEN}\n` });
    expect(discoverCredential('github-models', {}, runner)).toBe(GH_TOKEN);
    expect(runner).toHaveBeenCalledWith('gh', ['auth', 'token']);
  });

  it('returns undefined when the GitHub CLI is not authenticated', () => {
    const runner = vi.fn().mockReturnValue({ status: 1, stdout: '' });
    expect(discoverCredential('github-models', {}, runner)).toBeUndefined();
  });

  it('returns undefined when the GitHub CLI is not installed', () => {
    const runner = vi.fn().mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(discoverCredential('github-models', {}, runner)).toBeUndefined();
  });

  it('never shells out for the openai provider', () => {
    expect(discoverCredential('openai', { OPENAI_API_KEY: OPENAI_KEY }, noRunner)).toBe(OPENAI_KEY);
    expect(discoverCredential('openai', {}, noRunner)).toBeUndefined();
  });

  it('ignores blank environment values', () => {
    const runner = vi.fn().mockReturnValue({ status: 1, stdout: '' });
    expect(discoverCredential('github-models', { GITHUB_TOKEN: '   ' }, runner)).toBeUndefined();
  });
});

describe('loadConfig provider selection', () => {
  it('uses the DeepSeek credential, endpoint and Flash model', () => {
    const config = loadConfig({ LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: OPENAI_KEY });
    expect(config.llm.baseUrl).toBe('https://api.deepseek.com');
    expect(config.llm.models.analysis).toBe('deepseek-flash');
    expect(config.llm.models.ranking).toBe('deepseek-flash');
    expect(config.llm.credentialSource).toContain('DEEPSEEK_API_KEY');
    expect(discoverCredential('deepseek', {}, noRunner)).toBeUndefined();
  });
  it('defaults to openai', () => {
    const config = loadConfig({ OPENAI_API_KEY: OPENAI_KEY });
    expect(config.llm.provider).toBe('openai');
    expect(config.llm.credentialSource).toContain('OPENAI_API_KEY');
  });

  it('switches to GitHub Models with publisher-qualified default models', () => {
    const config = loadConfig({ LLM_PROVIDER: 'github-models', GITHUB_TOKEN: GH_TOKEN });

    expect(config.llm.provider).toBe('github-models');
    expect(config.llm.baseUrl).toBe(PROVIDER_SPECS['github-models'].defaultBaseUrl);
    expect(config.llm.models.analysis).toBe('openai/gpt-4o-mini');
    expect(config.llm.models.ranking).toBe('openai/gpt-4o');
    expect(config.llm.apiKey).toBe(GH_TOKEN);
  });

  it('accepts a slash in an explicitly configured model name', () => {
    const config = loadConfig({
      LLM_PROVIDER: 'github-models',
      GITHUB_TOKEN: GH_TOKEN,
      MODEL_RANKING: 'mistral-ai/Mistral-Large-2411',
    });
    expect(config.llm.models.ranking).toBe('mistral-ai/Mistral-Large-2411');
  });

  it('uses the GitHub CLI when no token variable is set', () => {
    const config = loadConfig(
      { LLM_PROVIDER: 'github-models' },
      { commandRunner: () => ({ status: 0, stdout: GH_TOKEN }) },
    );
    expect(config.llm.apiKey).toBe(GH_TOKEN);
    expect(config.llm.credentialSource).toMatch(/GitHub CLI/);
  });

  it('is case-insensitive about the provider name', () => {
    expect(
      loadConfig({ LLM_PROVIDER: 'GitHub-Models', GITHUB_TOKEN: GH_TOKEN }).llm.provider,
    ).toBe('github-models');
  });

  it('rejects an unknown provider', () => {
    expect(() => loadConfig({ LLM_PROVIDER: 'anthropic', OPENAI_API_KEY: OPENAI_KEY })).toThrow(
      /Unknown LLM_PROVIDER/,
    );
  });

  it('gives an actionable error when no GitHub credential can be found', () => {
    const attempt = () =>
      loadConfig({ LLM_PROVIDER: 'github-models' }, { commandRunner: () => ({ status: 1, stdout: '' }) });

    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(/gh auth login/);
    expect(attempt).toThrow(/models:read/);
  });

  it('still allows overriding the base URL per provider', () => {
    const config = loadConfig({
      LLM_PROVIDER: 'github-models',
      GITHUB_TOKEN: GH_TOKEN,
      OPENAI_BASE_URL: 'https://gateway.internal.example/v1/',
    });
    expect(config.llm.baseUrl).toBe('https://gateway.internal.example/v1');
  });
});
