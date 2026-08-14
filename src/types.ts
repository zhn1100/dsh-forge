export const INDEX_FORMAT_VERSION = 1

export type KnowledgeKind =
  | 'document'
  | 'symbol'
  | 'package'
  | 'service'
  | 'event'
  | 'tool'
  | 'config'
  | 'source'
  | 'example'
  | 'test'

export interface KnowledgeSnapshot {
  formatVersion: number
  harnessCommit: string
  harnessVersion: string
  runtimePackageVersion: string
  documentationRevision: string
  indexBuildRevision: string
  sourceRoot: string
  repository: string
  generatedAt: string
}

export interface KnowledgeRecord {
  id: string
  kind: KnowledgeKind
  name: string
  title: string
  path: string
  line: number
  text: string
  packageName?: string
  ctxKey?: string
  tags: string[]
  related: string[]
}

export interface KnowledgeIndex {
  snapshot: KnowledgeSnapshot
  records: KnowledgeRecord[]
}

export interface KnowledgeHit {
  score: number
  kind: KnowledgeKind
  name: string
  title: string
  path: string
  line: number
  excerpt: string
  packageName?: string
  ctxKey?: string
}

export const EXPERIMENT_STATES = [
  'REQUEST',
  'CLASSIFY',
  'INSPECT',
  'RETRIEVE',
  'DESIGN',
  'PLAN_CHECK',
  'IMPLEMENT',
  'STATIC_VERIFY',
  'PROTOTYPE',
  'RUNTIME_VERIFY',
  'DIAGNOSE',
  'REVISE',
  'PROMOTE',
  'CLEAN_PROFILE_TEST',
  'DELIVER',
] as const

export type ExperimentState = typeof EXPERIMENT_STATES[number]

export interface DesignSpec {
  objective: string
  capability: string
  existingSeam: string
  scope: string
  lifecycleOwner: string
  effects: string[]
  inject: string[]
  events: string[]
  changesModelContext: boolean
  needsConfig: boolean
  needsClientHalf: boolean
  securityBoundary: string
  verification: string[]
  rollback: string
  references: string[]
}

export interface PackageRevision {
  packageId: string
  pluginId: string
  reason: string
  createdAt: string
  documentationReferences: string[]
  status: 'DEFINED' | 'RUNNING' | 'FAILED' | 'STOPPED' | 'ROLLED_BACK'
}

export interface VerificationRun {
  level: string
  passed: boolean
  summary: string
  createdAt: string
}

export interface RuntimeDiagnostic {
  state: string
  summary: string
  createdAt: string
}

export interface Experiment {
  id: string
  task: string
  state: ExperimentState
  createdAt: string
  updatedAt: string
  baseCommit: string
  profileRevision: string
  documentationRevision: string
  designSpec?: DesignSpec
  pluginId?: string
  packageRevisions: PackageRevision[]
  currentRevision?: string
  verificationRuns: VerificationRun[]
  runtimeDiagnostics: RuntimeDiagnostic[]
  promotionStatus: 'NONE' | 'SCAFFOLDED' | 'VERIFIED' | 'FAILED'
}

export interface CommandResult {
  command: string
  code: number
  durationMs: number
  output: string
}

export interface VerificationReport {
  level: string
  root: string
  passed: boolean
  startedAt: string
  finishedAt: string
  commands: CommandResult[]
  skipped: string[]
}

export interface PromotionSpec {
  packageName: string
  pluginName: string
  description: string
  destination: string
  source: string
  rowId: string
  inject?: string[]
}
