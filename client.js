/**
 * LanChat 局域网通讯桥 —— 客户端半身（「设置 → 局域网通讯」）
 *
 * 写入通道：宿主行声明了 volatile Config 字段，DSH 的 settings 服务因此把它暴露成
 * 命名空间 `lanchat-bridge`，本面板直接读写 —— 保存即生效、无需重启。
 *
 * 三条硬性纪律（来自参考插件的真实事故）：
 *   ① factory(require) 执行路径上绝不能有 React Hook，Hook 只能在组件渲染时调用；
 *   ② 只用主题 token 上色，浅色/深色都跟着主题走，不硬编码颜色；
 *   ③ 任何异步调用都 try/catch，失败只显示错误文本，绝不让设置页崩掉。
 */
window.__ModuleLoader__.load({
  // ⚠️ id 必须与 package.json 的包名**逐字一致**：宿主侧客户端 bundle 的路由是
  //    `${id}/client.js`，靠 id 反查模块；写成短名会让模块被丢弃。
  id: '@local/dsh-plugin-lanchat',
  factory(require) {
    let React
    try {
      React = require('react')
    } catch {
      React = null
    }
    if (!React || typeof React.createElement !== 'function') {
      return { inject: [], apply() {} }
    }
    const h = React.createElement

    /** 本插件在 profile patch 里的行 id，也是 settings 命名空间。 */
    const NS = 'lanchat-bridge'

    /** 主题 token（浅色/深色自动适配）。 */
    const C = {
      border: 'var(--dsw-alias-border-l1)',
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      accent: 'var(--dsw-alias-brand-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
      card: 'var(--dsw-alias-bg-layer-1)',
      field: 'var(--dsw-alias-bg-layer-2)',
    }

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 14, fontSize: 13, lineHeight: 1.6, color: C.text },
      card: { border: `1px solid ${C.border}`, borderRadius: 8, padding: '12px 14px', background: C.card },
      row: { display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between' },
      title: { fontWeight: 600, marginBottom: 2 },
      hint: { color: C.muted, fontSize: 12 },
      grid: { display: 'grid', gridTemplateColumns: 'minmax(150px, 200px) 1fr', gap: '10px 12px', alignItems: 'center' },
      label: { color: C.text },
      field: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '6px 9px',
        borderRadius: 6,
        border: `1px solid ${C.border}`,
        background: C.field,
        color: C.text,
        font: 'inherit',
      },
      btn: {
        padding: '6px 14px',
        borderRadius: 6,
        border: `1px solid ${C.border}`,
        background: C.field,
        color: C.text,
        cursor: 'pointer',
        font: 'inherit',
      },
      btnPrimary: {
        padding: '6px 14px',
        borderRadius: 6,
        border: `1px solid ${C.accent}`,
        background: C.accent,
        color: '#fff',
        cursor: 'pointer',
        font: 'inherit',
      },
      badge: (color) => ({
        display: 'inline-block',
        padding: '1px 7px',
        borderRadius: 999,
        fontSize: 11,
        border: `1px solid ${color}`,
        color,
      }),
    }

    // 字段定义：key 必须与宿主 Config schema 的 volatile 字段一一对应
    const FIELDS = [
      { key: 'enabled', label: '启用插件', type: 'bool', hint: '总开关。关闭后不再收发、也不再唤醒本会话 AI' },
      { key: 'exePath', label: 'LanChat.exe 路径', type: 'text', hint: '留空则自动查找（工作目录 / 安装目录 / 局域网其它机器）', span: true },
      { key: 'port', label: 'LanChat 端口', type: 'number', hint: '默认 80（Windows 自带默认端口）' },
      { key: 'dataDir', label: '数据目录', type: 'text', hint: '留空用 LanChat 默认（接收到的文件在这里）', span: true },
      { key: 'autoStart', label: '自动拉起 LanChat', type: 'bool', hint: 'DSH 启动时若 LanChat 没在跑就帮你启动它（脱离式，与手动双击一样常驻托盘）。已在运行则直接接入，不会重复启动' },
      { key: 'allowFetchFromPeer', label: '允许从局域网获取程序', type: 'bool', hint: '本机没有 LanChat.exe 时，从局域网里其它机器拉一份' },
      { key: 'batchWindowMs', label: '合并窗口（毫秒）', type: 'number', hint: '同一批内容攒够这么久没新增就自动发出，默认 30000' },
      { key: 'wakeDebounceMs', label: '唤醒防抖（毫秒）', type: 'number', hint: '收到消息后安静这么久才唤醒本会话 AI，默认 4000' },
      { key: 'requireAgentStatus', label: 'AI 忙时不打断', type: 'bool', hint: '仅在 DSH 0.2.0+ 生效（0.1.7 无 agent/status 事件时自动降级）' },
      { key: 'wakeSessions', label: '收到消息时唤醒哪些会话', type: 'sessions', hint: '勾选后 LanChat 收到消息会主动唤醒这些会话的 AI 来处理（可多选）；一个都不勾则回退为「最近调用过 LanChat 工具的会话」。' },
    ]

    const DEFAULTS = {
      enabled: true,
      exePath: '',
      port: 80,
      dataDir: '',
      autoStart: true,
      allowFetchFromPeer: true,
      batchWindowMs: 30000,
      wakeDebounceMs: 4000,
      requireAgentStatus: true,
      wakeSessions: [],
    }

    function Panel(props) {
      const ctx = props.ctx
      const [cfg, setCfg] = React.useState(null)
      const [rev, setRev] = React.useState(undefined)
      const [status, setStatus] = React.useState('正在读取配置…')
      const [tone, setTone] = React.useState('muted')
      const [saved, setSaved] = React.useState(false)
      const [nsNames, setNsNames] = React.useState('')
      const cfgRef = React.useRef(null)
      const revRef = React.useRef(undefined)
      const savedTimer = React.useRef(null)
      cfgRef.current = cfg
      revRef.current = rev

      // ---- 会话列表（供"唤醒哪些会话"多选）----
      // 通过客户端 sessions 服务拿：含**会话名称**与**会话 ID**，正是勾选时需要的两样信息。
      const [sess, setSess] = React.useState(null)          // null = 读取中
      const [sessErr, setSessErr] = React.useState('')
      const loadSessions = React.useCallback(async () => {
        setSessErr('')
        try {
          // 取会话列表：**正确的接口**是 ctx.remote.session.list()
          //   —— 宿主 sessionController 通过 @Remote('list') 暴露成 remote.session 命名空间。
          //   （ctx.sessions.search('') 那条路走不通：空查询返回空，且它是另一个服务。）
          //   会话摘要里**没有 title 字段**，标题在 projections.values 里，故按三级回退显示：
          //   标题 → 工作区目录 → 短会话 ID。
          const pickTitle = (it) => {
            const vals = it && it.projections && it.projections.values
            if (vals && typeof vals === 'object') {
              for (const k of Object.keys(vals)) {
                if (!/title/i.test(k)) continue
                const raw = vals[k]
                const s = typeof raw === 'string'
                  ? raw
                  : (raw && (raw.title || raw.value || raw.text))
                if (typeof s === 'string' && s.trim()) return s.trim()
              }
            }
            if (it && it.cwd) {
              const base = String(it.cwd).replace(/[\\/]+$/, '').split(/[\\/]/).pop()
              if (base) return base + '（工作区）'
            }
            return '会话 ' + String((it && it.sessionId) || '').slice(0, 8)
          }
          let items = []
          let via = ''
          const ctrl = new AbortController()
          const rs = ctx && ctx.remote && ctx.remote.session
          if (rs && typeof rs.list === 'function') {
            const res = await rs.list({}, ctrl.signal)
            const val = res && res.ok === true ? res.value : res
            items = (val && val.items) || []
            via = 'remote.session.list'
          } else {
            // 退路：客户端 sessions 服务（有的版本可用）
            let api = null
            try { api = ctx && ctx.sessions } catch (e) { api = null }
            if (!api && ctx && typeof ctx.get === 'function') { try { api = ctx.get('sessions') } catch (e) { api = null } }
            if (api && typeof api.search === 'function') {
              const res = await api.search('', ctrl.signal)
              const val = res && res.ok === true ? res.value : res
              items = (val && val.items) || []
              via = 'sessions.search'
            }
          }
          const list = []
          for (const it of items) {
            if (!it) continue
            if (it.origin === 'subagent') continue          // 子代理会话不作为唤醒目标
            const id = String(it.sessionId || it.id || '')
            if (!id) continue
            list.push({
              id,
              title: pickTitle(it),
              running: it.running === true,
              updatedAt: Number(it.updatedAt) || 0,
            })
          }
          list.sort((a, b) => b.updatedAt - a.updatedAt)
          setSess(list)
          if (list.length > 0) setSessErr('')
          else setSessErr('接口返回 0 个会话' + (via ? '（来自 ' + via + '）' : '（没有可用接口）'))
          setSess(list)
        } catch (e) {
          setSess([])
          setSessErr('读取会话列表失败：' + String((e && e.message) || e))
        }
      }, [ctx])
      React.useEffect(() => { loadSessions() }, [loadSessions])

      const flashSaved = React.useCallback(() => {
        setSaved(true)
        if (savedTimer.current) clearTimeout(savedTimer.current)
        savedTimer.current = setTimeout(() => setSaved(false), 2500)
      }, [])

      /** 读取本插件配置（DSH 只暴露带 volatile 字段的行）。返回信封，兼容裸对象。 */
      const loadCfg = React.useCallback(async () => {
        let settings
        try {
          settings = ctx?.remote?.settings
        } catch (e) {
          setStatus(`访问 remote.settings 失败：${String(e?.message ?? e)}`)
          setTone('err')
          return null
        }
        if (!settings?.describe) {
          setStatus('remote.settings 不可用')
          setTone('err')
          return null
        }
        try {
          const res = await settings.describe()
          const view = res?.ok === true ? res.value : res?.ok === undefined ? res : null
          if (!view || !Array.isArray(view.namespaces)) {
            setStatus(`settings.describe 未返回命名空间：${String(res?.error?.message ?? res?.error ?? '空响应')}`)
            setTone('err')
            return null
          }
          setNsNames(view.namespaces.map((n) => n.ns).join('、'))
          const ns = view.namespaces.find((n) => n.ns === NS)
          if (!ns) {
            setStatus(`settings 里没有 ${NS} 命名空间 —— 插件宿主行可能未激活或未声明 volatile 配置`)
            setTone('warn')
            return null
          }
          const value = ns.value && typeof ns.value === 'object' ? ns.value : {}
          setCfg({ ...DEFAULTS, ...value })
          setRev(ns.revision)
          setStatus('')
          setTone('muted')
          return value
        } catch (e) {
          setStatus(`读取配置失败：${String(e?.message ?? e)}`)
          setTone('err')
          return null
        }
      }, [ctx])

      React.useEffect(() => {
        loadCfg()
      }, [loadCfg])

      /** 写入一个字段：DSH 的 volatile 写入走 settings.mutate，保存即生效。 */
      const writeField = React.useCallback(
        async (key, value) => {
          const next = { ...(cfgRef.current ?? DEFAULTS), [key]: value }
          setCfg(next)                                   // 乐观更新，界面立刻响应
          let settings
          try {
            settings = ctx?.remote?.settings
          } catch {
            settings = null
          }
          if (!settings?.mutate) {
            setStatus('remote.settings.mutate 不可用，无法保存')
            setTone('err')
            return
          }
          try {
            const res = await settings.mutate(NS, [{ op: 'set', path: [key], value }], revRef.current)
            const ok = res?.ok === true || res?.ok === undefined
            if (!ok) {
              setStatus(`保存失败：${String(res?.error?.message ?? res?.error ?? '未知错误')}`)
              setTone('err')
              return
            }
            const view = res?.ok === true ? res.value : res
            if (view && typeof view.revision === 'number') setRev(view.revision)
            setStatus('')
            setTone('muted')
            flashSaved()
          } catch (e) {
            setStatus(`保存失败：${String(e?.message ?? e)}`)
            setTone('err')
          }
        },
        [ctx, flashSaved],
      )

      const toneColor = tone === 'err' ? C.err : tone === 'warn' ? C.warn : C.muted

      const rows = []
      for (const f of FIELDS) {
        if (f.type === 'bool') {
          rows.push(
            h('div', { key: f.key, style: S.row },
              h('div', null,
                h('div', null, f.label),
                f.hint ? h('div', { style: S.hint }, f.hint) : null,
              ),
              h('input', {
                type: 'checkbox',
                checked: cfg ? cfg[f.key] === true : DEFAULTS[f.key] === true,
                disabled: cfg === null,
                onChange: (e) => writeField(f.key, e.target.checked),
                style: { width: 16, height: 16, cursor: 'pointer' },
              }),
            ),
          )
        } else if (f.type === 'sessions') {
          const sel = cfg && Array.isArray(cfg[f.key]) ? cfg[f.key] : []
          rows.push(
            h('div', { key: f.key, style: { ...S.row, alignItems: 'flex-start' } },
              h('div', { style: { width: '100%' } },
                h('div', null, f.label),
                f.hint ? h('div', { style: S.hint }, f.hint) : null,
                sessErr ? h('div', { style: { ...S.hint, color: C.err } }, sessErr) : null,
                sess === null
                  ? h('div', { style: S.hint }, '正在读取会话列表…')
                  : sess.length === 0
                    ? h('div', { style: S.hint }, '没有读到会话（可在别的会话里发一条消息后再刷新）')
                    : h('div', { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 } },
                        ...sess.map((s) => h('label', {
                          key: s.id,
                          style: {
                            display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                            padding: '6px 8px', borderRadius: 6,
                            background: sel.indexOf(s.id) >= 0 ? 'rgba(90,160,240,0.10)' : 'transparent',
                          },
                        },
                          h('input', {
                            type: 'checkbox',
                            checked: sel.indexOf(s.id) >= 0,
                            disabled: cfg === null,
                            onChange: (e) => {
                              const next = e.target.checked
                                ? sel.concat([s.id])
                                : sel.filter((x) => x !== s.id)
                              writeField(f.key, next)
                            },
                            style: { width: 16, height: 16, cursor: 'pointer' },
                          }),
                          h('span', null, s.title),
                          h('span', { style: { ...S.hint, marginLeft: 'auto' } }, s.id),
                        )),
                      ),
                h('div', { style: { marginTop: 8 } },
                  h('button', {
                    type: 'button',
                    onClick: loadSessions,
                    style: {
                      padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
                      border: '1px solid rgba(128,128,128,0.4)', background: 'transparent',
                      color: 'inherit', font: 'inherit',
                    },
                  }, '刷新会话列表'),
                  h('span', { style: { ...S.hint, marginLeft: 8 } },
                    '已勾选 ' + sel.length + ' 个会话'),
                ),
              ),
            ),
          )
        } else {
          rows.push(
            h('div', { key: f.key, style: S.row },
              h('div', null,
                h('div', null, f.label),
                f.hint ? h('div', { style: S.hint }, f.hint) : null,
              ),
              h('input', {
                type: f.type === 'number' ? 'number' : 'text',
                value: cfg ? String(cfg[f.key] ?? '') : '',
                disabled: cfg === null,
                placeholder: String(DEFAULTS[f.key] ?? ''),
                onChange: (e) => {
                  const raw = e.target.value
                  setCfg({ ...(cfgRef.current ?? DEFAULTS), [f.key]: raw })   // 输入时就更新本地，失焦才落盘
                },
                onBlur: (e) => {
                  const raw = e.target.value
                  const value = f.type === 'number' ? Number(raw) || DEFAULTS[f.key] : raw
                  writeField(f.key, value)
                },
                onKeyDown: (e) => {
                  if (e.key === 'Enter') e.target.blur()
                },
                style: S.field,
              }),
            ),
          )
        }
      }

      return h('div', { style: S.wrap },
        h('div', { style: S.card },
          h('div', { style: S.row },
            h('div', null,
              h('div', { style: S.title }, 'LanChat 局域网通讯'),
              h('div', { style: S.hint },
                '与局域网里其它机器的 DSH 对话。发送默认合并成一批（避免对面的 AI 被拆开唤醒）；' +
                '收到消息后会自动唤醒本会话。',
              ),
            ),
            h('span', { style: S.badge(cfg?.enabled ? C.ok : C.muted) }, cfg?.enabled ? '已启用' : '已停用'),
          ),
          h('div', { style: { ...S.hint, marginTop: 6 } },
            saved ? '✅ 已保存并即时生效' : (status || '改动立即生效，无需重启'),
          ),
        ),

        h('div', { style: S.card }, rows),

        h('div', { style: S.card },
          h('div', { style: S.title }, '排查'),
          h('div', { style: S.hint }, `配置命名空间：${NS}`),
          nsNames ? h('div', { style: S.hint }, `settings 现有命名空间：${nsNames}`) : null,
          h('div', { style: { ...S.row, justifyContent: 'flex-start', marginTop: 8 } },
            h('button', { style: S.btn, onClick: () => loadCfg() }, '重新读取'),
          ),
        ),
      )
    }

    /** 出错兜底：渲染异常只显示提示，不扩散到整个设置页。 */
    class Boundary extends React.Component {
      constructor(p) {
        super(p)
        this.state = { err: null }
      }
      static getDerivedStateFromError(err) {
        return { err }
      }
      render() {
        if (this.state.err) {
          return h('div', { style: S.card },
            h('div', { style: S.title }, 'LanChat 设置面板渲染失败'),
            h('div', { style: S.hint }, String(this.state.err?.message ?? this.state.err)),
          )
        }
        return this.props.children
      }
    }

    return {
      inject: ['slots', 'remote', 'remote.settings', 'sessions', 'remote.session'],
      apply(ctx) {
        // ⚠️ 必须像参考插件那样：先 slots.inject(槽位名, 回调) 声明占用，再在回调里 register。
        //    直接 register（不 inject）会注册不上 —— 而且如果外面套了 try/catch 就会**静默失败**，
        //    表现就是"设置页里根本没有这一栏"。这里失败要打日志，不许再吞。
        try {
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: 'lanchat', order: 62, label: () => '局域网通讯' },
              function LanChatSection() {
                return h(Boundary, null, h(Panel, { ctx }))
              },
            ),
          )
        } catch (e) {
          console.error('[lanchat] 设置面板注册失败：', e)
        }
      },
    }
  },
})
