/**
 * dsh-restart-guard —— DSH 重启管理（v1.0，整合 dsh-hot-reload）
 *
 * 目标：非必要不重启，最小化热更新。重启决策树：
 *   - client bundle 内容 → 原生热更新（刷新浏览器）
 *   - cordis.patch.yml → 原生 HMR 热重载
 *   - 插件包升级（已加载）→ 内置热重载引擎（lib/reload.js，watch pnpm-lock.yaml）
 *   - 热重载失败 → 自动登记重启（内部闭环）
 *   - 新增/移除插件、host 代码、cordis.yml → 守卫编排：合并窗口 + 空闲 + 自动重启
 *
 * 关键设计：
 *   - inject 仅 timer（webServer 用 ctx.inject/探测——模块级 inject webServer 会在
 *     无 webServer 的 profile 永久挂起）
 *   - 自动重启复刻 dsh-app.ps1 启动链（cmd /c pnpm dsh web）——与手动启动完全一致
 *   - force 模式：回合结束后 1s 轮询立即重启（不等长空闲）
 *   - spawn 失败/新进程退出 → 旧进程保持运行（不自杀）+ child.log 诊断
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, openSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { createReloader } from './lib/reload.js'

export const name = 'dsh-restart-guard'
export const inject = ['timer']

const DEFAULTS = {
  mergeWindowMs: 60000, // 合并窗口：待重启请求聚批时长
  forceMergeMs: 5000, // force 请求的合并窗口（短）
  idleWaitMs: 300000, // 最长等待空闲时间（超时取消，不强制）
  idlePollMs: 3000, // 空闲轮询间隔
  forcePollMs: 1000, // force 模式轮询间隔
  exitDelayMs: 2000, // spawn 新进程后退出本进程的延迟（端口释放）
  autoRestart: true, // 空闲后自动重启；false 时仅登记并提示
}

// ---- 改动分类表（非必要不重启） ----
function classifyPath(p, engineActive) {
  const path = String(p || '').replace(/\\/g, '/')
  const lower = path.toLowerCase()
  const base = lower.split('/').pop() || ''
  if (base.endsWith('.md') || base.endsWith('.txt')) {
    return { restart: false, kind: 'docs', hint: '文档改动，无需重启' }
  }
  if (base === 'client.js' || base.endsWith('/client.js') || lower.includes('/lib/client')) {
    return { restart: false, kind: 'hot-client', hint: 'client bundle 实时读取——刷新浏览器即生效，无需重启' }
  }
  if (base === 'cordis.patch.yml') {
    return { restart: false, kind: 'hot-patch', hint: 'profile patch 由 HMR watcher 热重载——写入即生效，无需重启' }
  }
  if (base === 'package.json' || lower.includes('node_modules')) {
    return {
      restart: true,
      kind: 'plugin-set',
      hint: engineActive
        ? '已加载插件的「升级」由内置热重载引擎自动处理（失败自动登记重启）；新增/移除插件包仍需要重启'
        : '插件集合变更由 loader 元数据缓存管理——需要重启',
    }
  }
  if (base === 'cordis.yml' || lower.endsWith('cordis.yml')) {
    return { restart: true, kind: 'composition', hint: '组成文件在 boot 解析——需要重启' }
  }
  if (base === 'index.js' || base.endsWith('.js') || base.endsWith('.ts')) {
    return { restart: true, kind: 'host-code', hint: 'host 代码在 boot 加载且受 Node 模块缓存——需要重启；实验阶段建议改用动态插件避免重启' }
  }
  return { restart: false, kind: 'unknown', hint: '无法判定的改动类型' }
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS }
  if (config && typeof config === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      if (config[key] !== undefined) cfg[key] = config[key]
    }
  }

  // ---- 状态 ----
  /** id -> { reason, kind, requester, createdAt, force } */
  const pending = new Map()
  /** { at, reasons[] } */
  const history = []
  /** 'idle' | 'waiting-merge' | 'waiting-idle' | 'restarting' */
  let state = 'idle'
  let mergeTimer = null
  let idleTimer = null
  let idlePoll = null

  // ---- 空闲检测（agents 服务：status idle|running） ----
  const isIdle = () => {
    const agents = ctx.get('agents')
    if (agents === undefined) return true
    try {
      return agents.list().every((a) => a.status !== 'running')
    } catch {
      return true
    }
  }

  // ---- 状态文件（重启证据 + 诊断） ----
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const stateFile = join(dshHome, 'dsh-restart-guard-state.json')
  const childLogFile = join(dshHome, 'dsh-restart-guard-state.child.log')
  const writeState = (obj) => {
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      writeFileSync(stateFile, JSON.stringify(obj, null, 2))
    } catch {}
  }

  // ---- 重启执行（复刻 dsh-app.ps1 启动链） ----
  const executeRestart = () => {
    if (state === 'restarting') return
    state = 'restarting'
    if (mergeTimer) { mergeTimer.stop(); mergeTimer = null }
    if (idleTimer) { idleTimer.stop(); idleTimer = null }
    if (idlePoll) { idlePoll.stop(); idlePoll = null }
    const reasons = [...pending.values()].map((p) => p.reason)
    pending.clear()
    history.push({ at: Date.now(), reasons })
    if (history.length > 50) history.shift()
    writeState({ last: { at: Date.now(), reasons, via: 'auto', stage: 'spawning' } })
    if (!cfg.autoRestart) {
      state = 'idle'
      return
    }
    // 与 dsh-app.ps1 完全一致的启动链：cmd /c pnpm dsh web（环境、日志文件一致）
    // 子进程输出重定向到 child.log（fd 重定向，父退出后仍有效）→ 失败原因可查
    let child = null
    let spawnError = null
    let logFd = null
    try {
      logFd = openSync(childLogFile, 'a')
    } catch {}
    try {
      const cmd = 'pnpm dsh web > dsh-web.log 2>&1'
      child = spawn('cmd.exe', ['/c', cmd], {
        cwd: process.cwd(),
        detached: true,
        stdio: logFd !== null ? ['ignore', logFd, logFd] : 'ignore',
        windowsHide: true,
      })
      child.on('error', (err) => {
        spawnError = String(err)
        writeState({ last: { at: Date.now(), reasons, via: 'auto', stage: 'spawn-error', spawnError } })
      })
      child.on('exit', (code, sig) => {
        writeState({ last: { at: Date.now(), reasons, via: 'auto', stage: 'child-exited', code, sig } })
      })
      child.unref()
    } catch (err) {
      spawnError = String(err)
      writeState({ last: { at: Date.now(), reasons, via: 'auto', stage: 'spawn-threw', spawnError } })
    }
    if (child === null) {
      state = 'idle'
      return
    }
    // 新进程存活才退出本进程；spawn 失败/新进程已退出则保持运行（不自杀）
    ctx.timeout(() => {
      if (spawnError !== null || child.exitCode !== null || child.signalCode !== null) {
        state = 'idle'
        return
      }
      try {
        process.exit(0)
      } catch {}
    }, cfg.exitDelayMs)
  }

  // ---- 状态机 ----
  const hasForce = () => [...pending.values()].some((p) => p.force === true)
  const stopIdleWait = () => {
    if (idleTimer) { idleTimer.stop(); idleTimer = null }
    if (idlePoll) { idlePoll.stop(); idlePoll = null }
  }
  const startIdleWait = () => {
    state = 'waiting-idle'
    const force = hasForce()
    // force：不设超时（直到成功或取消）；非 force：超时后 15s 重试（防饿死）
    if (!force) {
      idleTimer = ctx.timeout(() => {
        stopIdleWait()
        state = 'idle'
        if (pending.size > 0) {
          state = 'waiting-merge'
          mergeTimer = ctx.timeout(() => {
            mergeTimer = null
            startIdleWait()
          }, 15000)
        }
      }, cfg.idleWaitMs)
    }
    idlePoll = ctx.setInterval(() => {
      if (state !== 'waiting-idle') { stopIdleWait(); return }
      if (isIdle()) executeRestart()
    }, force ? cfg.forcePollMs : cfg.idlePollMs)
    if (isIdle()) executeRestart()
  }
  const request = (reason, opts) => {
    const r = String(reason || '未说明原因')
    const id = `rg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    const force = opts?.force === true
    pending.set(id, {
      reason: r,
      kind: opts?.kind || 'manual',
      requester: opts?.requester || 'unknown',
      createdAt: Date.now(),
      force,
    })
    if (state === 'idle') {
      state = 'waiting-merge'
      mergeTimer = ctx.timeout(() => {
        mergeTimer = null
        startIdleWait()
      }, force ? cfg.forceMergeMs : cfg.mergeWindowMs)
    }
    return id
  }
  const cancel = (id) => {
    if (id !== undefined) {
      const removed = pending.delete(id)
      if (removed && pending.size === 0 && state === 'waiting-merge') {
        if (mergeTimer) { mergeTimer.stop(); mergeTimer = null }
        state = 'idle'
      }
      return removed
    }
    if (state === 'waiting-merge') {
      pending.clear()
      if (mergeTimer) { mergeTimer.stop(); mergeTimer = null }
      state = 'idle'
      return true
    }
    if (state === 'waiting-idle') {
      stopIdleWait()
      pending.clear()
      state = 'idle'
      return true
    }
    return false
  }
  const status = () => {
    let lastRestart = null
    try {
      lastRestart = JSON.parse(readFileSync(stateFile, 'utf8')).last ?? null
    } catch {}
    const engine = reloader !== null ? reloader.status() : { active: false }
    return {
      state,
      pending: [...pending.entries()].map(([id, p]) => ({ id, ...p })),
      history: history.slice(-10),
      lastRestart,
      config: { ...cfg },
      reloadEngine: { active: reloader !== null, ...engine },
      hotUpdateHints: {
        clientBundle: '改 client 代码 → 刷新浏览器即生效',
        profilePatch: '改 cordis.patch.yml → HMR 热重载',
        dynamicPlugin: '实验性 host 代码 → 用动态插件避免重启',
        pluginUpgrade: reloader !== null ? '插件升级由内置热重载引擎自动处理；失败自动登记重启' : '插件升级需重启',
      },
    }
  }
  const restartNow = (reason) => {
    request(reason || 'manual restartNow', { kind: 'forced', force: true })
    if (mergeTimer) { mergeTimer.stop(); mergeTimer = null }
    startIdleWait()
    stopIdleWait()
    executeRestart()
    return true
  }

  // ---- 热重载引擎（整合 dsh-hot-reload） ----
  // 引擎失败（TERMINAL）→ 自动登记重启（内部闭环）
  const reloader = createReloader(ctx, config, {
    onRestartNeeded: (pkg, version) => {
      request(`热重载失败 ${pkg}@${version}，需要重启`, { kind: 'reload-failed' })
    },
  })
  const classify = (p) => classifyPath(p, reloader !== null)

  // ---- service ----
  ctx.provide('restartGuard', { request, cancel, status, classify, restartNow })

  // ---- HTTP routes（webServer 可选：ctx.get + 探测；无 webServer 的 profile 不挂起） ----
  const readBody = (req) => new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
  const sendJson = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(obj))
  }
  let uiRegistered = false
  const registerRoutes = (ws) => {
    if (uiRegistered) return
    ctx.effect(() => ws.register({ kind: 'exact', path: '/restart/status', handler: (req, res) => sendJson(res, 200, status()) }))
    ctx.effect(() => ws.register({
      kind: 'exact', path: '/restart/request',
      handler: async (req, res) => {
        const body = await readBody(req)
        sendJson(res, 200, {
          ok: true,
          id: request(body?.reason, { kind: body?.kind, requester: 'http', force: body?.force === true }),
        })
      },
    }))
    ctx.effect(() => ws.register({
      kind: 'exact', path: '/restart/cancel',
      handler: async (req, res) => {
        const body = await readBody(req)
        sendJson(res, 200, { ok: cancel(body?.id) })
      },
    }))
    ctx.effect(() => ws.register({
      kind: 'exact', path: '/restart/now',
      handler: async (req, res) => {
        const body = await readBody(req)
        restartNow(body?.reason)
        sendJson(res, 200, { ok: true, message: 'restarting…' })
      },
    }))
    ctx.effect(() => ws.register({
      kind: 'exact', path: '/restart/classify',
      handler: (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x')
        sendJson(res, 200, { path: url.searchParams.get('path') || '', ...classifyPath(url.searchParams.get('path') || '') })
      },
    }))
    uiRegistered = true
  }
  let webServer = ctx.get('webServer')
  if (webServer !== undefined) {
    registerRoutes(webServer)
  } else {
    let tries = 0
    const probe = ctx.setInterval(() => {
      webServer = ctx.get('webServer')
      if (webServer !== undefined) {
        registerRoutes(webServer)
        probe.stop()
      } else if (++tries >= 15) {
        probe.stop()
      }
    }, 2000)
  }
}
