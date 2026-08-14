import { createHash } from 'node:crypto'
import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { INDEX_FORMAT_VERSION, type KnowledgeIndex, type KnowledgeKind, type KnowledgeRecord } from './types.js'

const REPOSITORY = 'https://github.com/deepseek-ai/deepseek-harness.git'
const TEXT_LIMIT = 12_000

async function walk(root: string, current = root): Promise<string[]> {
  const result: string[] = []
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'dist') continue
    const path = join(current, entry.name)
    if (entry.isDirectory()) result.push(...await walk(root, path))
    else result.push(path)
  }
  return result
}

function lineAt(text: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset; index += 1) if (text.charCodeAt(index) === 10) line += 1
  return line
}

function idFor(kind: KnowledgeKind, path: string, line: number, name: string): string {
  return createHash('sha1').update(`${kind}\0${path}\0${line}\0${name}`).digest('hex').slice(0, 16)
}

function packageFromPath(path: string): string | undefined {
  const parts = path.split('/')
  const packageIndex = parts.indexOf('packages')
  if (packageIndex >= 0 && parts.length > packageIndex + 2) return parts.slice(packageIndex + 1, packageIndex + 3).join('/')
  const appIndex = parts.indexOf('apps')
  if (appIndex >= 0 && parts[appIndex + 1]) return `apps/${parts[appIndex + 1]}`
  return undefined
}

function packageExtra(path: string): { packageName?: string } {
  const packageName = packageFromPath(path)
  return packageName === undefined ? {} : { packageName }
}

function record(
  kind: KnowledgeKind,
  name: string,
  title: string,
  path: string,
  line: number,
  text: string,
  extras: Partial<Pick<KnowledgeRecord, 'packageName' | 'ctxKey' | 'tags' | 'related'>> = {},
): KnowledgeRecord {
  return {
    id: idFor(kind, path, line, name),
    kind,
    name,
    title,
    path,
    line,
    text: text.slice(0, TEXT_LIMIT),
    tags: extras.tags ?? [],
    related: extras.related ?? [],
    ...(extras.packageName === undefined ? {} : { packageName: extras.packageName }),
    ...(extras.ctxKey === undefined ? {} : { ctxKey: extras.ctxKey }),
  }
}

function markdownRecords(path: string, text: string): KnowledgeRecord[] {
  const records: KnowledgeRecord[] = []
  const lines = text.split(/\r?\n/)
  const headings: Array<{ line: number; level: number; title: string }> = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,4})\s+(.+?)\s*$/.exec(lines[index] ?? '')
    if (match) headings.push({ line: index + 1, level: match[1]?.length ?? 1, title: match[2] ?? '' })
  }
  if (headings.length === 0) {
    records.push(record('document', basename(path), basename(path), path, 1, text, {
      ...packageExtra(path),
      tags: ['markdown'],
    }))
    return records
  }
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]
    if (!heading) continue
    const next = headings.slice(index + 1).find(candidate => candidate.level <= heading.level)
    const end = next ? next.line - 1 : lines.length
    const body = lines.slice(heading.line - 1, end).join('\n')
    records.push(record('document', heading.title, heading.title, path, heading.line, body, {
      ...packageExtra(path),
      tags: ['markdown', `h${heading.level}`],
    }))
  }
  return records
}

function blockMatches(text: string, marker: RegExp): Array<{ text: string; offset: number }> {
  const blocks: Array<{ text: string; offset: number }> = []
  for (const match of text.matchAll(marker)) {
    const start = match.index ?? 0
    const open = text.indexOf('{', start)
    if (open < 0) continue
    let depth = 0
    for (let index = open; index < text.length; index += 1) {
      const character = text[index]
      if (character === '{') depth += 1
      if (character === '}') depth -= 1
      if (depth === 0) {
        blocks.push({ text: text.slice(start, index + 1), offset: start })
        break
      }
    }
  }
  return blocks
}

function typescriptRecords(path: string, text: string): KnowledgeRecord[] {
  const records: KnowledgeRecord[] = []
  const packageName = packageFromPath(path)
  const symbolPattern = /\bexport\s+(?:declare\s+)?(?:abstract\s+)?(class|interface|function|const|type|enum)\s+([A-Za-z_$][\w$]*)/g
  for (const match of text.matchAll(symbolPattern)) {
    const name = match[2]
    if (!name) continue
    const line = lineAt(text, match.index ?? 0)
    records.push(record('symbol', name, `${match[1]} ${name}`, path, line, text.slice(match.index ?? 0, (match.index ?? 0) + 1800), {
      ...(packageName === undefined ? {} : { packageName }),
      tags: ['typescript', match[1] ?? 'export'],
    }))
  }

  for (const block of blockMatches(text, /interface\s+Context\s*{/g)) {
    const propertyPattern = /\b([A-Za-z_$][\w$]*)\??:\s*([^;}\n]+)/g
    for (const match of block.text.matchAll(propertyPattern)) {
      const ctxKey = match[1]
      if (!ctxKey) continue
      const line = lineAt(text, block.offset + (match.index ?? 0))
      records.push(record('service', ctxKey, `ctx.${ctxKey}: ${match[2]?.trim() ?? ''}`, path, line, match[0], {
        ...(packageName === undefined ? {} : { packageName }),
        ctxKey,
        tags: ['context', 'service'],
      }))
    }
  }

  for (const block of blockMatches(text, /interface\s+Events\s*{/g)) {
    const eventPattern = /['"]([^'"]+)['"]\s*\(/g
    for (const match of block.text.matchAll(eventPattern)) {
      const name = match[1]
      if (!name) continue
      const line = lineAt(text, block.offset + (match.index ?? 0))
      records.push(record('event', name, name, path, line, block.text.slice(match.index ?? 0, (match.index ?? 0) + 600), {
        ...(packageName === undefined ? {} : { packageName }),
        tags: ['event'],
      }))
    }
  }

  const toolPattern = /defineTool\s*\(\s*{[\s\S]{0,500}?\bname:\s*['"]([^'"]+)['"]/g
  for (const match of text.matchAll(toolPattern)) {
    const name = match[1]
    if (!name) continue
    const line = lineAt(text, match.index ?? 0)
    records.push(record('tool', name, name, path, line, text.slice(match.index ?? 0, (match.index ?? 0) + 2200), {
      ...(packageName === undefined ? {} : { packageName }),
      tags: ['tool', 'defineTool'],
    }))
  }

  const servicePattern = /class\s+([A-Za-z_$][\w$]*)\s+extends\s+Service[\s\S]{0,1600}?super\s*\(\s*ctx\s*,\s*['"]([^'"]+)['"]\s*\)/g
  for (const match of text.matchAll(servicePattern)) {
    const className = match[1]
    const ctxKey = match[2]
    if (!className || !ctxKey) continue
    const line = lineAt(text, match.index ?? 0)
    records.push(record('service', ctxKey, `${className} provides ctx.${ctxKey}`, path, line, match[0], {
      ...(packageName === undefined ? {} : { packageName }),
      ctxKey,
      tags: ['service-provider', className],
      related: [className],
    }))
  }

  const configPattern = /export\s+interface\s+Config\s*{/g
  for (const match of text.matchAll(configPattern)) {
    const line = lineAt(text, match.index ?? 0)
    records.push(record('config', packageName ?? path, `Config for ${packageName ?? path}`, path, line, text.slice(match.index ?? 0, (match.index ?? 0) + 2600), {
      ...(packageName === undefined ? {} : { packageName }),
      tags: ['config', 'typescript'],
    }))
  }
  return records
}

async function packageRecord(path: string, text: string): Promise<KnowledgeRecord | undefined> {
  try {
    const manifest = JSON.parse(text) as { name?: unknown; description?: unknown; version?: unknown }
    if (typeof manifest.name !== 'string') return undefined
    return record('package', manifest.name, manifest.name, path, 1, JSON.stringify(manifest, null, 2), {
      packageName: manifest.name,
      tags: ['package', typeof manifest.version === 'string' ? manifest.version : 'unknown-version'],
    })
  } catch {
    return undefined
  }
}

function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'git command failed').trim())
  return result.stdout.trim()
}

export async function buildKnowledgeIndex(sourceRoot: string, runtimePackageVersion?: string): Promise<KnowledgeIndex> {
  const root = resolve(sourceRoot)
  const rootStat = await stat(root)
  if (!rootStat.isDirectory()) throw new Error(`Harness source is not a directory: ${root}`)
  const files = await walk(root)
  const records: KnowledgeRecord[] = []
  for (const absolute of files) {
    const path = relative(root, absolute).split(sep).join('/')
    const isMarkdown = path.endsWith('.md') && (path.startsWith('docs/') || path.endsWith('/README.md') || path === 'README.md')
    const isTypeScript = /\.(?:ts|tsx)$/.test(path) && !path.endsWith('.d.ts')
    const isPackage = path.endsWith('package.json')
    const isExample = path.startsWith('examples/')
    const isTest = /(?:^|\/)(?:tests?|__tests__)(?:\/|$)/.test(path)
    if (!isMarkdown && !isTypeScript && !isPackage && !isExample && !isTest) continue
    const text = await readFile(absolute, 'utf8').catch(() => '')
    if (isMarkdown) records.push(...markdownRecords(path, text))
    if (isTypeScript) records.push(...typescriptRecords(path, text))
    if (isPackage) {
      const item = await packageRecord(path, text)
      if (item) records.push(item)
    }
    if (isExample) records.push(record('example', basename(path), path, path, 1, text.slice(0, 3000), {
      ...packageExtra(path),
      tags: ['example'],
    }))
    if (isTest) records.push(record('test', basename(path), path, path, 1, text.slice(0, 3000), {
      ...packageExtra(path),
      tags: ['test'],
    }))
  }

  const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version?: string }
  const commit = git(root, ['rev-parse', 'HEAD'])
  const indexBuildRevision = createHash('sha256')
    .update(`${commit}\0${records.map(item => item.id).join('\0')}`)
    .digest('hex')
  return {
    snapshot: {
      formatVersion: INDEX_FORMAT_VERSION,
      harnessCommit: commit,
      harnessVersion: rootManifest.version ?? 'unknown',
      runtimePackageVersion: runtimePackageVersion ?? rootManifest.version ?? 'unknown',
      documentationRevision: commit,
      indexBuildRevision,
      sourceRoot: root,
      repository: REPOSITORY,
      generatedAt: new Date().toISOString(),
    },
    records,
  }
}

export async function writeKnowledgeIndex(index: KnowledgeIndex, output: string): Promise<void> {
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(index)}\n`, { encoding: 'utf8', mode: 0o600 })
}

export async function cloneHarnessSource(destination: string, revision = 'HEAD'): Promise<string> {
  await mkdir(dirname(destination), { recursive: true })
  try {
    await stat(join(destination, '.git'))
  } catch {
    const clone = spawnSync('git', ['clone', '--filter=blob:none', REPOSITORY, destination], { encoding: 'utf8' })
    if (clone.status !== 0) throw new Error((clone.stderr || clone.stdout || 'git clone failed').trim())
  }
  const fetch = spawnSync('git', ['-C', destination, 'fetch', '--prune', 'origin'], { encoding: 'utf8' })
  if (fetch.status !== 0) throw new Error((fetch.stderr || fetch.stdout || 'git fetch failed').trim())
  const resolved = git(destination, ['rev-parse', revision])
  const checkout = spawnSync('git', ['-C', destination, 'checkout', '--detach', resolved], { encoding: 'utf8' })
  if (checkout.status !== 0) throw new Error((checkout.stderr || checkout.stdout || 'git checkout failed').trim())
  return resolved
}
