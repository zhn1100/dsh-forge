# DSH Forge 项目交接说明

更新时间：2026-08-15（Asia/Shanghai）

## 1. 项目目标

DSH Forge 是一个面向 DeepSeek Harness / Cordis 插件开发的独立环境，目标是让 Agent 能够完成：

1. 检查当前 Harness 运行时结构；
2. 查询固定 revision 的官方文档与源码；
3. 创建并记录动态插件实验；
4. 验证、回滚，并将成功实验正式化为 TypeScript 包；
5. 使用独立 `DSH_HOME`，不修改普通 DSH Home；
6. 启动时安全吸收普通 DSH Home 的用户态数据，同时不覆盖 Forge 本地改动；
7. 在不同工作文件夹启动时，共享 Forge 配置和控制面，但绝不在工作区 A、B 之间同步源码。

项目不是 DeepSeek 官方项目。

## 2. 仓库与关键路径

- 本地项目：`/home/zhn/exp/test/test5`
- GitHub：<https://github.com/zhn1100/dsh-forge>
- GitHub 默认分支：`main`
- GitHub topic：`dsh-plugin`、`deepseek-harness`、`cordis`
- 远端已发布提交：`d734d75 Initial DSH Forge release`
- Forge Home：`/home/zhn/.dsh-forge`
- 普通 DSH Home：`/home/zhn/.dsh`
- Forge Profile：`/home/zhn/.dsh-forge/profiles/forge`
- Forge Preset：`/home/zhn/.dsh-forge/.agent-presets/cordis-developer`
- Home 同步清单：`/home/zhn/.dsh-forge/forge/home-sync-manifest.json`
- 固定 Harness 源码参考 checkout：`/home/zhn/.dsh-forge/forge/reference/deepseek-harness`
- 本次开发时使用的临时官方源码 checkout：`/tmp/dsh-forge-reference.ouJL5D`

当前工作树已包含本次会话的全部修复（安装器 Web Bundle 策略 + 运行时 Symbol 防护 + doctor 检查），见 §7 与 §9。

## 3. 版本锁定

- 目标运行时：`@deepseek-ai/dsh@0.1.0-rc.6`
- Cordis：`@deepseek-ai/cordis@4.0.1`
- 官方 Harness 源码提交：`47f943859bef60e4160492346772ded9b24f765a`
- Node.js：`^22.19.0 || >=24.0.0`

## 4. 已经完成的功能

### 4.1 Forge 控制面

`src/index.ts` 提供 `ctx.forge` Service，包括：

- 固定 revision 的知识快照；
- 文档、symbol、Service、Event、Tool、Config、Package、源码和示例查询；
- 实验状态机；
- 有界验证；
- Promotion scaffold；
- Forge doctor。

### 4.2 模型侧工具

`src/tools.ts` 注册：

- `forge_docs_search`
- `forge_symbol`
- `forge_service`
- `forge_event`
- `forge_tool`
- `forge_config`
- `forge_package`
- `forge_related`
- `forge_source`
- `forge_example`
- `forge_snapshot`
- `forge_experiment`
- `forge_verify`
- `forge_promote`
- `forge_doctor`

开发者 Preset 还包含官方 Cordis 自检和动态 Package 工具。

### 4.3 Home 同步

`src/home-sync.ts` 实现普通 Home 到 Forge Home 的单向、基线感知同步：

- 来源默认是 `~/.dsh`；
- 目标默认是 `~/.dsh-forge`；
- 新文件复制；
- 目标仍等于上次同步版本时，接收源端更新；
- Forge 侧已经修改或删除时，保留 Forge 状态并记录冲突；
- 源端删除不会删除 Forge 文件；
- 不跟随符号链接；
- 永久排除 `forge/`、`profiles/`、`.agent-presets/`、`cordis.patch.yml`；
- 不同步当前工作文件夹源码，不会把工作区 A 的代码复制到工作区 B。

最近一次真实同步报告为：15 个文件未变化，4 个 Forge 本地文件被保留；冲突路径为：

- `.credentials.yaml`
- `settings.yaml`
- `storages/session_projcache.json`
- `storages/workspace.json`

这些冲突是保护机制生效，不是同步失败。

### 4.4 安装与可复现工件

安装器会：

- 拒绝把 Forge 安装进普通 `~/.dsh`；
- 生成 SHA-256 内容寻址 tarball；
- 创建 Forge Preset；
- 建立固定 revision 的源码索引；
- 安装 `dsh-forge` Bundle；
- 展开配置并执行 doctor。

内容寻址安装是为避免 pnpm 因相同 tarball 路径复用旧包缓存。

### 4.5 README 与图标

- `README.md` 已重写为简洁中文项目说明；
- 图标为 `assets/dsh-forge.svg`，是一枚铁砧；
- npm 包清单包含图标；
- `package.json` 已改为本项目 GitHub 地址并包含 `dsh-plugin` keyword。

### 4.6 测试

当前测试数量：11。

最近一次执行以下命令全部通过：

```bash
pnpm run verify
```

该命令覆盖：

- TypeScript 类型检查；
- lint（当前等同严格类型检查）；
- Vitest；
- build；
- hygiene。

注意：单元测试通过，但当前真实 Profile 的集成 doctor 不通过，原因见下文。

## 5. 用户实际运行时发现的问题

用户在 Forge UI 中提出：

> 做一个插件，使得在主界面的右下角可以播放电脑里的音乐或接入线上音乐

Agent 能正常获得 System Prompt 和 Skill Catalog，但调用：

- `skill cordis-plugin-development`
- `cordis_inspect_list`

都会中止，前端显示：

```text
Cannot read properties of undefined (reading 'prepare')
UNKNOWN
```

该问题意味着音乐播放器插件尚未开始设计或实现。当前优先任务是修复 Forge 工具执行环境。

## 6. 已定位的根因

失败位置在官方 Agent Loop：

```text
packages/core/agent-loop/src/tool-calls.ts:169
ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec)
```

`ctx.tools[TOOL_RUNTIME_SCHEDULER]` 为 `undefined`。

`TOOL_RUNTIME_SCHEDULER` 在 `@deepseek-ai/dsh-tools` 中使用模块本地 `Symbol(...)`，不是 `Symbol.for(...)`。如果 Host Tool Runtime 和 Agent Loop 加载了两份不同路径的 `@deepseek-ai/dsh-tools`，两边 Symbol 身份不同，调度器属性就无法读取。

实际 Profile 中确实存在重复运行时：

```text
/home/zhn/.dsh-forge/profiles/forge/node_modules/@deepseek-ai/dsh-tools
```

更进一步的 `pnpm why @deepseek-ai/dsh-tools` 已证明，这个 Profile 本地副本主要由以下直接依赖引入：

```text
@deepseek-ai/dsh-web-app@0.1.0-rc.6
```

当前 Forge Profile 的 `package.json` 是：

```json
{
  "dependencies": {
    "@deepseek-ai/dsh-web-app": "0.1.0-rc.6",
    "dsh-forge": "file:/home/zhn/.dsh-forge/forge/packages/dsh-forge-0.1.0-c045f4bf3e3124313f5e821369b06d6b95840b4f34c1fe7777a96ee8f1f48975.tgz"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-forge"
      ]
    }
  }
}
```

问题在于：`@deepseek-ai/dsh-base` 和 `@deepseek-ai/dsh-web-app` 是 DSH 自带 Bundle，应从当前 DSH 安装中优先解析，不应作为 Profile 普通依赖再次安装。

官方普通 `web` Profile 的依赖为空，但 Bundle 列表仍为 Base + Web。官方文档明确说明：

> In-box bundles resolve from the dsh installation first; out-of-tree bundles resolve from the profile node_modules.

因此当前安装器把 Web Bundle 加入 `packages` 数组并执行 `dsh plugin add @deepseek-ai/dsh-web-app` 是错误策略。

## 7. 已完成且已提交的修复

本次会话已完成的修复（全部通过 `pnpm run verify` 并已在真实 Profile 验收）：

1. 将 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-system-prompt`、`@deepseek-ai/dsh-tools` 标记为 optional peers，减少 Forge 自身触发 peer 自动安装的机会；
2. `ForgeControlService` 启动时检查 `TOOL_RUNTIME_SCHEDULER` Symbol 身份，不匹配时立即给出明确错误；
3. runtime doctor 增加 `tool-runtime-identity`；
4. CLI doctor 增加 `host-runtime-unshadowed`；
5. installer 更新时先通过 DSH 正常 remove 旧 Forge（含旧错误策略安装的 `@deepseek-ai/dsh-web-app`），再 add 新工件，避免 lockfile 继续绑定旧 peer provider；
6. hygiene 检查宿主 runtime peers 必须保持 optional；
7. installer 不再执行 `dsh plugin add @deepseek-ai/dsh-web-app`：Profile 缺失时按官方 `PROFILE_TEMPLATES.web`（Base + Web、空 dependencies）初始化，随后只安装树外 `dsh-forge` tarball，最后原子写回 manifest（dependencies 仅 `dsh-forge`，bundles 保持 `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-forge"]`）。

当前 CLI doctor 结果（`node lib/cli.js doctor`，ok: true）：

```text
host-runtime-unshadowed: true  (no profile-local host runtime copies)
bundle: @deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-forge
artifact-install: file:/home/zhn/.dsh-forge/forge/packages/dsh-forge-0.1.0-b928cee....tgz; package directory
```

## 8. 当前运行状态

- Forge 服务器正在运行：`http://127.0.0.1:3080`（PID 79817，`DSH_HOME=/home/zhn/.dsh-forge npx --yes @deepseek-ai/dsh@0.1.0-rc.6 --profile forge --port 3080`）；
- 无头 Chrome 测试实例：`--remote-debugging-port=9222`（PID 见 `/tmp/opencode/chrome.pid`）；
- 当前已安装工件路径：

```text
/home/zhn/.dsh-forge/profiles/forge/node_modules/dsh-forge -> file:/home/zhn/.dsh-forge/forge/packages/dsh-forge-0.1.0-b928ceead511081ab213fa92550496e7cee823a9ea72ecac984b8533120746c2.tgz
```

- 真实工具调用验收已全部通过（见 9.3）；
- 音乐播放器插件实验已完成并通过 Promote（见 9.4），动态插件 `musi-1/pkg-5` 当前正在运行，播放器可见于 Forge UI 右下角。

## 9. 已完成任务与验收记录

### 9.1 安装器 Web Bundle 策略（已完成）

依据官方源码验证：

- `PROFILE_TEMPLATES` 只有 `web`/`headless` 两个内置模板（`packages/boot/app-boot/src/profile.ts:114`）；`forge` 无模板，若让 `dsh plugin` 自动初始化会落入 `DEFAULT_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base']`（无 Web UI）；
- `runPlugin` 的 `reconcilePlugins`（`apps/cli/src/plugin.ts:59`）只按 installed state 增删 bundles，内置模板 bundle 不是依赖、永不被触碰；移除 web-app 依赖后 reconcile 会把它从 bundles 中摘除，因此安装器最后必须原子写回完整 bundles 列表；
- `resolveBundleDir`（`profile.ts:344`）先解析安装锚点（DSH 发行版）再解析 Profile 目录，所以 Base/Web 不进入 dependencies 也能解析。

实施：`ensureForgeProfile`（缺失时按 web 模板初始化）→ `removeExistingForgeInstall`（移除 dsh-forge 与遗留 web-app 依赖）→ `dsh plugin add <tarball>` → `reconcileForgeManifest`（原子写回）。

### 9.2 真实 Profile 清理与验收（已完成）

```bash
cd /home/zhn/exp/test/test5
pnpm run verify   # 全部通过（typecheck/lint/11 tests/build/hygiene）
node lib/cli.js install --force --no-sync
DSH_HOME=/home/zhn/.dsh-forge node lib/cli.js doctor   # ok: true
```

目标 Profile manifest 已达成（见 §7）。以下路径不存在：

```text
/home/zhn/.dsh-forge/profiles/forge/node_modules/@deepseek-ai/dsh-tools
/home/zhn/.dsh-forge/profiles/forge/node_modules/@deepseek-ai/cordis
/home/zhn/.dsh-forge/profiles/forge/node_modules/@deepseek-ai/dsh-system-prompt
```

### 9.3 真实工具调用验收（已完成）

服务器运行期间，通过 `/api` RPC（`session.create` + `session.prompt` + `session.history`）驱动真实会话（`cordis-developer` preset），五个验收点全部通过：

1. `skill cordis-plugin-development` 返回完整 Skill 内容；
2. `cordis_inspect_list` 返回 Provider 目录（host/Service、Event、Builtin、Tool）；
3. `forge_snapshot` 返回固定 revision `47f943859bef60e4160492346772ded9b24f765a`；
4. `forge_experiment(action:"create", task:"smoke test")` 创建 trace `exp-mst6p0e9-703a7109`；
5. 不再出现 `Cannot read properties of undefined (reading 'prepare')`；
6. runtime `forge_doctor` 的 `tool-runtime-identity` 通过（`host scheduler identity matches`）。

### 9.4 音乐播放器插件（已完成 Inspect → Reference → Design → Experiment → Verify → Promote）

实验 trace：`exp-mst6wyo0-8f31c4ee`（promotionStatus: VERIFIED，4 个 package revisions，4 条 runtime verification）。

- **Inspect**：`Slots.listSubTree` 无 root 查询全树 → 选定 `shell.overlay`（kind=list, scope=root, 纯增量 id, replaceRisk none, 层本身 pointer-events:none、条目 opt-in）；精确查询 `root=shell.overlay` 取得注册协议（id 必填、order 可选）与标准 props。
- **Reference**：`packages/client/ui-layout/src/client/AppFrame.tsx`（`renderSlot('shell.overlay', {})` 于 `div.overlayLayer`）+ `AppFrame.module.css`（absolute/inset:0/z-index:20/pointer-events:none，`.overlayLayer > *` opt-in）。
- **Design**：纯 Client 半边，无 Host 依赖；本地音乐用浏览器 File API（`<input type=file accept="audio/*">` + `URL.createObjectURL`），在线音乐接受直链；播放列表仅进程内内存（符合动态插件文档边界）；右下角 fixed 定位，`width: min(320px, calc(100vw - 24px))` 兼顾窄屏；文件选择与直链添加均为用户显式操作。
- **Experiment**：动态插件 `musi-1`（session `session-accb98e8-d564-4935-b498-932896d18a5d`）。关键迭代：
  - `pkg-1`：注册组件为 `() => Player`（工厂返回函数）→ React "Functions are not valid as a React child" 风险；改为 `() => React.createElement(Player)` / 直接注册组件后成功；
  - `pkg-5`（最终版）：通过 UI 真实点击“仅允许此版本”完成浏览器审批（`/api/respond` 与 mux 通道对动态 Cordis 运行不适用，审批按钮在页面 DOM 中）；
  - 实际验证：本地 WAV（440Hz 3 秒，CDP `DOM.setFileInputFiles` + 真实鼠标事件）`currentTime` 0→3s 推进、曲终自动切下一首；SoundHelix MP3 直链 `currentTime` 持续推进；`cordis_stop` 后 UI 移除、`cordis_run mode=run` 恢复（run-6，已授权无需再审批）；
  - `musi-2`（误创建的重复插件）已 `cordis_undefine` 清理。
- **Promote**：`/home/zhn/exp/test/test6/music-player` 已生成正式 TypeScript 包（`dsh-music-player`，含 `cordis.patch.yml`、src/index.ts、tests），`pnpm install && pnpm run build && pnpm run typecheck && pnpm test` 全部通过；experiment promotion 状态置为 VERIFIED。

注意事项（后续接手者）：

- 动态插件与播放列表都是进程内状态：Forge 服务器重启后插件消失，需按 Skill 流程重新 define/run（可复用 `/home/zhn/exp/test/test6/music-player` 正式化源码）；
- 无头 Chrome 页面重载会丢失页面侧 Client half（运行状态是页面本地事实），如需长驻可用 `--autoplay-policy=no-user-gesture-required` 重启测试实例；
- 播放器右下角定位不遮挡会话输入区；`shell.overlay` 条目 order 默认 0，与未来其他浮层叠加时可用 order 调整。

## 10. Git 与发布任务

修复与真实验收均已完成。提交内容：

1. `src/cli.ts`（安装器 Web Bundle 策略修复 + doctor 检查）；
2. `src/index.ts`（Tool Runtime Symbol 身份防护 + runtime doctor）；
3. `package.json` / `scripts/hygiene.mjs`（optional host peers）；
4. `README.md` 与 `HANDOFF.md`。

提交后推送 `origin/main`，并确认 GitHub `dsh-plugin` topic 仍存在。

## 11. 参考资料

### 在线资料

- DeepSeek Harness Quickstart：<https://deepseek-harness.github.io/deepseek-harness/guide/quickstart>
- DeepSeek Harness GitHub：<https://github.com/deepseek-ai/deepseek-harness>
- DSH Forge GitHub：<https://github.com/zhn1100/dsh-forge>

### 本地官方源码与文档

- CLI Profile 参考：`/tmp/dsh-forge-reference.ouJL5D/apps/cli/reference/README.md`
- CLI 中文参考：`/tmp/dsh-forge-reference.ouJL5D/apps/cli/reference/README.zh.md`
- Profile 实现：`/tmp/dsh-forge-reference.ouJL5D/packages/boot/app-boot/src/profile.ts`
- Base Bundle：`/tmp/dsh-forge-reference.ouJL5D/packages/bundle/base/README.md`
- Web Bundle：`/tmp/dsh-forge-reference.ouJL5D/packages/bundle/web-app/README.md`
- Agent Loop 工具调度：`/tmp/dsh-forge-reference.ouJL5D/packages/core/agent-loop/src/tool-calls.ts`
- Tool Runtime Symbol：`/tmp/dsh-forge-reference.ouJL5D/packages/core/tools/src/index.ts`
- Skill Tool：`/tmp/dsh-forge-reference.ouJL5D/packages/skill/tool-skill/src/index.ts`
- Skill Registry：`/tmp/dsh-forge-reference.ouJL5D/packages/skill/skill/src/index.ts`
- Skill Filesystem：`/tmp/dsh-forge-reference.ouJL5D/packages/skill/skill-filesystem/src/index.ts`

临时 `/tmp` checkout 可能被系统清理。如果不存在，使用以下固定源码副本：

```text
/home/zhn/.dsh-forge/forge/reference/deepseek-harness
```

并确认 HEAD 是：

```text
47f943859bef60e4160492346772ded9b24f765a
```

## 12. 安全和操作注意事项

- 不要修改或删除普通 `/home/zhn/.dsh`；它只能作为只读同步源；
- 不要执行 `git reset --hard`、`git checkout --` 或删除当前未提交修复；
- 不要手工递归删除 Forge Profile 的 `node_modules`；优先使用 DSH plugin / pnpm 正常依赖流程；
- 不要输出 `.credentials.yaml` 内容；
- 不需要 sudo；本项目此前没有使用用户提供的 sudo 密码；
- 安装器 `--force` 会把旧 Preset 重命名为时间戳备份，不会直接删除；
- 当前存在多个旧内容寻址 tarball，它们是可恢复工件，不是正在使用的依赖；不要在没有清理策略时删除。

## 13. 快速接手检查清单

```bash
cd /home/zhn/exp/test/test5

# 1. 查看尚未提交的修复
git status -sb
git diff

# 2. 阅读本交接文件和任务书
sed -n '1,260p' HANDOFF.md
sed -n '1,220p' 任务书.md

# 3. 查看官方 Profile 解析规则
sed -n '1,120p' /tmp/dsh-forge-reference.ouJL5D/apps/cli/reference/README.md
rg -n "reconcile|bundles|dependencies" /tmp/dsh-forge-reference.ouJL5D/apps/cli/src

# 4. 确认当前 Profile 问题
cat /home/zhn/.dsh-forge/profiles/forge/package.json
cd /home/zhn/.dsh-forge/profiles/forge
pnpm why @deepseek-ai/dsh-tools --depth 20

# 5. 返回项目修复、验证、重装
cd /home/zhn/exp/test/test5
pnpm run verify
```

## 14. 一句话状态总结

DSH Forge 的控制面、Home 同步、知识索引、实验和安装框架已经完成并发布；本次会话修复了 Profile 把内置 Web Bundle 重装成本地依赖导致的两份 `@deepseek-ai/dsh-tools` Scheduler Symbol 身份不一致问题——安装器改为按官方 web 模板初始化 Profile、只安装树外 `dsh-forge` 工件并原子写回 manifest，真实 Profile 的 CLI doctor 全绿、五个真实工具调用验收点全部通过（含 `skill`、`cordis_inspect_list`、`forge_snapshot`、`forge_experiment`、runtime `forge_doctor` 的 `tool-runtime-identity`）。随后按 Forge Skill 的 Inspect→Reference→Design→Experiment→Verify→Promote 流程完成了用户原始需求的右下角音乐播放器插件：动态插件 `musi-1/pkg-5` 在 `shell.overlay` 槽注册，本地 WAV（File API + blob URL）与在线 MP3 直链均实测播放成功、生命周期清理验证通过，正式化 TypeScript 包已生成于 `/home/zhn/exp/test/test6/music-player` 且构建/测试通过，实验 promotion 状态 VERIFIED。修复与交接文件已提交并推送 `origin/main`。
