import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import ForgeControlService from '../src/index.js'
import * as ForgeTools from '../src/tools.js'
import type { KnowledgeIndex } from '../src/types.js'

const roots: string[] = []
afterEach(async () => {
  delete process.env.DSH_HOME
  delete process.env.DSH_FORGE_SOURCE_HOME
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Forge Cordis composition', () => {
  it('mounts the control service and contributes scoped tools plus discipline', async () => {
    const home = await mkdtemp(join(tmpdir(), 'forge-tools-'))
    roots.push(home)
    process.env.DSH_HOME = home
    process.env.DSH_FORGE_SOURCE_HOME = join(home, 'ordinary-home')
    await mkdir(join(home, 'forge'), { recursive: true })
    const index: KnowledgeIndex = {
      snapshot: {
        formatVersion: 1, harnessCommit: 'abc', harnessVersion: 'rc-source', runtimePackageVersion: 'rc-runtime',
        documentationRevision: 'abc', indexBuildRevision: 'index', sourceRoot: '/source',
        repository: 'https://example.invalid/harness.git', generatedAt: new Date(0).toISOString(),
      },
      records: [],
    }
    await writeFile(join(home, 'forge', 'knowledge-index.json'), JSON.stringify(index))

    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ForgeControlService)
    const mounted = await ctx.plugin(ForgeTools)
    const names = ctx.tools.schemas().map(tool => tool.name)
    expect(names).toContain('forge_docs_search')
    expect(names).toContain('forge_experiment')
    expect(names).toContain('forge_verify')
    expect(names).toContain('forge_promote')
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.find(section => section.name === 'forge:development-discipline')?.text)
      .toContain('PENDING is not success')
    await mounted.dispose()
    expect(ctx.tools.schemas().some(tool => tool.name.startsWith('forge_'))).toBe(false)
  })
})
