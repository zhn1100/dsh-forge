import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { forgeDataPath, safeSegment } from './paths.js'
import { EXPERIMENT_STATES, type DesignSpec, type Experiment, type ExperimentState, type PackageRevision } from './types.js'

const TRANSITIONS: Readonly<Record<ExperimentState, readonly ExperimentState[]>> = {
  REQUEST: ['CLASSIFY'],
  CLASSIFY: ['INSPECT'],
  INSPECT: ['RETRIEVE'],
  RETRIEVE: ['DESIGN'],
  DESIGN: ['PLAN_CHECK'],
  PLAN_CHECK: ['IMPLEMENT'],
  IMPLEMENT: ['STATIC_VERIFY'],
  STATIC_VERIFY: ['PROTOTYPE', 'DIAGNOSE'],
  PROTOTYPE: ['RUNTIME_VERIFY', 'DIAGNOSE'],
  RUNTIME_VERIFY: ['PROMOTE', 'DIAGNOSE', 'REVISE'],
  DIAGNOSE: ['REVISE'],
  REVISE: ['IMPLEMENT', 'PROTOTYPE', 'RUNTIME_VERIFY'],
  PROMOTE: ['CLEAN_PROFILE_TEST', 'DIAGNOSE'],
  CLEAN_PROFILE_TEST: ['DELIVER', 'DIAGNOSE'],
  DELIVER: [],
}

function validateDesignSpec(value: unknown): DesignSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('designSpec must be a JSON object')
  const candidate = value as Record<string, unknown>
  const strings = ['objective', 'capability', 'existingSeam', 'scope', 'lifecycleOwner', 'securityBoundary', 'rollback'] as const
  for (const key of strings) if (typeof candidate[key] !== 'string' || candidate[key].trim() === '') throw new Error(`designSpec.${key} is required`)
  const arrays = ['effects', 'inject', 'events', 'verification', 'references'] as const
  for (const key of arrays) if (!Array.isArray(candidate[key]) || !candidate[key].every(item => typeof item === 'string')) throw new Error(`designSpec.${key} must be a string array`)
  const booleans = ['changesModelContext', 'needsConfig', 'needsClientHalf'] as const
  for (const key of booleans) if (typeof candidate[key] !== 'boolean') throw new Error(`designSpec.${key} must be boolean`)
  return value as DesignSpec
}

export class ExperimentStore {
  readonly root: string

  constructor(root = forgeDataPath('experiments')) {
    this.root = root
  }

  private path(id: string): string {
    return join(this.root, `${safeSegment(id, 'experiment id')}.json`)
  }

  private async write(experiment: Experiment): Promise<void> {
    const path = this.path(experiment.id)
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(experiment, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
  }

  async create(task: string, snapshot: { harnessCommit: string; documentationRevision: string }, profileRevision = 'forge'): Promise<Experiment> {
    const timestamp = new Date().toISOString()
    const experiment: Experiment = {
      id: `exp-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      task: task.trim(),
      state: 'REQUEST',
      createdAt: timestamp,
      updatedAt: timestamp,
      baseCommit: snapshot.harnessCommit,
      profileRevision,
      documentationRevision: snapshot.documentationRevision,
      packageRevisions: [],
      verificationRuns: [],
      runtimeDiagnostics: [],
      promotionStatus: 'NONE',
    }
    if (!experiment.task) throw new Error('task is required')
    await this.write(experiment)
    return experiment
  }

  async get(id: string): Promise<Experiment> {
    return JSON.parse(await readFile(this.path(id), 'utf8')) as Experiment
  }

  async list(): Promise<Experiment[]> {
    const names = await readdir(this.root).catch(() => [])
    const experiments: Experiment[] = []
    for (const name of names.filter(item => /^exp-[a-z0-9-]+\.json$/i.test(item))) {
      try {
        experiments.push(JSON.parse(await readFile(join(this.root, name), 'utf8')) as Experiment)
      } catch {
        // A corrupt trace must not hide healthy traces. Doctor reports the file.
      }
    }
    return experiments.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async transition(id: string, state: string): Promise<Experiment> {
    if (!EXPERIMENT_STATES.includes(state as ExperimentState)) throw new Error(`Unknown experiment state: ${state}`)
    const experiment = await this.get(id)
    const target = state as ExperimentState
    if (!TRANSITIONS[experiment.state].includes(target)) {
      throw new Error(`Invalid transition ${experiment.state} -> ${target}`)
    }
    experiment.state = target
    experiment.updatedAt = new Date().toISOString()
    await this.write(experiment)
    return experiment
  }

  async setDesign(id: string, input: string): Promise<Experiment> {
    const experiment = await this.get(id)
    experiment.designSpec = validateDesignSpec(JSON.parse(input) as unknown)
    experiment.updatedAt = new Date().toISOString()
    await this.write(experiment)
    return experiment
  }

  async addRevision(id: string, revision: Omit<PackageRevision, 'createdAt'>): Promise<Experiment> {
    const experiment = await this.get(id)
    if (experiment.packageRevisions.some(item => item.packageId === revision.packageId)) {
      throw new Error(`Package revision already recorded: ${revision.packageId}`)
    }
    experiment.pluginId ??= revision.pluginId
    if (experiment.pluginId !== revision.pluginId) throw new Error('A Forge experiment tracks exactly one dynamic Plugin id')
    experiment.packageRevisions.push({ ...revision, createdAt: new Date().toISOString() })
    if (revision.status === 'RUNNING' || revision.status === 'ROLLED_BACK') experiment.currentRevision = revision.packageId
    experiment.updatedAt = new Date().toISOString()
    await this.write(experiment)
    return experiment
  }

  async addDiagnostic(id: string, state: string, summary: string): Promise<Experiment> {
    const experiment = await this.get(id)
    experiment.runtimeDiagnostics.push({ state, summary, createdAt: new Date().toISOString() })
    experiment.updatedAt = new Date().toISOString()
    await this.write(experiment)
    return experiment
  }

  async addVerification(id: string, level: string, passed: boolean, summary: string): Promise<Experiment> {
    const experiment = await this.get(id)
    experiment.verificationRuns.push({ level, passed, summary, createdAt: new Date().toISOString() })
    experiment.updatedAt = new Date().toISOString()
    await this.write(experiment)
    return experiment
  }

  async setPromotion(id: string, status: Experiment['promotionStatus']): Promise<Experiment> {
    const experiment = await this.get(id)
    experiment.promotionStatus = status
    experiment.updatedAt = new Date().toISOString()
    await this.write(experiment)
    return experiment
  }
}
