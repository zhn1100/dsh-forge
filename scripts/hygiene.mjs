import { access, readFile } from 'node:fs/promises'

const required = [
  'README.md',
  'LICENSE',
  'cordis.patch.yml',
  'assets/dsh-forge.svg',
  'lib/index.js',
  'lib/tools.js',
  'preset/preset.yml',
  'preset/skills/forge-plugin-development/SKILL.md',
]

for (const path of required) await access(new URL(`../${path}`, import.meta.url))
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error('dsh.bundle.patch is missing or invalid')
if (manifest.type !== 'module') throw new Error('package must be ESM')
