# dsh-restart-guard

DSH 重启管理（v1.0，**整合 dsh-hot-reload**）：**非必要不重启，最小化热更新**。插件升级自动热重载，热重载失败与残余重启由守卫聚批、空闲后自动执行。

## 重启决策树

| 改动类型 | 处理者 |
|---|---|
| client bundle 源码（`lib/client.js` 等） | 原生热更新——`/plugins/<id>/client.js` 实时读文件，**刷新浏览器即生效** |
| `cordis.patch.yml`（profile / home） | 原生 HMR watcher 事务性热重载，**写入即生效** |
| 插件包**升级**（已加载） | **内置热重载引擎**（watch `pnpm-lock.yaml`，loader 内部 API 原地替换 fiber，失败回滚） |
| 热重载失败 | **自动登记重启**（内部闭环，无需外部接线） |
| 插件**新增 / 移除**、host 代码、`cordis.yml` | 守卫编排：合并窗口聚批 → 空闲后自动重启 |
| 实验性 host 代码 | 用动态插件（`cordis_define`/`run`/`update`）进程内热插拔 |

## 功能

- **热重载引擎**（`lib/reload.js`，移植自 dsh-hot-reload v0.2.4）：
  - chokidar watch `pnpm-lock.yaml`（300ms 去抖）→ 版本 diff → 已加载包热重载（模块缓存失效 → 重新导入 → 每个 fiber 原地替换）
  - 失败**回滚旧版本**（永不留下死插件）；尝试过且失败的版本记 `failedVersions` 不重试
  - 失败 → 回调守卫自动登记重启（`热重载失败 <pkg>@<ver>，需要重启`）
  - 自升级（本插件版本变化）原地自 reload
  - 状态原子持久化（`.dsh-hot-reload-state.json`）
- **重启守卫**：
  - `request(reason, {kind, force})` 登记；合并窗口（默认 60s）聚批为一次重启
  - **force 模式**：`{force:true}` → 合并窗口 5s、空闲轮询 1s、**无超时**——当前回合结束后立即重启（不打断回合）
  - 空闲检测（`agents` 服务 status）；非 force 超时后 15s 重试（防饿死）
  - **自动重启复刻 dsh-app.ps1 启动链**（`cmd /c pnpm dsh web > dsh-web.log 2>&1`，cwd=DeepSeek-Harness）——与手动启动完全一致
  - **双保险**：spawn 失败 / 新进程已退出 → 旧进程**保持运行**（不自杀）+ state 记录 stage
  - 子进程输出重定向 `dsh-restart-guard-state.child.log`（fd 重定向，父退出后仍可读）——失败原因可查
- **改动分类**：`classify(path)` 判断热更新 vs 必须重启
- **HTTP API**（webServer 探测注册；无 webServer 的 profile 不挂起）：
  - `GET /restart/status` — 状态、待重启、历史、`lastRestart`（重启证据）、引擎状态
  - `POST /restart/request` — `{ reason, kind, force }`
  - `POST /restart/cancel` — `{ id }`（省略 = 取消整批）
  - `POST /restart/now` — 立即强制重启
  - `GET /restart/classify?path=...` — 改动分类
  - `GET /restart-guard/events` — 热重载通知 SSE 通道

## 诊断文件（`~/.dsh/`）

| 文件 | 内容 |
|---|---|
| `dsh-restart-guard-state.json` | 上次重启证据：`{ last: { at, reasons, via, stage } }`——`via:auto` = 自动重启；`stage` = spawning / spawn-error / child-exited / booted |
| `dsh-restart-guard-state.child.log` | 自动重启新进程的完整输出（fd 重定向，崩溃原因可查） |
| `profiles/<profile>/.dsh-hot-reload-state.json` | 热重载引擎状态：`{ versions, failedVersions, noticedVersions }` |

## 安装

```sh
pnpm dsh plugin --profile <profile名> add link:/path/to/dsh-restart-guard
# 或 git 安装
pnpm dsh plugin --profile <profile名> add <git URL>
# 需要一次重启启用（安装本身属于「插件集合变更」）
```

前置：依赖 `chokidar`（包内自带）；需要 `@deepseek-ai/cordis-plugin-loader` 的 `loader.internal`（web profile 默认具备；缺失时引擎降级为「提示重启」）。

## 配置

`cordis.patch.yml` 的 entry config 段可覆盖（默认值见 `index.js` `DEFAULTS`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `mergeWindowMs` | `60000` | 待重启合并窗口（ms） |
| `forceMergeMs` | `5000` | force 请求的合并窗口（ms） |
| `idleWaitMs` | `300000` | 最长等待空闲（ms），超时后 15s 重试；force 无超时 |
| `idlePollMs` / `forcePollMs` | `3000` / `1000` | 空闲轮询间隔（ms） |
| `exitDelayMs` | `2000` | spawn 新进程后退出本进程的延迟（ms） |
| `autoRestart` | `true` | 空闲后自动重启；`false` 仅登记 |
| `debounce` | `300` | 热重载引擎 lockfile 去抖（ms） |

## 在插件里使用

```js
const guard = ctx.get('restartGuard')
if (guard !== undefined) guard.request('新增了 xxx 插件包', { kind: 'plugin-set' })
// force：当前回合结束后立即重启
guard.request('部署 1.2.0', { kind: 'deploy', force: true })
```

## 限制

- 热重载不检测静默泄漏（插件裸 `setInterval`/socket 无 disposer 会悬空）——插件应使用 `ctx.effect`/`ctx.timeout` 等 fiber 感知 API
- 重启 = 派生同参数新进程并退出本进程；外部 supervisor（systemd 等）管理时应设 `autoRestart:false`
- 引擎只 watch `pnpm-lock.yaml`——`link:` 安装的本地插件改版本号不更新 lockfile，不会触发（registry 包升级正常触发）
- 重启/重载历史仅持久化在 state 文件（`last` 与版本表）

## 验证记录

```jsonc
// 热重载实测（改 dsh-subagent-free-router version 0.3.8→0.3.12 + touch lockfile）：
{ "log": "dsh-restart-guard: hot-reloaded dsh-subagent-free-router@0.3.12 (1 module(s))" }
{ "state.versions": { "dsh-subagent-free-router": "0.3.12" } }   // 版本已提交，无需重启

// 引擎激活状态：
{ "reloadEngine": { "active": true, "watching": true, "tracked": 164, "failedVersions": {} } }
```
