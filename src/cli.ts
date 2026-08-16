#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { buildKnowledgeIndex, cloneHarnessSource, writeKnowledgeIndex } from './indexer.js'
import { ExperimentStore } from './experiment-store.js'
import { KnowledgeStore } from './knowledge-store.js'
import { forgeDataPath, forgeHome } from './paths.js'
import { promotePackage } from './promoter.js'
import type { PromotionSpec } from './types.js'
import { verifyProject } from './verifier.js'
import { syncOrdinaryHome } from './home-sync.js'

const DEFAULT_REFERENCE_REVISION = '47f943859bef60e4160492346772ded9b24f765a'
const DSH_VERSION = '0.1.0-rc.6'
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FORGE_DEFAULT_PORT = 3188
const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
#
# Forge defaults its web server to a non-mainline port so the Forge profile
# can run side by side with a plain dsh profile; \`dsh --profile forge --port N\`
# still overrides it.
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  inject: [webStartup]
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'
    port: !!js ctx.webStartup.port ?? ${FORGE_DEFAULT_PORT}
`
const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function flag(args: string[], name: string): boolean {
  return args.includes(name)
}

function print(value: unknown): void {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`)
}

async function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ code: number; output: string }> {
  return await new Promise((resolvePromise) => {
    const detached = process.platform !== 'win32'
    const child = spawn(command, args, {
      env,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      detached,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let timedOut = false
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk) })
    child.on('error', error => resolvePromise({ code: 1, output: error.message }))
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (child.pid && detached) process.kill(-child.pid, 'SIGTERM')
        else child.kill('SIGTERM')
      } catch {
        // The process settled at the timeout boundary.
      }
    }, options.timeoutMs ?? 300_000)
    child.on('close', code => {
      clearTimeout(timer)
      resolvePromise({
        code: timedOut ? 124 : code ?? 1,
        output: `${output.trim()}${timedOut ? '\ncommand timed out and its process group received SIGTERM' : ''}`.trim(),
      })
    })
  })
}

async function sync(args: string[]): Promise<void> {
  const sourceOption = option(args, '--source')
  const revision = option(args, '--revision') ?? DEFAULT_REFERENCE_REVISION
  const source = sourceOption
    ? resolve(sourceOption)
    : forgeDataPath('reference', 'deepseek-harness')
  let resolvedRevision = revision
  if (!sourceOption) resolvedRevision = await cloneHarnessSource(source, revision)
  const index = await buildKnowledgeIndex(source, DSH_VERSION)
  const output = option(args, '--output') ? resolve(option(args, '--output') as string) : forgeDataPath('knowledge-index.json')
  await writeKnowledgeIndex(index, output)
  print({
    output,
    source,
    requestedRevision: revision,
    resolvedRevision,
    snapshot: index.snapshot,
    records: index.records.length,
  })
}

async function tightenPresetTree(root: string): Promise<void> {
  await chmod(root, 0o700)
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Preset archive must not contain symbolic links: ${path}`)
    if (entry.isDirectory()) await tightenPresetTree(path)
    else await chmod(path, 0o600)
  }
}

async function installPreset(home: string, force: boolean): Promise<string> {
  const target = join(home, '.agent-presets', 'cordis-developer')
  const exists = await stat(target).then(() => true, () => false)
  if (exists && !force) throw new Error(`Preset already exists: ${target}. Re-run with --force to create a recoverable backup.`)
  if (exists) await rename(target, `${target}.backup-${Date.now()}`)
  const staging = `${target}.staging-${process.pid}`
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-forge-preset-'))
  try {
    const packed = await run('npm', ['pack', `@deepseek-ai/dsh@${DSH_VERSION}`, '--pack-destination', temporary, '--silent'])
    if (packed.code !== 0) throw new Error(`Cannot download the DSH preset: ${packed.output}`)
    const archive = join(temporary, packed.output.split(/\r?\n/).at(-1) ?? '')
    const extracted = join(temporary, 'extracted')
    await mkdir(extracted)
    const unpacked = await run('tar', ['-xzf', archive, '-C', extracted])
    if (unpacked.code !== 0) throw new Error(`Cannot unpack the DSH preset: ${unpacked.output}`)
    const shippedPreset = join(extracted, 'package', 'config', 'agent-presets', 'cordis')
    await cp(shippedPreset, staging, { recursive: true, errorOnExist: true, force: false })
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  const compositionPath = join(staging, 'agent.cordis.yml')
  const composition = await readFile(compositionPath, 'utf8')
  await writeFile(compositionPath, `${composition.trimEnd()}\n\n# DSH Forge model-facing control-plane consumers.\n- id: forge-tools\n  name: dsh-forge/tools\n`, { encoding: 'utf8', mode: 0o600 })
  await cp(join(packageRoot, 'preset', 'preset.yml'), join(staging, 'preset.yml'), { force: true })
  await cp(join(packageRoot, 'preset', 'skills'), join(staging, 'skills'), { recursive: true, force: true })
  await writeFile(join(staging, 'forge.json'), `${JSON.stringify({
    forgeVersion: '0.1.0',
    dshVersion: DSH_VERSION,
    referenceRevision: DEFAULT_REFERENCE_REVISION,
    installedAt: new Date().toISOString(),
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await tightenPresetTree(staging)
  await rename(staging, target)
  return target
}

async function acknowledgePinnedOfficialBuild(home: string, output: string): Promise<boolean> {
  if (!output.includes('Ignored build scripts: koffi@3.1.4')) return false
  const workspacePath = join(home, 'profiles', 'forge', 'pnpm-workspace.yaml')
  const before = await readFile(workspacePath, 'utf8')
  const placeholder = '  koffi: set this to true or false'
  if (!before.includes(placeholder)) return false
  const after = before.replace(placeholder, '  # The pinned Web bundle ships @koromix/koffi-linux-x64; do not run koffi host builds.\n  koffi: false')
  await writeFile(workspacePath, after, { encoding: 'utf8', mode: 0o600 })
  return true
}

async function packForgeArtifact(home: string): Promise<string> {
  const artifactRoot = join(home, 'forge', 'packages')
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 })
  const staging = await mkdtemp(join(artifactRoot, '.pack-'))
  try {
    const packed = await run('pnpm', ['pack', '--pack-destination', staging, '--silent'], process.env, { cwd: packageRoot })
    if (packed.code !== 0) throw new Error(`Failed to build the Forge installation artifact:\n${packed.output}`)
    const reported = packed.output.split(/\r?\n/).at(-1) ?? ''
    const generated = isAbsolute(reported) ? reported : join(staging, reported)
    const bytes = await readFile(generated)
    const hash = createHash('sha256').update(bytes).digest('hex')
    const artifact = join(artifactRoot, `dsh-forge-0.1.0-${hash}.tgz`)
    const existing = await stat(artifact).catch(() => undefined)
    if (existing === undefined) await rename(generated, artifact)
    else if (!existing.isFile()) throw new Error(`Forge artifact path is not a file: ${artifact}`)
    return artifact
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function ensureForgeProfile(home: string): Promise<void> {
  const dir = join(home, 'profiles', 'forge')
  const manifestPath = join(dir, 'package.json')
  const exists = await stat(manifestPath).then(() => true, () => false)
  if (!exists) {
    // Mirror the official shipped web profile template (PROFILE_TEMPLATES.web):
    // in-box Base + Web bundles and an empty dependency set. The `dsh plugin`
    // auto-init would otherwise fall back to DEFAULT_PROFILE_BUNDLES, which is
    // headless and would drop the Web UI.
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(manifestPath, `${JSON.stringify({
      name: 'dsh-profile-forge',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }, undefined, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  }
  // initProfile semantics: existing files are never touched; the patch layer
  // and pnpm settings are only created when missing.
  const patchPath = join(dir, 'cordis.patch.yml')
  if (!(await stat(patchPath).then(() => true, () => false))) {
    await writeFile(patchPath, PROFILE_PATCH_TEMPLATE, { encoding: 'utf8', mode: 0o600 })
  } else {
    // Migrate older profiles: default the web server to the Forge port while
    // preserving any user rows. The webserver row restates the bundle layer's
    // whole config, so it must carry host as well as port. Repairs stray bare
    // flow-list markers (`[]`) left by earlier migrations.
    const existing = await readFile(patchPath, 'utf8')
    const stripped = existing.replace(/^[ \t]*\[\s*\]\s*$/m, '')
    const hasWebserver = /- id: webserver\b/.test(stripped)
    if (!hasWebserver) {
      const base = stripped.trim().length > 0 ? stripped.trimEnd() : ''
      const row = `- id: webserver\n  name: '@deepseek-ai/dsh-host-webserver'\n  inject: [webStartup]\n  config:\n    host: !!js ctx.webStartup.host ?? '127.0.0.1'\n    port: !!js ctx.webStartup.port ?? ${FORGE_DEFAULT_PORT}\n`
      const next = base ? `${base}\n\n${row}` : row
      await writeFile(patchPath, next, { encoding: 'utf8', mode: 0o600 })
    } else if (stripped !== existing) {
      await writeFile(patchPath, stripped, { encoding: 'utf8', mode: 0o600 })
    }
  }
  const workspacePath = join(dir, 'pnpm-workspace.yaml')
  if (!(await stat(workspacePath).then(() => true, () => false))) {
    await writeFile(workspacePath, PROFILE_PNPM_WORKSPACE, { encoding: 'utf8', mode: 0o600 })
  }
}

async function removeExistingForgeInstall(home: string, env: NodeJS.ProcessEnv): Promise<void> {
  const manifestPath = join(home, 'profiles', 'forge', 'package.json')
  const manifest = await readFile(manifestPath, 'utf8').then(
    value => JSON.parse(value) as { dependencies?: Record<string, string> },
    () => undefined,
  )
  if (manifest === undefined) return
  const removals: string[] = []
  const installed = join(home, 'profiles', 'forge', 'node_modules', 'dsh-forge')
  const metadata = await lstat(installed).catch(() => undefined)
  if (metadata !== undefined || manifest.dependencies?.['dsh-forge'] !== undefined) removals.push('dsh-forge')
  // Legacy installers wrongly installed the in-box Web bundle as a profile
  // dependency; drop it so a duplicate @deepseek-ai/dsh-tools runtime (and its
  // Scheduler Symbol mismatch) cannot survive an upgrade.
  if (manifest.dependencies?.['@deepseek-ai/dsh-web-app'] !== undefined) removals.push('@deepseek-ai/dsh-web-app')
  for (const packageName of removals) {
    const removed = await run('npx', ['--yes', `@deepseek-ai/dsh@${DSH_VERSION}`, 'plugin', '--profile', 'forge', 'remove', packageName], env)
    if (removed.code !== 0) throw new Error(`Failed to remove ${packageName} before replacement:\n${removed.output}`)
  }
}

async function reconcileForgeManifest(home: string): Promise<void> {
  const manifestPath = join(home, 'profiles', 'forge', 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: string[] } }
  }
  const forgeSpec = manifest.dependencies?.['dsh-forge']
  if (forgeSpec === undefined || !forgeSpec.startsWith('file:')) {
    throw new Error(`dsh-forge was not installed from the artifact tarball: ${forgeSpec ?? 'missing dependency'}`)
  }
  // Reconcile may have dropped the in-box Web bundle from the layer list while
  // cleaning the legacy dependency; restore the full layer stack and the
  // artifact-only dependency set atomically. Base/Web stay resolved from the
  // dsh installation and never become profile-local dependencies.
  manifest.dependencies = { 'dsh-forge': forgeSpec }
  manifest.dsh = {
    ...manifest.dsh,
    profile: { ...manifest.dsh?.profile, bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-forge'] },
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

async function install(args: string[]): Promise<void> {
  const home = resolve(option(args, '--home') ?? forgeHome())
  const ordinary = resolve(process.env.HOME ?? '', '.dsh')
  if (home === ordinary) throw new Error('Refusing to install Forge into the ordinary ~/.dsh Home')
  process.env.DSH_HOME = home
  await mkdir(home, { recursive: true, mode: 0o700 })
  const homeSync = await syncOrdinaryHome(undefined, home)
  const preset = await installPreset(home, flag(args, '--force'))
  const forgeArtifact = await packForgeArtifact(home)
  const env = { ...process.env, DSH_HOME: home }
  // Base/Web are in-box bundles resolved from the dsh installation; the
  // profile must never install them as local dependencies, or a duplicate
  // @deepseek-ai/dsh-tools runtime breaks the scheduler Symbol identity.
  // A remove/add replacement is intentional: pnpm otherwise binds a new
  // optional host peer to a stale Profile-local provider from the old lockfile.
  await ensureForgeProfile(home)
  await removeExistingForgeInstall(home, env)
  let result = await run('npx', ['--yes', `@deepseek-ai/dsh@${DSH_VERSION}`, 'plugin', '--profile', 'forge', 'add', forgeArtifact], env)
  if (result.code !== 0 && await acknowledgePinnedOfficialBuild(home, result.output)) {
    const prepared = await run('pnpm', ['install'], env, { cwd: join(home, 'profiles', 'forge') })
    if (prepared.code !== 0) throw new Error(`Failed to build the pinned official Web dependency:\n${prepared.output}`)
    result = await run('npx', ['--yes', `@deepseek-ai/dsh@${DSH_VERSION}`, 'plugin', '--profile', 'forge', 'add', forgeArtifact], env)
  }
  if (result.code !== 0) throw new Error(`Failed to install ${forgeArtifact}:\n${result.output}`)
  await reconcileForgeManifest(home)
  if (!flag(args, '--no-sync')) {
    await cloneHarnessSource(forgeDataPath('reference', 'deepseek-harness'), DEFAULT_REFERENCE_REVISION)
    const index = await buildKnowledgeIndex(forgeDataPath('reference', 'deepseek-harness'), DSH_VERSION)
    await writeKnowledgeIndex(index, forgeDataPath('knowledge-index.json'))
  }
  const dump = await run('npx', ['--yes', `@deepseek-ai/dsh@${DSH_VERSION}`, '--profile', 'forge', '--dump-config'], env)
  if (dump.code !== 0 || !dump.output.includes('forge-control')) throw new Error(`Forge profile validation failed:\n${dump.output}`)
  print({ home, profile: 'forge', homeSync, preset, forgeArtifact, installed: [forgeArtifact], configValidated: true })
}

async function doctor(): Promise<void> {
  const home = forgeHome()
  const paths = {
    index: forgeDataPath('knowledge-index.json'),
    homeSync: forgeDataPath('home-sync-manifest.json'),
    profile: join(home, 'profiles', 'forge', 'package.json'),
    preset: join(home, '.agent-presets', 'cordis-developer', 'agent.cordis.yml'),
    homeSyncRuntime: join(home, 'profiles', 'forge', 'node_modules', 'dsh-forge', 'lib', 'home-sync.js'),
  }
  const checks: Array<{ name: string; ok: boolean; detail: string }> = []
  checks.push({ name: 'isolated-home', ok: home !== resolve(process.env.HOME ?? '', '.dsh'), detail: home })
  for (const [name, path] of Object.entries(paths)) {
    checks.push({ name, ok: await stat(path).then(() => true, () => false), detail: path })
  }
  const hostRuntimePackages = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools']
  const shadowResults = await Promise.all(hostRuntimePackages.map(
    name => stat(join(home, 'profiles', 'forge', 'node_modules', ...name.split('/'))).then(() => true, () => false),
  ))
  const shadows = hostRuntimePackages
    .filter((_, index) => shadowResults[index])
  checks.push({
    name: 'host-runtime-unshadowed',
    ok: shadows.length === 0,
    detail: shadows.length === 0 ? 'no profile-local host runtime copies' : `shadow copies: ${shadows.join(', ')}`,
  })
  const manifest = await readFile(paths.profile, 'utf8').then(value => JSON.parse(value) as { dsh?: { profile?: { bundles?: string[] } } }, () => undefined)
  const bundles = manifest?.dsh?.profile?.bundles ?? []
  checks.push({ name: 'bundle', ok: bundles.includes('dsh-forge'), detail: bundles.join(', ') })
  const forgeDependency = (await readFile(paths.profile, 'utf8').then(value => JSON.parse(value) as { dependencies?: Record<string, string> }, () => undefined))?.dependencies?.['dsh-forge']
  const installedMetadata = await lstat(join(home, 'profiles', 'forge', 'node_modules', 'dsh-forge')).catch(() => undefined)
  checks.push({
    name: 'artifact-install',
    ok: forgeDependency?.startsWith('file:') === true && installedMetadata?.isDirectory() === true,
    detail: `${forgeDependency ?? 'missing dependency'}; ${installedMetadata?.isSymbolicLink() ? 'workspace symlink' : 'package directory'}`,
  })
  const report = { ok: checks.every(item => item.ok), checks }
  print(report)
  if (!report.ok) process.exitCode = 1
}

async function search(args: string[]): Promise<void> {
  const query = args.filter(item => !item.startsWith('--') && item !== option(args, '--kind') && item !== option(args, '--limit')).join(' ').trim()
  if (!query) throw new Error('search requires a query')
  const kind = option(args, '--kind')
  const store = new KnowledgeStore()
  const hits = await store.search(query, {
    ...(kind === undefined ? {} : { kinds: [kind as never] }),
    ...(option(args, '--limit') === undefined ? {} : { limit: Number(option(args, '--limit')) }),
  })
  print(hits)
}

async function verify(args: string[]): Promise<void> {
  const root = resolve(option(args, '--root') ?? process.cwd())
  const level = (option(args, '--level') ?? 'quick') as 'quick' | 'package' | 'full'
  if (!['quick', 'package', 'full'].includes(level)) throw new Error('level must be quick, package, or full')
  const report = await verifyProject(process.cwd(), root, level)
  print(report)
  if (!report.passed) process.exitCode = 1
}

async function promote(args: string[]): Promise<void> {
  const specPath = option(args, '--spec')
  if (!specPath) throw new Error('promote requires --spec <file>')
  const spec = JSON.parse(await readFile(resolve(specPath), 'utf8')) as PromotionSpec
  print(await promotePackage(process.cwd(), spec))
  const experiment = await new ExperimentStore().get(spec.rowId).catch(() => undefined)
  if (experiment?.designSpec?.needsClientHalf) {
    print('WARNING: the design requires a client half; the promoted package is host-only. Add dsh.client, exports["./client"] and the client bundle, then verify in a real browser before CLEAN_PROFILE_TEST.')
  }
}

function help(): void {
  print(`DSH Forge 0.1.0

Usage:
  dsh-forge install [--home PATH] [--force] [--no-sync]
  dsh-forge sync [--source CHECKOUT] [--revision COMMIT] [--output FILE]
  dsh-forge doctor
  dsh-forge search QUERY [--kind KIND] [--limit N]
  dsh-forge verify [--root DIR] [--level quick|package|full]
  dsh-forge promote --spec promotion.json

Launch after installation:
  DSH_HOME=~/.dsh-forge npx @deepseek-ai/dsh@${DSH_VERSION} --profile forge`)
}

async function main(): Promise<void> {
  const [command = 'help', ...args] = process.argv.slice(2)
  if (command === 'install') await install(args)
  else if (command === 'sync') await sync(args)
  else if (command === 'doctor') await doctor()
  else if (command === 'search') await search(args)
  else if (command === 'verify') await verify(args)
  else if (command === 'promote') await promote(args)
  else if (command === 'help' || command === '--help' || command === '-h') help()
  else throw new Error(`Unknown command: ${command}`)
}

main().catch(error => {
  process.stderr.write(`dsh-forge: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
