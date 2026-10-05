# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-05

First release.

### Added

- `createProceduralMemory({ root, chat })` — records a successful agent run, compiles it
  into an executable skill and replays it on the next matching request.
- `handle()` for the whole flow in one call, and `instrument()` to record a run without
  touching your agent loop.
- Deterministic compiler: no model-written code. Request parameters become `{{placeholders}}`,
  values flowing between steps become `{"$from": …}` references.
- Safety rules: a run that did not succeed, an opaque identifier that would be baked into the
  script, or an unused parameter all prevent a skill from being registered. Failed steps that
  the agent later corrected are dropped.
- Pluggable identifier recognition (`identifiers`), domain hint and examples for the
  classification prompt, usage metrics in the registry.
- TypeScript declarations.
