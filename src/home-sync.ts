import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { forgeHome } from './paths.js'

const MANIFEST_VERSION = 1
const PROTECTED_ROOTS = new Set(['forge', 'profiles', '.agent-presets', 'cordis.patch.yml'])
const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

interface SyncManifestEntry {
  sourceHash: string
  destinationHash: string
  synchronizedAt: string
}

interface SyncManifest {
  version: number
  sourceRoot: string
  destinationRoot: string
  entries: Record<string, SyncManifestEntry>
}

export interface HomeSyncPluginReport {
  copied: number
  updated: number
  preserved: number
  skipped: number
  registered: string[]
}

export interface HomeSyncReport {
  sourceRoot: string
  destinationRoot: string
  manifestPath: string
  status: 'synchronized' | 'source-missing'
  copied: number
  updated: number
  unchanged: number
  preserved: number
  retainedAfterSourceDeletion: number
  skipped: number
  conflicts: string[]
  errors: string[]
  plugins: HomeSyncPluginReport
  completedAt: string
}

interface OutOfTreePlugin {
  id: string
  name: string
}

export function ordinaryDshHome(): string {
  return resolve(process.env.DSH_FORGE_SOURCE_HOME?.trim() || join(homedir(), '.dsh'))
}

function digest(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function isProtected(relativePath: string): boolean {
  const root = relativePath.split(sep)[0]
  return root !== undefined && PROTECTED_ROOTS.has(root)
}

async function atomicWrite(path: string, data: Buffer | string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.sync-${process.pid}-${randomUUID()}`
  try {
    await writeFile(temporary, data, { mode })
    await rename(temporary, path)
    await chmod(path, mode)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function loadManifest(path: string, sourceRoot: string, destinationRoot: string): Promise<{ manifest: SyncManifest; error?: string }> {
  const empty: SyncManifest = { version: MANIFEST_VERSION, sourceRoot, destinationRoot, entries: {} }
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<SyncManifest>
    if (value.version !== MANIFEST_VERSION || value.sourceRoot !== sourceRoot || value.destinationRoot !== destinationRoot || typeof value.entries !== 'object' || value.entries === null) {
      return { manifest: empty, error: 'Home sync manifest has incompatible identity or format; existing destination files were preserved.' }
    }
    return { manifest: value as SyncManifest }
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    return missing ? { manifest: empty } : { manifest: empty, error: `Cannot read home sync manifest: ${String(error)}` }
  }
}

/**
 * Merge the ordinary DSH Home into the Forge Home without deleting anything.
 * A destination file is updated only while it still matches the last version
 * written by this synchronizer. Local Forge edits always win.
 */
export async function syncOrdinaryHome(
  sourceRoot = ordinaryDshHome(),
  destinationRoot = forgeHome(),
): Promise<HomeSyncReport> {
  const source = resolve(sourceRoot)
  const destination = resolve(destinationRoot)
  if (source === destination) throw new Error('Home sync source and destination must be different')

  const manifestPath = join(destination, 'forge', 'home-sync-manifest.json')
  const destinationMetadata = await lstat(destination).catch(() => undefined)
  if (destinationMetadata?.isSymbolicLink() === true || (destinationMetadata !== undefined && !destinationMetadata.isDirectory())) {
    throw new Error(`Home sync destination must be a real directory: ${destination}`)
  }
  await mkdir(destination, { recursive: true, mode: 0o700 })
  const loaded = await loadManifest(manifestPath, source, destination)
  const report: HomeSyncReport = {
    sourceRoot: source,
    destinationRoot: destination,
    manifestPath,
    status: 'synchronized',
    copied: 0,
    updated: 0,
    unchanged: 0,
    preserved: 0,
    retainedAfterSourceDeletion: 0,
    skipped: 0,
    conflicts: [],
    errors: loaded.error === undefined ? [] : [loaded.error],
    plugins: { copied: 0, updated: 0, preserved: 0, skipped: 0, registered: [] },
    completedAt: '',
  }

  const sourceMetadata = await lstat(source).catch(() => undefined)
  if (sourceMetadata === undefined) {
    report.status = 'source-missing'
    await atomicWrite(manifestPath, `${JSON.stringify(loaded.manifest, null, 2)}\n`, 0o600)
    report.completedAt = new Date().toISOString()
    return report
  }
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    throw new Error(`Home sync source must be a real directory: ${source}`)
  }
  const seen = new Set<string>()
  const syncFile = async (relativePath: string, force = false): Promise<void> => {
    if (!force && relativePath !== '' && isProtected(relativePath)) {
      report.skipped += 1
      return
    }
    const sourcePath = join(source, relativePath)
    const destinationPath = join(destination, relativePath)
    let metadata
    try {
      metadata = await lstat(sourcePath)
    } catch (error) {
      report.errors.push(`${relativePath || '.'}: cannot inspect source: ${String(error)}`)
      return
    }
    if (metadata.isSymbolicLink()) {
      report.skipped += 1
      return
    }
    if (metadata.isDirectory()) {
      const target = await lstat(destinationPath).catch(() => undefined)
      if (target !== undefined && (!target.isDirectory() || target.isSymbolicLink())) {
        report.preserved += 1
        report.conflicts.push(relativePath)
        return
      }
      await mkdir(destinationPath, { recursive: true, mode: metadata.mode & 0o777 })
      const children = await readdir(sourcePath)
      for (const child of children.sort()) await syncFile(relativePath === '' ? child : join(relativePath, child), force)
      return
    }
    if (!metadata.isFile()) {
      report.skipped += 1
      return
    }

    seen.add(relativePath)
    try {
      const sourceBytes = await readFile(sourcePath)
      const sourceHash = digest(sourceBytes)
      const target = await lstat(destinationPath).catch(() => undefined)
      if (target === undefined) {
        if (loaded.manifest.entries[relativePath] !== undefined) {
          report.preserved += 1
          report.conflicts.push(relativePath)
          return
        }
        await atomicWrite(destinationPath, sourceBytes, metadata.mode & 0o777)
        loaded.manifest.entries[relativePath] = { sourceHash, destinationHash: sourceHash, synchronizedAt: new Date().toISOString() }
        report.copied += 1
        return
      }
      if (!target.isFile() || target.isSymbolicLink()) {
        report.preserved += 1
        report.conflicts.push(relativePath)
        return
      }
      const destinationBytes = await readFile(destinationPath)
      const destinationHash = digest(destinationBytes)
      const baseline = loaded.manifest.entries[relativePath]
      if (baseline === undefined || destinationHash !== baseline.destinationHash) {
        report.preserved += 1
        report.conflicts.push(relativePath)
        return
      }
      if (sourceHash === baseline.sourceHash) {
        report.unchanged += 1
        return
      }
      await atomicWrite(destinationPath, sourceBytes, metadata.mode & 0o777)
      loaded.manifest.entries[relativePath] = { sourceHash, destinationHash: sourceHash, synchronizedAt: new Date().toISOString() }
      report.updated += 1
    } catch (error) {
      report.errors.push(`${relativePath}: ${String(error)}`)
    }
  }
  const visit = async (relativePath: string): Promise<void> => {
    if (relativePath !== '' && isProtected(relativePath)) {
      report.skipped += 1
      return
    }
    await syncFile(relativePath)
  }

  /**
   * Mirror out-of-tree plugins from ordinary-home profiles into the Forge
   * home. A plugin joins a profile's loader graph through two things: its
   * package directory under `profiles/node_modules/<name>` and an `insert`
   * row in the profile's own `cordis.patch.yml`. This mirrors the declared
   * plugin directories and registers the same rows in the Forge profile's
   * patch (idempotent: rows whose id already exists are never duplicated).
   */
  const syncOutOfTreePlugins = async (): Promise<void> => {
    const pluginsDir = join(source, 'profiles')
    const profiles = await readdir(pluginsDir).catch(() => [] as string[])
    const declared = new Map<string, OutOfTreePlugin>()
    for (const profile of profiles.sort()) {
      if (profile === 'node_modules') continue
      const patchPath = join(pluginsDir, profile, PROFILE_PATCH_FILENAME)
      const content = await readFile(patchPath, 'utf8').catch(() => undefined)
      if (content === undefined) continue
      for (const plugin of parseInsertRows(content)) {
        declared.set(plugin.name, plugin)
      }
    }
    if (declared.size === 0) return

    const forgePatchPath = join(destination, 'profiles', 'forge', PROFILE_PATCH_FILENAME)
    const forgePatch = await readFile(forgePatchPath, 'utf8').catch(() => '')
    const registeredIds = parseRowIds(forgePatch)
    const rows: OutOfTreePlugin[] = []
    for (const plugin of declared.values()) {
      if (registeredIds.has(plugin.id)) {
        report.plugins.skipped += 1
        continue
      }
      const sourceDir = join(pluginsDir, 'node_modules', plugin.name)
      if (!(await lstat(sourceDir).then(() => true, () => false))) {
        report.plugins.skipped += 1
        continue
      }
      const before = { copied: report.copied, updated: report.updated, preserved: report.preserved, conflicts: report.conflicts.length }
      await syncFile(join('profiles', 'node_modules', plugin.name), true)
      if (report.copied > before.copied) report.plugins.copied += 1
      else if (report.updated > before.updated) report.plugins.updated += 1
      else if (report.preserved > before.preserved || report.conflicts.length > before.conflicts) report.plugins.preserved += 1
      else report.plugins.skipped += 1
      rows.push(plugin)
      registeredIds.add(plugin.id)
    }
    if (rows.length > 0) {
      const block = rows.map(plugin => `- insert:\n    - id: ${plugin.id}\n      name: ${plugin.name}`).join('\n')
      const next = forgePatch.trim().length > 0 ? `${forgePatch.replace(/\s*$/, '')}\n\n${block}\n` : `${block}\n`
      await atomicWrite(forgePatchPath, next, 0o600)
      report.plugins.registered.push(...rows.map(plugin => plugin.id))
    }
  }

  await visit('')
  await syncOutOfTreePlugins()
  for (const path of Object.keys(loaded.manifest.entries)) {
    if (!seen.has(path)) report.retainedAfterSourceDeletion += 1
  }
  loaded.manifest.sourceRoot = source
  loaded.manifest.destinationRoot = destination
  await atomicWrite(manifestPath, `${JSON.stringify(loaded.manifest, null, 2)}\n`, 0o600)
  report.conflicts.sort()
  report.completedAt = new Date().toISOString()
  return report
}

/** Collect every top-level `- id:` row id from a patch file. */
function parseRowIds(content: string): Set<string> {
  const ids = new Set<string>()
  for (const line of content.split('\n')) {
    const match = line.trim().match(/^- id:\s*(\S+)/)
    if (match !== null && match[1] !== undefined) ids.add(match[1])
  }
  return ids
}

/**
 * Extract out-of-tree plugin rows from `- insert:` blocks (block form:
 * `- id: <id>` followed by `name: <name>` at deeper indentation). Rows that
 * lack an id or a name are ignored because they cannot be mirrored.
 */
function parseInsertRows(content: string): OutOfTreePlugin[] {
  const plugins: OutOfTreePlugin[] = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const row = lines[i]
    if (row === undefined || row.trim() !== '- insert:') continue
    const indent = row.match(/^\s*/)?.[0].length ?? 0
    let current: OutOfTreePlugin | undefined
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      if (line === undefined) continue
      const text = line.trim()
      if (text === '' || text.startsWith('#')) continue
      const lineIndent = line.match(/^\s*/)?.[0].length ?? 0
      if (lineIndent <= indent) break
      const idMatch = text.match(/^-\s*id:\s*(\S+)/)
      if (idMatch !== null) {
        if (current !== undefined && current.name !== '') plugins.push(current)
        current = { id: idMatch[1] ?? '', name: '' }
        continue
      }
      const nameMatch = text.match(/^name:\s*(\S+)/)
      if (nameMatch !== null && current !== undefined) current.name = nameMatch[1] ?? ''
    }
    if (current !== undefined && current.name !== '') plugins.push(current)
  }
  return plugins
}
