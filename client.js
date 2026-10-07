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
      inject: ['slots', 'remote', 'remote.settings'],
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
