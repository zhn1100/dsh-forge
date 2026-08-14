import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { forgeHome } from './paths.js'

const MANIFEST_VERSION = 1
const PROTECTED_ROOTS = new Set(['forge', 'profiles', '.agent-presets', 'cordis.patch.yml'])

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
  completedAt: string
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
  const visit = async (relativePath: string): Promise<void> => {
    if (relativePath !== '' && isProtected(relativePath)) {
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
      for (const child of children.sort()) await visit(relativePath === '' ? child : join(relativePath, child))
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

  await visit('')
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
