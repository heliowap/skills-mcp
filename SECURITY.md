# Security

This file is the single source of truth for security in this repository. Other docs point here.

## Threat model

- **Adversary:** the author of a skill, of a GitHub repository, or of a command source's output. Their text reaches the agent's context.
- **Adversary:** anyone who can reach the listen address of the [HTTP entry point](#http-entry-point).
- **Assets:** the user's files and machine, the decision-model API keys, and what the agent does with the text it receives.
- **Boundary:** the server never runs a skill file. It runs only the git and command programs that a source spec declares.

## Trusted and untrusted sources

- **Trusted:** a local source. Its top-level symlinks may point outside it.
- **Untrusted:** a GitHub source and a command source. Every path must resolve, with `realpath`, inside its skill directory.
- **Who may add sources:** local and command sources come only from the config file or the [admin CLI](README.md#admin-cli). Agents may add and remove GitHub sources through the `sources` tool. A command source runs a program, so only the user adds one. The per-action table is in [README Tools](README.md#what-agents-may-do-with-sources).

## Rules for untrusted content

- Every skill, resource and source is data. The server reads and returns text and never executes a file from a skill.
- Commands start from an argument array with `Bun.spawn`, with a timeout, an `AbortSignal` and an output cap. No shell is involved.
- Command sources get an allowlisted environment: `PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR`, `USER` and `SHELL`. API keys are not passed to them.
- Git runs with `GIT_TERMINAL_PROMPT=0` and without the repository override variables. Git otherwise inherits the server's environment, so API keys are visible to git. Git does not use them.
- Every path is resolved with `realpath` and must stay inside its skill directory before it is read. The one exception is the top-level symlinks of a trusted local source.
- Sanitize every skill id, name and description before it reaches agent-visible text (tool output, server instructions, suggestions). Validate ids against the id pattern, strip control characters and XML-like tags, and cap the length.
- `load`'s `body` and `read`'s `text` are returned verbatim. Treat them as third-party text.
- Size limits: 512 files and 16 MiB per skill; 256 KiB per served resource; a scan stops at depth 6 or 20,000 entries.

## Keys and logs

- Keys are read by name from the environment when the server starts. They never appear in the config file.
- Keys do not appear in logs, errors, tool output or test snapshots. An error names the variable, never its value.
- Diagnostics go to stderr. A tool error reaches the agent as one sanitized line, and the same line is written to stderr.
- A missing key does not stop the server. Its effect is in [README Decision models](README.md#decision-models).

## What leaves your machine

- `find` with no decision model sends nothing.
- `find` with a decision model sends the task text, the skill ids and descriptions (each cut to a character budget), and, for the three shortlisted skills, the first 700 characters of their bodies. `typesafe-ai` entries send this to the TypeSafe AI API (`https://api.typesafe.ai/v1`). `gateway` entries send it through the AI SDK gateway. Resources, full bodies, paths, the config file and keys are not sent.
- `sources sync` on a GitHub source contacts GitHub. A command source runs its configured program, which can do whatever that program does.
- `load` returns `base`, the absolute path of the skill directory on the server's machine, into the agent's context. Keep that in mind before you share a transcript.

## HTTP entry point

The [HTTP entry point](README.md#install-and-run) (`src/http.ts`) is the only network surface.

- It has no authentication. Anyone who can reach its listen address can call every tool, including `sources add`, `sync` and `remove` for GitHub sources.
- Requests whose `Host` header, or browser `Origin`, names a host other than the listen address are refused. This blocks DNS rebinding.
- Traffic is plain HTTP. Encryption relies on the private network, such as Tailscale.
- Bind only to loopback or to a private network address that you control. Never bind to a public address.
- Do not enable Tailscale Funnel until bearer tokens and a configurable Host allowlist exist. The accepted design is [ADR-0018](docs/adr/0018-serve-cloud-agents-through-tailscale-funnel.md).
- Changes to the exposure are recorded in [docs/adr/](docs/adr/).

## Reporting a vulnerability

Report it privately through GitHub's [private vulnerability reporting](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability): the **Security and quality** tab of `heliowap/skills-mcp`, then **Report a vulnerability**. Do not open a public issue, and do not post keys or exploit details in public.

## Security updates

- **Version updates:** Dependabot checks the `bun` ecosystem weekly, as set in [`.github/dependabot.yml`](.github/dependabot.yml). Minor and patch updates arrive as one pull request. Each major update arrives as its own pull request. `@types/bun` is excluded: it moves only with the Bun upgrade. A new release waits 3 days before Dependabot proposes it, by default.
- **Security updates:** Dependabot opens one pull request per vulnerable dependency, including those in `bun.lock`. Security updates do not wait for the cooldown.
- **Repository settings:** verified 2026-11-07, Dependabot alerts, Dependabot security updates and private vulnerability reporting are enabled. `.github/dependabot.yml` takes effect only once it is merged to the default branch, `main`. See the [Dependabot security updates](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-security-updates) docs.
- **Gate:** every update pull request must pass the `verify` CI check before it is merged. The rule is in [coding standards, Dependencies](docs/coding-standards.md#dependencies).
- **Bun runtime:** Dependabot does not change the Bun pin. Check the Bun version monthly, and on any Bun security release. The upgrade steps are in [coding standards, Dependencies](docs/coding-standards.md#dependencies).
- **VPS:** `unattended-upgrades` applies Ubuntu security updates daily, and the VPS reboots at 01:00 Brasília time only when a reboot is required. Bun is excluded from automatic upgrades. See [ADR-0019](docs/adr/0019-apply-vps-security-updates-daily.md).
