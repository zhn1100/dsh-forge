<p align="center">
  <img src="assets/dsh-forge.svg" width="128" alt="DSH Forge 铁砧图标">
</p>

# DSH Forge

面向 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart) 的独立插件开发环境。它把源码参考、运行时检查、实验记录、验证和正式化流程收进一个可复现的 Forge Profile，同时避免污染日常使用的 DSH 环境。

> 当前版本针对 `@deepseek-ai/dsh@0.1.0-rc.6`，参考源码固定在官方提交 `47f943859bef60e4160492346772ded9b24f765a`。本项目不是 DeepSeek 官方项目。

## 能做什么

- 建立独立的 `~/.dsh-forge` Home、`forge` Profile 和开发者 Agent Preset。
- 本地索引 Harness 文档、源码符号、Service、事件、工具、Config 和示例。
- 管理可恢复的插件实验、验证状态与 Promotion scaffold。
- 提供受限的 `quick`、`package`、`full` 验证流程。
- 每次启动安全同步普通 `~/.dsh` 中的用户配置，同时保护 Forge 本地修改。
- 使用 SHA-256 内容寻址 tarball 安装自身，避免复用旧包缓存。

## 安装

需要 Node.js `^22.19.0` 或 `>=24`，以及 pnpm。

```bash
git clone https://github.com/zhn1100/dsh-forge.git
cd dsh-forge
pnpm install
pnpm run verify
node lib/cli.js install
```

安装程序不会写入普通 `~/.dsh`，默认目标为 `~/.dsh-forge`。

## 启动

在需要开发插件的工作区运行：

```bash
DSH_HOME="$HOME/.dsh-forge" npx @deepseek-ai/dsh@0.1.0-rc.6 --profile forge
```

打开 Web UI 后选择 **DSH Forge 开发者** Preset。

### 工作区边界

Forge 启动时同步的是 `~/.dsh → ~/.dsh-forge` 的用户态数据，不同步当前工作文件夹的源码。

- 从工作区 A 切换到工作区 B，不会复制 A 的代码到 B。
- A、B 的修改互不影响，但共享同一个 Forge 配置和控制面。
- `forge/`、`profiles/`、`.agent-presets/` 和 `cordis.patch.yml` 永不参与 Home 同步。
- Forge 侧已修改或删除的文件不会被覆盖；源端删除也不会传播。

同步基线保存在 `~/.dsh-forge/forge/home-sync-manifest.json`。如需使用其他上游 Home，可显式设置 `DSH_FORGE_SOURCE_HOME`。

## 常用命令

```bash
# 环境检查
DSH_HOME="$HOME/.dsh-forge" node lib/cli.js doctor

# 重建指定 Harness revision 的知识索引
DSH_HOME="$HOME/.dsh-forge" node lib/cli.js sync --revision <commit>

# 搜索本地索引
DSH_HOME="$HOME/.dsh-forge" node lib/cli.js search "Service.init"

# 验证当前插件项目
node lib/cli.js verify --root . --level full
```

完整设计和安全边界见 [任务书](任务书.md)。

## 开发验证

```bash
pnpm run verify
```

验证包括类型检查、测试、构建和包结构检查。动态 Cordis Package 仍属于显式信任边界；Forge 提供隔离和恢复能力，但不将其包装成强安全沙箱。

## License

[MIT](LICENSE)
