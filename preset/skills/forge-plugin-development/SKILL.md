---
name: forge-plugin-development
description: Develop, inspect, prototype, verify, and promote DeepSeek Harness Cordis plugins in DSH Forge.
---

# Forge plugin development

Use this workflow for every Harness/Cordis extension.

Experiment state machine (advance exactly one step per `forge_experiment transition`; every create/transition/show result lists `nextStates`):

```
REQUEST → CLASSIFY → INSPECT → RETRIEVE → DESIGN → PLAN_CHECK → IMPLEMENT
→ STATIC_VERIFY → PROTOTYPE → RUNTIME_VERIFY → PROMOTE → CLEAN_PROFILE_TEST → DELIVER
   │          │           │            │              │              │
   └──────────┴─── DIAGNOSE → REVISE ──┴──────────────┴──────────────┘
```

1. Create a trace with `forge_experiment(action:"create")`, then advance it to `CLASSIFY`, then `INSPECT`.
2. Read `forge_snapshot`. Never mix another checkout or documentation revision into the task.
3. Run `cordis_inspect_list`, then `cordis_inspect_query` for every Service, Event, Builtin, Tool, and Client slot the design may use.
4. Retrieve official documentation, symbols, packages, implementations, examples, and tests with the matching `forge_*` tools.
5. Record a `PluginDesignSpec` containing objective, capability kind, existing seam, scope, lifecycle owner, effects, injection, events, model-context impact, Config, Client half, security boundary, verification, rollback, and authoritative references. Submit the complete 15-field object in one call: the validator rejects every missing or invalid field in a single error.
6. Prototype only when plain JavaScript without imports/TypeScript/JSX is sufficient. Treat each `cordis_define` result as immutable and record its Plugin and Package ids.
7. Inspect runtime state after every run. `PENDING` and `FAILED` are not successful activation. Test stop, update, and rollback, and verify registrations disappear after stop.
8. Use `forge_promote` or normal source edits to create the formal TypeScript package. Dynamic source is evidence, not a deliverable.
9. Run `forge_verify` and reproduce in a new process and clean Forge Profile before `DELIVER`.
10. Close the trace: advance the experiment through the remaining states to `DELIVER` even when promotion is not applicable (leave `promotionStatus` as NONE). A trace that stops at `PROTOTYPE` is not closed.

Revisions are immutable evidence: each dynamic Package id is recorded exactly once (a second `revision` call for the same id is rejected); later states of that package go into `diagnostic`. Recording with `RUNNING` or `ROLLED_BACK` implicitly marks the revision current.

## Hard-won platform facts

- **Client evaluator traps**: the dynamic client half is evaluated in a sandbox where the globals `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `fetch`, and `require` throw. Timers are a Service: declare `inject: ['timer']` and use `ctx.timer.timeout` / `ctx.timer.interval` (both return disposers). React is available as a closure symbol, not an import.
- **`ctx.effect(fn)` runs `fn` immediately**; the function's *return value* is the disposer. Registering a listener inside the effect body without returning its removal (`ctx.effect(() => () => removeListener(...))`) unregisters it instantly.
- **No Node/browser habits**: verify every global (`document`, `window`, `fetch`, timers) against the live Builtin/Service catalog before relying on it. Unverified assumptions here are the top cause of "works in the stub, dead in the real app".
- **Real CSS/DOM beats stubs**: copy the actual product CSS and DOM facts (e.g. `position: fixed` vs `absolute`) from the installed packages under the harness `node_modules`; a stub that encodes your wrong guess will pass green forever. Add static guards (no bare timer identifiers in client source) and regression cases with the real values.
- **When a `forge_*` or `cordis_*` call rejects** for missing fields or unknown state values, read the installed implementation (`~/.dsh-forge/profiles/forge/node_modules/dsh-forge/lib/experiment-store.js` and `tools.js`) before retrying. Never iterate by guessing one field per attempt.
- **Evidence layering**: stub/smoke tests are `static` or `package` evidence (PROTOTYPE level). `RUNTIME_VERIFY` requires genuine end-user interaction evidence in the real running app.
- **One source of truth**: if the dynamic package is mirrored for smoke tests and re-typed for promotion, generate the mirror from the package source instead of maintaining three copies by hand.
- **"Mechanism A is equivalent to mechanism B" must be verified in official source first**; also confirm the mechanism is *open to third-party packages*, not merely that it exists. Check the official README's "Known Limitations / Deferred Work" section for walls the maintainers admit to.
- **The only fork-free writable-config channel for third-party plugins is the credentials domain** (`api.credentials.describe/set/unset`); settings namespaces are host-allowlisted, not plugin-declared.
- **Self-declared minimal interfaces type-check but lie**: the wire shape of client RPC calls must be copied verbatim from an official call site of the same feature, not inferred from your own interface.
- **Client bundle contract**: factory returns `{ inject(services), apply }`; only modules on the module table can be required (cross-package value imports are build errors); draw your own chrome and wait for injected services. Scanning metadata is cached by name forever (add/remove a client needs a restart) but bundle content is served no-cache from disk (a page refresh picks it up).
- **Two diagnosability contracts**: web boot is fail-loud (any non-ACTIVE entry freezes the UI with a list), while a crashing slot entry is silent — the row disappears and only the console shows `slot entry crashed in '<slot>': <error>`. UI loads ⇒ your entry activated; your UI is missing ⇒ check that console line.
- **A client half must pass a real browser**: serving the bundle is not the same as it being usable. Delivery standard: headless Chrome + CDP, zero console errors, target DOM present. Keep the browser-verification drivers and profile in the workspace `.dev/` (scratch directories are wiped), prefer `ps aux | grep '[x]xx'` over `pkill -f` self-matches, and use Node ≥22's built-in WebSocket/fetch instead of puppeteer.

If the index and live runtime disagree, live Inspect wins for activation and the locked source wins for implementation details; record the mismatch in diagnostics instead of guessing.
