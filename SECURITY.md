# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes |

Security fixes land on the latest release line on `master`.

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report privately via
[GitHub Security Advisories / Private Vulnerability Reporting](https://github.com/shu0819-sjy/dsh-auto-continue/security/advisories/new)
for this repository (repository → *Security* → *Report a vulnerability*).

Include:

- Affected version or commit
- Description of the issue and impact
- Steps to reproduce with **placeholder** credentials / sanitized logs only
- Any suggested fix if you have one

We aim to acknowledge reports within **7 days** and to agree a fix or mitigation
timeline after triage. Credit is optional and anonymous by default.

## Scope

In scope:

- The published plugins under `plugins/` (`auto-continue`, `anti-repetition`)
- Bypass of documented safety guards (whitelist, attempt caps, anti-race fence,
  human veto) that could cause unbounded auto-resume
- Install scripts writing unexpected locations outside the intended DSH data dir
  when given normal inputs

Out of scope:

- Misconfiguration of DSH itself or of third-party models / upstreams
- Running with `includeSubagents: true` in environments that cannot tolerate
  nested retries
- Example snippets under `examples/` used as-is in production without review

## Design posture

- Plugins perform no network I/O of their own; they only schedule follow-ups
  through the DSH agent bus / services they inject.
- Default error patterns aim at recoverable transport / overload failures — not
  auth or policy denials.
- Attempt caps and human veto are fail-closed: when unsure, do not resume.

## Secrets hygiene

Never commit API keys, tokens, cookies, private channel ids, or machine-absolute
paths. If a secret was ever committed, **rotate it first**; history cleanup is
secondary to rotation.
