'use strict'
/**
 * dsh-restart-guard —— DSH 重启守卫（v0.1.0）
 *
 * 目标：非必要不重启，最小化热更新。
 *
 * DSH 现有热更新能力（本插件只处理「真正需要重启」的改动）：
 *   - client bundle 内容（/plugins/<id>/client.js）：实时读文件 + rev 哈希 → 刷新浏览器即生效
 *   - cordis.patch.yml（profile / home）：app-boot 的 HMR watcher 事务性热重载
 *   - 动态插件（cordis_define / run / update / rollback）：进程内热插拔
 *   - credentials / llm 动态配置：每次操作重新解析
 * 需要进程重启的：
 *   - 新增 / 移除插件包（loader 元数据缓存，never expire）
 *   - host entry 代码改动（boot 加载 + Node 模块缓存）
 *   - 组成文件（cordis.yml）改动
 *
 * 本插件行为：
 *   1. request(reason) —— 其他插件/工具/HTTP 登记「待重启」原因；
 *   2. 合并窗口（mergeWindowMs，默认 60s）：窗口内多次请求聚批为一次重启；
 *   3. 空闲等待（idleWaitMs，默认 5min）：无 running agent 时执行重启；
 *      超时自动取消本次重启并保留登记（绝不打断活跃会话）；
 *   4. 自动重启：以相同 argv 派生新进程（detached）后退出本进程；
 *   5. classify(path) —— 改动分类判断：哪些热更新、哪些必须重启；
 *   6. /restart/* HTTP API。
 */

const name = 'dsh-restart-guard'
const inject = ['timer', 'webServer']

const DEFAULTS = {
  mergeWindowMs: 60000, // 合并窗口：待重启请求聚批时长
  idleWaitMs: 300000, // 最长等待空闲时间（超时取消，不强制）
  idlePollMs: 3000, // 空闲轮询间隔
  exitDelayMs: 1500, // spawn 新进程后退出本进程的延迟（端口释放）
  autoRestart: true, // 空闲后自动重启；false 时仅登记并提示
}

// ---- 改动分类表（非必要不重启） ----
function classifyPath(p, hotReloadInstalled = false) {
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
      // 若已装 dsh-hot-reload：已加载包的「升级」可热重载；新增/移除仍需重启
      hint: hotReloadInstalled
        ? '插件升级可被 dsh-hot-reload 热重载；新增/移除插件包仍需要重启'
        : '插件集合变更由 loader 元数据缓存管理——需要重启（安装 dsh-hot-reload 可使升级免重启）',
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

function apply(ctx, config) {
  const cfg = { ...DEFAULTS }
  // 允许从 entry 配置覆盖（cordis.yml 的 config 段）
  const configured = config
  if (configured && typeof configured === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      if (configured[key] !== undefined) cfg[key] = configured[key]
    }
  }

  // ---- 检测 dsh-hot-reload 是否活跃（升级类改动的热重载能力） ----
  // loader.entries 结构随版本变化且可能不可达——用文件系统检测（DSH_HOME/profiles/*）
  let hotReloadInstalled = false
  try {
    const fs = require('node:fs')
    const path = require('node:path')
    const os = require('node:os')
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const profilesDir = path.join(home, 'profiles')
    if (fs.existsSync(profilesDir)) {
      // 优先当前 profile（argv 中的 positional 参数，如 `dsh web` 的 web）
      const argv = process.argv || []
      let profileName = null
      for (const a of argv.slice(2)) {
        if (!a.startsWith('-') && !a.includes('=')) { profileName = a; break }
      }
      const direct = profileName
        ? path.join(profilesDir, profileName, 'node_modules', 'dsh-hot-reload', 'package.json')
        : null
      if (direct !== null && fs.existsSync(direct)) {
        hotReloadInstalled = true
      } else {
        // 兜底：扫描全部 profile
        for (const dir of fs.readdirSync(profilesDir)) {
          if (fs.existsSync(path.join(profilesDir, dir, 'node_modules', 'dsh-hot-reload', 'package.json'))) {
            hotReloadInstalled = true
            break
          }
        }
      }
    }
  } catch {}
  const classify = (p) => classifyPath(p, hotReloadInstalled)

  /** id -> { reason, kind, requester, createdAt } */
  const pending = new Map()
  /** { at, reasons[] } */
  const history = []
  /** 'idle' | 'waiting-merge' | 'waiting-idle' | 'restarting' */
  let state = 'idle'
  let mergeTimer = null
  let idleTimer = null
  let idlePoll = null
  let lastActivity = 0

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

  // ---- 重启执行 ----
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
    if (!cfg.autoRestart) {
      state = 'idle'
      return
    }
    // 以相同启动参数派生新进程（execArgv 保留 tsx 等 loader 参数）
    const args = [...(process.execArgv || []), ...(process.argv || []).slice(1)]
    let spawned = false
    try {
      const { spawn } = require('node:child_process')
      const child = spawn(process.execPath, args, {
        cwd: process.cwd(),
        detached: true,
        stdio: 'inherit',
        windowsHide: false,
      })
      child.unref()
      spawned = true
    } catch {}
    // 给新进程窗口，再退出本进程
    ctx.timeout(() => {
      try {
        process.exit(spawned ? 0 : 1)
      } catch {}
    }, cfg.exitDelayMs)
  }

  // ---- 状态机 ----
  const stopIdleWait = () => {
    if (idleTimer) { idleTimer.stop(); idleTimer = null }
    if (idlePoll) { idlePoll.stop(); idlePoll = null }
  }
  const startIdleWait = () => {
    state = 'waiting-idle'
    idleTimer = ctx.timeout(() => {
      // 等待超时：不打断活跃会话，取消本次重启、保留登记
      stopIdleWait()
      state = 'idle'
    }, cfg.idleWaitMs)
    idlePoll = ctx.setInterval(() => {
      if (state !== 'waiting-idle') { stopIdleWait(); return }
      if (isIdle()) executeRestart()
    }, cfg.idlePollMs)
    if (isIdle()) executeRestart()
  }
  const request = (reason, opts) => {
    const r = String(reason || '未说明原因')
    const id = `rg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    pending.set(id, {
      reason: r,
      kind: opts?.kind || 'manual',
      requester: opts?.requester || 'unknown',
      createdAt: Date.now(),
    })
    lastActivity = Date.now()
    if (state === 'idle') {
      state = 'waiting-merge'
      mergeTimer = ctx.timeout(() => {
        mergeTimer = null
        startIdleWait()
      }, cfg.mergeWindowMs)
    }
    return id
  }
  const cancel = (id) => {
    if (id !== undefined) {
      const removed = pending.delete(id)
      // 全部取消后复位状态机（否则合并窗口结束仍会触发重启）
      if (removed && pending.size === 0 && state === 'waiting-merge') {
        if (mergeTimer) { mergeTimer.stop(); mergeTimer = null }
        state = 'idle'
      }
      return removed
    }
    if (state === 'waiting-merge') {
      // 取消整批（合并窗口内）
      pending.clear()
      if (mergeTimer) { mergeTimer.stop(); mergeTimer = null }
      state = 'idle'
      return true
    }
    if (id === undefined && state === 'waiting-idle') {
      stopIdleWait()
      pending.clear()
      state = 'idle'
      return true
    }
    return false
  }
  const status = () => ({
    state,
    pending: [...pending.entries()].map(([id, p]) => ({ id, ...p })),
    history: history.slice(-10),
    config: { ...cfg },
    hotReloadInstalled,
    hotUpdateHints: {
      clientBundle: '改 client 代码 → 刷新浏览器即生效',
      profilePatch: '改 cordis.patch.yml → HMR 热重载',
      dynamicPlugin: '实验性 host 代码 → 用动态插件避免重启',
      pluginUpgrade: hotReloadInstalled ? '已装 dsh-hot-reload → 插件升级自动热重载' : '插件升级需重启（安装 dsh-hot-reload 可免）',
    },
  })
  const restartNow = (reason) => {
    request(reason || 'manual restartNow', { kind: 'forced' })
    // 强制：跳过合并与空闲等待
    if (mergeTimer) { mergeTimer.stop(); mergeTimer = null }
    startIdleWait()
    // 立即重启（不等空闲轮询）
    stopIdleWait()
    executeRestart()
    return true
  }

  // ---- service ----
  ctx.provide('restartGuard', { request, cancel, status, classify, restartNow })

  // ---- HTTP routes（webServer 可选） ----
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
        sendJson(res, 200, { ok: true, id: request(body?.reason, { kind: body?.kind, requester: 'http' }) })
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

module.exports = { apply, inject, name }
