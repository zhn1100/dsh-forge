import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { promotePackage } from '../src/promoter.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

describe('promotion', () => {
  it('creates a formal no-overwrite package inside the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-promote-'))
    roots.push(root)
    const spec = {
      packageName: 'dsh-demo-tool', pluginName: 'demo-tool', rowId: 'demo-tool',
      description: 'A promoted tool.', destination: 'packages/demo',
      source: "export const name = 'demo-tool'\nexport function apply() {}",
    }
    const result = await promotePackage(root, spec)
    expect(result.files).toContain('cordis.patch.yml')
    expect(await readFile(join(result.destination, 'src', 'index.ts'), 'utf8')).toContain('export function apply')
    await expect(promotePackage(root, spec)).rejects.toThrow('already exists')
  })

  it('rejects a destination outside the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-promote-'))
    roots.push(root)
    await expect(promotePackage(root, {
      packageName: 'dsh-demo', pluginName: 'demo', rowId: 'demo', description: 'demo',
      destination: '../escape', source: 'export function apply() {}',
    })).rejects.toThrow('outside the allowed root')
  })
})
