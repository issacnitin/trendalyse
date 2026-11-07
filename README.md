# Trendalyse — Search signals and market intelligence

Trendalyse adds a web interface for **Google Trends data via SerpApi**, with comparison
charts, rising/top related queries, CSV downloads, and evidence-led business hypotheses
using **DeepSeek `deepseek-flash`**. The existing Scrouge CLI remains available.

## Website development

The account-backed website requires **Node.js 22.13+** (the CLI still supports Node 20).

```bash
npm ci
cp .env.example .env
# Set DEEPSEEK_API_KEY in .env; leave base URL/model overrides unset.
# Add ACCOUNT_ENCRYPTION_KEY using `openssl rand -hex 32`. Keep it secret and stable.
npm run build
node --env-file=.env dist/web/server.js
# Open http://localhost:3000
```

The encryption key is required even in development. With it configured, development
without a DeepSeek key still supports accounts and customer-provided SerpApi searches;
AI readiness is reported explicitly. The site never substitutes simulated Trends data.
For watch-mode development, use `node --env-file=.env --import tsx src/web/server.ts`;
rebuild the browser assets after changing the frontend.

The web server always selects the DeepSeek provider; the CLI still defaults to OpenAI.
The web UI supports up to five terms, selected countries and five date ranges. Related
queries apply to the **first** term only. The API also accepts country/subregion codes.
Interest scores are normalized 0-100 within the selected comparison, **not absolute
search counts**. Growth compares the last quarter of complete periods with the first;
zero baselines produce no percentage, and partial periods are excluded from metrics.
AI opportunities are hypotheses, not measured revenue, purchase intent, or market size.
Market insights use DeepSeek Flash's [high-effort thinking mode](https://api-docs.deepseek.com/guides/thinking_mode)
to explore and challenge less-obvious ideas, not just summarize trends. Each idea
includes its unexpected angle, cited search evidence, an untested assumption, a failure
risk, and a small experiment with proposed pass/fail criteria. Ideas appear before the
brief search-context summary; assumptions and risks expand on demand. This does not
prove novelty or demand. One analysis uses one completion with the existing retry policy
and daily-attempt accounting; thinking can increase latency and token usage. The website
defaults to a 120-second provider timeout unless `LLM_TIMEOUT_MS` is set; the CLI
default and other completion stages are unchanged.

Google's [direct Trends API](https://developers.google.com/search/apis/trends) is still
access-limited. This implementation uses the documented
[SerpApi Google Trends API](https://serpapi.com/google-trends-api), not Google's alpha
endpoint. Each uncached search makes two SerpApi requests; successful data is cached for
one hour, up to 10 queries per active customer and 20 customer clients in memory. Caches
are account-isolated and discarded on key changes/disconnection or logout. AI analysis
is opt-in and fetches its evidence server-side.

## Customer onboarding and idea research

There is no longer a shared **site access token**. Customers register with email and a
12-128-character password, or sign in to an existing account. Registration signs them
in immediately. **Email verification is deferred**: no email is sent and new accounts
remain explicitly unverified. Password reset/email delivery are not implemented yet.

The public landing page is at `/`. Account access is on the separate `/login` page
(`/login?mode=register` opens registration). Signing in or registering sends customers
to the dashboard. Sign-in is the primary form action; a smaller **Create your account**
link below it opens registration, which has a corresponding sign-in link.
Anonymous `/dashboard` requests redirect to login, and authenticated
login requests redirect to the dashboard. Signing out returns to the landing page.
The dashboard contains a three-step data onboarding wizard and the research tools:

1. Open [SerpApi signup](https://serpapi.com/users/sign_up) and the
   [API-key dashboard](https://serpapi.com/manage-api-key) in a new tab.
2. Copy/paste the key, then select **Verify & connect**. Clipboard reading happens
   only after clicking the paste button. SerpApi's free
   [Account API](https://serpapi.com/account-api) verifies the key and reports quota
   without using a search credit. Only plan/quota fields are returned to the browser;
   the provider's echoed key is stripped. Failed verification does not replace a saved key.
3. Explore searches and generate market hypotheses. Existing connections survive
   sign-out/restarts. The compact connected panel has a **Manage your connection**
   disclosure for replacement, disconnection, and quota refresh; returning customers
   can go straight to research without repeating setup.

SerpApi does not document a third-party OAuth account-linking/key-provisioning flow for
this integration. The wizard links to the real provider dashboard rather than scraping
credentials, collecting SerpApi passwords, or pretending automatic account linking.

To explore an idea, start with a specific audience/question, such as busy households
looking for convenient food options. Compare `meal prep,healthy snacks` in your target
region, check both 12-month and 5-year trends, inspect related searches, and generate
AI hypotheses. Interview 5-10 people in your target audience, then run a small validation
experiment. For commercial ideas, test willingness to pay. Search interest alone does
not establish demand.

Credentials are stored in a persistent SQLite database. Passwords use salted scrypt;
login tokens are random, hashed at rest, expire after seven days, and are sent only in
HttpOnly/SameSite cookies (Secure, host-only `__Host-` cookies in production). Mutating
requests require the exact configured Origin and JSON bodies, and authentication
attempts are rate/concurrency limited. SerpApi keys use AES-256-GCM with per-account
authenticated context; keys never return to the browser or localStorage after saving.
Each search uses the signed-in customer's key, **never the operator's key**.

DeepSeek still uses the operator's server-side key. Each customer gets **five AI
attempts per UTC day**, persisted across restarts; model failures may count because
they can incur provider charges. Global paid-request limits remain 20/minute with two
active requests, plus a per-customer 10/minute limit. Email verification should be
enabled before a broad public launch; deferred verification is not an anti-abuse control.

## Public search and AI discovery

The homepage is deliberately short and image-led. Its original SVG illustrations
are self-hosted under `/images/` and copied into the container build; they illustrate
research rather than representing live Google Trends results. Detailed explanations
belong in the separate public guide, while account setup and paid research stay in
the authenticated dashboard.

The landing page targets **market research using AI** with concise server-served
text, canonical and social metadata, a link to a separate practical research guide, and
JSON-LD describing the actual organization, website, and application. There are no
fabricated ratings, prices, or claims of measured demand. The CSP allows only the hash
of the landing page's structured-data block, not arbitrary inline scripts.
The public `/market-research-using-ai` guide explains the workflow, sources, provider
limits, and evidence caveats without adding card/FAQ sections to the homepage.

`/robots.txt` permits public crawling, including Googlebot, OAI-SearchBot,
Claude-SearchBot, and Claude-User, while excluding `/dashboard`, `/api/`, and
`/healthz`. `/sitemap.xml` lists only the homepage and guide, with no invented
modification dates. Login remains crawlable so crawlers can see its `noindex`;
login, dashboard, API responses, redirects, and errors receive `X-Robots-Tag:
noindex, nofollow`. These directives are **not access control**: session checks,
no-store account responses, and encrypted customer credentials remain unchanged.
Public metadata assumes the production hostname is `https://trendalyse.com`.

Crawler guidance verified against official documentation on November 7, 2026:

- [OpenAI crawlers](https://developers.openai.com/api/docs/bots):
  OAI-SearchBot is for ChatGPT search; GPTBot is for model training. Their controls
  are independent. ChatGPT-User is user-directed retrieval, not search crawling,
  and robots rules may not apply to those user actions.
- [Anthropic crawlers](https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler):
  Claude-SearchBot serves search, Claude-User serves user retrieval, and ClaudeBot
  serves training. Anthropic documents separate robots controls.
- [Google AI search guidance](https://developers.google.com/search/docs/appearance/ai-features):
  ordinary SEO applies to AI Overviews/AI Mode. Eligible pages need indexing and
  snippets; no special AI files or schema are required. Structured data must match
  visible content.
- [Google crawler controls](https://developers.google.com/crawling/docs/crawlers-fetchers/google-common-crawlers#google-extended):
  Googlebot controls Search. Google-Extended controls both Gemini training and
  some Gemini/Vertex grounding; it does not affect Google Search inclusion or ranking.

**Training policy is unchanged**, not newly opted in or out. The wildcard public
crawl policy does not opt out of training. Before choosing a different policy, the
operator should decide separately about GPTBot and ClaudeBot, and consider the
coupled training/grounding tradeoff for Google-Extended. Discoverability should not
be treated as consent to training. No `llms.txt` is added: auxiliary AI-file
conventions are not required and do not guarantee indexing or recommendations.

After deployment, verify the domain in Google Search Console, submit
`https://trendalyse.com/sitemap.xml`, and inspect the canonical landing URL's indexed
HTML. Check Cloudflare WAF/bot/Access settings and origin logs so public pages and
discovery resources are accessible without challenges to legitimate crawlers; use
the providers' published verification guidance rather than trusting a spoofable
user-agent. Do not remove private-route authentication to enable crawling.
Check live GET/HEAD responses, canonical/share metadata, and structured data after
integration. Search engines and assistants decide whether to crawl, index, cite,
or recommend the site; none of these changes guarantees a rank or recommendation.

## Container hosting inside an isolated KVM guest

The deployment target is `issacnitin@dellr6301.tail303f77.ts.net`. Run **Docker only
inside the dedicated `trendalyse` KVM guest**, not directly on the host.

The provisioning files in `deploy/kvm/` create a 2-vCPU / 4-GB / 30-GB Ubuntu 24.04
guest with its own `172.29.245.0/24` libvirt NAT network. Host-enforced nwfilters reject
guest-initiated LAN, other-guest, Tailscale, loopback and link-local connections, deny
IPv6 and non-permitted traffic, and allow only public TCP 443/7844 plus DNS to
`1.1.1.1:53`. The only inbound initiation allowed is host-to-guest SSH; outbound SSH
replies are state-bound. There are **no public port forwards**. This is network
segmentation, not an air gap: public HTTPS egress remains necessary for the APIs and
image/package updates. The hypervisor remains a trusted administrator.

Provision on the Dell host with an ed25519 public key:

```bash
bash deploy/kvm/provision.sh /absolute/path/to/guest-key.pub
```

The script uses `qemu:///system` permissions, verifies the cloud-image SHA-256,
and refuses existing VM/network names or an occupied subnet. It creates only
Trendalyse resources. If provisioning fails partway through, inspect those resources
before retrying; it deliberately does not delete VMs, pools, or networks automatically.
Guest access is through SSH ProxyJump from your workstation:

```bash
ssh -J issacnitin@dellr6301.tail303f77.ts.net -i /path/to/guest-key issacnitin@172.29.245.10
sudo cloud-init status --wait
test -f /var/lib/cloud/trendalyse-ready
```

Copy this repository to `/opt/trendalyse` in the guest, then create secrets there:

```bash
cd /opt/trendalyse
mkdir -m 700 -p deploy/secrets
umask 077
printf 'ACCOUNT_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" > deploy/secrets/app.env
# Edit app.env to add DEEPSEEK_API_KEY. Do not paste keys into chat.
# Model/base URL overrides are optional; the default is deepseek-flash at api.deepseek.com.
```

`ACCOUNT_ENCRYPTION_KEY` must remain stable across deployments. Back it up securely
and separately from the database; losing it makes customer SerpApi keys unrecoverable.
The `accounts` Docker volume mounts `/data` for the database, sessions and daily quotas.
Back up that volume using SQLite's backup facility or while the app is stopped, not
by copying only a live database without its WAL. Never run `docker compose down -v`
unless intentionally deleting all accounts. Existing `WEB_ACCESS_TOKEN` and
`SERPAPI_API_KEY` environment variables are ignored by the website.

Build/start just the app before configuring the tunnel:

```bash
sudo docker compose up -d --build --wait --wait-timeout 60 app
sudo docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/healthz').then(async r=>console.log(await r.text()))"
```

In Cloudflare Zero Trust, create a **remotely managed Cloudflare Tunnel**. Add a public
hostname route for `trendalyse.com` with service **`http://app:3000`** (not
`localhost:3000`), and allow Cloudflare to create the DNS route in your zone.
Save **only the tunnel token** into `deploy/secrets/tunnel-token`, not a command:

```bash
# Write the token with your editor, then set mount permissions:
chmod 644 deploy/secrets/tunnel-token
sudo docker compose up -d
sudo docker compose ps
```

The enclosing secrets directory is mode 700; the mounted token must be readable by
the unprivileged cloudflared container. The app and tunnel run read-only with all
capabilities dropped, no-new-privileges, memory/CPU/PID limits and bounded logs.
No container ports are published. Cloudflare terminates public HTTPS; its connector
initiates outbound HTTP/2 connections on port 7844. Optionally protect the hostname
with Cloudflare Access as an additional perimeter. Domain ownership/tunnel credentials
are required before `https://trendalyse.com` can go live.

After updates: `sudo docker compose up -d --build --wait --wait-timeout 60`. After changing keys:
`sudo docker compose up -d --force-recreate --wait --wait-timeout 60 app`. Never commit `deploy/secrets/`,
`.env`, VM disks or SSH keys.

HTML references stylesheets and browser scripts with a content-derived version in
their URLs so cached assets do not become mismatched after a deployment. Keep query
strings in CDN cache keys and respect the HTML cache-control headers; never
force-cache account pages or API responses.

Check connectivity from the guest: public HTTPS should
succeed; connections to `192.168.68.1:443`, another guest, `100.64.0.0/10`, and
host gateway ports other than replying to SSH must fail.

## Scrouge CLI

Scrouge is an AI-powered CLI agent that browses URLs (forums, subreddits, social feeds), extracts user posts, analyzes sentiment and topics, and generates **non-obvious, high-value product/service ideas** ranked by estimated revenue potential.

## Demo

![](./recording.gif)

## How It Works

1. **Validate** — every URL is checked against an SSRF guard before a browser is launched.
2. **Browse** — Playwright opens the target with realistic headers and scrolls to load more posts.
3. **Extract** — DOM candidates → LLM filtering → chunked full-text fallback → DOM-only fallback.
4. **Analyze** — each post gets a sentiment, topic and summary pass, run with bounded concurrency.
5. **Ideate** — a product-strategist prompt proposes up to 3 differentiated ideas per post.
6. **Rank** — ideas are aggregated across posts, then ranked with revenue, pricing and channels.
7. **Prompt** — after each batch you choose whether to continue.

## Prerequisites

- **Node.js ≥ 20.11**
- **Playwright Chromium** — `npm run browsers`
- **An LLM credential** — either an OpenAI API key, or a GitHub account (see below)

## Setup

```bash
git clone https://github.com/issacnitin/scrouge_market.git && cd scrouge_market
npm install
npm run browsers
cp .env.example .env      # then choose a provider
```

### Authentication

Scrouge supports three providers. Pick whichever you already have.

**DeepSeek** — set `DEEPSEEK_API_KEY` and `LLM_PROVIDER=deepseek` (or
`--provider deepseek`). All stages default to `deepseek-flash`. Leave
`OPENAI_BASE_URL` and model overrides unset to use provider defaults. The client
uses DeepSeek's documented JSON-object mode, `max_tokens`, and disabled thinking,
and validates the resulting JSON with the same schemas as other providers.

**OpenAI** (default) — set `OPENAI_API_KEY`.

**GitHub Models** — uses your GitHub account, so there is no OpenAI key to manage. It is
included with GitHub Copilot and free GitHub plans, and is an officially supported,
OpenAI-compatible endpoint.

```bash
gh auth login                                  # if you have the GitHub CLI
npm run dev -- --provider github-models

# or, without the GitHub CLI:
$env:GITHUB_TOKEN = "ghp_..."                  # needs the "models:read" scope
npm run dev -- --provider github-models
```

Credentials are resolved in this order: `GITHUB_TOKEN` → `GH_TOKEN` → `gh auth token`.

> Scrouge deliberately does **not** talk to Copilot's internal chat endpoint or read tokens
> out of VS Code's credential storage. That API is undocumented, restricted to first-party
> clients, and using it from a third-party tool would breach the Copilot terms of service.
> GitHub Models is the supported way to use your GitHub identity for inference.

## Usage

```bash
# Interactive (prompts for URLs, asks before each batch)
npm run dev

# Non-interactive / scriptable
npm run dev -- --url https://example.com/forum --yes --headless

# Using your GitHub login instead of an OpenAI key
npm run dev -- --provider github-models -u https://example.com/forum -y

# The ranked report goes to stdout, logs go to stderr — so this works:
npm run dev -- -u https://example.com/forum -y > report.txt
```

| Flag | Description |
|---|---|
| `-u, --url <url>` | Target URL. Repeatable, and accepts comma-separated values. |
| `-y, --yes` | Never prompt between batches. Required for non-interactive use. |
| `--provider <id>` | `openai` (default), `github-models`, or `deepseek`. |
| `--headless` / `--headful` | Force browser visibility, overriding `SHOW_BROWSER`. |
| `-h, --help` | Show usage. |

Exit codes: `0` success, `1` failure, `64` usage error, `78` configuration error, `130` interrupted.

## Configuration

All settings are environment variables, validated at startup — see [.env.example](./.env.example) for the full list. The most relevant ones:

| Variable | Default | Description |
|---|---|---|
| `LLM_PROVIDER` | `openai` | `openai`, `github-models`, or `deepseek` (CLI). |
| `DEEPSEEK_API_KEY` | — | Required for DeepSeek; web insights always use this provider. |
| `ACCOUNT_ENCRYPTION_KEY` | — | Required 64-hex-character server secret for encrypting customer keys. Keep stable. |
| `ACCOUNT_DATABASE_PATH` | `./data/accounts.sqlite` | Persistent account database; Compose uses `/data/accounts.sqlite`. |
| `AI_DAILY_LIMIT` | `5` | Per-account AI attempts per UTC day. |
| `WEB_ORIGIN` | `http://localhost:3000` | Exact allowed browser origin; Compose sets `https://trendalyse.com`. |
| `OPENAI_API_KEY` | — | Required when the provider is `openai`. |
| `GITHUB_TOKEN` / `GH_TOKEN` | — | Used by `github-models`; falls back to `gh auth token`. |
| `OPENAI_BASE_URL` | per provider | Override to point at a compatible gateway. |
| `MODEL_ANALYSIS` / `MODEL_IDEAS` / `MODEL_RANKING` | per provider | Per-stage models. |
| `LLM_CONCURRENCY` | `4` | Max in-flight LLM requests. |
| `LLM_TIMEOUT_MS` | `60000` | Hard per-request timeout. |
| `MAX_POSTS_PER_URL` | `200` | Cost and memory ceiling. |
| `ALLOW_PRIVATE_HOSTS` | `0` | **Only** enable for local development. |
| `PERSIST_INSIGHTS` | `0` | Write analyzed insights to `INSIGHTS_PATH`. |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `pretty` | `LOG_FORMAT=json` for machine-readable logs. |

## Security model

This tool feeds **attacker-controlled web content** into an LLM, so it is built defensively:

- **SSRF protection** — URLs are restricted to `http`/`https` on ports 80/443, with no embedded
  credentials. Every DNS-resolved address is checked against loopback, RFC1918, CGNAT,
  link-local (including `169.254.169.254` cloud metadata), multicast and reserved ranges, in both
  IPv4 and IPv6, covering IPv4-mapped, NAT64 and 6to4 encodings. Redirect targets are re-validated.
- **Prompt-injection hardening** — scraped text is stripped of control characters, bidi overrides
  and forged role/special tokens, then wrapped in a per-call random delimiter that embedded text
  cannot forge. Every prompt states that fenced content is untrusted data, never instructions.
- **Secret redaction** — API keys and bearer tokens are scrubbed from every log line and every
  error message, because provider error bodies routinely echo the submitted `Authorization` header.
- **Schema-validated output** — responses are constrained with a strict JSON schema *and*
  re-validated with Zod, so malformed or hostile model output cannot flow downstream.
- **Resource bounds** — DOM traversal, post counts, post length, retry delays and the insight log
  are all capped.

Report vulnerabilities via a private GitHub security advisory rather than a public issue.

## Project structure

```
src/
├── index.ts              # Entry point: config, signals, graceful shutdown
├── cli.ts                # Argument parsing and prompts
├── config.ts             # Environment parsing and validation
├── logger.ts             # Levelled structured logging with secret redaction
├── errors.ts             # Error taxonomy
├── llm/
│   ├── client.ts         # Single LLM entry point: retry, concurrency, caching, validation
│   ├── http.ts           # Timeout-enforcing JSON transport
│   ├── provider.ts       # Provider registry and credential discovery
│   ├── prompts.ts        # Injection-hardened prompt construction
│   └── schemas.ts        # Zod + JSON schemas per stage
├── net/url-guard.ts      # SSRF validation
├── scrape/
│   ├── browser.ts        # Playwright lifecycle and navigation
│   └── extract.ts        # Multi-strategy post extraction
├── pipeline/
│   ├── analyze.ts        # Concurrent per-post analysis and ideation
│   ├── rank.ts           # Cross-post aggregation and ranking
│   ├── report.ts         # Pure rendering
│   ├── run.ts            # Orchestration
│   └── storage.ts        # Atomic, schema-validated insight log
└── util/                 # retry, concurrency, text sanitization
```

## Development

```bash
npm run verify        # typecheck + lint + test
npm run test:watch
npm run test:coverage
npm run build         # emit dist/
```

TypeScript runs in strict mode with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`;
ESLint uses type-aware rules. CI runs all of the above on Node 20 and 22, plus `npm audit`.

## Notes

- Some sites (Reddit, Twitter/X) aggressively block automated browsers. Scrouge detects
  login/consent walls and reports them instead of scraping an empty page.
- Scraping may violate a site's terms of service. Check before you point this at a target.
- Large media files should be tracked with [Git LFS](https://git-lfs.github.com/).
- Never commit `.env` or API keys.
