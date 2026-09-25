# Contributing to dsh-auto-continue

Thanks for helping improve this project. Keep the plugins small, auditable, and
safe to mount into a DeepSeek Harness (DSH) profile.

## Development setup

Requirements: **Node.js >= 18** and npm. A local DSH install is only needed for
the mock / integration suites — not for the portable CI gate.

```bash
git clone https://github.com/shu0819-sjy/dsh-auto-continue.git
cd dsh-auto-continue
npm ci
npm run ci          # syntax check + eslint + portable static suite
```

Optional (needs a local DSH / `@deepseek-ai/*` resolve path):

```bash
node test/test.mjs          # mock suite
node test/integration.mjs   # cordis Context integration
node test/check.mjs         # installed-profile self-check
```

Install scripts for a real profile:

```powershell
pwsh -File install/install.ps1
```

```bash
bash install/install.sh
```

Restart DSH fully after install (tray quit counts as a real restart).

## Ground rules

1. **Plugin shape.** Keep `plugins/*.mjs` as ESM Cordis plugins. Do not introduce
   a bundler or runtime dependency beyond what DSH already provides.
2. **Portable CI first.** Changes that affect contracts must update
   `test/ci-static.mjs` (or keep it green). Suites that import `@deepseek-ai/*`
   stay optional for machines with DSH installed.
3. **Dual-chain safety.** Hard-failure and soft-resume counters stay independent;
   anti-race fences (alive / idle / empty inbox / runtime open) and human veto
   must remain fail-closed.
4. **No secrets / PII.** Never commit profile paths that identify a person,
   private upstream channel ids, tokens, or machine-absolute paths.
5. **English in new code comments** when practical; user-facing `continueText`
   stays configurable (default Chinese is fine).

## Workflow

1. Branch from `master` (`feat/...`, `fix/...`, `docs/...`).
2. Make a focused change; update `CHANGELOG.md` for user-visible behavior.
3. Run `npm run ci` locally until green.
4. Open a PR describing behavior impact and any default-value changes.

Commit messages: conventional, imperative subject ≤ 72 chars
(`feat: ...`, `fix: ...`, `docs: ...`).

## Lint / scripts

| Script | Purpose |
|--------|---------|
| `npm run check` | `node --check` on both plugins |
| `npm run lint` | ESLint flat config over `plugins/` + `test/` |
| `npm run test:static` | Portable static suite (no DSH) |
| `npm run ci` | All of the above |

## Reporting issues

- Bugs: include Node version, DSH version if relevant, minimal repro, expected vs actual.
- Security issues: **do not** open a public issue — see [`SECURITY.md`](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE) of this repository.
