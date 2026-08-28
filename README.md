# dsh-restart-guard

DSH 重启守卫：**非必要不重启，最小化热更新**。聚批待重启原因、等会话空闲后自动重启、提供改动分类判断与 HTTP API。

## 为什么需要它

DSH 的多数改动其实**不需要重启进程**：

| 改动 | 生效方式 | 是否重启 |
|---|---|---|
| client bundle 源码（`lib/client.js` 等） | `/plugins/<id>/client.js` 实时读文件 + 内容哈希 rev | ❌ 刷新浏览器即可 |
| `cordis.patch.yml`（profile / home） | app-boot HMR watcher 事务性热重载 | ❌ 写入即生效 |
| 实验性 host 代码 | 用**动态插件**（`cordis_define` / `run` / `update` / `rollback`）进程内热插拔 | ❌ 无需重启 |
| credentials / llm 动态配置 | 每次操作重新解析 | ❌ 无需重启 |
| 新增 / 移除插件包 | loader 元数据缓存（never expire） | ✅ 需要重启 |
| host entry 代码（`index.js` 等） | boot 加载 + Node 模块缓存 | ✅ 需要重启 |
| 组成文件（`cordis.yml`） | boot 解析 | ✅ 需要重启 |

真正需要重启的改动才值得重启——`dsh-restart-guard` 把这些重启**聚批、延后到空闲、自动执行**。

## 功能

- **登记制**：其他插件 / 工具 / HTTP 调用 `restartGuard.request('原因')` 登记待重启
- **合并窗口**（默认 60s）：窗口内多次请求聚批为**一次**重启，避免连环重启
- **空闲等待**（默认 5min）：无 running agent 时执行重启；超时**自动取消并保留登记**——绝不打断活跃会话
- **自动重启**：以相同启动参数（含 `execArgv`）detached 派生新进程后退出本进程
- **改动分类**：`restartGuard.classify(path)` 判断某文件改动是热更新还是必须重启
- **HTTP API**（`webServer` 可选探测，CLI 环境自动降级）：
  - `GET /restart/status` — 当前状态、待重启原因、历史、热更新提示
  - `POST /restart/request` — `{ reason, kind }` 登记
  - `POST /restart/cancel` — `{ id }` 取消（省略 id = 取消整批）
  - `POST /restart/now` — `{ reason }` 强制立即重启
  - `GET /restart/classify?path=...` — 改动分类判断

## 状态机

```
idle ──request()──▶ waiting-merge ──窗口到──▶ waiting-idle ──空闲──▶ restarting ──▶ 新进程
                      │                        │
                      │ cancel(整批)            │ idleWaitMs 超时
                      ▼                        ▼
                     idle ◀──────────────────── idle（保留登记）
```

## 安装

```sh
pnpm dsh plugin --profile <profile名> add link:/path/to/dsh-restart-guard
# 或从 git 安装
pnpm dsh plugin --profile <profile名> add <git URL>
# 需要一次重启启用（安装本身属于「插件集合变更」）
```

## 配置

`cordis.yml` 的 entry config 段可覆盖（默认值见 `index.js` `DEFAULTS`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `mergeWindowMs` | `60000` | 待重启合并窗口（毫秒） |
| `idleWaitMs` | `300000` | 最长等待空闲（毫秒），超时取消不强制 |
| `idlePollMs` | `3000` | 空闲轮询间隔 |
| `exitDelayMs` | `1500` | 派生新进程后退出本进程的延迟 |
| `autoRestart` | `true` | 空闲后自动重启；`false` 仅登记 |

## 在插件里使用

```js
// 其他插件：登记一次待重启（合并窗口内自动聚批）
const guard = ctx.get('restartGuard')
if (guard !== undefined) guard.request('新增了 xxx 插件包', { kind: 'plugin-set' })
```

## 限制

- 重启 = 派生同参数新进程并退出本进程；若 DSH 由外部 supervisor 管理（systemd 等），`autoRestart` 应设为 `false`，由 supervisor 负责拉起
- 重启瞬间正在进行的会话会被中断（本插件已尽量避开活跃会话；会话本身持久化，重启后可恢复）
- 重启历史仅内存保持
