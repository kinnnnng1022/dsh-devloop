# dsh-devloop

把「写 DSH 插件」的机械流程自动化：**生成骨架 → 静态自检 → 同步进 profile → 安装 → 看日志**。

零第三方依赖，只用 Node 内置模块（`node:fs` / `node:path` / `node:child_process` / `node:crypto`）。

## 两种形态

| 形态 | 用法 |
|---|---|
| **CLI** | `node cli.mjs <命令>` 或全局安装后 `devloop <命令>` |
| **DSH 插件** | 装进 DSH profile 后，对话里直接调用 `devloop_*` 工具 |

插件壳只是 CLI 的包装：它 `spawn` 同目录的 `cli.mjs`，不重复实现逻辑。

## 命令

| 命令 | 作用 |
|---|---|
| `devloop new <name>` | 生成插件骨架（正确的 `output`/`render`/`cordis.patch.yml`） |
| `devloop check <name>` | 静态自检，只读 |
| `devloop install <name>` | 声明进 profile + `pnpm install`，改前强制备份 |
| `devloop sync <name>` | `robocopy` 镜像到 profile，并做哈希对比 |
| `devloop status` | 所有插件的声明/安装/同步状态 |
| `devloop logs <name>` | 查看 `~/.dsh/<插件>/debug.log` 尾部 |
| `devloop restart` | 提示如何重启 DSH（不自动执行） |

通用选项：`--json`（stdout 只输出 JSON）、`--no-color`。

## 快速开始

```bash
# 1. 生成骨架
node cli.mjs new my-plugin --desc "我的插件"

# 2. 自检
node cli.mjs check my-plugin

# 3. 安装进 DSH profile（首次）
node cli.mjs install my-plugin

# 4. 改完代码后同步
node cli.mjs sync my-plugin
# 5. 重启 DSH 生效
```

工作区默认是**当前目录**，也可以在插件工作区根目录运行，或设置 `DEVLOOP_WORKSPACE`。

## 作为 DSH 插件安装

1. 把本仓库复制到插件工作区
2. 在 profile 的 `package.json` 加依赖：
   ```json
   "dsh-devloop": "file:<本仓库路径>"
   ```
3. 在 `dsh.profile.bundles` 里加入 `dsh-devloop`
4. 在 profile 目录运行 `pnpm install`
5. 重启 DSH，对话里就会出现 `devloop_status` / `devloop_check` / `devloop_sync` / `devloop_install` / `devloop_logs` / `devloop_new`

壳会自动选择运行 CLI 的方式：优先用配置/环境变量里的 node；在 Electron 里则用 `process.execPath + ELECTRON_RUN_AS_NODE=1` 自举，不要求系统装 node。

## `check` 覆盖的坑

全部来自真实踩坑：

- `package.json` 缺 `type: module` / `dsh.bundle.patch`
- `cordis.patch.yml` 缺 `insert:` 或 `- id:`
- `index.js` 缺 `export name` / `inject` / `apply`
- `defineTool` 缺 `output`
- `render` 没返回 content 数组
- `link:` 依赖（DSH 加载器会静默跳过）
- 原生 `.node` 模块（Electron ABI 与 node ABI 不一致）
- 非 UTF-8 / BOM
- profile 未声明依赖 / 未安装

**诚实边界**：check 是静态启发式，抓不到运行时错误。最终验收永远是：装进 profile → 重启 DSH → 工具列表里出现。

## 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `DEVLOOP_WORKSPACE` | 插件工作区根目录 | 当前工作目录 |
| `DEVLOOP_PROFILE` | DSH profile 目录 | `~/.dsh/profiles/desktop`（找不到则扫描 `~/.dsh/profiles`） |
| `DEVLOOP_NODE` | 指定 node 可执行文件 | 当前进程 / Electron 自举 |
| `DEVLOOP_PNPM` | 指定 `pnpm.cjs` 路径 | 从 node 同级 `dependencies/pnpm` 探测 |

## 已知限制

- `check` 的 `render`/`output` 检查是启发式，多行写法可能漏判
- `sync` 依赖 Windows 的 `robocopy`（范围外平台需自行替换）
- 不会自动重启 DSH（杀 GUI 会丢会话状态）
- 不自动删除插件目录

## License

MIT
