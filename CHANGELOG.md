# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-10-05

### Added

- `isMutation` now also receives the step's arguments: `(tool, args) => boolean`. With a
  generic tool — a `restCall`, an `execute` — it is the arguments that say whether anything
  was written, not the tool's name. Existing one-parameter implementations are unaffected.

## [0.2.0] - 2026-10-05

Two guards on what gets learned, both found in real use: a registry can be corrupted
silently, and a corrupted registry runs instead of the agent.

### Added

- `verify` option on `createProceduralMemory`: the last word on whether a run may become a
  skill, called before compiling with `{ intent, steps, skill }`. Unset, nothing changes.
  A verifier that throws refuses the run rather than letting it through.
- `mutationVerifier({ isMutation })`, exported ready-made for the common case: an intent
  starting with a mutation verb (`create`, `update`, `delete`, `remove`, `add`, `set`,
  `send`, `assign`) whose successful steps ran no mutating tool is refused. An agent that
  queries, reads a schema and then asks the user for the missing first name has not created
  the contact, but the structural check alone cannot see that.
- `impliesMutation()` and `MUTATION_VERBS` for inspecting or extending the verb list.

### Changed

- `learn()` no longer replaces a registered skill with a procedure that uses a different set
  of tools. Replacement stays allowed when the tool set is identical — that is a repair,
  because the environment moved — but a different tool set means another task landed under
  the same intent, and the working procedure is kept. `saveSkill()` is unchanged: calling it
  directly is still an explicit choice.

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
