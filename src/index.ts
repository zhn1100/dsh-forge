import { lstat, stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { TOOL_RUNTIME_SCHEDULER } from '@deepseek-ai/dsh-tools'
import { ExperimentStore } from './experiment-store.js'
import { KnowledgeStore } from './knowledge-store.js'
import { forgeDataPath, forgeHome } from './paths.js'
import { promotePackage } from './promoter.js'
import type { Experiment, KnowledgeHit, KnowledgeKind, KnowledgeSnapshot, PromotionSpec, VerificationReport } from './types.js'
import { verifyProject } from './verifier.js'
import { syncOrdinaryHome, type HomeSyncReport } from './home-sync.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    forge: ForgeControlService
  }
}

export interface ForgeDoctorReport {
  ok: boolean
  home: string
  checks: Array<{ name: string; ok: boolean; detail: string }>
}

export default class ForgeControlService extends Service {
  static inject = ['tools']

  readonly knowledge: KnowledgeStore
  readonly experiments: ExperimentStore
  readonly workspaceRoot: string
  homeSync?: HomeSyncReport

  constructor(ctx: Context) {
    super(ctx, 'forge')
    this.knowledge = new KnowledgeStore()
    this.experiments = new ExperimentStore()
    this.workspaceRoot = process.cwd()
  }

  protected async [Service.init](): Promise<void> {
    if (this.ctx.tools[TOOL_RUNTIME_SCHEDULER] === undefined) {
      throw new Error('Forge resolved a different @deepseek-ai/dsh-tools runtime than the host; reinstall the Forge profile to remove the shadow copy')
    }
    this.homeSync = await syncOrdinaryHome()
    if (this.homeSync.conflicts.length > 0) {
      this.ctx.logger.warn(`Forge Home sync preserved ${this.homeSync.conflicts.length} locally modified path(s); see ${this.homeSync.manifestPath}`)
    }
    for (const error of this.homeSync.errors) this.ctx.logger.warn(error)
  }

  snapshot(): Promise<KnowledgeSnapshot> {
    return this.knowledge.snapshot()
  }

  search(query: string, kinds?: readonly KnowledgeKind[], limit?: number): Promise<KnowledgeHit[]> {
    return this.knowledge.search(query, {
      ...(kinds === undefined ? {} : { kinds }),
      ...(limit === undefined ? {} : { limit }),
    })
  }

  docsSearch(query: string, limit?: number): Promise<KnowledgeHit[]> { return this.knowledge.docsSearch(query, limit) }
  symbol(name: string): Promise<KnowledgeHit[]> { return this.knowledge.symbol(name) }
  service(ctxKey: string): Promise<KnowledgeHit[]> { return this.knowledge.service(ctxKey) }
  event(name: string): Promise<KnowledgeHit[]> { return this.knowledge.event(name) }
  tool(name: string): Promise<KnowledgeHit[]> { return this.knowledge.tool(name) }
  config(packageName: string): Promise<KnowledgeHit[]> { return this.knowledge.config(packageName) }
  package(name: string): Promise<KnowledgeHit[]> { return this.knowledge.package(name) }
  related(name: string): Promise<KnowledgeHit[]> { return this.knowledge.related(name) }
  source(name: string): Promise<KnowledgeHit[]> { return this.knowledge.source(name) }
  example(capability: string): Promise<KnowledgeHit[]> { return this.knowledge.example(capability) }

  async createExperiment(task: string): Promise<Experiment> {
    const snapshot = await this.snapshot()
    return this.experiments.create(task, snapshot)
  }

  verify(root: string, level: 'quick' | 'package' | 'full', signal?: AbortSignal): Promise<VerificationReport> {
    return verifyProject(this.workspaceRoot, root, level, signal)
  }

  promote(spec: PromotionSpec): Promise<{ destination: string; files: string[] }> {
    return promotePackage(this.workspaceRoot, spec)
  }

  async doctor(): Promise<ForgeDoctorReport> {
    const home = forgeHome()
    const checks: ForgeDoctorReport['checks'] = []
    const checkFile = async (name: string, path: string): Promise<void> => {
      const metadata = await stat(path).catch(() => undefined)
      checks.push({ name, ok: Boolean(metadata), detail: metadata ? path : `missing: ${path}` })
    }
    checks.push({
      name: 'isolated-home',
      ok: home !== join(process.env.HOME ?? '', '.dsh'),
      detail: home,
    })
    checks.push({
      name: 'home-sync',
      ok: this.homeSync !== undefined && this.homeSync.errors.length === 0,
      detail: this.homeSync === undefined
        ? 'startup synchronization has not completed'
        : `${this.homeSync.status}; copied=${this.homeSync.copied}, updated=${this.homeSync.updated}, preserved=${this.homeSync.preserved}`,
    })
    checks.push({
      name: 'tool-runtime-identity',
      ok: this.ctx.tools[TOOL_RUNTIME_SCHEDULER] !== undefined,
      detail: this.ctx.tools[TOOL_RUNTIME_SCHEDULER] === undefined ? 'scheduler symbol mismatch' : 'host scheduler identity matches',
    })
    await checkFile('knowledge-index', forgeDataPath('knowledge-index.json'))
    await checkFile('forge-profile', join(home, 'profiles', 'forge', 'package.json'))
    await checkFile('developer-preset', join(home, '.agent-presets', 'cordis-developer', 'agent.cordis.yml'))
    const profileManifest = await readFile(join(home, 'profiles', 'forge', 'package.json'), 'utf8').then(
      value => JSON.parse(value) as { dsh?: { profile?: { bundles?: string[] } } },
      () => undefined,
    )
    const bundles = profileManifest?.dsh?.profile?.bundles ?? []
    checks.push({
      name: 'forge-bundle',
      ok: bundles.includes('dsh-forge'),
      detail: bundles.join(', ') || 'no bundles found',
    })
    const forgeDependency = profileManifest && (JSON.parse(await readFile(join(home, 'profiles', 'forge', 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }).dependencies?.['dsh-forge']
    const installedMetadata = await lstat(join(home, 'profiles', 'forge', 'node_modules', 'dsh-forge')).catch(() => undefined)
    checks.push({
      name: 'artifact-install',
      ok: forgeDependency?.startsWith('file:') === true && installedMetadata?.isDirectory() === true,
      detail: `${forgeDependency ?? 'missing dependency'}; ${installedMetadata?.isSymbolicLink() ? 'workspace symlink' : 'package directory'}`,
    })
    return { ok: checks.every(item => item.ok), home, checks }
  }
}

export const name = 'dsh-forge-control'
