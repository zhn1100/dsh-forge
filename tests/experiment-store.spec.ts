import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExperimentStore } from '../src/experiment-store.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

describe('experiment store', () => {
  it('enforces the development state machine and immutable revisions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-experiment-'))
    roots.push(root)
    const store = new ExperimentStore(root)
    const created = await store.create('build a tool', { harnessCommit: 'abc', documentationRevision: 'abc' })
    expect(created.state).toBe('REQUEST')
    await expect(store.transition(created.id, 'IMPLEMENT')).rejects.toThrow('Invalid transition')
    const classified = await store.transition(created.id, 'CLASSIFY')
    expect(classified.state).toBe('CLASSIFY')

    await store.addRevision(created.id, {
      pluginId: 'demo-1', packageId: 'pkg-1', reason: 'first prototype',
      documentationReferences: ['docs/tool.md'], status: 'DEFINED',
    })
    await expect(store.addRevision(created.id, {
      pluginId: 'demo-1', packageId: 'pkg-1', reason: 'overwrite',
      documentationReferences: [], status: 'FAILED',
    })).rejects.toThrow('already recorded')
    const trace = await store.get(created.id)
    expect(trace.packageRevisions).toHaveLength(1)
  })
})
