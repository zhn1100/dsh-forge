import { homedir } from 'node:os'
import { isAbsolute, join, normalize, relative, resolve } from 'node:path'

export function forgeHome(): string {
  const configured = process.env.DSH_HOME?.trim()
  return resolve(configured || join(homedir(), '.dsh-forge'))
}

export function forgeDataPath(...parts: string[]): string {
  return join(forgeHome(), 'forge', ...parts)
}

export function assertContained(root: string, candidate: string): string {
  const base = resolve(root)
  const target = resolve(candidate)
  const rel = relative(base, target)
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return target
  throw new Error(`Path is outside the allowed root: ${target}`)
}

export function safeSegment(value: string, label: string): string {
  const normalized = normalize(value)
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(normalized) || normalized.includes('..')) {
    throw new Error(`${label} must be a single safe path segment`)
  }
  return normalized
}
