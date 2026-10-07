// LanChat 局域网通讯桥：给 DSH 的 AI 提供原生工具
//
// 解决两个真实痛点：
//  1) 合并发送：AI 连发「文字 + 文件」时，若文字先单独到达，对面的 AI 会被立刻唤醒并开始处理，
//     随后到的文件就成了"另一件事"，被延迟甚至忽略 —— 明明是同一批。
//     这里在**发送侧**暂存：同一目标的内容攒够 batchWindowMs（默认 30 秒）没有新增，才作为一整批发出去；
//     对面收到的是一条消息、一个批次号，一次就能看全。也可以调用 lanchat_flush 立即送出。
//  2) 收到消息唤醒：轮询到新消息后不立刻打断本会话，而是等 wakeDebounceMs 内没有新消息、
//     且本 Agent 处于空闲状态时，才用 sessionController.prompt（mode=queue）把它作为一条用户消息投进来。
//     如果 AI 正在处理别的事务，就只入队、不打断，等它这一轮结束再处理。
//
// 注入的 Harness 服务：tools、agents、sessionController（可选，缺了就只读不能唤醒）
//
// 注意：本插件**只 import Node 内置模块**。插件是 junction 链接安装的，真实路径在工作区，
// 从那里解析不到 dsh 自带的包（@deepseek-ai/*），所以不能 import 它们 —— 下面自带一个
// 与 defineTool 等价的轻量实现，并用 createRequire 探测式加载 schemastery。

import { createRequire } from 'node:module'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** 同步 fs：ESM 里没有 require，用 createRequire 取一个（日志要同步落盘，不能丢） */
const fsSync = createRequire(import.meta.url)('node:fs')

/** Cordis 插件名（同时也是设置页里的配置命名空间）。 */
// exported for unit testing only: the plugin itself does not need this symbol exported.
export { jsonSafe }
export const name = 'lanchat-bridge'

/** 需要注入的 Harness 服务（sessionController 用可选读取，缺失时降级）。 */
export const inject = ['tools', 'agents']

// ------------------------------------------------------------------ schemastery（探测式加载）
// ⚠️ 血的教训：本机存在**两份**同名同版本的 schemastery：
//      dsh 自带：     ...\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\schemastery
//      profile 里的： ...\.dsh\profiles\web\node_modules\@deepseek-ai\schemastery
//    两者是**不同的模块实例**。DSH 投影配置 schema 时会做实例识别，喂"另一个实例"会被判成
//    status: absent —— 表现就是「设置页拿不到本插件的配置」。
//    所以**必须优先从 dsh 入口(process.argv[1])解析**，这个基准顺序不能改。
function loadSchemastery() {
  const bases = []
  const entry = String(process.argv[1] ?? '')
  if (entry) bases.push(entry)
  const at = entry.lastIndexOf('node_modules')
  if (at > 0) bases.push(path.join(entry.slice(0, at + 'node_modules'.length), 'index.js'))
  const profileDir = String(process.env.DSH_PROFILE_DIR ?? '').trim()
  if (profileDir) bases.push(path.join(profileDir, 'index.js'))
  const home = String(process.env.DSH_HOME ?? '').trim()
  const profName = String(process.env.DSH_PROFILE ?? '').trim()
  if (home && profName) bases.push(path.join(home, 'profiles', profName, 'index.js'))
  for (const base of bases) {
    try {
      const mod = createRequire(base)('@deepseek-ai/schemastery')
      if (mod && typeof mod.object === 'function') return mod
      if (mod?.default && typeof mod.default.object === 'function') return mod.default
    } catch { /* 换下一个基准 */ }
  }
  return null
}

const z = loadSchemastery()

/**
 * 配置 schema —— **这是设置页能写的前提**。
 *
 * 规则（DSH 的实际行为）：只有 `.volatile()` 的字段才被投影成可编辑表单，
 * 非 volatile 字段既不出现在表单里、写入也会被拒绝；volatile 字段在插件里拿到的是
 * "活引用"（用 .get() 读），所以设置页改完立即生效、无需重启，值落在 profile patch 里。
 */
export const Config = z
  ? z.object({
      enabled: z.boolean().default(true).volatile(),
      exePath: z.string().default('').volatile(),
      port: z.number().default(80).volatile(),
      dataDir: z.string().default('').volatile(),
      autoStart: z.boolean().default(true).volatile(),
      allowFetchFromPeer: z.boolean().default(true).volatile(),
      batchWindowMs: z.number().default(30000).volatile(),
      wakeDebounceMs: z.number().default(4000).volatile(),
      requireAgentStatus: z.boolean().default(true).volatile(),
    })
  : undefined

/** volatile 字段是活引用，普通字段就是普通值。 */
function deref(v) {
  return v !== null && typeof v === 'object' && typeof v.get === 'function' ? v.get() : v
}
/** 取值：空字符串 / undefined 视为未配置，用兜底值。 */
function pick(config, key, fallback) {
  const v = deref(config?.[key])
  return v === undefined || v === null || v === '' ? fallback : v
}

// ------------------------------------------------------------------ 工具定义辅助（自带，无外部依赖）
/** 简写参数规格 -> JSON Schema（等价于 dsh-tools 的 parameterSchemaSpecToJsonSchema）。 */
function specToJsonSchema(parameters) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(parameters ?? {})) {
    const s = spec ?? {}
    const node = { type: s.type ?? 'string' }
    if (s.type === 'number' || s.type === 'integer') node.type = 'number'
    if (Array.isArray(s.enum) && s.enum.length > 0) node.enum = s.enum
    if (s.description) node.description = s.description
    if (s.default !== undefined) node.default = s.default
    properties[key] = node
    if (s.required === true) required.push(key)
  }
  const schema = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  // ⚠️ 刻意**不设** additionalProperties:false —— 与 DSH 官方 parameterSchemaSpecToJsonSchema
  //    保持一致（它也不设）。设成 false 的后果：模型只要多带一个字段（很常见，比如顺手加
  //    to / message / content），参数校验就会在他进入我们代码**之前**失败并报
  //    `invalid arguments: arguments.xxx is not a supported property` —— 看起来就像
  //    "这个工具有缺陷"。宽松比严格稳，多余字段各工具自己忽略即可。
  return schema
}

/** 定义工具（对齐 ToolDefinition：name/description/parameters/output/execute）。 */
function defineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: specToJsonSchema(options.parameters),
    output: options.output,
    // ⚠️ 这里在**模块作用域**，不能调用 apply() 内定义的 refresh()（会 ReferenceError）。
    //    配置刷新由各工具自己的 execute 开头调用 refresh() 完成。
    async execute(args, exec) {
      // ⚠️ 关键加固：任何工具都不许把异常抛出去。
      //    LanChat 没在跑时 fetch 会抛 ECONNREFUSED；若让它逃逸成未处理的 Promise 拒绝，
      //    Node 会**直接结束进程** —— 表现就是"DSH 突然退出，只剩 LanChat"。实测踩过这个坑。
      //    统一在这里兜住，转成结构化失败结果（对 AI 也更友好：能直接看到原因）。
      try {
        return jsonSafe(await options.execute(args ?? {}, exec))
      } catch (e) {
        const why = String(e?.message ?? e)
        logErr(`工具 ${options.name} 执行失败: ${why}`)
        return {
          ok: false,
          error: why,
        hint: undefined,
        hint: jsonSafe('LanChat 可能没在运行或端口不通；可调用 lanchat_status 查看诊断（会列出找过的路径与开关状态）'),
        }
      }
    },
  }
}

/** 统一的 JSON 输出渲染（与 dsh-tools 的 jsonOutput 等价）。 */
// v1.1.1 FIX (peer defect report, 2026-10-07): every lanchat tool result passes through here first.
//   Measured: a tool returned fields that were undefined, and the RPC layer reported "value is not
//   lossless JSON" AFTER the send had already succeeded -- a failure report for a success, which makes
//   the caller retry and duplicate the message. The peer named the remedy: absent fields become null,
//   and strings must be well formed (a lone surrogate from truncated emoji also breaks a round trip).
function jsonSafe(value) {
  if (value === undefined || value === null) return null
  const t = typeof value
  if (t === 'number') return Number.isFinite(value) ? value : null
  if (t === 'boolean') return value
  if (t === 'string') return value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (t === 'object') {
    const out = {}
    for (const k of Object.keys(value)) out[k] = jsonSafe(value[k])
    return out
  }
  return null
}

function jsonOutput(schema) {
  return {
    schema,
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }],
  }
}

// ------------------------------------------------------------------ 配置默认值（无 Config schema，允许热改）
const DEFAULTS = {
  exePath: '',
  port: 80,
  dataDir: '',
  batchWindowMs: 30000,
  wakeDebounceMs: 4000,
  autoStart: true,
  allowFetchFromPeer: true,
  requireAgentStatus: true,
}

/** 本插件自己的目录 —— 发布包里 LanChat.exe 就和插件放在一起，优先从这里找。 */
const PLUGIN_DIR = (() => {
  try { return path.dirname(fileURLToPath(import.meta.url)) } catch { return '' }
})()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- 日志（同时写文件，便于事后取证）
// 为什么落盘：插件日志默认只进 DSH 的终端，一旦 DSH 自己退出，现场就没了。
// 日志放在 %LOCALAPPDATA%\LanChat\dsh-plugin.log，超过 1 MB 自动截断重开。
const LOG_FILE = (() => {
  try {
    const base = process.env.LOCALAPPDATA || process.env.TEMP || process.cwd()
    return path.join(base, 'LanChat', 'dsh-plugin.log')
  } catch { return '' }
})()

function writeLog(line) {
  if (!LOG_FILE) return
  try {
    const fs = fsSync
    const dir = path.dirname(LOG_FILE)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    try { if (fs.statSync(LOG_FILE).size > 1024 * 1024) fs.writeFileSync(LOG_FILE, '') } catch { }
    fs.appendFileSync(LOG_FILE, line + '\n')
  } catch { /* 日志失败绝不能影响主流程 */ }
}

function stamp() {
  try { return new Date().toISOString().replace('T', ' ').slice(0, 19) } catch { return '' }
}
/** 唤醒投递用的 AbortSignal —— prompt(request, signal) 的第二个参数是必填的。 */
let _wakeCtrl = null
function wakeSignal() {
  if (!_wakeCtrl) _wakeCtrl = new AbortController()
  return _wakeCtrl.signal
}
function log(msg) {
  const line = `[lanchat] ${msg}`
  console.log(line)
  writeLog(`${stamp()} ${line}`)
}
function logErr(msg) {
  const line = `[lanchat] ${msg}`
  console.error(line)
  writeLog(`${stamp()} [ERROR] ${line}`)
}

/** 把一个可能抛错的同步/异步动作包起来：**绝不让异常逃逸成未处理的 Promise 拒绝**
 *  （Node 遇到未处理的拒绝会直接结束进程 —— 那会把整个 DSH 带崩）。 */
function safely(label, fn) {
  try {
    const r = fn()
    if (r && typeof r.then === 'function') {
      return r.catch((e) => { logErr(`${label} 失败: ${e?.message ?? e}`) })
    }
    return r
  } catch (e) {
    logErr(`${label} 抛错: ${e?.message ?? e}`)
    return undefined
  }
}

export function apply(ctx, rawConfig) {
  // 配置按"实时"读取：volatile 字段是活引用，设置页改完立刻反映到下面这些 getter，
  // 所以不需要重启，也不需要缓存快照。
  const D = DEFAULTS
  const read = () => ({
    enabled: pick(rawConfig, 'enabled', D.enabled) !== false,
    exePath: String(pick(rawConfig, 'exePath', D.exePath) ?? ''),
    port: Number(pick(rawConfig, 'port', D.port)) || 80,
    dataDir: String(pick(rawConfig, 'dataDir', D.dataDir) ?? ''),
    batchWindowMs: Number(pick(rawConfig, 'batchWindowMs', D.batchWindowMs)) || 30000,
    wakeDebounceMs: Number(pick(rawConfig, 'wakeDebounceMs', D.wakeDebounceMs)) || 4000,
    autoStart: pick(rawConfig, 'autoStart', D.autoStart) !== false,
    allowFetchFromPeer: pick(rawConfig, 'allowFetchFromPeer', D.allowFetchFromPeer) !== false,
    requireAgentStatus: pick(rawConfig, 'requireAgentStatus', D.requireAgentStatus) !== false,
  })
  const cfg = read()
  const baseOf = (c) => `http://127.0.0.1:${c.port}`
  let base = baseOf(cfg)

  // 设置页改完立即生效：每次用之前刷新一次配置。
  // 端口变了就换地址并让收消息循环重连（只重连一次，不会抖动）。
  function refresh() {
    const next = read()
    if (next.port !== cfg.port) {
      cfg.port = next.port
      base = baseOf(cfg)
      reconnect = true
      log(`端口已按设置改为 ${cfg.port}，正在重连…`)
    }
    cfg.enabled = next.enabled
    cfg.exePath = next.exePath
    cfg.dataDir = next.dataDir
    cfg.batchWindowMs = next.batchWindowMs
    cfg.wakeDebounceMs = next.wakeDebounceMs
    cfg.autoStart = next.autoStart
    cfg.allowFetchFromPeer = next.allowFetchFromPeer
    cfg.requireAgentStatus = next.requireAgentStatus
    if (!next.enabled) {
      for (const b of buffers.values()) clearTimeout(b.wakeTimer)
      buffers.clear()
    }
    return cfg
  }

  let selfNodeId = ''
  let stopped = false
  /** 上次尝试拉起 LanChat 的时间（冷却用，避免反复 spawn） */
  let lastSpawnAt = 0
  /** 上次尝试启动 LanChat 的失败原因（供 lanchat_status 诊断输出） */
  let lastStartError = ''
  /** 端口被设置页改过 → 需要重连一次 */
  let reconnect = false
  /** 是否收到过 agent/status 事件（0.1.7 及更早没有这个事件） */
  let statusEventsSeen = false
  /** 本会话 Agent（第一次调用任意工具时确定，背景线程靠它决定投给谁） */
  let sessionAgent = null
  /** Agent 运行状态：agentId -> 'idle' | 'running'，来自 agent/status 事件 */
  const agentStatus = new Map()
  /** 收件缓冲：convKey -> { peer, items[], lastAt, wakeTimer } */
  const buffers = new Map()

  // ---------------------------------------------------------------- HTTP
  async function http(path, init) {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), init?.timeoutMs ?? 20000)
    try {
      const res = await fetch(base + path, { ...init, signal: ctl.signal })
      const text = await res.text()
      let json = null
      try { json = JSON.parse(text) } catch { /* 非 JSON 响应（如 /dsh/doc） */ }
      return { ok: res.ok, status: res.status, text, json }
    } finally {
      clearTimeout(t)
    }
  }

  async function whoami() {
    try {
      const r = await http('/dsh/whoami', { timeoutMs: 3000 })
      if (r.json?.ok) { selfNodeId = r.json.nodeId ?? ''; return r.json }
      return null
    } catch { return null }
  }

  // ---------------------------------------------------------------- 状态事件
  //
  // 兼容性说明：`agent/status` 事件是 DSH 0.2.0 起才有的，0.1.7-rc.2 上收不到。
  // 收不到时 statusEventsSeen 保持 false，isBusy() 退化为"状态未知" —— 那时不再自己判忙，
  // 而是直接交给 sessionController.prompt(mode:'queue')：它本身就有"正在跑就排队、空闲才起跑"的语义，
  // 功能仍然正确，只是唤醒时机的判断不如有事件时精确。
  ctx.on('agent/status', (payload) => {
    statusEventsSeen = true
    const id = payload?.agent?.id
    if (id) agentStatus.set(String(id), payload.status === 'running' ? 'running' : 'idle')
  })

  function isBusy() {
    if (!sessionAgent) return false
    if (!statusEventsSeen) return false        // 老版本 DSH：状态未知 → 交给 queue 语义
    return agentStatus.get(String(sessionAgent.id)) === 'running'
  }

  // ---------------------------------------------------------------- 查找 / 拉起 LanChat
  /** 按优先级列出可能存放 LanChat.exe 的位置（不含任何硬编码的个人路径）。 */
  function candidatePaths() {
    const out = []
    if (cfg.exePath) out.push(cfg.exePath)
    // ① 与插件**同级**（发布包：exe 与插件文件放在一起）
    if (PLUGIN_DIR) out.push(path.join(PLUGIN_DIR, 'LanChat.exe'))
    // ② 插件目录的**上一级 / 上两级**（开发布局：插件在 <项目>\dsh-plugin，exe 在 <项目>\）
    //    这条很关键：以"插件自身位置"为锚点，而不是靠 DSH 的工作目录 —— 后者随用户从哪启动而变。
    if (PLUGIN_DIR) {
      out.push(path.join(PLUGIN_DIR, '..', 'LanChat.exe'))
      out.push(path.join(PLUGIN_DIR, '..', '..', 'LanChat.exe'))
    }
    // ③ DSH 的工作目录（从项目根启动 DSH 的常见情况）
    const cwd = process.cwd()
    out.push(`${cwd}\\LanChat.exe`)
    out.push(`${cwd}\\lanchat\\LanChat.exe`)
    out.push(`${cwd}\\dsh-plugin-lanchat\\LanChat.exe`)
    // ④ 常见安装位置
    if (process.env.LOCALAPPDATA) out.push(`${process.env.LOCALAPPDATA}\\LanChat\\LanChat.exe`)
    if (process.env.ProgramFiles) out.push(`${process.env.ProgramFiles}\\LanChat\\LanChat.exe`)
    if (process.env['ProgramFiles(x86)']) out.push(`${process.env['ProgramFiles(x86)']}\\LanChat\\LanChat.exe`)
    if (process.env.USERPROFILE) out.push(`${process.env.USERPROFILE}\\Desktop\\LanChat.exe`)
    if (process.env.USERPROFILE) out.push(`${process.env.USERPROFILE}\\Downloads\\LanChat.exe`)
    return out
  }

  /** 探测某端口上是否已经有人在监听（纯 TCP 连接，3 秒超时）。 */
  async function portListening(port) {
    try {
      const net = await import('node:net')
      return await new Promise((resolve) => {
        let done = false
        const sock = net.connect({ host: '127.0.0.1', port }, () => { done = true; sock.destroy(); resolve(true) })
        sock.setTimeout(3000)
        sock.on('timeout', () => { if (!done) { done = true; sock.destroy(); resolve(false) } })
        sock.on('error', () => { if (!done) { done = true; resolve(false) } })
      })
    } catch { return false }
  }
  async function findLocalExe() {
    const fs = await import('node:fs/promises')
    for (const p of candidatePaths()) {
      if (!p) continue
      try { await fs.access(p); return p } catch { /* 试下一个 */ }
    }
    return ''
  }

  /** 本机没有就从局域网里其它机器的 /dsh/self 拉一份（这就是"自动获取 LanChat"） */
  async function fetchExeFromPeer() {
    if (!cfg.allowFetchFromPeer) return ''
    try {
      const peers = (await http('/dsh/peers', { timeoutMs: 5000 })).json?.peers ?? []
      for (const p of peers) {
        if (!p?.node || !p?.online) continue
        try {
          const res = await fetch(`http://${p.node}/dsh/self`)
          if (!res.ok) continue
          const buf = Buffer.from(await res.arrayBuffer())
          if (buf.length < 100000) continue
          const fs = await import('node:fs/promises')
          const path = await import('node:path')
          const dir = `${process.env.LOCALAPPDATA ?? process.cwd()}\\LanChat`
          await fs.mkdir(dir, { recursive: true })
          const dst = path.join(dir, 'LanChat.exe')
          await fs.writeFile(dst, buf)
          log(`已从局域网机器 ${p.name || p.node} 取得 LanChat.exe（${buf.length} 字节）`)
          return dst
        } catch { /* 换下一台 */ }
      }
    } catch { /* 忽略 */ }
    return ''
  }

  async function ensureRunning() {
    const me = await whoami()
    if (me) return me
    if (!cfg.autoStart) return null

    // ① 端口探测：如果**已经有人在这个端口上监听**（可能是 LanChat 正忙、或正在启动），
    //    就先别急着重启 —— 否则会在端口被占的情况下再 spawn 一个，制造"端口被占用"的混乱。
    if (await portListening(cfg.port)) {
      log(`端口 ${cfg.port} 有人在监听但接口没响应（可能在启动中），本轮不重复拉起`)
      return null
    }
    // ② 启动冷却：5 分钟内最多尝试拉起一次。反复 spawn 是"端口冲突 + 进程堆积"的根源。
    const now = Date.now()
    if (now - lastSpawnAt < 5 * 60 * 1000) {
      log('距上次尝试启动不足 5 分钟，本轮不再尝试')
      return null
    }
    lastSpawnAt = now

    let exe = await findLocalExe()
    if (!exe) exe = await fetchExeFromPeer()
    if (!exe) {
      lastStartError = '本地与局域网都没找到 LanChat.exe'
      logErr('找不到 LanChat.exe：请在插件配置里填 exePath，或先手动运行一次 LanChat')
      return null
    }
    // 不依赖 Harness 的 subprocess 服务：那会把 LanChat 变成"受管进程"，DSH 一退出就被杀。
    // 这里用 node 原生 spawn 脱离式启动，进程归属用户自己，与手动双击 exe 等价。
    try {
      // ⚠️ 两条铁律，改回去会出真事故：
      //
      // ① 绝不加 --nogui：那会**隐藏托盘图标**。LanChat 是可独立运行的软件，
      //    即便由插件拉起，也要和手动启动一样常驻托盘、右键有菜单、双击打开 WebUI。
      //    只用 --no-browser：托盘照常，但不在 DSH 启动时抢开浏览器窗口。
      //
      // ② 用 node 的 child_process **脱离式**启动（detached + unref），
      //    **不要**用 ctx.subprocess：Harness 的 subprocess 服务在销毁时会终止所有
      //    托管进程 —— 那样一关 DSH 就会把 LanChat 一起杀掉。本插件只做接口适配，
      //    LanChat 的运行必须完全独立于 DSH，直到用户从托盘手动退出。
      const args = ['--no-browser']
      if (cfg.dataDir) args.push(`--data=${cfg.dataDir}`)
      const child = spawn(exe, args, {
        cwd: cfg.dataDir || path.dirname(exe),
        detached: true,        // 独立进程组：DSH 退出不影响它
        stdio: 'ignore',       // 不占管道，父进程退出后不会因为管道断开而受影响
        windowsHide: false,
      })
      child.unref()            // 不把子进程留在父进程的事件循环里
      lastStartError = ''
      log(`已启动 LanChat（脱离式，托盘保留，DSH 退出后继续运行）: ${exe}`)
    } catch (e) {
      lastStartError = 'spawn 失败: ' + String(e?.message ?? e)
      logErr(`启动 LanChat 失败: ${e?.message ?? e}`)
      return null
    }
    for (let i = 0; i < 40 && !stopped; i++) {
      await sleep(250)
      const got = await whoami()
      if (got) return got
    }
    lastStartError = '已启动但探测不到响应（端口占用/防火墙？）'
    logErr('LanChat 启动后仍未响应：检查端口占用或防火墙提示')
    return null
  }

  // ---------------------------------------------------------------- 唤醒
  async function deliver(convKey) {
    if (!refresh().enabled) return
    const b = buffers.get(convKey)
    if (!b || b.items.length === 0) return
    if (!sessionAgent) {
      // 不能投递就**丢掉**，绝不在缓冲里囤积 —— 囤积等于内存只涨不降（有过 OOM 事故）。
      // 本会话只要调用过任意 lanchat_* 工具就会绑定 Agent，之后收到的消息才会被唤醒投递。
      logErr('还没有会话绑定唤醒目标（本会话没调用过 LanChat 工具），本条已丢弃；在你想接收唤醒的会话里调用一次 lanchat_status 即可绑定')
      buffers.delete(convKey)
      return
    }
    const sc = ctx.get('sessionController')
    if (!sc?.prompt) {
      logErr('缺少 sessionController 服务，无法唤醒本会话 AI')
      return
    }
    const n = b.items.length
    const body = [
      `【LanChat 收到${n > 1 ? ` ${n} 条消息（同一批，请一并处理）` : '消息'}｜来自 ${b.peer}｜会话键 ${convKey}】`,
      ...b.items,
      '',
      '（自动唤醒提示。请调用 lanchat_recv 拿完整内容与文件路径；回复用 lanchat_send。' +
      '若这是需要与对方持续对话的场景，处理完后可用 lanchat_recv 的 waitSeconds 继续等下一批。）',
    ].join('\n---\n')
    const busy = isBusy()
    try {
      // ⚠️ prompt(request, signal) 的**第二个参数是必填的**：DSH 内部第一行就是
      //    signal.throwIfAborted()，只传一个参数会得到
      //    "Cannot read properties of undefined (reading 'throwIfAborted')"
      //    —— 实测这正是"收到消息却唤不醒 AI"的原因。
      await sc.prompt({
        requestId: `lanchat-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        sessionId: sessionAgent.id,
        mode: 'queue',
        content: [{ type: 'text', text: body }],
      }, wakeSignal())
      buffers.delete(convKey)
      log(`已${busy ? '入队（AI 正忙，不打断）' : '唤醒 AI'}：${n} 条来自 ${b.peer} → 会话 ${String(sessionAgent.id).slice(0, 12)}…`)
    } catch (e) {
      logErr(`投递失败，消息留在缓冲稍后重试: ${e?.message ?? e}`)
      b.lastAt = Date.now()
      scheduleWake(convKey)
    }
  }

  function scheduleWake(convKey) {
    const b = buffers.get(convKey)
    if (!b) return
    clearTimeout(b.wakeTimer)
    // 关键：不是"来了就唤醒"，而是等到这段安静时间过去、且 AI 空闲时才唤醒。
    // 同一批被拆成几条到达也不会唤醒两次，更不会让 AI 漏看后到的那条。
    b.wakeTimer = setTimeout(async function tick() {
      // 整个 tick 包在 try 里：这里是**异步定时器回调**，
      // 一旦它抛错就会变成"未处理的 Promise 拒绝"，而 Node 默认会**直接结束进程**——
      // 那会把整个 DSH 带崩（表现为"DSH 突然退出，只剩 LanChat"）。所以绝不能让它逃逸。
      try {
        if (stopped) return
        const cur = buffers.get(convKey)
        if (!cur || cur.items.length === 0) return
        if (Date.now() - cur.lastAt < cfg.wakeDebounceMs) { cur.wakeTimer = setTimeout(tick, cfg.wakeDebounceMs); return }
        if (cfg.requireAgentStatus && isBusy()) { cur.wakeTimer = setTimeout(tick, cfg.wakeDebounceMs); return }
        await deliver(convKey)
      } catch (e) {
        logErr(`唤醒流程异常（已忽略，不影响 DSH）: ${e?.message ?? e}`)
      }
    }, cfg.wakeDebounceMs)
  }

  // ---------------------------------------------------------------- 后台收消息
  /** 群聊收消息游标：只取比它新的，避免每次轮询都重取全部历史（OOM 事故的根因） */
  let cursor = 0
  /** 缓冲条数上限（内存安全兜底） */
  const MAX_BUFFER_ITEMS = 50

  async function pollLoop() {
    let me = await ensureRunning()
    while (!me && !stopped) {
      await sleep(15000)
      me = await ensureRunning()
    }
    if (stopped) return
    log(`已连接 LanChat（本机 ${selfNodeId || '未知'}，版本 ${me.version ?? '?'}）`)

    // 启动时先把游标推到"现在"，**跳过启动前的历史**：
    // 否则每次 DSH 重启都会拿一整批旧消息去唤醒 AI（实测会把 50 条历史当一批投递）。
    // 历史随时可以用 lanchat_recv 主动读，不该由唤醒机制代劳。
    try {
      const prime = await http('/dsh/recv?since=0&timeout=0', { timeoutMs: 8000 })
      const pj = prime.json
      if (pj?.ok && typeof pj.next === 'number') {
        cursor = pj.next
        const mine = (pj.messages ?? []).filter((m) => !m.mine).length
        if (mine > 0) log(`启动前已有 ${mine} 条消息，已跳过（需要时用 lanchat_recv 主动读）`)
      }
    } catch { /* 拿不到就从 0 开始，不影响主流程 */ }

    while (!stopped) {
      // 设置页可以随时改配置：启用开关、端口变化都在这里即时生效
      if (!refresh().enabled) { await sleep(1500); continue }
      if (reconnect) {
        reconnect = false
        const again = await ensureRunning()
        if (again) log('已按新设置重连 LanChat')
      }
      try {
        // ⚠️ 必须带游标 since！不带的话服务端按 since=0 处理，
        //    每 20 秒都会把**全部历史消息**再返回一遍，而下面又会把它们重新塞进缓冲 →
        //    缓冲无限膨胀 → 实测 7 分钟吃光 4 GB 堆内存，DSH 直接 OOM abort（exit 134）。
        const r = await http(`/dsh/recv?since=${cursor}&timeout=20`, { timeoutMs: 32000 })
        const j = r.json
        if (!j?.ok) { await sleep(2000); continue }
        // 游标前移：next 是本会话已收到的最大序号，下次只取比它更新的
        if (typeof j.next === 'number' && j.next > cursor) cursor = j.next
        const convKey = j.key ?? 'public'
        for (const m of j.messages ?? []) {
          if (m.mine) continue                          // 自己发的消息不唤醒自己
          let b = buffers.get(convKey)
          if (!b) { b = { peer: m.from ?? '未知', items: [], lastAt: 0, wakeTimer: null }; buffers.set(convKey, b) }
          b.peer = m.from ?? b.peer
          const files = m.files?.length ? `（含 ${m.files.length} 个文件：${m.files.map((f) => f.name).join(', ')}）` : ''
          b.items.push(`【来自 ${m.from}${m.batch ? `｜批次 ${m.batch}` : ''}】${m.text ?? ''}${files}`)
          b.lastAt = Date.now()
          // 缓冲上限：无论什么异常情况，都不允许它无限增长（内存安全兜底）
          if (b.items.length > MAX_BUFFER_ITEMS) b.items.splice(0, b.items.length - MAX_BUFFER_ITEMS)
          scheduleWake(convKey)
        }
      } catch {
        await sleep(3000)
      }
    }
  }

  // ---------------------------------------------------------------- 工具

  function remember(exec) {
    // ⚠️ 必须**每次调用都刷新绑定**，而不是只绑第一次：
    //    旧写法是 if (!sessionAgent)，于是「最先调用过工具的会话」会**永久霸占**唤醒投递；
    //    用户换到另一个会话之后，消息照旧投给那个旧会话 ——
    //    在用户眼里就是"消息来了却唤不醒 AI 回答"（实测踩过这个坑）。
    //    改以「最近一次调用 LanChat 工具的会话」为准：谁在用就投给谁。
    if (exec?.agent && sessionAgent?.id !== exec.agent.id) {
      const from = sessionAgent?.id ?? '(未绑定)'
      sessionAgent = exec.agent
      log(`唤醒目标已切换到本会话: ${exec.agent.id}（原 ${from}）`)
    }
  }

  const OBJ = (props, required) => ({ type: 'object', properties: props, required, additionalProperties: true })

  // Builds the ?peer=... fragment from a name, a node id, or "ip:port".
  // Added with the v1.0.8 now-semantics fix: the immediate send path needs the target in the query.
  function peerQ(peer) {
    if (!peer) return ''
    return '?peer=' + encodeURIComponent(String(peer))
  }

  ctx.tools.register(defineTool({
    name: 'lanchat_status',
    description:
      '查看 LanChat 局域网通讯状态：本机名称/节点号、当前在线的其它机器、最近收到的文件。' +
      '要与别的机器通讯前先调用它确认对方在线。',
    parameters: {
      includeFiles: { type: 'boolean', description: '同时列出最近的文件' },
    },
    output: jsonOutput(OBJ({
      ok: { type: 'boolean' },
      me: { type: 'object', additionalProperties: true },
      peers: { type: 'array', items: { type: 'object', additionalProperties: true } },
      files: { type: 'array', items: { type: 'object', additionalProperties: true } },
    }, ['ok'])),
    async execute(args, exec) {
      refresh()
      remember(exec)
      const me = await whoami()
      if (!me) {
        // 连不上时给出**可自己排错的诊断**：找过哪些路径、哪个存在、开关是什么、上次启动报了什么错
        const fs = await import('node:fs')
        const cands = candidatePaths().map((p) => ({ path: p, exists: (() => { try { return fs.existsSync(p) } catch { return false } })() }))
        return {
          ok: false,
          error: 'LanChat 未运行或端口不通',
          howToFix: [
            '① 若下面 candidates 里有 exists:true 的项，说明 exe 找得到但启动失败 —— 看 lastStartError',
            '② 若全是 false，请在设置 → 局域网通讯 里把「LanChat.exe 路径」填成实际路径',
            '③ 也可以手动双击 LanChat.exe 先跑起来，插件会直接接入',
          ],
          config: { port: cfg.port, exePath: cfg.exePath || '(未设置)', autoStart: cfg.autoStart, enabled: cfg.enabled },
          pluginDir: PLUGIN_DIR,
          dshCwd: process.cwd(),
          candidates: cands,
          lastStartError: lastStartError || '(无：还没尝试过启动)',
        }
      }
      const peers = (await http('/dsh/peers', { timeoutMs: 6000 })).json?.peers ?? []
      const out = {
        ok: true,
        me: { name: me.name, nodeId: me.nodeId, port: me.port, ips: me.ips },
        peers: peers.map((p) => ({ node: p.node, name: p.name, online: p.online })),
        note: '用 peers[].name 或 node 作为 lanchat_send / lanchat_recv 的 peer 参数；peer 省略 = 群聊',
      }
      if (args.includeFiles) out.files = (await http('/dsh/files', { timeoutMs: 6000 })).json?.files ?? []
      return out
    },
  }))

  ctx.tools.register(defineTool({
    name: 'lanchat_recv',
    description:
      '读取局域网消息：peer 省略 = 群聊，给了 = 与那台机器的私聊。' +
      '收到唤醒提示后调用本工具即可拿到完整正文与文件磁盘路径。',
    parameters: {
      peer: { type: 'string', description: '对方机器名或节点号（如 DESKTOP-ABC 或 192.168.0.5:80）；省略 = 群聊' },
      since: { type: 'number', description: '游标：上次返回的 next；首次传 0' },
      waitSeconds: { type: 'number', description: '长轮询等待秒数（0-25），默认 0 立即返回' },
      wait: { type: 'number', description: 'waitSeconds 别名' },
      timeout: { type: 'number', description: 'waitSeconds 别名' },
    },
    output: jsonOutput(OBJ({
      ok: { type: 'boolean' },
      key: { type: 'string' },
      next: { type: 'number' },
      count: { type: 'number' },
      messages: { type: 'array', items: { type: 'object', additionalProperties: true } },
    }, ['ok'])),
    async execute(args, exec) {
      refresh()
      remember(exec)
      const wait = Math.max(0, Math.min(25, Number(args.waitSeconds ?? args.wait ?? args.timeout ?? 0) || 0))
      const q = [`since=${Number(args.since ?? 0) || 0}`, `timeout=${wait}`]
      if (args.peer && args.peer !== 'all' && args.peer !== 'public') q.push(`peer=${encodeURIComponent(args.peer)}`)
      const r = await http(`/dsh/recv?${q.join('&')}`, { timeoutMs: wait * 1000 + 15000 })
      const j = r.json
      if (!j?.ok) return { ok: false, error: `LanChat 无响应 (HTTP ${r.status})` }
      // 已经通过工具读到了，就不要再唤醒一次
      if (j.key) {
        const b = buffers.get(j.key)
        if (b) { clearTimeout(b.wakeTimer); buffers.delete(j.key) }
      }
      const out = { ok: true, key: j.key, next: j.next, count: j.count, messages: j.messages ?? [] }
      if (j.count === 0) out.hint = '暂无新消息；可用刚返回的 next 作为 since 再等一次'
      return out
    },
  }))

  ctx.tools.register(defineTool({
    name: 'lanchat_send',
    description:
      '向局域网其它机器发消息或文件。默认攒批：连续调用会合并成一批一起送出' +
      `（空闲 ${Math.round(cfg.batchWindowMs / 1000)} 秒自动发出，或用 mode:flush ／ lanchat_flush 立即发出）。` +
      '要发文字 + 文件、或连续说几句时，最后调用一次 lanchat_flush。',
    parameters: {
      text: { type: 'string', description: '要发送的文字（可与 file 同时给）' },
      message: { type: 'string', description: 'text 的别名' },
      file: { type: 'string', description: '要发送的本地文件绝对路径' },
      peer: { type: 'string', description: '对方机器名或节点号；省略 = 群聊' },
      to: { type: 'string', description: 'peer 的别名' },
      mode: { type: 'string', enum: ['stage', 'flush', 'now'], description: 'stage=攒批(默认)、flush=攒批并立即发出、now=立刻单独发出（会先把已积压的那批发出去，再单发本条，因此不会与旧内容合并）' },
      kind: { type: 'string', description: '内容类型提示：image 表示图片（图片不参与合并，避免对方干等）' },
    },
    output: jsonOutput(OBJ({
      ok: { type: 'boolean' },
      staged: { type: 'boolean' },
      sent: { type: 'boolean' },
      drained: { type: 'boolean' },
      flushed: { type: 'boolean' },
      items: { type: 'number' },
      remainingMs: { type: 'number' },
      note: { type: 'string' },
    }, ['ok'])),
    async execute(args, exec) {
      refresh()
      remember(exec)
      // 参数别名：模型常用 message / to 这两种更自然的写法，一并接受 ——
      // 避免"参数其实对、却报参数错误"（那会被误认为工具缺陷）。
      const textArg = args.text ?? args.message
      const peerArg = args.peer ?? args.to
      if (!textArg && !args.file) return { ok: false, error: '至少要给 text（或 message）与 file 之一' }
      const payload = { text: textArg, file: args.file, peer: peerArg, kind: args.kind }
      if (args.mode === 'now') {
        // v1.0.8 FIX (measured 2026-10-07): 'now' used to POST to /dsh/stage with flush:true, but the server
        //   flushes the ENTIRE pending buffer for that peer, so anything already staged went out glued to
        //   this message. It also returned the server echo of the sent text, which for long markdown or
        //   emoji surfaced as 'value is not lossless JSON' although the message HAD been delivered --
        //   a failure report for a success, which is the worst possible shape.
        //   Now: drain whatever is already staged as its own batch first, then send THIS message alone.
        let drained = false
        try {
          const st = await http('/dsh/stage/status' + peerQ(peerArg), { timeoutMs: 8000 })
          if (Number(st.json?.items ?? 0) > 0) {
            await http('/dsh/stage/flush' + peerQ(peerArg), { timeoutMs: 60000 })
            drained = true
          }
        } catch { /* best effort; never block a send on the status probe */ }
        const rNow = await http('/dsh/send?text=' + encodeURIComponent(textArg ?? '')
          + (peerArg ? '&to=' + encodeURIComponent(String(peerArg)) : '')
          + (args.kind ? '&kind=' + encodeURIComponent(args.kind) : ''), { timeoutMs: 60000 })
        if (rNow.json?.ok !== true) return { ok: false, error: rNow.json?.error || 'immediate send failed' }
        // v1.1.2: return the SAME key set as stage and flush, so criterion 3 (three branches structurally
        //   identical) holds literally rather than only in spirit. Keys that do not apply are null.
        return jsonSafe({
          ok: true, staged: true, flushed: true, sent: true, drained,
          items: 1, remainingMs: 0, error: null,
          note: (drained ? '已先把积压的那批发出去，然后' : '') + '本条单独发出（未合并）',
        })
      }
      const body = { ...payload }
      if (args.mode === 'flush') body.flush = true
      const r = await http('/dsh/stage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
        timeoutMs: 60000,
      })
      const j = r.json ?? {}
      const win = Math.round((j.window_ms ?? cfg.batchWindowMs) / 1000)
      return jsonSafe({
        ok: j.ok === true, staged: j.staged === true, flushed: j.flushed === true, sent: null, drained: null,
        items: j.items ?? null, remainingMs: j.window_ms ?? null, error: j.error ?? null,
        note: j.flushed
          ? '已作为一整批发给对面'
          : (`已攒入本批（当前 ${j.items ?? 1} 件）。还要发就继续调用 lanchat_send；发完请调用 lanchat_flush 立即送出，否则 ${win} 秒后自动发出。`),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'lanchat_flush',
    description:
      '把攒着的一批内容立即送给对面。**一轮对话里把所有内容都发完后调用一次**，这样对面马上收到完整的一批，不用等自动窗口。',
    parameters: {
      peer: { type: 'string', description: '目标机器名或节点号；省略 = 群聊' },
    },
    output: jsonOutput(OBJ({ ok: { type: 'boolean' }, flushed: { type: 'boolean' } }, ['ok'])),
    async execute(args, exec) {
      refresh()
      remember(exec)
      const q = peerQ(args.peer && args.peer !== 'all' ? args.peer : null)
      const r = await http(`/dsh/stage/flush${q}`, { timeoutMs: 60000 })
      return { ok: r.json?.ok === true, flushed: r.json?.flushed === true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'lanchat_identity',
    description: '查看或修改本机在局域网里的名称与头像颜色（改动会自动同步给所有机器，重名/撞色自动避让）。',
    parameters: {
      name: { type: 'string', description: '新名称（可选）' },
      color: { type: 'string', description: '头像颜色 6 位十六进制，如 7bc7f4（可选）' },
    },
    output: jsonOutput(OBJ({
      ok: { type: 'boolean' },
      name: { type: 'string' },
      letter: { type: 'string' },
      color: { type: 'string' },
    }, ['ok'])),
    async execute(args, exec) {
      refresh()
      remember(exec)
      if (args.name || args.color) {
        const r = await http('/dsh/setid', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ name: args.name, color: args.color }),
          timeoutMs: 15000,
        })
        const j = r.json ?? {}
        return { ok: j.ok === true, name: j.name, letter: j.letter, color: j.color }
      }
      const j = (await http('/dsh/whoami', { timeoutMs: 6000 })).json ?? {}
      return { ok: j.ok === true, name: j.name, letter: j.letter, color: j.color }
    },
  }))

  // ---------------------------------------------------------------- 生命周期
  ctx.effect(() => {
    stopped = false
    pollLoop().catch((e) => logErr(`收消息循环异常退出: ${e?.message ?? e}`))
    return () => {
      stopped = true
      for (const b of buffers.values()) clearTimeout(b.wakeTimer)
      buffers.clear()
      // ⚠️ 刻意**不**终止 LanChat：它的生命周期完全独立于 DSH。
      //    关掉 DSH 后 LanChat 继续运行（托盘常驻），直到用户自己从托盘"退出"。
      //    插件只是接口适配层，不拥有这个进程。
    }
  })

// 版本兼容探测：agent/status 是 0.2.0 起才有的，晚一点看它有没有来过
  setTimeout(() => {
    if (!stopped && !statusEventsSeen) {
      log('提示：暂未观测到 agent/status 事件（本会话还没产生过状态变化，或 DSH 为 0.1.7 及更早）→ 判忙暂按「不忙」处理，功能不受影响')
    }
  }, 5000)
  log(`已加载（端口 ${cfg.port}｜合并窗口 ${cfg.batchWindowMs}ms｜唤醒防抖 ${cfg.wakeDebounceMs}ms）`)
}
