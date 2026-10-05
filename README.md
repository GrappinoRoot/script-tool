# @script-flow/procedural-memory

Procedural memory for LLM agents: it records the tasks your agent has solved, compiles them into **executable scripts**, and replays them on the next matching request.

You pay for the reasoning once. Every run after that is deterministic code.

```
USER REQUEST
      │
 intent + parameters
      │
 ┌────┴─────┐
 │ REGISTRY │
 └────┬─────┘
   ┌──┴──┐
MATCH    NO MATCH
   │          │
SCRIPT      AGENT → success check → compile → REGISTRY
   │          │
   └────┬─────┘
      RESULT
```

## Install

```bash
npm install @script-flow/procedural-memory
```

Node >= 20, no dependencies. The package is **ESM-only**: from CommonJS, reach it with
`const { createProceduralMemory } = await import("@script-flow/procedural-memory")`.
TypeScript declarations are included.

## What it does (and what it does not)

The library knows **neither your tools nor your model**: you pass `chat` and `callTool`, and they stay yours. As a result, whatever you enforce around tools — permissions, confirmations, rate limits, auditing — still applies when the caller is a compiled skill.


Licensed under MIT.
