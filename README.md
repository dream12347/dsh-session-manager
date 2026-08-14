# dsh-delete-session

[English](README.en.md) | 中文

在 DeepSeek Harness Web 界面中直接**删除会话**的插件。设置页新增独立的「会话管理」分栏，列出所有会话并彻底删除（日志与记录一并清除），不修改 DSH 核心代码。

<sub><span style="opacity:.6">本项目由 dsh + Deepseek-V4-Flash0813 独立完成</span></sub>

## 功能

- 设置页新增独立的「会话管理」分栏（与 Notifications 同级的设置分区）
- 面板列出全部会话（标题 / 工作目录），底部折叠区单独展示**已归档会话**，均可删除
- 删除时二次确认，确认后**永久删除**该会话的日志目录
- 当前正在使用的会话标记「当前会话」、运行中的标记「运行中」，按钮禁用，避免误删
- 子代理（subagent）会话自动禁用，其生命周期由 DSH 委派机制管理
- 中英文界面自适应（跟随页面语言）

## 安装

### 从 GitHub

```sh
dsh plugin --profile web add 'github:dream12347/dsh-delete-session#v0.1.0'
```

### 从本地目录

```sh
dsh plugin --profile web add /absolute/path/to/dsh-delete-session
```

### 从 tarball

```sh
pnpm pack
dsh plugin --profile web add /absolute/path/to/dsh-delete-session-0.1.0.tgz
```

安装完成后**重启** `dsh web`（host 插件与客户端 bundle 需要重启加载）。

## 使用

1. 打开侧边栏底部 **设置**（齿轮图标）
2. 左侧导航出现独立的 **会话管理** 分栏，点击进入
3. 主列表为未归档会话；底部「已归档会话」折叠区可展开查看并删除归档会话
4. 点击 **删除**，确认后立即删除

## 工作原理

| 层 | 实现 |
|---|---|
| Host | `src/index.ts` 注册 webserver 路由 `POST /dsh-delete-session/delete`，通过 `ctx.sessionPersistence` 定位会话、`ctx.workspaceRegistry` 先归档（触发官方广播让所有客户端立即隐藏该会话）、再物理删除日志目录；`ctx.agents` 检测运行中的会话并拒绝删除 |
| Client | `src/client/index.ts` 通过官方 `settings.section` 插槽注册独立分栏，用 `useSessions` / `useWorkspaces` 标准数据源列出会话（含归档分组），删除调用 host 路由；已删除会话 id 记录在浏览器 localStorage，避免 live 会话删除后刷新「复活」 |

- 删除时先走官方归档通道：侧边栏立即隐藏该会话
- 工作区记账（`sessionIds` 槽位 / 归档集合）在下次启动时由 registry 重建索引自动对账，无需手动编辑文件
- 无系统提示词改动、无模型工具新增，对 token 与模型行为零影响

## 限制

- **不能删除正在运行的会话**（按钮禁用并拒绝删除），多标签页场景请先在别处确认该会话已停止
- 子代理会话不可删除
- live 会话（当前进程内打开的会话）删除后，其内存状态由 DSH 在重启时彻底清理；已删除 id 在浏览器 localStorage 中有记录，避免刷新后重新出现

## 兼容性

当前版本适配 DSH `0.1.0-rc.6`（依赖 `settings.section` 插槽与 `ctx.sessionPersistence` / `ctx.workspaceRegistry` / `ctx.agents` 服务）。DSH 版本升级后如插槽或服务 API 变化，需要同步适配。

## 开发

```sh
pnpm install        # 安装依赖（@deepseek-ai 系列为 link 本地开发依赖）
pnpm run check      # typecheck + test + build
```

`lib/` 为提交的构建产物，修改源码后必须重新构建并提交 `lib/`。
