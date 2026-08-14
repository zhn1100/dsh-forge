import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildKnowledgeIndex, writeKnowledgeIndex } from '../src/indexer.js'
import { KnowledgeStore } from '../src/knowledge-store.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'forge-index-'))
  roots.push(root)
  await mkdir(join(root, 'docs'), { recursive: true })
  await mkdir(join(root, 'packages', 'demo', 'tool-demo', 'src'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'harness', version: '1.2.3' }))
  await writeFile(join(root, 'docs', 'guide.md'), '# Tools\n\nUse ctx.tools.register and defineTool.\n')
  await writeFile(join(root, 'packages', 'demo', 'tool-demo', 'package.json'), JSON.stringify({ name: '@demo/tool-demo', version: '1.0.0' }))
  await writeFile(join(root, 'packages', 'demo', 'tool-demo', 'src', 'index.ts'), `
    import { Service } from '@deepseek-ai/cordis'
    declare module '@deepseek-ai/cordis' {
      interface Context { demoService: DemoService }
      interface Events { 'demo/ready'(value: string): void }
    }
    export interface Config { greeting: string }
    export class DemoService extends Service {
      constructor(ctx: unknown) { super(ctx as never, 'demoService') }
    }
    export const tool = defineTool({ name: 'demo_tool', description: 'demo' })
  `)
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['-c', 'user.name=Forge Test', '-c', 'user.email=forge@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root })
  return root
}

describe('knowledge index', () => {
  it('extracts structured docs, symbols, services, events, tools and configs', async () => {
    const root = await fixture()
    const index = await buildKnowledgeIndex(root)
    expect(index.snapshot.harnessVersion).toBe('1.2.3')
    expect(index.snapshot.runtimePackageVersion).toBe('1.2.3')
    expect(index.records.some(item => item.kind === 'service' && item.ctxKey === 'demoService')).toBe(true)
    expect(index.records.some(item => item.kind === 'event' && item.name === 'demo/ready')).toBe(true)
    expect(index.records.some(item => item.kind === 'tool' && item.name === 'demo_tool')).toBe(true)
    expect(index.records.some(item => item.kind === 'symbol' && item.name === 'DemoService')).toBe(true)
    expect(index.records.some(item => item.kind === 'config')).toBe(true)

    const output = join(root, 'index.json')
    await writeKnowledgeIndex(index, output)
    const store = new KnowledgeStore(output)
    expect((await store.service('demoService'))[0]?.ctxKey).toBe('demoService')
    expect((await store.tool('demo_tool'))[0]?.name).toBe('demo_tool')
    expect((await store.docsSearch('defineTool')).length).toBeGreaterThan(0)
  })
})
