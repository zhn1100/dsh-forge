---
name: forge-plugin-development
description: Develop, inspect, prototype, verify, and promote DeepSeek Harness Cordis plugins in DSH Forge.
---

# Forge plugin development

Use this workflow for every Harness/Cordis extension.

1. Create a trace with `forge_experiment(action:"create")` and advance it to `INSPECT`.
2. Read `forge_snapshot`. Never mix another checkout or documentation revision into the task.
3. Run `cordis_inspect_list`, then `cordis_inspect_query` for every Service, Event, Builtin, Tool, and Client slot the design may use.
4. Retrieve official documentation, symbols, packages, implementations, examples, and tests with the matching `forge_*` tools.
5. Record a `PluginDesignSpec` containing objective, capability kind, existing seam, scope, lifecycle owner, effects, injection, events, model-context impact, Config, Client half, security boundary, verification, rollback, and authoritative references.
6. Prototype only when plain JavaScript without imports/TypeScript/JSX is sufficient. Treat each `cordis_define` result as immutable and record its Plugin and Package ids.
7. Inspect runtime state after every run. `PENDING` and `FAILED` are not successful activation. Test stop, update, and rollback, and verify registrations disappear after stop.
8. Use `forge_promote` or normal source edits to create the formal TypeScript package. Dynamic source is evidence, not a deliverable.
9. Run `forge_verify` and reproduce in a new process and clean Forge Profile before `DELIVER`.

If the index and live runtime disagree, live Inspect wins for activation and the locked source wins for implementation details; record the mismatch in diagnostics instead of guessing.
