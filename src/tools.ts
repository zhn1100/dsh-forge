import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-system-prompt'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import type { Experiment, PackageRevision, PromotionSpec } from './types.js'

export const name = 'dsh-forge-tools'
export const inject = ['tools', 'forge', 'systemPrompt']

const FORGE_PROMPT = `You are operating the DSH Forge development environment. Follow this order for every Harness extension: create an experiment trace; read forge_snapshot; call cordis_inspect_list and then cordis_inspect_query for every Service, Event, Builtin, Tool schema, or Client slot you depend on; retrieve authoritative local references with forge_* queries; record a complete PluginDesignSpec before implementation; verify Fiber state explicitly (PENDING is not success); record every immutable dynamic Package revision and diagnostic; stop and rollback experiments when testing lifecycle cleanup; then promote successful behavior into a source-controlled TypeScript package and reproduce it in a clean Profile.

The dynamic Cordis runtime is a prototype plane, never a release artifact. Do not modify or unload the forge control Service, its knowledge index, experiment registry, verification policy, this preset, or the ordinary user DSH Home. Do not invent an API when local Reference or live Inspect has no match: report that it was not found. Do not enable an untrusted git dependency build script without explicit user approval.`

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function renderJson(_args: unknown, value: JsonValue): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

const jsonOutput = { schema: { type: 'json' as const }, render: renderJson }

function references(input?: string): string[] {
  if (!input?.trim()) return []
  if (input.trim().startsWith('[')) {
    const parsed = JSON.parse(input) as unknown
    if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) throw new Error('references must be a JSON string array')
    return parsed
  }
  return input.split(',').map(item => item.trim()).filter(Boolean)
}

function experimentSummary(experiment: Experiment): JsonValue {
  return asJson(experiment)
}

export function apply(ctx: Context): void {
  ctx.systemPrompt.section({ name: 'forge:development-discipline', order: 116, text: FORGE_PROMPT })
  ctx.tools.register(defineTool({
    name: 'forge_docs_search',
    description: 'Search the version-locked local DeepSeek Harness documentation/reference index. Use before relying on remembered APIs.',
    parameters: {
      query: { type: 'string', required: true, description: 'Terms, capability, or design question.' },
      limit: { type: 'integer', description: 'Maximum hits, 1-20.' },
    },
    output: jsonOutput,
    execute: async args => asJson(await ctx.forge.docsSearch(args.query, args.limit)),
    isConcurrencySafe: () => true,
  }))

  const exactTools = [
    ['forge_symbol', 'Find an exported TypeScript symbol in the locked Harness source.', 'name', (value: string) => ctx.forge.symbol(value)],
    ['forge_service', 'Find a Cordis Service by ctx key and its providers/API references.', 'ctxKey', (value: string) => ctx.forge.service(value)],
    ['forge_event', 'Find a Cordis event declaration and signature.', 'name', (value: string) => ctx.forge.event(value)],
    ['forge_tool', 'Find a model-facing Tool definition and schema source.', 'name', (value: string) => ctx.forge.tool(value)],
    ['forge_config', 'Find Config declarations for a Harness package.', 'packageName', (value: string) => ctx.forge.config(value)],
    ['forge_package', 'Find an npm package manifest in Harness.', 'name', (value: string) => ctx.forge.package(value)],
    ['forge_related', 'Find documents, symbols, implementations and tests related to a capability.', 'name', (value: string) => ctx.forge.related(value)],
    ['forge_source', 'Find authoritative source locations for an API or symbol.', 'name', (value: string) => ctx.forge.source(value)],
    ['forge_example', 'Find examples and tests for a capability.', 'capability', (value: string) => ctx.forge.example(value)],
  ] as const
  for (const [toolName, description, parameterName, query] of exactTools) {
    ctx.tools.register(defineTool({
      name: toolName,
      description,
      parameters: { [parameterName]: { type: 'string', required: true } },
      output: jsonOutput,
      execute: async args => asJson(await query(args[parameterName] as string)),
      isConcurrencySafe: () => true,
    }))
  }

  ctx.tools.register(defineTool({
    name: 'forge_snapshot',
    description: 'Read the exact Harness commit, version, documentation revision, source root and index build revision for this task.',
    parameters: {},
    output: jsonOutput,
    execute: async () => asJson(await ctx.forge.snapshot()),
    isConcurrencySafe: () => true,
  }))

  ctx.tools.register(defineTool({
    name: 'forge_experiment',
    description: 'Persist the Forge development state machine, PluginDesignSpec, immutable dynamic revisions, diagnostics and verification evidence.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['create', 'show', 'list', 'transition', 'design', 'revision', 'diagnostic', 'verification', 'promotion'],
      },
      id: { type: 'string', description: 'Experiment id; omitted only for create/list.' },
      task: { type: 'string', description: 'Task description for create.' },
      state: { type: 'string', description: 'Target task state, diagnostic Fiber state, or revision status.' },
      value: { type: 'string', description: 'Design JSON, diagnostic summary, verification summary, or promotion status.' },
      pluginId: { type: 'string', description: 'Stable dynamic Plugin id.' },
      packageId: { type: 'string', description: 'Immutable dynamic Package id.' },
      reason: { type: 'string', description: 'Why this revision exists.' },
      references: { type: 'string', description: 'JSON string array or comma-separated authoritative references.' },
      level: { type: 'string', description: 'Verification level.' },
      passed: { type: 'boolean', description: 'Verification outcome.' },
    },
    output: jsonOutput,
    async execute(args) {
      if (args.action === 'create') return experimentSummary(await ctx.forge.createExperiment(args.task ?? ''))
      if (args.action === 'list') return asJson(await ctx.forge.experiments.list())
      if (!args.id) throw new Error('id is required for this action')
      if (args.action === 'show') return experimentSummary(await ctx.forge.experiments.get(args.id))
      if (args.action === 'transition') return experimentSummary(await ctx.forge.experiments.transition(args.id, args.state ?? ''))
      if (args.action === 'design') return experimentSummary(await ctx.forge.experiments.setDesign(args.id, args.value ?? ''))
      if (args.action === 'diagnostic') return experimentSummary(await ctx.forge.experiments.addDiagnostic(args.id, args.state ?? 'UNKNOWN', args.value ?? ''))
      if (args.action === 'verification') {
        return experimentSummary(await ctx.forge.experiments.addVerification(args.id, args.level ?? 'unknown', args.passed ?? false, args.value ?? ''))
      }
      if (args.action === 'promotion') {
        const allowed = ['NONE', 'SCAFFOLDED', 'VERIFIED', 'FAILED'] as const
        if (!allowed.includes(args.value as typeof allowed[number])) throw new Error('Invalid promotion status')
        return experimentSummary(await ctx.forge.experiments.setPromotion(args.id, args.value as typeof allowed[number]))
      }
      const statuses = ['DEFINED', 'RUNNING', 'FAILED', 'STOPPED', 'ROLLED_BACK'] as const
      if (!args.pluginId || !args.packageId || !args.reason || !statuses.includes(args.state as PackageRevision['status'])) {
        throw new Error('revision requires pluginId, packageId, reason, and a valid state')
      }
      return experimentSummary(await ctx.forge.experiments.addRevision(args.id, {
        pluginId: args.pluginId,
        packageId: args.packageId,
        reason: args.reason,
        status: args.state as PackageRevision['status'],
        documentationReferences: references(args.references),
      }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'forge_verify',
    description: 'Run the bounded Forge verification gate in a workspace-contained package directory. Commands are selected from package scripts, never model-supplied.',
    parameters: {
      root: { type: 'string', required: true, description: 'Package directory inside the current workspace.' },
      level: { type: 'string', required: true, enum: ['quick', 'package', 'full'] },
    },
    output: jsonOutput,
    execute: async (args, exec) => asJson(await ctx.forge.verify(args.root, args.level, exec.signal)),
  }))

  ctx.tools.register(defineTool({
    name: 'forge_promote',
    description: 'Create a new formal TypeScript Harness bundle from a reviewed promotion spec. Refuses existing or out-of-workspace destinations.',
    parameters: {
      spec: { type: 'string', required: true, description: 'JSON PromotionSpec: packageName, pluginName, description, destination, source, rowId.' },
    },
    output: jsonOutput,
    async execute(args) {
      const parsed = JSON.parse(args.spec) as PromotionSpec
      return asJson(await ctx.forge.promote(parsed))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'forge_doctor',
    description: 'Check Forge Home isolation, knowledge index, profile, preset, and bundle installation.',
    parameters: {},
    output: jsonOutput,
    execute: async () => asJson(await ctx.forge.doctor()),
    isConcurrencySafe: () => true,
  }))
}
