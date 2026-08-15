# dsh-delete-session

[English](README.en.md) | 中文

在 DeepSeek Harness Web 界面中全面**管理会话**的插件：设置页与对话顶部均提供入口，支持删除（回收站可恢复或彻底清除）、恢复已归档会话、查看近期活动统计、继续/暂停会话、打开日志目录，不修改 DSH 核心代码。

<sub><span style="opacity:.6">本项目由 dsh + Deepseek-V4-Flash0731 独立完成</span></sub>

## 功能

- 设置页新增独立的「会话管理」分栏（与 Notifications 同级的设置分区）
- 面板列出全部会话（标题 / 工作目录），底部折叠区单独展示**已归档会话**，支持**一键恢复**回到会话列表
- **回收站**：删除的会话移入回收站（保留最近 10 条，超出自动清除最早一条），可**恢复**或**彻底删除**
- **统计**：每个会话可展开查看近期活动统计（轮次 / 用户消息 / 助手消息 / 工具调用 / 活动窗口）
- **继续会话**：一键打开会话并关闭面板；**暂停**：停止正在运行会话的当前回合
- **文件夹**：在系统文件管理器中打开会话日志目录
- **删除本对话**：对话顶部右侧红色按钮，一键删除当前对话（Session log 左侧）
- **对话管理 / 回收站**：对话顶部入口，打开自绘右侧抽屉（图钉固定常驻、点击外部自动收起）
- 删除限制：仅禁止删除「正在思考」的会话；当前打开的会话（空闲）可删除
- 子代理（subagent）功能不受影响：其会话由 DSH 委派机制管理，本插件不提供删除入口（子代理需在其父会话中结束/清理）
- 中英文界面自适应（跟随页面语言）

## 安装

### 从 GitHub

```sh
dsh plugin --profile web add 'github:dream12347/dsh-delete-session#v0.1.3'
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

### 设置页会话管理

1. 打开侧边栏底部 **设置**（齿轮图标）
2. 设置页面左侧导航出现独立的 **会话管理** 分栏，点击进入
3. 主列表为未归档会话；底部「已归档会话」折叠区可展开查看、**恢复**或删除归档会话
4. 删除会话 → 进入底部「回收站」折叠区（保留最近 10 条）
5. 回收站内可 **恢复**（回到会话列表）或 **彻底删除**（永久清除，不可恢复）
6. 每行操作：**继续会话**（打开并进入对话）、**暂停**（停止正在运行的回合）、**统计**（展开近期活动）、**文件夹**（打开日志目录）、**删除**

### 对话顶部快捷入口

任意对话页右上角（Session log 左侧）：
- **对话管理**：打开会话管理抽屉（完整列表 + 已归档 + 回收站），图钉可固定常驻，点击外部自动收起
- **回收站**：打开抽屉并直接展开回收站
- **删除本对话**（红色）：确认后删除当前对话（移入回收站）

## 工作原理

| 层 | 实现 |
|---|---|
| Host | `src/index.ts` 注册 4 条路由：`POST /delete`（归档 + 非 live 会话文件移入回收站 + 记录条目）、`POST /restore`（文件移回 + 取消归档 + 删除条目）、`POST /purge`（清除回收站与原位置文件 + 删除条目）、`GET /trash`（回收站列表）。通过 `ctx.sessionPersistence` 定位会话、`ctx.workspaceRegistry` 归档/取消归档、`ctx.storageDomain` 持久化回收站条目与归档集合；`ctx.agents` 检测运行中的会话并拒绝删除 |
| Client | `src/client/index.ts` 通过官方 `settings.section` 插槽注册独立分栏，用 `useSessions` / `useWorkspaces` 标准数据源列出会话（含归档/回收站分组），删除/恢复/彻底删除调用 host 路由；彻底删除的会话 id 记录在浏览器 localStorage，避免 live 会话删除后刷新「复活」 |

- 删除时先走官方归档通道：侧边栏立即隐藏该会话
- 回收站条目持久化在 DSH 存储域（`~/.dsh/storages/dsh_delete_session.json`），文件在 `~/.dsh/dsh-delete-session-trash/`
- 工作区记账（`sessionIds` 槽位）在下次启动时由 registry 重建索引自动对账，无需手动编辑文件
- 无系统提示词改动、无模型工具新增，对 token 与模型行为零影响

## 限制

- **不能删除正在运行的会话**（按钮禁用并拒绝删除），多标签页场景请先在别处确认该会话已停止
- 子代理会话不可删除
- live 会话（当前进程内打开的会话）删除后，其内存状态由 DSH 在重启时彻底清理
- 已彻底删除的会话 id 会保留在浏览器 localStorage（防止刷新后重新出现）与归档集合中（无害残留，不显示）

## 兼容性

当前版本适配 DSH `0.1.0-rc.6`（依赖 `settings.section` 插槽与 `ctx.sessionPersistence` / `ctx.workspaceRegistry` / `ctx.agents` / `ctx.storageDomain` 服务）。DSH 版本升级后如插槽或服务 API 变化，需要同步适配。

## 开发

```sh
pnpm install        # 安装依赖（@deepseek-ai 系列为 link 本地开发依赖）
pnpm run check      # typecheck + test + build
```

`lib/` 为提交的构建产物，修改源码后必须重新构建并提交 `lib/`。
