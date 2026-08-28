/**
 * dsh-restart-guard —— 插件升级热重载引擎（移植自 dsh-hot-reload v0.2.4）
 *
 * 监听 profile 的 pnpm-lock.yaml；已加载插件包版本变化时，使模块缓存失效、
 * 重新导入、原地替换运行中的插件 fiber（cordis-plugin-loader 内部 API，
 * 与 cordis-plugin-hmr 同技术但触及 node_modules）。失败回滚旧版本并
 * 通过 hooks.onRestartNeeded 通知守卫登记重启。
 *
 * 设计不变量（继承自 dsh-hot-reload）：
 *  - reload 循环串行化（running promise 链）
 *  - snapshot() 唯一分类点；版本在 import 时捕获
 *  - TERMINAL（尝试过且失败）记 failedVersions 永不重试；retryable 下次重试
 *  - 失败回滚旧插件（永不留下死插件）
 *  - 通知加法式：report() 吞错、路由注册 catch 返回 no-op、ctx.inject 注册最后
 *  - 自 reload 顺序：导入新模块 → 提交+持久化版本 → 关 watcher → selfReloading → swap
 *  - state 文件 .tmp + rename 原子写；启动 fail-loud
 *  - 无 loader.internal / 目录不可解析 / dsh.hotReload:false → 降级「提示重启」
 */
import { watch } from 'chokidar'
import { readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const cjsRequire = createRequire(import.meta.url)
const EVENTS_ENDPOINT = '/restart-guard/events'
const STATE_FILE = '.dsh-hot-reload-state.json'
const TERMINAL = Symbol('dsh-restart-guard:terminal')

/**
 * @param ctx     激活的插件上下文
 * @param config  { debounce?, profileDir?, log? }
 * @param hooks   整合钩子：{ onRestartNeeded(pkg, version, reason) }
 * @returns       { dispose(), status() }
 */
export function createReloader(ctx, config = {}, hooks = {}) {
  const log = config.log ?? ctx.logger ?? console
  const loader = ctx.loader
  const internal = loader?.internal
  const debounceMs = Number(config.debounce ?? 300)
  const onRestartNeeded = hooks.onRestartNeeded ?? (() => {})

  if (!loader || typeof loader.entries !== 'function') {
    log.warn?.('dsh-restart-guard: no loader on context; reload engine inactive')
    return null
  }
  if (!internal) {
    log.warn?.('dsh-restart-guard: loader.internal unavailable — upgrades degrade to restart-needed notices (no live reload)')
  }

  const profileDir = resolveProfileDir(ctx, config)
  if (!profileDir) {
    log.warn?.('dsh-restart-guard: could not locate profile dir (set config.profileDir); reload engine inactive')
    return null
  }
  const lockfile = join(profileDir, 'pnpm-lock.yaml')
  const nodeModules = join(profileDir, 'node_modules')
  const stateFile = join(profileDir, STATE_FILE)
  if (!existsSync(lockfile)) {
    log.warn?.(`dsh-restart-guard: no pnpm-lock.yaml at ${lockfile} — is this the profile dir? set config.profileDir to fix.`)
  }

  // ---- 通知（stderr + SSE；加法式，绝不抛入循环） ----
  const connections = new Set()
  const report = (kind, message) => {
    try {
      if (kind === 'reloaded') log.info?.(`dsh-restart-guard: ${message}`)
      else log.warn?.(`dsh-restart-guard: ${message}`)
    } catch {}
    try {
      process.stderr.write(`dsh-restart-guard: ${message}\n`)
    } catch {}
    if (!connections.size) return
    const line = `data: ${JSON.stringify({ type: 'notice', kind, text: message })}\n\n`
    for (const res of connections) {
      try { res.write(line) } catch {}
    }
  }

  // ---- package <-> loader-entry helpers ----
  const pkgOf = (specifier) => {
    if (typeof specifier !== 'string' || !specifier || specifier.startsWith('.') || specifier.startsWith('cordis:')) return null
    if (specifier.startsWith('@')) {
      const [scope, pkg] = specifier.split('/')
      return scope && pkg ? `${scope}/${pkg}` : null
    }
    return specifier.split('/')[0]
  }
  const readPkgJson = (pkg) => {
    try { return JSON.parse(readFileSync(join(nodeModules, pkg, 'package.json'), 'utf8')) } catch { return null }
  }
  const versionOf = (pkg) => readPkgJson(pkg)?.version ?? null
  const entries = () => {
    try { return [...loader.entries()] } catch { return null }
  }
  const snapshot = () => {
    const list = entries()
    if (!list) return null
    const pkgs = Object.create(null)
    const seenRuntimes = new Map()
    for (const e of list) {
      if (e?.options?.group || e?.disabled) continue
      const pkg = pkgOf(e?.options?.name)
      if (!pkg) continue
      let rec = pkgs[pkg]
      if (!rec) {
        const json = readPkgJson(pkg)
        rec = pkgs[pkg] = { json, version: json?.version ?? null, live: [], fiberless: 0 }
        seenRuntimes.set(pkg, new Set())
      }
      const runtime = e?.fiber?.runtime
      if (!runtime) rec.fiberless += 1
      else if (!seenRuntimes.get(pkg).has(runtime)) {
        seenRuntimes.get(pkg).add(runtime)
        rec.live.push(e)
      }
    }
    return pkgs
  }
  const currentVersions = (snap) => {
    const map = Object.create(null)
    for (const pkg in snap) map[pkg] = snap[pkg].version
    return map
  }

  // ---- reload primitives ----
  const resolveUrl = async (specifier, parentURL) => {
    const attrs = {}
    let res
    try {
      switch (internal.version) {
        case 'v1': res = await internal.resolve(specifier, parentURL, attrs); break
        case 'v2': res = internal.resolveSync(parentURL, { specifier, attributes: attrs }); break
        default:
          if (typeof internal.resolve === 'function') res = await internal.resolve(specifier, parentURL, attrs)
          else if (typeof internal.resolveSync === 'function') res = internal.resolveSync(parentURL, { specifier, attributes: attrs })
          else throw new Error('loader.internal exposes no resolver')
      }
    } catch {
      return null
    }
    return typeof res === 'string' ? res : res?.url
  }
  const invalidate = (url) => {
    try { Map.prototype.delete.call(internal.loadCache, url) } catch {}
    try {
      const fp = fileURLToPath(url)
      if (cjsRequire.cache[fp]) delete cjsRequire.cache[fp]
    } catch {}
  }
  const packageRootUrlOf = (url) => {
    try {
      let dir = dirname(fileURLToPath(url))
      for (;;) {
        if (existsSync(join(dir, 'package.json'))) {
          const href = pathToFileURL(dir).href
          return href.endsWith('/') ? href : `${href}/`
        }
        const parent = dirname(dir)
        if (parent === dir) return null
        dir = parent
      }
    } catch { return null }
  }
  const invalidateTree = (rootUrl) => {
    if (!rootUrl) return
    try {
      for (const u of Map.prototype.keys.call(internal.loadCache)) {
        if (typeof u === 'string' && u.startsWith(rootUrl)) Map.prototype.delete.call(internal.loadCache, u)
      }
    } catch {}
    try {
      const rootPath = fileURLToPath(rootUrl)
      for (const fp of Object.keys(cjsRequire.cache)) {
        if (fp.startsWith(rootPath)) delete cjsRequire.cache[fp]
      }
    } catch {}
  }

  let disposed = false
  let watcher = null
  let watcherClosed = false
  let selfReloading = false
  let timer = null
  let pending = false
  let running = Promise.resolve()

  /** 原地重载一个 entry；失败时回滚旧插件后抛出 */
  async function reloadEntry(entry, pkg) {
    const specifier = entry?.options?.name
    const parentURL = entry?.parent?.tree?.ctx?.baseUrl ?? ctx.baseUrl
    const oldFiber = entry.fiber
    const runtime = oldFiber?.runtime
    const oldPlugin = runtime?.callback
    if (!oldPlugin || !runtime) throw new Error(`no live fiber for ${specifier}`)
    const url = await resolveUrl(specifier, parentURL)
    if (!url) throw new Error(`could not resolve ${specifier}`)
    const rootUrl = packageRootUrlOf(url)
    if (rootUrl) invalidateTree(rootUrl)
    else invalidate(url)
    const importedVersion = versionOf(pkg)
    const newPlugin = loader.unwrapExports(await loader.import(url, getOuterStack()))
    if (!newPlugin) throw new Error(`fresh import produced no plugin for ${specifier}`)
    if (disposed) throw new Error('dsh-restart-guard disposed mid-reload')
    const isSelf = pkg === 'dsh-restart-guard'
    if (isSelf) {
      versions[pkg] = importedVersion
      delete failedVersions[pkg]
      delete noticedVersions[pkg]
      persistState()
      await closeWatcher()
      selfReloading = true
    }
    const fibers = [...runtime.fibers]
    ctx.registry.delete(oldPlugin)
    try {
      const fresh = fibers.map((of) => reattach(newPlugin, of))
      await Promise.all(fresh.map((f) => f?.await?.()))
      if (disposed) throw new Error('dsh-restart-guard disposed mid-reload')
    } catch (err) {
      try { ctx.registry.delete(newPlugin) } catch {}
      if (disposed) throw err
      const restored = []
      for (const of of fibers) {
        try { restored.push(reattach(oldPlugin, of)) } catch {}
      }
      try { await Promise.all(restored.map((f) => f?.await?.())) } catch {}
      throw err
    }
    return importedVersion
  }
  function reattach(plugin, oldFiber) {
    const fiber = oldFiber.parent.registry.plugin(plugin, oldFiber._config, getOuterStack())
    fiber.entry = oldFiber.entry
    if (fiber.entry) fiber.entry.fiber = fiber
    return fiber
  }

  async function handlePackage(pkg, rec) {
    const { version, live, fiberless } = rec
    if (rec.json?.dsh?.hotReload === false) {
      report('stale', `${pkg}@${version} sets dsh.hotReload:false — restart dsh to load the new version`)
      return version
    }
    if (!internal) {
      report('stale', `${pkg}@${version} changed — restart dsh to load the new version`)
      return version
    }
    if (!live.length) {
      if (!fiberless) return version
      if (noticedVersions[pkg] !== version) {
        noticedVersions[pkg] = version
        report('stale', `${pkg}@${version} has no live fiber to reload right now — restart dsh if it stays on the old version`)
      }
      return false
    }
    if (fiberless) log.warn?.(`dsh-restart-guard: ${pkg}@${version}: skipping ${fiberless} entry(ies) with no live fiber`)
    try {
      let committed = null
      for (const entry of live) {
        if (disposed) return false
        const imported = await reloadEntry(entry, pkg)
        if (committed && imported !== committed) {
          log.info?.(`dsh-restart-guard: ${pkg} changed again mid-reload — re-checking on the next change`)
          return false
        }
        committed ??= imported
      }
      committed ??= version
      report('reloaded', `hot-reloaded ${pkg}@${committed} (${live.length} module(s))`)
      return committed
    } catch (err) {
      if (disposed) return false
      report('failed', `could not hot-reload ${pkg}@${version} — not retrying; restart dsh (or install a different version) to load it`)
      log.warn?.(err)
      return TERMINAL
    }
  }

  // ---- 持久化状态 ----
  const toNullProto = (obj) => {
    const out = Object.create(null)
    if (obj && typeof obj === 'object') for (const key in obj) out[key] = obj[key]
    return out
  }
  const loadState = () => {
    let raw
    try { raw = JSON.parse(readFileSync(stateFile, 'utf8')) } catch { return null }
    const versions = raw && typeof raw.versions === 'object' && raw.versions ? toNullProto(raw.versions) : null
    return {
      versions,
      failedVersions: toNullProto(raw?.failedVersions),
      noticedVersions: toNullProto(raw?.noticedVersions),
    }
  }
  const persistState = () => {
    const payload = JSON.stringify({ versions, failedVersions, noticedVersions }, null, 2)
    const tmp = `${stateFile}.tmp`
    try {
      writeFileSync(tmp, payload)
      renameSync(tmp, stateFile)
    } catch (err) {
      throw new Error(`dsh-restart-guard: cannot persist reload state to ${stateFile}: ${err?.message ?? err}`, { cause: err })
    }
  }
  const closeWatcher = async () => {
    if (watcherClosed || !watcher) return
    watcherClosed = true
    try { await watcher.close() } catch {}
  }

  const boot = snapshot()
  const persisted = loadState()
  let versions = persisted?.versions ?? null
  if (!versions) {
    versions = boot ? currentVersions(boot) : null
  } else if (boot) {
    const bootVersions = currentVersions(boot)
    for (const pkg in bootVersions) {
      if (bootVersions[pkg] != null) versions[pkg] = bootVersions[pkg]
    }
  }
  const failedVersions = persisted?.failedVersions ?? Object.create(null)
  const noticedVersions = persisted?.noticedVersions ?? Object.create(null)

  try {
    persistState()
  } catch (err) {
    // 与上游一致：state 不可写 = fail-loud（拒绝启动引擎而非内存态运行）
    throw err
  }

  // ---- 变化处理 ----
  async function runCycle() {
    if (disposed) return
    const snap = snapshot()
    if (!snap) return
    if (!versions) {
      versions = currentVersions(snap)
      return
    }
    for (const pkg in snap) {
      if (disposed) return
      const version = snap[pkg].version
      if (!version) {
        if (!(pkg in versions)) versions[pkg] = null
        continue
      }
      if (!(pkg in versions)) {
        if (!snap[pkg].live.length) {
          versions[pkg] = version
          continue
        }
      }
      if (versions[pkg] === version) continue
      if (failedVersions[pkg] === version) continue
      const commit = await handlePackage(pkg, snap[pkg])
      if (commit === TERMINAL) {
        failedVersions[pkg] = version
        persistState()
        // ---- 整合闭环：热重载失败 → 通知守卫登记重启 ----
        onRestartNeeded(pkg, version)
      } else if (commit) {
        versions[pkg] = commit
        delete failedVersions[pkg]
        delete noticedVersions[pkg]
        persistState()
      }
    }
    let dropped = false
    for (const pkg of Object.keys(versions)) {
      if (!(pkg in snap)) {
        delete versions[pkg]
        delete failedVersions[pkg]
        delete noticedVersions[pkg]
        dropped = true
      }
    }
    if (dropped) persistState()
  }

  const trigger = () => {
    if (disposed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (pending) return
      pending = true
      running = running
        .then(() => {
          pending = false
          return runCycle()
        })
        .catch((e) => log.warn?.('dsh-restart-guard: reload cycle error', e))
    }, debounceMs)
  }

  watcher = watch(lockfile, { ignoreInitial: true })
  watcher.on('change', trigger)
  watcher.on('add', trigger)
  watcher.on('error', (e) => log.warn?.('dsh-restart-guard: watcher error', e))

  ctx.effect(() => async () => {
    if (selfReloading) {
      running.catch(() => {})
      return
    }
    disposed = true
    if (timer) clearTimeout(timer)
    running.catch(() => {})
    await closeWatcher()
  })

  // ---- 通知通道（最后注册 + 包裹：通知面失败绝不影响 reload 引擎） ----
  try {
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(() => {
        let disposeRoute
        try {
          disposeRoute = webCtx.webServer.register({
            kind: 'exact',
            path: EVENTS_ENDPOINT,
            handler: (req, res) => {
              if (req.method === 'HEAD') {
                res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
                res.end()
                return
              }
              if (req.method !== 'GET') {
                res.writeHead(405)
                res.end()
                return
              }
              res.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
              })
              res.write(': connected\n\n')
              connections.add(res)
              res.on('close', () => connections.delete(res))
            },
          })
        } catch (err) {
          log.warn?.('dsh-restart-guard: could not register the notice channel; web notices are disabled')
          log.warn?.(err)
          return () => {}
        }
        return () => {
          disposeRoute()
          for (const res of connections) {
            try { res.destroy() } catch {}
          }
          connections.clear()
        }
      }, 'dsh-restart-guard: notice channel')
    })
  } catch (err) {
    log.warn?.('dsh-restart-guard: could not set up the notice channel; web notices are disabled')
    log.warn?.(err)
  }

  log.info?.(`dsh-restart-guard: watching ${lockfile} (${Object.keys(versions ?? {}).length} plugin package(s) tracked)`)

  return {
    dispose: closeWatcher,
    status: () => ({
      watching: !watcherClosed && watcher !== null,
      lockfile,
      tracked: Object.keys(versions ?? {}).length,
      failedVersions: { ...failedVersions },
      endpoint: EVENTS_ENDPOINT,
    }),
  }
}

/** 与上游一致：取外层调用栈（loader 诊断用），空实现可接受 */
function getOuterStack() {
  return []
}

function resolveProfileDir(ctx, config) {
  if (config.profileDir) return config.profileDir
  try {
    if (ctx.baseUrl) return fileURLToPath(new URL('.', ctx.baseUrl)).replace(/\/$/, '')
  } catch {}
  return null
}
