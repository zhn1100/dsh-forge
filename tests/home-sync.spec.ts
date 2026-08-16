import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { syncOrdinaryHome } from '../src/home-sync.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

describe('ordinary Home synchronization', () => {
  it('updates only files that still match the synchronization baseline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-home-sync-'))
    roots.push(root)
    const source = join(root, 'main')
    const target = join(root, 'forge-home')
    await mkdir(join(source, 'sessions'), { recursive: true })
    await mkdir(join(source, 'profiles', 'web'), { recursive: true })
    await mkdir(join(target, 'profiles', 'forge'), { recursive: true })
    await writeFile(join(source, 'settings.yaml'), 'model: first\n')
    await writeFile(join(source, 'sessions', 'one.json'), '{"turn":1}\n')
    await writeFile(join(source, 'profiles', 'web', 'package.json'), '{}\n')
    await writeFile(join(target, 'profiles', 'forge', 'package.json'), '{"forge":true}\n')

    const first = await syncOrdinaryHome(source, target)
    expect(first.copied).toBe(2)
    expect(await readFile(join(target, 'settings.yaml'), 'utf8')).toBe('model: first\n')
    await expect(readFile(join(target, 'profiles', 'web', 'package.json'), 'utf8')).rejects.toThrow()

    await writeFile(join(source, 'settings.yaml'), 'model: upstream\n')
    await writeFile(join(source, 'sessions', 'one.json'), '{"turn":2}\n')
    await writeFile(join(target, 'settings.yaml'), 'model: local-development\n')
    const second = await syncOrdinaryHome(source, target)

    expect(await readFile(join(target, 'settings.yaml'), 'utf8')).toBe('model: local-development\n')
    expect(await readFile(join(target, 'sessions', 'one.json'), 'utf8')).toBe('{"turn":2}\n')
    expect(second.conflicts).toEqual(['settings.yaml'])
    expect(second.updated).toBe(1)
  })

  it('never deletes a Forge copy when the source file disappears', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-home-retain-'))
    roots.push(root)
    const source = join(root, 'main')
    const target = join(root, 'forge-home')
    await mkdir(source)
    await writeFile(join(source, 'settings.yaml'), 'keep: true\n')
    await syncOrdinaryHome(source, target)
    await rm(join(source, 'settings.yaml'))

    const report = await syncOrdinaryHome(source, target)
    expect(report.retainedAfterSourceDeletion).toBe(1)
    expect(await readFile(join(target, 'settings.yaml'), 'utf8')).toBe('keep: true\n')
  })

  it('preserves a local deletion instead of recreating a previously synchronized file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-home-local-delete-'))
    roots.push(root)
    const source = join(root, 'main')
    const target = join(root, 'forge-home')
    await mkdir(source)
    await writeFile(join(source, 'settings.yaml'), 'upstream: true\n')
    await syncOrdinaryHome(source, target)
    await rm(join(target, 'settings.yaml'))

    const report = await syncOrdinaryHome(source, target)
    expect(report.conflicts).toEqual(['settings.yaml'])
    await expect(readFile(join(target, 'settings.yaml'), 'utf8')).rejects.toThrow()
  })

  it('preserves pre-existing destination files without a known baseline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-home-existing-'))
    roots.push(root)
    const source = join(root, 'main')
    const target = join(root, 'forge-home')
    await mkdir(source)
    await mkdir(target)
    await writeFile(join(source, 'settings.yaml'), 'main: true\n')
    await writeFile(join(target, 'settings.yaml'), 'forge: true\n')

    const report = await syncOrdinaryHome(source, target)
    expect(report.conflicts).toEqual(['settings.yaml'])
    expect(await readFile(join(target, 'settings.yaml'), 'utf8')).toBe('forge: true\n')
  })

  it('records a successful no-op when the source Home does not exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-home-missing-'))
    roots.push(root)
    const target = join(root, 'forge-home')
    const report = await syncOrdinaryHome(join(root, 'missing'), target)
    expect(report.status).toBe('source-missing')
    expect(JSON.parse(await readFile(join(target, 'forge', 'home-sync-manifest.json'), 'utf8'))).toMatchObject({
      version: 1,
      entries: {},
    })
  })

  it('mirrors out-of-tree plugins and registers them in the Forge profile patch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-home-plugins-'))
    roots.push(root)
    const source = join(root, 'main')
    const target = join(root, 'forge-home')
    await mkdir(join(source, 'profiles', 'web'), { recursive: true })
    await mkdir(join(source, 'profiles', 'node_modules', 'dsh-vision-access', 'lib'), { recursive: true })
    await mkdir(join(target, 'profiles', 'forge'), { recursive: true })
    await writeFile(join(target, 'profiles', 'forge', 'cordis.patch.yml'), '# forge patch\n[]\n')
    await writeFile(join(source, 'profiles', 'web', 'cordis.patch.yml'), [
      '- insert:',
      '    - id: vision-access',
      '      name: dsh-vision-access',
      '',
    ].join('\n'))
    await writeFile(join(source, 'profiles', 'node_modules', 'dsh-vision-access', 'package.json'), '{"name":"dsh-vision-access"}\n')
    await writeFile(join(source, 'profiles', 'node_modules', 'dsh-vision-access', 'lib', 'client.js'), 'export const ok = true\n')

    const first = await syncOrdinaryHome(source, target)
    expect(first.plugins.copied).toBe(1)
    expect(first.plugins.registered).toEqual(['vision-access'])
    expect(await readFile(join(target, 'profiles', 'node_modules', 'dsh-vision-access', 'lib', 'client.js'), 'utf8')).toBe('export const ok = true\n')
    const patch = await readFile(join(target, 'profiles', 'forge', 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('- insert:')
    expect(patch).toContain('- id: vision-access')
    expect(patch).toContain('name: dsh-vision-access')

    const second = await syncOrdinaryHome(source, target)
    expect(second.plugins.skipped).toBe(1)
    expect(second.plugins.registered).toEqual([])
    const patchAgain = await readFile(join(target, 'profiles', 'forge', 'cordis.patch.yml'), 'utf8')
    expect(patchAgain.match(/- id: vision-access/g)).toHaveLength(1)
  })
})
