import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { assertContained } from './paths.js'
import type { CommandResult, VerificationReport } from './types.js'

const OUTPUT_LIMIT = 64 * 1024

async function run(root: string, script: string, signal?: AbortSignal): Promise<CommandResult> {
  const started = Date.now()
  return await new Promise((resolvePromise) => {
    const child = spawn('pnpm', ['run', script], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const append = (chunk: Buffer): void => {
      if (output.length < OUTPUT_LIMIT) output += chunk.toString('utf8').slice(0, OUTPUT_LIMIT - output.length)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const abort = (): void => { child.kill('SIGTERM') }
    signal?.addEventListener('abort', abort, { once: true })
    child.on('close', code => {
      signal?.removeEventListener('abort', abort)
      resolvePromise({
        command: `pnpm run ${script}`,
        code: code ?? 1,
        durationMs: Date.now() - started,
        output: output.trim(),
      })
    })
    child.on('error', error => {
      signal?.removeEventListener('abort', abort)
      resolvePromise({ command: `pnpm run ${script}`, code: 1, durationMs: Date.now() - started, output: error.message })
    })
  })
}

export async function verifyProject(
  workspaceRoot: string,
  requestedRoot: string,
  level: 'quick' | 'package' | 'full',
  signal?: AbortSignal,
): Promise<VerificationReport> {
  const root = assertContained(resolve(workspaceRoot), resolve(requestedRoot))
  const metadata = await stat(root)
  if (!metadata.isDirectory()) throw new Error(`Verification root is not a directory: ${root}`)
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
  const available = manifest.scripts ?? {}
  const desired = level === 'quick'
    ? ['typecheck', 'lint', 'test']
    : level === 'package'
      ? ['typecheck', 'lint', 'test', 'build']
      : ['doc-sync', 'constraints', 'typecheck', 'lint', 'test', 'build', 'hygiene']
  const startedAt = new Date().toISOString()
  const commands: CommandResult[] = []
  const skipped: string[] = []
  for (const script of desired) {
    if (!available[script]) {
      skipped.push(script)
      continue
    }
    const result = await run(root, script, signal)
    commands.push(result)
    if (result.code !== 0 || signal?.aborted) break
  }
  return {
    level,
    root,
    passed: commands.length > 0 && commands.every(item => item.code === 0),
    startedAt,
    finishedAt: new Date().toISOString(),
    commands,
    skipped,
  }
}
