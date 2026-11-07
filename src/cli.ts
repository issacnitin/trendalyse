import { createInterface, type Interface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

export interface CliOptions {
  urls: string[];
  assumeYes: boolean;
  headless: boolean | undefined;
  provider: string | undefined;
  help: boolean;
  version: boolean;
}

export const USAGE = `
Scrouge — Market Idea Agent

Usage:
  scrouge [options]

Options:
  -u, --url <url>      Target URL. Repeat for multiple. Prompts interactively if omitted.
  -y, --yes            Never prompt between batches. Required for non-interactive use.
      --provider <id>  LLM provider: openai (default), github-models or deepseek.
      --headless       Force headless browsing (overrides SHOW_BROWSER).
      --headful        Force a visible browser window.
  -h, --help           Show this help.
  -v, --version        Show the version.

Authentication:
  openai         Set OPENAI_API_KEY.
  deepseek       Set DEEPSEEK_API_KEY. Defaults to deepseek-flash.
  github-models  Uses your existing GitHub CLI login (\`gh auth login\`), or GITHUB_TOKEN
                 with the "models:read" scope. No OpenAI key required.

Environment:
  See .env.example for all supported variables.
  Logs go to stderr; the ranked report goes to stdout, so it can be piped.
`.trim();

export function parseCliArgs(argv: readonly string[]): CliOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      url: { type: 'string', short: 'u', multiple: true },
      yes: { type: 'boolean', short: 'y', default: false },
      provider: { type: 'string' },
      headless: { type: 'boolean', default: false },
      headful: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  if (values.headless && values.headful) {
    throw new Error('--headless and --headful are mutually exclusive');
  }

  return {
    urls: (values.url ?? []).flatMap((value) => value.split(',')).map((v) => v.trim()).filter(Boolean),
    assumeYes: values.yes === true,
    headless: values.headless ? true : values.headful ? false : undefined,
    provider: values.provider?.trim() || undefined,
    help: values.help === true,
    version: values.version === true,
  };
}

export interface Prompter {
  askUrls(): Promise<string[]>;
  confirmContinue(): Promise<boolean>;
  close(): void;
}

/** Interactive prompter backed by a single readline interface shared across the run. */
export function createPrompter(signal: AbortSignal): Prompter {
  let rl: Interface | undefined;

  const ensure = (): Interface => {
    rl ??= createInterface({ input: process.stdin, output: process.stderr });
    return rl;
  };

  return {
    askUrls: async () => {
      const answer = await ensure().question('Enter URLs separated by commas: ', { signal });
      return answer
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    },
    confirmContinue: async () => {
      if (signal.aborted) return false;
      const answer = await ensure().question('Continue to next batch? (y/N): ', { signal });
      return /^(y|yes)$/i.test(answer.trim());
    },
    close: () => {
      rl?.close();
      rl = undefined;
    },
  };
}

/** Non-interactive prompter for `--yes`, CI and piped input. */
export function createAutoPrompter(urls: readonly string[]): Prompter {
  return {
    askUrls: () => Promise.resolve([...urls]),
    confirmContinue: () => Promise.resolve(true),
    close: () => undefined,
  };
}
