import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyProject } from '../src/verifier.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

describe('verifier', () => {
  it('runs only declared gate scripts and reports skipped gates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forge-verify-'))
    roots.push(root)
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'verification-fixture', private: true,
      scripts: { typecheck: 'node -e "process.stdout.write(\'ok\')"', test: 'node -e "process.exit(0)"' },
    }))
    const report = await verifyProject(root, root, 'quick')
    expect(report.passed).toBe(true)
    expect(report.commands.map(item => item.command)).toEqual(['pnpm run typecheck', 'pnpm run test'])
    expect(report.skipped).toEqual(['lint'])
  })
})
