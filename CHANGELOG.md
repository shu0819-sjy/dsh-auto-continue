# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-09-25

### Added

- Dual-chain architecture: hard failure whitelist resume (auto-continue ≤3) + soft circuit-break resume after `anti-repetition/stopped` (≤2)
- anti-repetition v2 streaming detectors with bus event for soft resume
- Parameterized test suite: 25 mock + 5 integration + 11 static (41 total)
- Cross-platform install scripts under `install/` with idempotent `cordis.patch.yml` mount
- Example snippets: `examples/cordis-patch.snippet.yml`, `examples/settings-retry.snippet.yml`
- Bilingual README (Chinese primary + English summary)
