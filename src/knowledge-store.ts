import { readFile, stat } from 'node:fs/promises'
import { forgeDataPath } from './paths.js'
import { INDEX_FORMAT_VERSION, type KnowledgeHit, type KnowledgeIndex, type KnowledgeKind, type KnowledgeRecord, type KnowledgeSnapshot } from './types.js'

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}_.:/@-]+/gu, ' ').trim()
}

function tokens(value: string): string[] {
  return normalize(value).split(/\s+/).filter(Boolean)
}

function excerpt(record: KnowledgeRecord, query: string): string {
  const flat = record.text.replace(/\s+/g, ' ').trim()
  const needle = normalize(query).split(' ')[0] ?? ''
  const index = needle ? normalize(flat).indexOf(needle) : -1
  const start = index < 0 ? 0 : Math.max(0, index - 180)
  const prefix = start > 0 ? '…' : ''
  const suffix = flat.length > start + 560 ? '…' : ''
  return `${prefix}${flat.slice(start, start + 560)}${suffix}`
}

function score(record: KnowledgeRecord, query: string, kinds?: readonly KnowledgeKind[]): number {
  if (kinds && !kinds.includes(record.kind)) return 0
  const normalizedQuery = normalize(query)
  if (!normalizedQuery) return 0
  const name = normalize(record.name)
  const title = normalize(record.title)
  const path = normalize(record.path)
  const body = normalize(record.text)
  let total = 0
  if (name === normalizedQuery) total += 140
  if (record.ctxKey && normalize(record.ctxKey) === normalizedQuery) total += 150
  if (title === normalizedQuery) total += 100
  if (name.includes(normalizedQuery)) total += 60
  if (title.includes(normalizedQuery)) total += 45
  if (path.includes(normalizedQuery)) total += 30
  if (body.includes(normalizedQuery)) total += 25
  for (const token of tokens(query)) {
    if (name.includes(token)) total += 18
    if (title.includes(token)) total += 12
    if (path.includes(token)) total += 7
    if (body.includes(token)) total += 3
    if (record.tags.some(tag => normalize(tag).includes(token))) total += 5
  }
  return total
}

function toHit(record: KnowledgeRecord, query: string, itemScore: number): KnowledgeHit {
  return {
    score: itemScore,
    kind: record.kind,
    name: record.name,
    title: record.title,
    path: record.path,
    line: record.line,
    excerpt: excerpt(record, query),
    ...(record.packageName === undefined ? {} : { packageName: record.packageName }),
    ...(record.ctxKey === undefined ? {} : { ctxKey: record.ctxKey }),
  }
}

export class KnowledgeStore {
  readonly indexPath: string
  private index?: KnowledgeIndex
  private mtimeMs = -1

  constructor(indexPath = forgeDataPath('knowledge-index.json')) {
    this.indexPath = indexPath
  }

  private async load(): Promise<KnowledgeIndex> {
    const metadata = await stat(this.indexPath).catch(() => undefined)
    if (!metadata) {
      throw new Error(`Forge knowledge index is missing at ${this.indexPath}. Run: dsh-forge sync`)
    }
    if (this.index && metadata.mtimeMs === this.mtimeMs) return this.index
    const parsed = JSON.parse(await readFile(this.indexPath, 'utf8')) as KnowledgeIndex
    if (parsed.snapshot?.formatVersion !== INDEX_FORMAT_VERSION || !Array.isArray(parsed.records)) {
      throw new Error(`Unsupported or invalid Forge knowledge index: ${this.indexPath}`)
    }
    this.index = parsed
    this.mtimeMs = metadata.mtimeMs
    return parsed
  }

  async snapshot(): Promise<KnowledgeSnapshot> {
    return (await this.load()).snapshot
  }

  async search(query: string, options: { kinds?: readonly KnowledgeKind[]; limit?: number } = {}): Promise<KnowledgeHit[]> {
    const index = await this.load()
    const limit = Math.min(20, Math.max(1, options.limit ?? 8))
    return index.records
      .map(item => ({ item, score: score(item, query, options.kinds) }))
      .filter(candidate => candidate.score > 0)
      .sort((left, right) => right.score - left.score || left.item.path.localeCompare(right.item.path) || left.item.line - right.item.line)
      .slice(0, limit)
      .map(candidate => toHit(candidate.item, query, candidate.score))
  }

  async exact(query: string, kinds: readonly KnowledgeKind[], limit = 8): Promise<KnowledgeHit[]> {
    const index = await this.load()
    const key = normalize(query)
    const exact = index.records.filter(item => kinds.includes(item.kind) && (
      normalize(item.name) === key
      || normalize(item.ctxKey ?? '') === key
      || normalize(item.packageName ?? '') === key
    ))
    if (exact.length > 0) return exact.slice(0, limit).map(item => toHit(item, query, 200))
    return this.search(query, { kinds, limit })
  }

  docsSearch(query: string, limit?: number): Promise<KnowledgeHit[]> {
    return this.search(query, { kinds: ['document', 'example', 'test'], ...(limit === undefined ? {} : { limit }) })
  }

  symbol(name: string): Promise<KnowledgeHit[]> {
    return this.exact(name, ['symbol'])
  }

  service(ctxKey: string): Promise<KnowledgeHit[]> {
    return this.exact(ctxKey, ['service'])
  }

  event(name: string): Promise<KnowledgeHit[]> {
    return this.exact(name, ['event'])
  }

  tool(name: string): Promise<KnowledgeHit[]> {
    return this.exact(name, ['tool'])
  }

  config(packageName: string): Promise<KnowledgeHit[]> {
    return this.exact(packageName, ['config'])
  }

  package(name: string): Promise<KnowledgeHit[]> {
    return this.exact(name, ['package'])
  }

  related(name: string): Promise<KnowledgeHit[]> {
    return this.search(name, { kinds: ['document', 'symbol', 'service', 'event', 'tool', 'config', 'example', 'test'], limit: 12 })
  }

  source(name: string): Promise<KnowledgeHit[]> {
    return this.search(name, { kinds: ['symbol', 'service', 'event', 'tool', 'config', 'source'], limit: 12 })
  }

  example(capability: string): Promise<KnowledgeHit[]> {
    return this.search(capability, { kinds: ['example', 'test', 'document'], limit: 12 })
  }
}
