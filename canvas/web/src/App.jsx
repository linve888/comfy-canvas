import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  ReactFlow,
  Background,
  MiniMap,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  useReactFlow,
  useViewport,
} from '@xyflow/react'
import {
  CanvasCtx,
  USE_OF_KIND,
  defaultParams,
  fieldsOf,
  labelOfSlot,
  pickOutput,
  outputsOf,
  slotsOfKind,
  slotKindOf,
  IMAGE_TOOLS,
  LIGHT_PRESETS,
  carryParams,
} from './ctx.js'
import * as api from './api.js'
import { rlog } from './log.js'
import TemplateNode from './nodes/TemplateNode.jsx'
import MediaNode from './nodes/MediaNode.jsx'
import GenNode from './nodes/GenNode.jsx'
import TextNode from './nodes/TextNode.jsx'
import Wire from './edges/Wire.jsx'
import { planChain } from './chain.js'
import Lightbox from './ui/Lightbox.jsx'
import SplitModal from './ui/SplitModal.jsx'
import ChainPlan from './ui/ChainPlan.jsx'
import WorkflowImport from './ui/WorkflowImport.jsx'
import Icon, { ToolIcon } from './ui/Icon.jsx'
import { installPlusMagnet } from './ui/plusMagnet.js'

const NODE_TYPES = {
  template: TemplateNode,
  media: MediaNode,
  imagegen: (p) => <GenNode {...p} kind="imagegen" />,
  videogen: (p) => <GenNode {...p} kind="videogen" />,
  text: TextNode,
}

const EDGE_TYPES = { wire: Wire }

let seq = 1
const newId = () => `n${Date.now().toString(36)}${seq++}`
const clone = (x) => JSON.parse(JSON.stringify(x))

// 挑模板：needsImage 表示新节点进来就得有图槽（拖一根图过来接上）
function pickTemplate(templates, kind, needsImage) {
  const opts = templates.filter((t) => t.use === USE_OF_KIND[kind])
  if (!opts.length) return null
  if (!needsImage) return opts[0]
  return opts.find((t) => (t.imageSlots || []).length) || opts[0]
}

function makeGenNode(templates, kind, pos, tplName) {
  const opts = templates.filter((t) => t.use === USE_OF_KIND[kind])
  const t = (tplName && opts.find((x) => x.name === tplName)) || opts[0]
  return {
    id: newId(),
    type: kind,
    position: pos,
    data: { template: t?.name || '', params: defaultParams(t), status: 'idle', outputs: [], history: [], error: '' },
  }
}

function makeTemplateNode(templates, pos) {
  const t = templates.find((x) => x.name === 'qwen21_edit') || templates[0]
  return {
    id: newId(),
    type: 'template',
    position: pos,
    data: { template: t?.name || '', params: defaultParams(t), status: 'idle', outputs: [], error: '' },
  }
}

function makeTextNode(pos) {
  return {
    id: newId(),
    type: 'text',
    position: pos,
    data: { text: '', label: '提示词' },
  }
}

/**
 * 老画布的边是按具体槽位连的（in:image_1 / in:video_1 …）。统一成一个媒体口之后，
 * 要把它们归到 in:media，并按原先的槽位顺序写出 mediaOrder ——
 * 这样连线和跑出来的结果都不变，只是以后槽位由顺序现算。
 */
function migrateMediaPorts(nodes, edges, templates) {
  const RANK = { image: 0, video: 1000, audio: 2000 }
  const nextEdges = []
  const ranked = new Map()

  for (const e of edges) {
    const h = e.targetHandle || ''
    const isMedia = h.startsWith('in:') && h !== 'in:prompt'
    if (!isMedia) {
      nextEdges.push(e)
      continue
    }
    const slot = h.slice(3)
    const tpl = templates.find((t) => t.name === nodes.find((n) => n.id === e.target)?.data?.template)
    let rank = 9e6
    for (const [kind, key] of [
      ['image', 'imageSlots'],
      ['video', 'videoSlots'],
      ['audio', 'audioSlots'],
    ]) {
      const i = (tpl?.[key] || []).indexOf(slot)
      if (i >= 0) {
        rank = RANK[kind] + i
        break
      }
    }
    if (!ranked.has(e.target)) ranked.set(e.target, [])
    ranked.get(e.target).push({ id: e.id, rank })
    nextEdges.push(h === 'in:media' ? e : { ...e, targetHandle: 'in:media' })
  }

  const nextNodes = nodes.map((n) => {
    const list = ranked.get(n.id)
    if (!list) return n
    const existing = n.data?.mediaOrder || []
    const mine = nextEdges.filter((e) => e.target === n.id && e.targetHandle === 'in:media').map((e) => e.id)
    // 已经是新画布、顺序也是用户调过的：只把新冒出来的边补到末尾
    if (existing.length && list.every((x) => x.rank === 9e6)) {
      const extra = mine.filter((id) => !existing.includes(id))
      return extra.length ? { ...n, data: { ...n.data, mediaOrder: [...existing, ...extra] } } : n
    }
    const ids = [...list].sort((a, b) => a.rank - b.rank).map((x) => x.id)
    const extra = mine.filter((id) => !ids.includes(id))
    return { ...n, data: { ...n.data, mediaOrder: [...ids, ...extra] } }
  })

  return { nodes: nextNodes, edges: nextEdges }
}

function mediaNode(m, pos, id = newId()) {
  const out = { assetId: m.assetId, url: m.url, kind: m.kind || 'image', filename: m.filename }
  return {
    id,
    type: 'media',
    position: pos,
    data: {
      kind: m.kind || 'image',
      url: m.url,
      label: m.label,
      filename: m.filename,
      assetId: m.assetId,
      outputs: [out],
      history: [{ jobId: 'src', outputs: [out] }],
    },
  }
}

const loadImage = (url) =>
  new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片加载失败'))
    img.src = url
  })

// 鼠标/触摸事件的屏幕坐标
function posOf(e) {
  if (!e) return null
  if (typeof e.clientX === 'number') return { x: e.clientX, y: e.clientY }
  const t = e.touches?.[0] || e.changedTouches?.[0]
  return t ? { x: t.clientX, y: t.clientY } : null
}

// 槽位名做短：meta 里的「图 1（构图基准，必接）」挂在线中间太长了
function shortSlot(label) {
  const t = String(label || '').split(/[（(·]/)[0].trim()
  if (!t) return '连线'
  return t.length > 14 ? t.slice(0, 13) + '…' : t
}

export default function App() {
  const [templates, setTemplates] = useState([])
  const [materials, setMaterials] = useState([])
  const [nodes, setNodes] = useState([])
  const [edges, setEdges] = useState([])
  const [jobs, setJobs] = useState([])
  const [health, setHealth] = useState(null)
  const [toast, setToast] = useState('')
  const [saved, setSaved] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [matQuery, setMatQuery] = useState('')
  const [busyUpload, setBusyUpload] = useState(false)
  const [viewer, setViewer] = useState(null)
  const [split, setSplit] = useState(null)
  const [menu, setMenu] = useState(null)
  const [plan, setPlan] = useState(null)
  const [chain, setChain] = useState(null)
  const [importOpen, setImportOpen] = useState(null)

  // 画布工具层（借 LibTV 的 dock / 左下状态条 / 全部功能）
  const [compact, setCompact] = useState(false) // 全局紧凑：编辑器收成一行
  const [sideTab, setSideTab] = useState('lib') // lib=素材模板 out=节点大纲
  const [expandOpen, setExpandOpen] = useState(false) // 底部「＋」加节点菜单
  const [allTools, setAllTools] = useState(false) // 全部功能面板
  const [cheat, setCheat] = useState(false) // 快捷键面板
  const [hand, setHand] = useState(false) // 移动工具
  const [miniMap, setMiniMap] = useState(false)
  const [hideWires, setHideWires] = useState(false)
  const [snap, setSnap] = useState(false)
  const [zoomMenu, setZoomMenu] = useState(false)
  const [outQuery, setOutQuery] = useState('')
  const [tasksOpen, setTasksOpen] = useState(false) // 任务抽屉：默认收起，画布全屏
  const [sideOpen, setSideOpen] = useState(false) // 左侧素材抽屉：默认收起
  const openSide = (tab) => {
    if (sideTab === tab) setSideOpen((v) => !v)
    else {
      setSideTab(tab)
      setSideOpen(true)
    }
  }
  const [toolQuery, setToolQuery] = useState('')

  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  const jobsRef = useRef(jobs)
  const templatesRef = useRef(templates)
  const uploadInput = useRef(null)
  const connectFrom = useRef(null)
  const paneClickAt = useRef(0)
  const chainRef = useRef({ running: false, cancel: false, jobId: '' })
  nodesRef.current = nodes
  edgesRef.current = edges
  jobsRef.current = jobs
  templatesRef.current = templates

  const rf = useReactFlow()
  const { zoom } = useViewport()

  const flash = useCallback((m) => {
    setToast(m)
    setTimeout(() => setToast(''), 6000)
  }, [])

  // ---------- 初始化
  useEffect(() => {
    ;(async () => {
      try {
        const [t, g, m] = await Promise.all([
          api.getTemplates(),
          api.getGraph(),
          api.getMaterials().catch(() => ({ materials: [] })),
        ])
        setTemplates(t.templates || [])
        setMaterials(m.materials || [])
        if (g.nodes?.length) {
          const mig = migrateMediaPorts(g.nodes, g.edges || [], t.templates || [])
          setNodes(mig.nodes)
          setEdges(mig.edges)
        } else {
          setNodes([makeGenNode(t.templates || [], 'imagegen', { x: 140, y: 120 })])
        }
      } catch (e) {
        flash(`初始化失败：${e.message}`)
      } finally {
        setLoaded(true)
      }
    })()
  }, [flash])

  // 一次性说明：编辑器的位置变了，老用户第一次打开容易以为节点坏了
  useEffect(() => {
    if (!loaded) return
    try {
      if (localStorage.getItem('cv-editor-tip')) return
      localStorage.setItem('cv-editor-tip', '1')
    } catch {
      /* 隐私模式下 localStorage 不可用，不提示也罢 */
    }
    const t = setTimeout(
      () => flash('点一下节点就展开提示词与参数，点空白处收起 · 节点太密时按底部「紧凑」收成一行'),
      900
    )
    return () => clearTimeout(t)
  }, [loaded, flash])

  // ---------- 健康检查
  useEffect(() => {
    const tick = async () => {
      try {
        setHealth(await api.getHealth())
      } catch {
        setHealth({ online: false })
      }
    }
    tick()
    const t = setInterval(tick, 6000)
    return () => clearInterval(t)
  }, [])

  // ---------- 侧边「＋」的磁吸：鼠标靠近时朝光标靠过去（不移动线的端点）
  useEffect(() => installPlusMagnet(), [])

  // ---------- 任务轮询：状态回写 + 产物进版本历史
  useEffect(() => {
    let stop = false
    // 上一次看到的任务状态：只在跃迁时记日志。900ms 一次的轮询全记，
    // 一个 40 秒的任务能刷出 40 条一样的行，真正有用的那条就找不着了。
    const seen = new Map()
    // 首轮只铺底不记：历史任务会一次性刷出几十条 from=new，把日志淹掉
    let primed = false
    const tick = async () => {
      try {
        const d = await api.getJobs(60)
        if (stop) return
        const list = d.jobs || []
        if (!primed) {
          for (const j of list) seen.set(j.id, j.status)
          primed = true
        }
        for (const j of list) {
          const prev = seen.get(j.id)
          if (prev === j.status) continue
          seen.set(j.id, j.status)
          rlog(
            'gen.state',
            {
              node: j.nodeId || '',
              job: j.id,
              from: prev || 'new',
              to: j.status,
              secs: j.elapsed ?? '',
              phase: j.phase || '',
              err: j.error || '',
              out: j.status === 'done' ? (j.outputs || []).length : '',
              seed: j.status === 'done' ? j.seed || '' : '',
            },
            j.status === 'error' ? 'E' : 'I'
          )
        }
        setJobs(list)
        setNodes((nds) => {
          let changed = false
          const next = nds.map((n) => {
            if (!n.data?.template) return n
            const mine = list.find((j) => j.nodeId === n.id)
            if (!mine) return n
            const patch = {}
            if (mine.status !== n.data.status) patch.status = mine.status
            if (mine.elapsed && mine.elapsed !== n.data.elapsed) patch.elapsed = mine.elapsed
            if (mine.error && mine.error !== n.data.error) patch.error = mine.error
            if (mine.status === 'done' && (mine.outputs || []).length && (!n.data.jobId || n.data.jobId === mine.id)) {
              const hist = n.data.history || []
              if (!hist.some((h) => h.jobId === mine.id)) {
                patch.history = [
                  { jobId: mine.id, at: mine.finishedAt || '', seed: mine.seed || '', template: mine.template, outputs: mine.outputs },
                  ...hist,
                ].slice(0, 12)
                patch.outputs = mine.outputs
                patch.activeVersion = 0
                patch.activeOut = 0
                patch.dirty = false
              }
            }
            if (!Object.keys(patch).length) return n
            changed = true
            return { ...n, data: { ...n.data, ...patch } }
          })
          return changed ? next : nds
        })
      } catch {
        /* 后端短暂不可用时静默 */
      }
    }
    tick()
    const h = setInterval(tick, 900)
    return () => {
      stop = true
      clearInterval(h)
    }
  }, [])

  // ---------- 自动保存（防抖）
  useEffect(() => {
    if (!loaded) return
    const t = setTimeout(async () => {
      try {
        await api.saveGraph({ nodes, edges })
        const d = new Date()
        setSaved(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`)
      } catch {
        setSaved('保存失败')
      }
    }, 1200)
    return () => clearTimeout(t)
  }, [nodes, edges, loaded])

  // ---------- 派生：媒体输入
  /**
   * 一个生成节点只有一个媒体口（in:media），图 / 视频 / 音频都连在那一个点上。
   * 到底进哪个槽位是**现算**的：按 node.data.mediaOrder 记录的顺序排好，
   * 再按类型依次填 imageSlots / videoSlots / audioSlots。
   *
   * 好处是切模板不用搬线 —— 顺序不变，槽位自动重排；顺序也能在参数面板里改。
   */
  const mediaEdgesOf = useCallback((nodeId) => {
    const node = nodesRef.current.find((n) => n.id === nodeId)
    const order = node?.data?.mediaOrder || []
    const list = []
    for (const e of edgesRef.current) {
      if (e.target !== nodeId) continue
      const h = e.targetHandle || ''
      if (!h.startsWith('in:') || h === 'in:prompt') continue
      const src = nodesRef.current.find((n) => n.id === e.source)
      const out = pickOutput(src)
      const kind =
        out?.kind || (src?.type === 'videogen' ? 'video' : src?.type === 'text' ? 'text' : src?.data?.kind || 'image')
      list.push({
        edgeId: e.id,
        sourceId: e.source,
        kind,
        url: out?.url || src?.data?.url || '',
        assetId: out?.assetId || '',
        name: src?.data?.label || src?.data?.filename || out?.filename || '素材',
      })
    }
    const rank = (id) => {
      const i = order.indexOf(id)
      return i < 0 ? 1e6 : i
    }
    return list.sort((a, b) => rank(a.edgeId) - rank(b.edgeId))
  }, [])

  /** 给 UI 用：有序列表 + 每条实际占到的槽位名（空串 = 这个模板没位置给它） */
  const getMediaInputs = useCallback(
    (nodeId) => {
      const node = nodesRef.current.find((n) => n.id === nodeId)
      const tpl =
        templatesRef.current.find((t) => t.name === node?.data?.template) ||
        templatesRef.current.find((t) => t.use === USE_OF_KIND[node?.type])
      const pool = {
        image: tpl?.imageSlots || [],
        video: tpl?.videoSlots || [],
        audio: tpl?.audioSlots || [],
      }
      const used = { image: 0, video: 0, audio: 0 }
      const items = mediaEdgesOf(nodeId).map((it) => {
        const slots = pool[it.kind] || []
        const idx = used[it.kind] || 0
        used[it.kind] = idx + 1
        return { ...it, slot: slots[idx] || '', slotLabel: slots[idx] ? labelOfSlot(tpl, slots[idx]) : '' }
      })
      return { items, tpl, pool }
    },
    [mediaEdgesOf]
  )

  // over：整链跑的时候，上游刚出的图还没回写进画布状态，用任务产物直接顶上
  const getInputs = useCallback(
    (nodeId, over) => {
      const res = {}
      const { items, pool } = getMediaInputs(nodeId)
      const used = { image: 0, video: 0, audio: 0 }
      for (const it of items) {
        const idx = used[it.kind] || 0
        used[it.kind] = idx + 1
        const fresh = over && over[it.sourceId]
        const assetId = (fresh ? fresh[0]?.assetId : it.assetId) || ''
        const slot = (pool[it.kind] || [])[idx]
        if (assetId && slot) res[slot] = assetId
      }
      return res
    },
    [getMediaInputs]
  )

  // 上游文本节点 → 提示词
  const getTextInput = useCallback((nodeId) => {
    for (const e of edgesRef.current) {
      if (e.target !== nodeId || e.targetHandle !== 'in:prompt') continue
      const src = nodesRef.current.find((n) => n.id === e.source)
      if (src?.type === 'text' && src.data?.text) return src.data.text
    }
    return ''
  }, [])

  const updateNode = useCallback((id, patch) => {
    if (patch.__remove) {
      setNodes((nds) => nds.filter((n) => n.id !== id))
      setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id))
      return
    }
    setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)))
  }, [])

  // ---------- 提交（单节点 / 整链 / 图片工具共用一条通路）
  const submit = useCallback(
    async (id, { template, params, inputs, label }) => {
      const t0 = performance.now()
      updateNode(id, { status: 'queued', error: '', elapsed: 0 })
      // 提交前的真实载荷：出问题时先看这条，别再猜「到底传了什么进去」
      rlog('gen.submit', {
        node: id,
        tpl: template,
        label,
        prompt_chars: String(params?.prompt || '').length,
        seed: params?.seed === '' || params?.seed == null ? '(auto)' : params.seed,
        slots: Object.keys(inputs || {}).join(',') || '(none)',
        params: Object.fromEntries(
          Object.entries(params || {}).filter(([k]) => k !== 'prompt').slice(0, 10)
        ),
      })
      try {
        const { job } = await api.runJob({
          nodeId: id,
          template,
          label: label || template,
          params,
          inputs,
        })
        rlog('gen.accepted', { node: id, job: job.id, ms: Math.round(performance.now() - t0) })
        updateNode(id, { jobId: job.id, status: 'queued' })
        return job
      } catch (e) {
        rlog('gen.submit.fail', { node: id, tpl: template, err: e.message }, 'E')
        updateNode(id, { status: 'error', error: e.message })
        flash(e.message)
        return null
      }
    },
    [updateNode, flash]
  )

  /**
   * 把「点什么」算成一份可提交的参数 + 输入。
   * 单节点运行和整链运行都走这里，校验只写一遍。
   */
  const prepareRun = useCallback(
    (id, opts = {}) => {
      const node = nodesRef.current.find((n) => n.id === id)
      if (!node) return { error: '节点不存在' }
      // 节点刚建、模板列表还没拉回来时 template 可能是空串，按类别兜第一个
      const tplName = node.data.template || templatesRef.current.find((t) => t.use === USE_OF_KIND[node.type])?.name
      const tpl = templatesRef.current.find((t) => t.name === tplName)
      if (!tpl) return { error: '请先选模板' }

      const inputs = getInputs(id, opts.over)
      const need = tpl.requiredImageSlots || tpl.imageSlots || []
      const missing = need.filter((s) => !inputs[s])
      if (missing.length) {
        return { error: `这些参考图还没连：${missing.map((s) => labelOfSlot(tpl, s)).join('、')}` }
      }
      const linked = Object.keys(inputs).length
      if (linked < (tpl.minImages || 0)) {
        return { error: `这个模板至少要接 ${tpl.minImages} 张参考图，现在接了 ${linked} 张` }
      }

      const params = { ...(node.data.params || {}) }
      if (opts.reroll) params.seed = ''
      const up = getTextInput(id)
      if (up) params.prompt = up
      if (fieldsOf(tpl).some((f) => f.slot === 'prompt') && !String(params.prompt || '').trim()) {
        return { error: '提示词是空的 —— 写清画面里有什么再跑' }
      }

      return { node, tpl, tplName, params, inputs, label: tpl.label || tpl.name }
    },
    [getInputs, getTextInput]
  )

  const runNode = useCallback(
    async (id, opts = {}) => {
      const prep = prepareRun(id, opts)
      if (prep.error) {
        // 点了生成却什么都没跑：原因写进日志，不然界面上只有一个一闪而过的提示
        rlog('gen.blocked', { node: id, why: prep.error, reroll: !!opts.reroll }, 'W')
        return flash(prep.error)
      }
      if (!prep.node.data.template) updateNode(id, { template: prep.tplName })
      return submit(id, { template: prep.tplName, params: prep.params, inputs: prep.inputs, label: prep.label })
    },
    [prepareRun, updateNode, submit, flash]
  )

  // ---------- 整链：按拓扑序一个个跑，上游跑完才提交下游
  const stopChain = useCallback(async () => {
    if (!chainRef.current.running) return
    chainRef.current.cancel = true
    if (chainRef.current.jobId) {
      try {
        await api.cancelJob(chainRef.current.jobId)
      } catch {
        /* 已经跑完就算了 */
      }
    }
    flash('正在停下整链…')
  }, [flash])

  /** 等一个任务到终态，返回任务记录（带产物）；超时或取消返回 null */
  const waitJob = useCallback(async (jobId) => {
    const t0 = Date.now()
    let misses = 0
    while (Date.now() - t0 < 45 * 60 * 1000) {
      await new Promise((r) => setTimeout(r, 700))
      if (chainRef.current.cancel) return null
      try {
        const d = await api.getJobs(60)
        const j = (d.jobs || []).find((x) => x.id === jobId)
        if (!j) {
          if (++misses > 6) return null
          continue
        }
        misses = 0
        if (j.status === 'done' || j.status === 'error' || j.status === 'canceled') return j
      } catch {
        /* 后端抖一下不算失败，继续等 */
      }
    }
    return null
  }, [])

  const startChain = useCallback(async () => {
    const pending = plan
    if (!pending || chainRef.current.running) return
    const order = pending.plan.order
    chainRef.current = { running: true, cancel: false, jobId: '' }
    rlog('chain.start', { total: order.length, target: pending.targetId })
    setPlan(null)
    setChain({ done: 0, total: order.length, label: '' })

    const fresh = {} // 刚跑完的节点产物：下游取它，不然会拿到旧图
    let stop = ''

    for (let i = 0; i < order.length; i++) {
      const id = order[i]
      if (chainRef.current.cancel) {
        stop = `停在第 ${i + 1} 个之前`
        break
      }
      const prep = prepareRun(id, { over: fresh })
      if (prep.error) {
        stop = `第 ${i + 1} 个：${prep.error}`
        break
      }
      setChain({ done: i, total: order.length, label: prep.label })
      rlog('chain.step', { i: i + 1, of: order.length, node: id, tpl: prep.tplName })
      if (!prep.node.data.template) updateNode(id, { template: prep.tplName })

      const job = await submit(id, {
        template: prep.tplName,
        params: prep.params,
        inputs: prep.inputs,
        label: prep.label,
      })
      if (!job) {
        stop = `第 ${i + 1} 个提交失败`
        break
      }
      chainRef.current.jobId = job.id

      const done = await waitJob(job.id)
      if (!done || done.status !== 'done') {
        stop = done?.status === 'canceled' ? '已取消' : `第 ${i + 1} 个（${prep.label}）失败`
        break
      }
      if (done.outputs?.length) fresh[id] = done.outputs
      chainRef.current.jobId = ''
      setChain({ done: i + 1, total: order.length, label: prep.label })
    }

    chainRef.current = { running: false, cancel: false, jobId: '' }
    setChain(null)
    rlog('chain.stop', { total: order.length, why: stop || 'done' }, stop ? 'W' : 'I')
    flash(stop ? `整链中断：${stop}` : `整链跑完，共 ${order.length} 个节点`)
  }, [plan, prepareRun, submit, waitJob, updateNode, flash])

  const openChain = useCallback(
    (targetId) => {
      if (chainRef.current.running) return flash('整链正在跑，先停掉再开新的')
      const p = planChain(nodesRef.current, edgesRef.current, targetId)
      if (p.reason) return flash(p.reason)
      if (!p.order.length) return flash('这条链上没有要跑的节点')
      setPlan({ targetId, plan: p })
    },
    [flash]
  )

  // 顶栏「整链」：多个选中时取最靠右的那个（流程从左往右）
  const chainSelected = useCallback(() => {
    const sel = nodesRef.current.filter((n) => n.selected && n.data?.template)
    if (!sel.length) return flash('先选中要跑到哪个节点')
    const t = [...sel].sort((a, b) => (b.position?.x || 0) - (a.position?.x || 0))[0]
    openChain(t.id)
  }, [flash, openChain])

  // 图片工具：拿当前这张图再加工，切到多图编辑模板直接跑
  const applyTool = useCallback(
    async (id, tool) => {
      const node = nodesRef.current.find((n) => n.id === id)
      if (!node) return
      if (node.data.status === 'running' || node.data.status === 'queued') {
        return flash('这个节点还在生成，等它跑完再用工具')
      }
      const tpl = templatesRef.current.find((t) => t.name === 'qwen21_edit_multi')
      if (!tpl) return flash('缺少多图编辑模板 qwen21_edit_multi')

      const cur = pickOutput(node)
      const firstImg = getMediaInputs(id).items.find((i) => i.kind === 'image')?.assetId
      const src = cur?.assetId || firstImg
      if (!src) return flash('先给节点一张图：生成一张，或接一张参考图')

      const old = node.data.params || {}
      // 比例、像素这些从原模板搬过来时要按目标模板的选项收一遍：
      // Krea2 存的是 `16:9`，Qwen 那边的 ResolutionSelector 只认 `16:9 (Widescreen)`，
      // 原样搬就是 value_not_in_list（整单 400）。carryParams 走一遍 coerceParam：
      // 同比例的换成目标写法，换不了退回目标模板自己的默认值。
      const params = {
        ...defaultParams(tpl),
        ...carryParams(tpl, old, ['aspect', 'megapixels', 'resolution']),
        prompt: tool.prompt,
      }
      updateNode(id, { template: tpl.name, params, error: '' })
      rlog('gen.tool', {
        node: id,
        tool: tool.key,
        tpl: tpl.name,
        src: cur?.assetId || firstImg || '',
        aspect: `${old.aspect || '(none)'} -> ${params.aspect || '(none)'}`,
      })
      await submit(id, {
        template: tpl.name,
        params,
        inputs: { image_1: src },
        label: `工具 · ${tool.label}`,
      })
    },
    [getMediaInputs, updateNode, submit, flash]
  )

  const cancelNode = useCallback(
    async (jobId) => {
      rlog('gen.stop.req', { job: jobId || '(no-job)' })
      try {
        await api.cancelJob(jobId)
      } catch (e) {
        rlog('gen.stop.fail', { job: jobId, err: e.message }, 'W')
        flash(e.message)
      }
    },
    [flash]
  )

  // ---------- 画布事件
  const onNodesChange = useCallback((ch) => setNodes((nds) => applyNodeChanges(ch, nds)), [])
  const onEdgesChange = useCallback((ch) => setEdges((eds) => applyEdgeChanges(ch, eds)), [])

  const deleteEdge = useCallback((id) => setEdges((eds) => eds.filter((e) => e.id !== id)), [])

  // 从 from 顺着连线能不能走到 to —— 用来挡环
  const reaches = useCallback((from, to) => {
    const seen = new Set()
    const stack = [from]
    while (stack.length) {
      const cur = stack.pop()
      if (cur === to) return true
      if (seen.has(cur)) continue
      seen.add(cur)
      for (const e of edgesRef.current) if (e.source === cur) stack.push(e.target)
    }
    return false
  }, [])

  /**
   * 拖线的时候就判合法性，接不了的口不会被吸住：
   * 文本只能进提示词口；媒体按类型对号入座（图片进图槽、视频进视频槽、音频进音频槽）；
   * 自己连自己、连成环都不行。
   */
  /** 一个节点的输出算什么媒体：有产物按产物，没产物按节点类型兜 */
  const kindOfNode = useCallback((n) => {
    if (!n) return 'image'
    if (n.type === 'text') return 'text'
    const out = pickOutput(n)
    if (out?.kind) return out.kind
    if (n.type === 'videogen') return 'video'
    return n.data?.kind || 'image'
  }, [])

  /**
   * 拖线时的合法性：文本只能进提示词口，媒体进那唯一一个媒体口。
   * 媒体类型对不对得上（模板有没有这类槽位）放到 onConnect 里判 ——
   * 接不上还能顺手换个模板，比在拖动时把人挡回去好。
   */
  const isValidConnection = useCallback(
    (c) => {
      if (!c?.source || !c?.target || c.source === c.target) return false
      const src = nodesRef.current.find((n) => n.id === c.source)
      if (!src) return false
      const slot = (c.targetHandle || '').replace(/^in:/, '')
      if (!slot) return false
      if (slot === 'prompt') return src.type === 'text'
      // 生成节点左边只有一个「＋」，媒体和文本都从这里进：
      // 文本落下来时 onConnect 会归到 in:prompt，所以这里不能判成非法
      if (src.type === 'text') return slot === 'media'
      return !reaches(c.target, c.source)
    },
    [reaches]
  )

  // 从空白处拖出一根线松手：就地建节点并接上，不用「先建节点再连线」
  const linkNewNode = useCallback(
    ({ kind, fromId, fromType, downstream, pos }) => {
      const tpls = templatesRef.current
      const needsImage = downstream && fromType !== 'text'
      const tpl = kind === 'text' ? null : pickTemplate(tpls, kind, needsImage)
      if (kind !== 'text' && !tpl) return flash(`没有可用的${kind === 'videogen' ? '视频' : '图片'}模板`)

      const node = kind === 'text' ? makeTextNode(pos) : makeGenNode(tpls, kind, pos, tpl?.name)
      const targetId = downstream ? node.id : fromId
      const sourceId = downstream ? fromId : node.id
      // 文本走提示词口，其余全部走统一媒体口
      const handle = fromType === 'text' || kind === 'text' ? 'in:prompt' : 'in:media'
      const eid = `e-${sourceId}-${targetId}-${Date.now().toString(36)}`

      setNodes((nds) => {
        const next = [...nds, node]
        if (handle !== 'in:media') return next
        return next.map((n) =>
          n.id === targetId ? { ...n, data: { ...n.data, mediaOrder: [...(n.data.mediaOrder || []), eid] } } : n
        )
      })
      setEdges((eds) => [
        ...eds,
        { id: eid, source: sourceId, sourceHandle: 'out', target: targetId, targetHandle: handle, type: 'wire' },
      ])
      flash(kind === 'text' ? '已建文本节点并连上' : '已建节点并连上')
    },
    [flash]
  )

  const onConnectStart = useCallback((e, params) => {
    const pt = posOf(e)
    connectFrom.current = pt
      ? { ...pt, handleId: params?.handleId || '', handleType: params?.handleType || 'source' }
      : null
  }, [])

  const onConnectEnd = useCallback(
    (e, state) => {
      const start = connectFrom.current
      connectFrom.current = null
      if (!start) return
      const pt = posOf(e)
      if (!pt) return
      // 只在端口上点了一下、没拖出去，不弹菜单
      if (Math.hypot(pt.x - start.x, pt.y - start.y) < 18) return
      if (state?.isValid || state?.toNode) return
      const fromNode = state?.fromNode
      if (!fromNode) return

      const slot = (start.handleId || '').replace(/^in:/, '')
      const downstream = start.handleType === 'source'
      const pos = rf.screenToFlowPosition(pt)
      const mk = (kind, label) => ({
        label,
        onClick: () =>
          linkNewNode({ kind, fromId: fromNode.id, fromType: fromNode.type, slot, downstream, pos }),
      })

      const items =
        !downstream && slot === 'prompt'
          ? [mk('text', '文本节点')]
          : [mk('imagegen', '图片生成节点'), mk('videogen', '视频生成节点')]

      if (!downstream && slot !== 'prompt' && !slot) return
      // 松手落在空白处会顺带触发一次 pane click，别让那次点击立刻把菜单关掉
      paneClickAt.current = Date.now()
      setMenu({
        x: pt.x,
        y: pt.y,
        title: downstream ? '这根线接给谁' : '这个槽由谁供给',
        items,
      })
    },
    [rf, linkNewNode]
  )

  /** 把一条媒体线接进统一媒体口，并追加到顺序末尾 */
  const attachMediaEdge = useCallback((targetId, sourceId, sourceHandle = 'out') => {
    const exists = edgesRef.current.find(
      (e) => e.target === targetId && e.source === sourceId && e.targetHandle === 'in:media'
    )
    if (exists) return ''
    const id = `e-${sourceId}-${targetId}-${Date.now().toString(36)}`
    setEdges((eds) => [
      ...eds,
      { id, source: sourceId, sourceHandle, target: targetId, targetHandle: 'in:media', type: 'wire' },
    ])
    setNodes((nds) =>
      nds.map((n) =>
        n.id === targetId ? { ...n, data: { ...n.data, mediaOrder: [...(n.data.mediaOrder || []), id] } } : n
      )
    )
    return id
  }, [])

  /** 参数面板里调顺序：直接写入新的 edgeId 排列 */
  const setMediaOrder = useCallback((nodeId, ids) => {
    setNodes((nds) => nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, mediaOrder: ids } } : n)))
  }, [])

  /** 参数面板里断开某一条媒体线 */
  const removeMediaEdge = useCallback((nodeId, edgeId) => {
    setEdges((eds) => eds.filter((e) => e.id !== edgeId))
    setNodes((nds) =>
      nds.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, mediaOrder: (n.data.mediaOrder || []).filter((x) => x !== edgeId) } }
          : n
      )
    )
  }, [])

  const onConnect = useCallback(
    (rawConn) => {
      // 生成节点左边的「＋」一个口兼着媒体与提示词：按来源类型归位。
      // 两个 Handle 叠在同一个位置，所以线条位置不变，只是存成正确的槽
      let conn = rawConn
      if ((rawConn.targetHandle || '') === 'in:media') {
        const src = nodesRef.current.find((n) => n.id === rawConn.source)
        if (kindOfNode(src) === 'text') conn = { ...rawConn, targetHandle: 'in:prompt' }
      }
      const handle = conn.targetHandle || ''
      if (!handle.startsWith('in:')) return
      const srcNode = nodesRef.current.find((n) => n.id === conn.source)
      const kind = kindOfNode(srcNode)

      // 提示词口：只吃文本
      if (handle === 'in:prompt') {
        if (kind !== 'text') return flash('只有文本节点能接提示词口')
        setEdges((eds) =>
          addEdge(
            { ...conn, type: 'wire' },
            eds.filter((e) => !(e.target === conn.target && e.targetHandle === 'in:prompt'))
          )
        )
        return
      }

      if (!isValidConnection(conn)) {
        return flash(
          conn.source === conn.target
            ? '节点不能连自己'
            : kind === 'text'
              ? '文本只能接到提示词口'
              : '这条线会把链连成环'
        )
      }

      // 通用模板节点还是按具体槽位连（它的端口本来就是一个个槽）
      const tgtNode = nodesRef.current.find((n) => n.id === conn.target)
      if (tgtNode?.type === 'template') {
        const slot = handle.slice(3)
        setEdges((eds) =>
          addEdge(
            { ...conn, type: 'wire' },
            eds.filter((e) => !(e.target === conn.target && e.targetHandle === 'in:' + slot))
          )
        )
        return
      }

      // 生成节点：模板得吃得下这类资源。图片接不上时按老规矩找一个能吃图的同类模板
      const tgt = tgtNode
      const tpl =
        templatesRef.current.find((t) => t.name === tgt?.data?.template) ||
        templatesRef.current.find((t) => t.use === USE_OF_KIND[tgt?.type])
      if (!slotsOfKind(tpl, kind).length) {
        const alt =
          kind === 'image'
            ? templatesRef.current.find(
                (t) => t.use === (USE_OF_KIND[tgt?.type] || 'imagegen') && (t.imageSlots || []).length
              )
            : null
        if (!alt) return flash(`这个模板不吃${kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '图片'}参考`)
        const params = { ...defaultParams(alt), prompt: tgt?.data?.params?.prompt || '' }
        setNodes((nds) =>
          nds.map((n) => (n.id === conn.target ? { ...n, data: { ...n.data, template: alt.name, params } } : n))
        )
        flash(`已切到「${alt.label || alt.name}」`)
      }

      attachMediaEdge(conn.target, conn.source, conn.sourceHandle || 'out')
    },
    [flash, isValidConnection, kindOfNode, attachMediaEdge]
  )

  // 拖动线头改接：媒体口就一个，接过来就行，顺序不变
  const onReconnect = useCallback(
    (oldEdge, conn) => {
      if (!conn?.targetHandle?.startsWith('in:')) return
      if (!isValidConnection(conn)) return flash('这个接口接不了这条线')
      setEdges((eds) => eds.map((e) => (e.id === oldEdge.id ? { ...e, ...conn, type: 'wire' } : e)))
    },
    [isValidConnection, flash]
  )

  // ---------- 添加节点
  // 没指定位置就落在当前视口中心：从工具条加的节点一定看得见，不会甩到画布外
  const viewCenter = useCallback(() => {
    const vp = rf.getViewport()
    const el = document.querySelector('.canvas-wrap')
    const w = el?.clientWidth || 900
    const h = el?.clientHeight || 640
    return { x: (w / 2 - vp.x) / vp.zoom - 168, y: (h / 2 - vp.y) / vp.zoom - 150 }
  }, [rf])

  const addImageNode = useCallback(
    (at) => {
      setNodes((nds) => [...nds, makeGenNode(templatesRef.current, 'imagegen', at || viewCenter())])
    },
    [viewCenter]
  )

  const addVideoNode = useCallback(
    (at) => {
      setNodes((nds) => [...nds, makeGenNode(templatesRef.current, 'videogen', at || viewCenter())])
    },
    [viewCenter]
  )

  const addTextNode = useCallback(
    (at) => {
      setNodes((nds) => [...nds, makeTextNode(at || viewCenter())])
    },
    [viewCenter]
  )

  const addTemplate = useCallback(
    (at) => {
      setNodes((nds) => [...nds, makeTemplateNode(templatesRef.current, at || viewCenter())])
    },
    [viewCenter]
  )

  const addMaterial = useCallback((m) => {
    const pos = { x: 40 + Math.random() * 120, y: 120 + Math.random() * 200 }
    setNodes((nds) => [...nds, mediaNode(m, pos)])
  }, [])

  // ---------- 导入工作流（上传 API json → 模板）
  const openImport = useCallback((use) => setImportOpen({ use: use || 'imagegen' }), [])

  const refreshTemplates = useCallback(async () => {
    const t = await api.getTemplates()
    setTemplates(t.templates || [])
    return t.templates || []
  }, [])

  const dropTemplate = useCallback(
    async (name) => {
      if (!window.confirm(`删掉导入的模板「${name}」？画布上正在用它的节点会退回同类第一个模板。`)) return
      try {
        await api.deleteTemplate(name)
        await refreshTemplates()
        flash(`已删除模板 ${name}`)
      } catch (e) {
        flash(e.message)
      }
    },
    [refreshTemplates, flash]
  )

  // 导入完成：刷新模板表；要的话顺手在视口中间放一个用它的节点
  const onImported = useCallback(
    async (name, use, createNode, _tpl, dropped) => {
      let list = []
      try {
        list = await refreshTemplates()
      } catch (e) {
        flash(`模板已写入，但刷新失败：${e.message}`)
      }
      const tpl = list.find((t) => t.name === name)
      setImportOpen(null)
      if (createNode) {
        const pos = rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
        if (use === 'template') {
          setNodes((nds) => [
            ...nds,
            {
              id: newId(),
              type: 'template',
              position: pos,
              data: { template: name, params: defaultParams(tpl), status: 'idle', outputs: [], error: '' },
            },
          ])
        } else {
          const kind = use === 'videogen' ? 'videogen' : 'imagegen'
          setNodes((nds) => [...nds, makeGenNode(list, kind, pos, name)])
        }
      }
      const tail = dropped?.length
        ? ` · 已丢弃 ${dropped.length} 个本机不存在的孤立节点（${dropped[0].split(':').slice(1).join(':')}）`
        : ''
      flash(`已导入「${tpl?.label || name}」· ${tpl?.imageSlots?.length || 0} 图槽 / ${tpl?.videoSlots?.length || 0} 视频槽 / ${tpl?.audioSlots?.length || 0} 音频槽${tail}`)
    },
    [refreshTemplates, rf, flash]
  )

  // ---------- 上传
  const uploadAndAdd = useCallback(
    async (files) => {
      if (!files?.length) return []
      setBusyUpload(true)
      const t0 = performance.now()
      rlog('upload.start', {
        files: files.length,
        mb: (Array.from(files).reduce((s, f) => s + (f.size || 0), 0) / 1048576).toFixed(2),
        types: Array.from(files).map((f) => f.type || f.name.split('.').pop()).slice(0, 4),
      })
      try {
        const r = await api.uploadImages(files)
        const list = r.files || []
        rlog('upload.ok', { n: list.length, ms: Math.round(performance.now() - t0) })
        setMaterials((ms) => [...list, ...ms])
        return list
      } catch (e) {
        rlog('upload.fail', { err: e.message, ms: Math.round(performance.now() - t0) }, 'E')
        flash(`上传失败：${e.message}`)
        return []
      } finally {
        setBusyUpload(false)
      }
    },
    [flash]
  )

  // 节点里直接传参考图：上传 + 铺成图片节点 + 连到空闲槽位
  const attachRef = useCallback(
    async (nodeId, files) => {
      const node = nodesRef.current.find((n) => n.id === nodeId)
      if (!node || !files?.length) return
      let tpl = templatesRef.current.find((t) => t.name === node.data.template)
      if (!(tpl?.imageSlots || []).length) {
        const alt = templatesRef.current.find((t) => t.use === USE_OF_KIND[node.type] && (t.imageSlots || []).length)
        if (!alt) return flash('当前模板不吃参考图')
        const params = { ...defaultParams(alt), prompt: node.data.params?.prompt || '' }
        updateNode(nodeId, { template: alt.name, params })
        tpl = alt
      }
      const uploaded = await uploadAndAdd(files)
      if (!uploaded.length) return

      const base = node.position || { x: 100, y: 100 }
      const newNodes = []
      const newEdges = []
      const newIds = []
      uploaded.forEach((f, k) => {
        const mid = newId()
        const eid = `e-${mid}-${nodeId}`
        newNodes.push(mediaNode(f, { x: base.x - 320, y: base.y + k * 190 }, mid))
        // 全部接同一个媒体口，顺序按上传先后排在已有素材后面
        newEdges.push({
          id: eid,
          source: mid,
          sourceHandle: 'out',
          target: nodeId,
          targetHandle: 'in:media',
          type: 'wire',
        })
        newIds.push(eid)
      })
      setNodes((nds) => [
        ...nds.map((n) =>
          n.id === nodeId
            ? { ...n, data: { ...n.data, mediaOrder: [...(n.data.mediaOrder || []), ...newIds] } }
            : n
        ),
        ...newNodes,
      ])
      setEdges((eds) => [...eds, ...newEdges])
      rlog('gen.attach', { node: nodeId, n: newEdges.length, tpl: tpl?.name || '' })
      flash(`已接入 ${newEdges.length} 个参考`)
    },
    [flash, updateNode, uploadAndAdd]
  )

  const spawnVideoFrom = useCallback(
    (nodeId) => {
      const node = nodesRef.current.find((n) => n.id === nodeId)
      const alt = templatesRef.current.find((t) => t.use === 'videogen')
      if (!alt) return flash('没有可用的视频模板')
      const vid = newId()
      const pos = { x: (node?.position?.x || 0) + 400, y: node?.position?.y || 120 }
      const vnode = {
        id: vid,
        type: 'videogen',
        position: pos,
        data: { template: alt.name, params: defaultParams(alt), status: 'idle', outputs: [], history: [], error: '' },
      }
      setNodes((nds) => [...nds, vnode])
      attachMediaEdge(vid, nodeId, 'out')
    },
    [flash, attachMediaEdge]
  )

  /**
   * 节点右侧那个「＋」：从当前节点直接长出一个下游并连好线。
   * 规则跟 LibTV 一致 —— 文本接图片、图片接视频、视频接下一镜。
   * 省掉「拖线到空白处 → 弹选单 → 选类型」那一串。
   */
  const spawnDownstream = useCallback(
    (nodeId) => {
      const node = nodesRef.current.find((n) => n.id === nodeId)
      if (!node) return
      const tpls = templatesRef.current
      const pos = { x: (node.position?.x || 0) + 420, y: node.position?.y || 120 }

      // 文本 → 图片节点，接提示词口
      if (node.type === 'text') {
        if (!pickTemplate(tpls, 'imagegen', false)) return flash('没有可用的图片模板')
        const fresh = makeGenNode(tpls, 'imagegen', pos)
        setNodes((nds) => [...nds, fresh])
        setEdges((eds) => [
          ...eds,
          {
            id: `e-${fresh.id}`,
            source: nodeId,
            sourceHandle: 'out',
            target: fresh.id,
            targetHandle: 'in:prompt',
            type: 'wire',
          },
        ])
        return flash('已接一个图片节点')
      }

      const srcOut = pickOutput(node)
      const srcKind = srcOut?.kind || node.data?.kind || (node.type === 'videogen' ? 'video' : 'image')
      const t = pickTemplate(tpls, 'videogen', srcKind !== 'video')
      if (!t) return flash('没有可用的视频模板')
      const fresh = makeGenNode(tpls, 'videogen', pos, t.name)
      setNodes((nds) => [...nds, fresh])
      // 图片/视频都进同一个媒体口，进哪个槽由类型 + 顺序决定
      attachMediaEdge(fresh.id, nodeId, 'out')
      flash(srcKind === 'video' ? '已接下一镜' : '已接一个视频节点')
    },
    [flash, attachMediaEdge]
  )

  const duplicateNode = useCallback((nodeId) => {
    const node = nodesRef.current.find((n) => n.id === nodeId)
    if (!node) return
    const copy = clone(node)
    copy.id = newId()
    copy.position = { x: node.position.x + 40, y: node.position.y + 60 }
    copy.selected = false
    copy.data = { ...copy.data, status: 'idle', jobId: null, elapsed: 0, error: '', history: [], mediaOrder: [] }
    setNodes((nds) => [...nds, copy])
  }, [])

  // ---------- 看图 / 切图
  const openViewer = useCallback((items, index = 0) => {
    if (!items?.length) return
    setViewer({ items, index })
  }, [])

  const openSplit = useCallback((nodeId) => {
    const node = nodesRef.current.find((n) => n.id === nodeId)
    if (!node) return
    const out = pickOutput(node)
    const url = out?.url || node.data?.url
    if (!url) return flash('这个节点还没有图')
    setSplit({ nodeId, url })
  }, [flash])

  const doSplit = useCallback(
    async (rows, cols) => {
      const { nodeId, url } = split || {}
      const node = nodesRef.current.find((n) => n.id === nodeId)
      if (!node) return
      try {
        const img = await loadImage(url)
        const w = Math.floor(img.naturalWidth / cols)
        const h = Math.floor(img.naturalHeight / rows)
        if (w < 8 || h < 8) throw new Error('切分太小')

        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const c2d = canvas.getContext('2d')
        const files = []
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            c2d.clearRect(0, 0, w, h)
            c2d.drawImage(img, c * w, r * h, w, h, 0, 0, w, h)
            const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'))
            files.push(new File([blob], `cut-r${r + 1}c${c + 1}.png`, { type: 'image/png' }))
          }
        }
        const uploaded = await uploadAndAdd(files)
        if (!uploaded.length) throw new Error('上传失败')

        const base = { x: (node.position?.x || 0) + 320, y: (node.position?.y || 0) }
        const fresh = uploaded.map((f, i) => {
          const r = Math.floor(i / cols)
          const c = i % cols
          return mediaNode(f, { x: base.x + c * 232, y: base.y + r * 232 })
        })
        setNodes((nds) => [...nds, ...fresh])
        setSplit(null)
        flash(`已切出 ${fresh.length} 张（${rows}×${cols}），排在原节点右侧`)
      } catch (e) {
        flash(`切分失败：${e.message}`)
      }
    },
    [split, uploadAndAdd, flash]
  )

  // ---------- 画布整理 / 批量
  const selectedNodes = useMemo(() => nodes.filter((n) => n.selected), [nodes])

  const autoLayout = useCallback(() => {
    const nds = nodesRef.current
    const eds = edgesRef.current
    const depth = {}
    for (const n of nds) depth[n.id] = 0
    for (let k = 0; k < nds.length; k++) {
      let moved = false
      for (const e of eds) {
        if (depth[e.target] < depth[e.source] + 1) {
          depth[e.target] = depth[e.source] + 1
          moved = true
        }
      }
      if (!moved) break
    }
    const cols = {}
    const next = nds.map((n) => {
      const d = depth[n.id] || 0
      cols[d] = (cols[d] || 0) + 1
      return { ...n, position: { x: 60 + d * 350, y: 60 + (cols[d] - 1) * 300 } }
    })
    setNodes(next)
    setTimeout(() => rf.fitView({ padding: 0.2, duration: 400 }), 60)
  }, [rf])

  const runSelected = useCallback(() => {
    const list = nodesRef.current.filter((n) => n.selected && n.data?.template)
    if (!list.length) return flash('先选中要跑的节点（拖框或按住 Shift 点）')
    const ordered = [...list].sort((a, b) => a.position.x - b.position.x)
    ordered.forEach((n, i) => setTimeout(() => runNode(n.id), i * 60))
    flash(`已排队 ${ordered.length} 个节点`)
  }, [runNode, flash])

  const deleteSelected = useCallback(() => {
    const ids = new Set(nodesRef.current.filter((n) => n.selected).map((n) => n.id))
    if (!ids.size) return
    setNodes((nds) => nds.filter((n) => !ids.has(n.id)))
    setEdges((eds) => eds.filter((e) => !ids.has(e.source) && !ids.has(e.target)))
  }, [])

  // 只断线、不删节点
  const detachSelected = useCallback(() => {
    const ids = new Set(nodesRef.current.filter((n) => n.selected).map((n) => n.id))
    if (!ids.size) return flash('先选节点')
    let cut = 0
    setEdges((eds) => {
      const keep = eds.filter((e) => !ids.has(e.source) && !ids.has(e.target))
      cut = eds.length - keep.length
      return keep
    })
    setTimeout(() => flash(`断开了 ${cut} 条线`), 0)
  }, [flash])

  // ---------- 快捷键
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target?.tagName || '').toLowerCase()
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select'
      const mod = e.ctrlKey || e.metaKey

      // 这几个在输入框里也要能按：生成、适应画布、搜节点
      if (mod && e.key === 'Enter') {
        e.preventDefault()
        return runSelected()
      }
      if (mod && e.key === '0') {
        e.preventDefault()
        return rf.fitView({ padding: 0.2, duration: 300 })
      }
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSideTab('out')
        return setTimeout(() => document.querySelector('.outline .search')?.focus(), 60)
      }
      if (e.altKey && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        return autoLayout()
      }
      if (e.key === 'Escape') {
        setMenu(null)
        setAllTools(false)
        setCheat(false)
        setZoomMenu(false)
        return
      }
      if (typing) return

      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        selectedNodes.forEach((n) => duplicateNode(n.id))
      } else if ((e.key === 'r' || e.key === 'R') && e.shiftKey) {
        chainSelected()
      } else if ((e.key === 'r' || e.key === 'R') && !mod) {
        runSelected()
      } else if (e.key === 'f' || e.key === 'F') {
        rf.fitView({ padding: 0.2, duration: 300 })
      } else if (e.key === 'v' || e.key === 'V') {
        setHand(true)
      } else if (e.key === 's' || e.key === 'S') {
        setHand(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedNodes, duplicateNode, runSelected, chainSelected, rf, autoLayout])

  const jobsByNode = useMemo(() => {
    const m = {}
    for (const j of jobs) if (j.nodeId) m[j.nodeId] = j
    return m
  }, [jobs])

  /**
   * 连线的渲染数据：颜色、槽位名、错开量。
   *
   * 十几个图槽全接满时，线在节点附近会挤成一束，看不出哪根进哪个口，
   * 所以按槽位顺序给每根线一个垂直偏移量，并在线中间挂槽位名。
   */
  const displayEdges = useMemo(() => {
    // 线太多看不清画面时可以整层关掉（不影响数据，只是不画）
    if (hideWires) return []
    const tplOf = (n) => templates.find((t) => t.name === n?.data?.template)
    const isPromptEdge = (e) => (e.targetHandle || '') === 'in:prompt'
    // 槽位名现算：媒体边按顺序排进类型对应的槽位
    const slotNameOf = (e, tgt) => {
      if (isPromptEdge(e)) return '提示词'
      const { items } = getMediaInputs(tgt.id)
      const it = items.find((x) => x.edgeId === e.id)
      return it?.slotLabel || it?.slot || ''
    }
    // 同一条目标上的线错开多少，按媒体顺序来（以前按槽位序号）
    const rankOf = (e, tgt) => {
      if (isPromptEdge(e)) return 999
      const order = tgt?.data?.mediaOrder || []
      const i = order.indexOf(e.id)
      return i < 0 ? 500 : i
    }

    const alive = []
    const byTarget = new Map()
    for (const e of edges) {
      const src = nodes.find((n) => n.id === e.source)
      const tgt = nodes.find((n) => n.id === e.target)
      if (!src || !tgt) continue // 节点没了，线也别画
      const it = { e, src, tgt }
      alive.push(it)
      const arr = byTarget.get(e.target) || []
      arr.push(it)
      byTarget.set(e.target, arr)
    }

    const lane = new Map()
    for (const arr of byTarget.values()) {
      const sorted = [...arr].sort((a, b) => rankOf(a.e, a.tgt) - rankOf(b.e, b.tgt))
      const n = sorted.length
      const step = n > 8 ? 6 : 9
      sorted.forEach((it, i) => lane.set(it.e.id, (i - (n - 1) / 2) * step))
    }

    return alive.map(({ e, src, tgt }) => {
      const isPrompt = isPromptEdge(e)
      const out = pickOutput(src)
      const tpl = tplOf(tgt)
      const status = tgt.data?.status
      return {
        ...e,
        type: 'wire',
        data: {
          tone: isPrompt ? 'prompt' : out?.kind === 'video' ? 'video' : out?.kind === 'audio' ? 'audio' : 'image',
          offset: lane.get(e.id) || 0,
          label: shortSlot(slotNameOf(e, tgt) || '未占位'),
          srcName:
            src.type === 'text'
              ? '文本'
              : src.data?.label || tplOf(src)?.label || src.data?.filename || '节点',
          empty: !isPrompt && !out,
          active: status === 'running' || status === 'queued',
          onDelete: deleteEdge,
        },
      }
    })
  }, [edges, nodes, templates, deleteEdge, hideWires, getMediaInputs])

  const ctx = useMemo(
    () => ({
      templates,
      updateNode,
      runNode,
      cancelNode,
      getInputs,
      getMediaInputs,
      setMediaOrder,
      removeMediaEdge,
      getTextInput,
      jobsByNode,
      edges,
      attachRef,
      spawnVideoFrom,
      duplicateNode,
      openViewer,
      openSplit,
      applyTool,
      openChain,
      openImport,
      chainRunning: !!chain,
      flash,
      compact,
      spawnDownstream,
    }),
    [
      templates,
      updateNode,
      runNode,
      cancelNode,
      getInputs,
      getMediaInputs,
      setMediaOrder,
      removeMediaEdge,
      getTextInput,
      jobsByNode,
      edges,
      attachRef,
      spawnVideoFrom,
      duplicateNode,
      openViewer,
      openSplit,
      applyTool,
      openChain,
      openImport,
      chain,
      flash,
      compact,
      spawnDownstream,
    ]
  )

  // 左栏节点大纲：本画布所有节点，按画布顺序（先左后右、先上后下）列出来
  const outlineNodes = useMemo(() => {
    const q = outQuery.trim().toLowerCase()
    return [...nodes]
      .sort((a, b) => (a.position?.x || 0) - (b.position?.x || 0) || (a.position?.y || 0) - (b.position?.y || 0))
      .map((n) => {
        const d = n.data || {}
        const t = templates.find((x) => x.name === d.template)
        const outs = outputsOf(n)
        const o = outs[d.activeOut || 0] || outs[0]
        const name =
          n.type === 'media'
            ? d.label || d.filename || '素材'
            : n.type === 'text'
              ? d.label || '提示词'
              : t?.label || d.template || (n.type === 'videogen' ? '视频节点' : '图片节点')
        return {
          id: n.id,
          name,
          status: d.status || 'idle',
          thumb: o?.url || '',
          kind: o?.kind || d.kind || 'image',
          icon: n.type === 'text' ? 'T' : n.type === 'media' ? '▣' : '◇',
        }
      })
      .filter((n) => !q || n.name.toLowerCase().includes(q))
  }, [nodes, templates, outQuery])

  const selectedIds = useMemo(() => new Set(nodes.filter((n) => n.selected).map((n) => n.id)), [nodes])

  // 换模板（全部功能面板里用）：跟节点内部的下拉同一套动作
  const applyTemplateTo = useCallback(
    (nid, name) => {
      const node = nodesRef.current.find((n) => n.id === nid)
      const t = templatesRef.current.find((x) => x.name === name)
      if (!node || !t) return
      const old = templatesRef.current.find((x) => x.name === node.data?.template)
      updateNode(nid, {
        template: name,
        params: Object.fromEntries(fieldsOf(t).map((f) => [f.slot, f.default ?? ''])),
        dirty: true,
      })
      flash(`已切到「${t.label || t.name}」`)
    },
    [updateNode, flash]
  )

  // 「全部功能」：把散在节点工具行和右键菜单里的动作收成一张可搜索的表
  const toolGroups = useMemo(() => {
    const sel = selectedNodes[0]
    const selOut = sel ? pickOutput(sel) : null
    const selKind = selOut?.kind || sel?.data?.kind || 'image'
    const hasImg = !!sel && selKind === 'image'
    const q = toolQuery.trim().toLowerCase()
    const mk = (g, items) => ({
      g,
      items: items.filter((i) => !q || i.label.toLowerCase().includes(q)),
    })

    return [
      mk('新建', [
        { label: '图片生成节点', icon: '▣', run: () => addImageNode() },
        { label: '视频生成节点', icon: '▶', run: () => addVideoNode() },
        { label: '文本描述节点', icon: 'T', run: () => addTextNode() },
        { label: '通用模板节点', icon: '◇', run: () => addTemplate() },
      ]),
      mk('图片加工', [
        ...IMAGE_TOOLS.map((t) => ({
          label: t.label,
          icon: '✦',
          disabled: !hasImg,
          run: () => applyTool(sel.id, t),
        })),
        ...LIGHT_PRESETS.map((l) => ({
          label: `打光 · ${l.label}`,
          icon: '☀',
          disabled: !hasImg,
          run: () => applyTool(sel.id, { key: l.key, label: `打光 · ${l.label}`, prompt: l.text }),
        })),
      ]),
      mk('产物', [
        { label: '宫格切分', icon: '⧉', disabled: !selOut, run: () => openSplit(sel.id) },
        { label: '用这张图生视频', icon: '▶', disabled: !hasImg, run: () => spawnVideoFrom(sel.id) },
        { label: '派生下游节点', icon: '＋', disabled: !sel, run: () => spawnDownstream(sel.id) },
        { label: '复制选中节点', icon: '⧫', disabled: !sel, run: () => duplicateNode(sel.id) },
        { label: '全屏查看', icon: '⤢', disabled: !selOut, run: () => openViewer(outputsOf(sel), 0) },
      ]),
      mk('画布', [
        { label: '整理画布', icon: '⧉', run: autoLayout },
        { label: '适应画布', icon: '⤢', run: () => rf.fitView({ padding: 0.2, duration: 300 }) },
        { label: '导入工作流', icon: '⇪', run: () => openImport('imagegen') },
        { label: '快捷键一览', icon: '⌘', run: () => setCheat(true) },
      ]),
      mk(
        '换模板',
        templates.map((t) => ({
          label: t.label || t.name,
          icon: '◇',
          sub: t.kind === 'video' ? '视频' : '图片',
          disabled: !sel,
          run: () => applyTemplateTo(sel.id, t.name),
        }))
      ),
    ].filter((g) => g.items.length)
  }, [
    selectedNodes,
    toolQuery,
    templates,
    applyTool,
    openSplit,
    spawnVideoFrom,
    spawnDownstream,
    duplicateNode,
    openViewer,
    autoLayout,
    rf,
    openImport,
    applyTemplateTo,
  ])

  const focusNode = useCallback(
    (nid) => {
      const n = nodesRef.current.find((x) => x.id === nid)
      if (!n) return
      rf.setCenter((n.position?.x || 0) + 168, (n.position?.y || 0) + 150, { zoom: 1, duration: 320 })
      setNodes((nds) => nds.map((x) => ({ ...x, selected: x.id === nid })))
    },
    [rf]
  )

  const activeJobs = jobs.filter((j) => j.status === 'queued' || j.status === 'running')
  const shownJobs = showAll ? jobs : jobs.slice(0, 10)

  const shownMats = useMemo(() => {
    const q = matQuery.trim().toLowerCase()
    const hit = materials.filter(
      (m) => !q || (m.label || '').toLowerCase().includes(q) || (m.filename || '').toLowerCase().includes(q)
    )
    return hit.slice(0, 60)
  }, [materials, matQuery])

  const menuItems = [
    { label: '图片生成节点', onClick: addImageNode },
    { label: '视频生成节点', onClick: addVideoNode },
    { label: '文本节点', onClick: addTextNode },
    { label: '通用模板节点', onClick: addTemplate },
    { sep: true },
    ...(selectedNodes.length ? [{ label: '断开选中节点的连线', onClick: detachSelected }, { sep: true }] : []),
    { label: '自动排列', onClick: autoLayout },
    { label: '适应画布', onClick: () => rf.fitView({ padding: 0.2, duration: 300 }) },
  ]

  return (
    <CanvasCtx.Provider value={ctx}>
      <div className="app">
        <div className="topbar">
          <span className="brand">
            <span className="logo" />
            画布
          </span>
          <span className="tb-crumb">
            <span className="crumb-sep">/</span>
            <span className="crumb-name">默认项目</span>
          </span>

          <span className="spacer" />

          {chain && (
            <span className="chain-chip">
              <span className="spin" />
              整链 {chain.done}/{chain.total}
              {chain.label ? ` · ${chain.label}` : ''}
              <button className="mini" onClick={stopChain}>
                停
              </button>
            </span>
          )}
          <span
            className="tb-health"
            title={health?.online ? '本地 ComfyUI 已连上' : '连不上 ComfyUI：先把它跑起来，画布这边不受影响'}
          >
            <span className={`dot ${health?.online ? 'on' : 'off'}`} />
            {health?.online ? `ComfyUI ${health.version}` : 'ComfyUI 离线'}
          </span>
          {saved && <span className="tb-saved">已保存 {saved}</span>}
          <button className="tb-ghost" onClick={chainSelected} title="整链：从最上游按顺序跑到选中节点（Shift+R）" disabled={!!chain}>
            整链
          </button>
          <button className="tb-run" onClick={runSelected} title="只跑选中的节点（R）">
            运行{selectedNodes.length ? ` ${selectedNodes.length}` : ''}
          </button>
        </div>

        <div className="main">
          {sideOpen && (
          <div className="leftbar">
            <div className="lb-tabs">
              <button className={sideTab === 'lib' ? 'on' : ''} onClick={() => setSideTab('lib')}>
                素材 · 模板
              </button>
              <button className={sideTab === 'out' ? 'on' : ''} onClick={() => setSideTab('out')}>
                节点<span className="lb-n">{nodes.length}</span>
              </button>
              <button className="panel-x" onClick={() => setSideOpen(false)} title="收起面板" aria-label="收起面板">
                <Icon name="close" size={13} />
              </button>
            </div>

            {sideTab === 'out' ? (
              <div className="outline">
                <input
                  className="search"
                  placeholder="搜索节点…"
                  value={outQuery}
                  onChange={(e) => setOutQuery(e.target.value)}
                  style={{ marginBottom: 6 }}
                />
                {outlineNodes.map((n) => (
                  <button
                    key={n.id}
                    className={`ol-item ${selectedIds.has(n.id) ? 'on' : ''}`}
                    onClick={() => focusNode(n.id)}
                    title={n.name}
                  >
                    <span className="ol-thumb">
                      {n.thumb ? (
                        n.kind === 'video' ? (
                          <video src={n.thumb} muted preload="metadata" />
                        ) : (
                          <img src={n.thumb} alt="" />
                        )
                      ) : (
                        <span className="ph">{n.icon}</span>
                      )}
                    </span>
                    <span className="ol-name">{n.name}</span>
                    <span className={`ol-dot ${n.status}`} />
                  </button>
                ))}
                {!outlineNodes.length && (
                  <span className="muted" style={{ fontSize: 11, padding: '4px 2px' }}>
                    {nodes.length ? '没有匹配的节点' : '画布还是空的'}
                  </span>
                )}
              </div>
            ) : (
              <>
            <div className="lb-sec">
              <div className="lb-title">素材</div>
              <button className="up-btn" onClick={() => uploadInput.current?.click()} disabled={busyUpload}>
                {busyUpload ? '上传中…' : '↑ 上传素材'}
              </button>
              <input
                ref={uploadInput}
                type="file"
                accept="image/*,video/*,audio/*"
                multiple
                style={{ display: 'none' }}
                onChange={async (e) => {
                  const list = await uploadAndAdd(e.target.files)
                  list.forEach((f) => addMaterial(f))
                  e.target.value = ''
                }}
              />
              <input
                className="search"
                placeholder="搜索素材…"
                value={matQuery}
                onChange={(e) => setMatQuery(e.target.value)}
              />
              <div className="mat-list">
                {shownMats.map((m) => (
                  <button key={m.assetId} className="mat" onClick={() => addMaterial(m)} title={m.filename}>
                    <span className={`mat-thumb k-${m.kind || 'image'}`}>
                      {m.kind === 'video' ? (
                        <video src={m.url} preload="metadata" muted />
                      ) : m.kind === 'audio' ? (
                        <span className="mat-audio">♪</span>
                      ) : (
                        <img src={m.url} alt="" />
                      )}
                    </span>
                    <span className="mat-name">{m.label || m.filename}</span>
                  </button>
                ))}
                {!shownMats.length && (
                  <span className="muted" style={{ fontSize: 11 }}>
                    {materials.length ? '没有匹配的素材' : '没有可用素材'}
                  </span>
                )}
              </div>
            </div>

            <div className="lb-sec">
              <div className="lb-title">
                模板
                <button className="lb-add" onClick={() => openImport('imagegen')} title="上传 ComfyUI 的 API 格式工作流，按它生成输入槽位">
                  ＋ 导入
                </button>
              </div>
              <div className="tpl-list">
                {templates.map((t) => (
                  <div key={t.name} className={`tpl-card ${t.imported ? 'imported' : ''}`}>
                    <b>
                      <span className={`kind-dot k-${t.kind === 'video' ? 'video' : 'image'}`} />
                      {t.label || t.name}
                      {t.imported && <span className="tpl-tag">导入</span>}
                    </b>
                    {/* 种类已经在点上说了，这行只讲「占几个位」，别再说一遍图片/视频 */}
                    <span>
                      {[
                        t.imageSlots?.length ? `${t.imageSlots.length} 图位` : '',
                        t.videoSlots?.length ? `${t.videoSlots.length} 视频位` : '',
                        t.audioSlots?.length ? `${t.audioSlots.length} 音频位` : '',
                      ]
                        .filter(Boolean)
                        .join(' · ') || '无参考位'}
                    </span>
                    {t.imported && (
                      <button
                        className="tpl-del"
                        title="删除这个导入的模板"
                        onClick={(e) => {
                          e.stopPropagation()
                          dropTemplate(t.name)
                        }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
              </>
            )}
          </div>
          )}

          <div
            className="canvas-wrap"
            onPointerDownCapture={(e) => {
              // 在空白画布上按下去就把焦点从节点输入框里拿走：
              // 拖动是 preventDefault 的，浏览器不会自己失焦，
              // 结果按空格既不平移画布，又往提示词里塞空格。
              if (!e.target.closest?.('.react-flow__pane')) return
              const el = document.activeElement
              if (el && el !== document.body && /^(input|textarea|select)$/i.test(el.tagName)) el.blur()
            }}
            onDoubleClick={(e) => {
              // 只在空白画布上响应，双击节点/线不该弹建节点菜单
              if (!e.target?.classList?.contains('react-flow__pane')) return
              const at = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })
              setMenu({
                x: e.clientX,
                y: e.clientY,
                title: '在这里建节点',
                items: [
                  { label: '▣ 图片生成节点', onClick: () => addImageNode(at) },
                  { label: '▶ 视频生成节点', onClick: () => addVideoNode(at) },
                  { label: 'T 文本描述节点', onClick: () => addTextNode(at) },
                  { label: '◇ 通用模板节点', onClick: () => addTemplate(at) },
                ],
              })
            }}
          >
            <ReactFlow
              nodes={nodes}
              edges={displayEdges}
              nodeTypes={NODE_TYPES}
              edgeTypes={EDGE_TYPES}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onConnectStart={onConnectStart}
              onConnectEnd={onConnectEnd}
              isValidConnection={isValidConnection}
              edgesReconnectable
              onReconnect={onReconnect}
              onEdgeContextMenu={(e, edge) => {
                e.preventDefault()
                setMenu({
                  x: e.clientX,
                  y: e.clientY,
                  title: '这条连线',
                  items: [{ label: `断开「${edge.data?.label || '连线'}」`, onClick: () => deleteEdge(edge.id) }],
                })
              }}
              onEdgeDoubleClick={(e, edge) => {
                e.stopPropagation()
                deleteEdge(edge.id)
              }}
              onNodeContextMenu={(e, node) => {
                e.preventDefault()
                setMenu({
                  x: e.clientX,
                  y: e.clientY,
                  title: '这个节点',
                  items: [
                    { label: '整链跑到这里（含上游）', onClick: () => openChain(node.id) },
                    ...(node.data?.template ? [{ label: '只跑这一个', onClick: () => runNode(node.id) }] : []),
                    { sep: true },
                    { label: '复制节点', onClick: () => duplicateNode(node.id) },
                    { label: '删除节点', onClick: () => updateNode(node.id, { __remove: true }) },
                  ],
                })
              }}
              onPaneClick={() => {
                if (Date.now() - paneClickAt.current < 500) return
                setMenu(null)
                setSideOpen(false)
                setTasksOpen(false)
              }}
              onPaneContextMenu={(e) => {
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY })
              }}
              fitView
              minZoom={0.12}
              maxZoom={2}
              defaultEdgeOptions={{ type: 'wire' }}
              proOptions={{ hideAttribution: true }}
              selectionKeyCode="Shift"
              multiSelectionKeyCode={['Meta', 'Control']}
              deleteKeyCode={['Delete', 'Backspace']}
              snapToGrid={snap}
              snapGrid={[20, 20]}
              panOnDrag={hand}
              selectionOnDrag={!hand}
              className={`rf ${hand ? 'hand' : ''}`}
            >
              <Background variant="dots" gap={24} size={1} color="#262626" />
              {miniMap && (
                <MiniMap
                  pannable
                  zoomable
                  position="bottom-right"
                  style={{
                    width: 168,
                    height: 112,
                    background: '#202020',
                    border: '1px solid rgba(255,255,255,.08)',
                    borderRadius: 10,
                  }}
                  maskColor="rgba(26,26,26,.7)"
                  nodeColor={(n) =>
                    n.type === 'videogen' ? '#1fc1a0' : n.type === 'text' ? '#c09a62' : '#8a7bff'
                  }
                />
              )}
            </ReactFlow>

            {/* 空画布：中间一排创建入口，对齐 LibTV 的引导 */}
            {!nodes.length && (
              <div className="empty-stage">
                <div className="es-tip">
                  <span className="cursor-i">
                    <Icon name="select" size={13} />
                  </span>
                  双击画布空白处自由建节点
                </div>
                <div className="es-row">
                  <button className="es-btn" onClick={() => addImageNode()}>
                    <span className="ei"><Icon name="image" size={15} /></span>图片生成
                  </button>
                  <button className="es-btn" onClick={() => addVideoNode()}>
                    <span className="ei"><Icon name="play" size={15} /></span>视频生成
                  </button>
                  <button className="es-btn" onClick={() => addTextNode()}>
                    <span className="ei"><Icon name="text" size={15} stroke={2} /></span>文本描述
                  </button>
                  <button className="es-btn" onClick={() => addTemplate()}>
                    <span className="ei"><Icon name="template" size={15} /></span>通用模板
                  </button>
                </div>
              </div>
            )}

            {/* 底部悬浮工具条：全局动作都在这，顶栏不再堆按钮 */}
            <div className="dock">
              <button className="cream" onClick={() => setExpandOpen((v) => !v)} title="添加节点">
                <Icon name="plus" size={17} stroke={2.1} />
                <span className="dk-tip">添加节点</span>
              </button>
              <button className={hand ? 'on' : ''} onClick={() => setHand(true)} title="移动画布（左键拖）">
                <Icon name="move" />
                <span className="dk-tip">移动（V）</span>
              </button>
              <button className={!hand ? 'on' : ''} onClick={() => setHand(false)} title="框选节点（左键拖出选框）">
                <Icon name="select" />
                <span className="dk-tip">选择（左键框选）</span>
              </button>
              <span className="dock-sep" />
              <button
                className={sideOpen && sideTab === 'lib' ? 'on' : ''}
                onClick={() => openSide('lib')}
                title="素材库"
              >
                <Icon name="images" />
                <span className="dk-tip">素材库</span>
              </button>
              <button className={allTools ? 'on' : ''} onClick={() => setAllTools(true)} title="全部功能">
                <Icon name="grid" />
                <span className="dk-tip">全部功能</span>
              </button>
              <button
                className={sideOpen && sideTab === 'out' ? 'on' : ''}
                onClick={() => openSide('out')}
                title="节点大纲"
              >
                <Icon name="list" />
                <span className="dk-tip">节点大纲</span>
              </button>
              <button className={tasksOpen ? 'on' : ''} onClick={() => setTasksOpen((v) => !v)} title="任务">
                <Icon name="clock" />
                <span className="dk-tip">任务</span>
              </button>
              <button onClick={() => setCheat(true)} title="快捷键">
                <Icon name="keyboard" />
                <span className="dk-tip">快捷键</span>
              </button>
              <span className="dock-sep" />
              <button className={compact ? 'on' : ''} onClick={() => setCompact((v) => !v)} title="紧凑：把节点编辑器收成一行">
                <Icon name="compact" />
                <span className="dk-tip">{compact ? '展开编辑器' : '紧凑模式'}</span>
              </button>
              <button onClick={autoLayout} title="按连线层级自动整理（Alt+Shift+F）">
                <Icon name="arrange" />
                <span className="dk-tip">整理画布</span>
              </button>

              {expandOpen && (
                <div className="dock-menu" onMouseLeave={() => setExpandOpen(false)}>
                  <button onClick={() => (addImageNode(), setExpandOpen(false))}>▣ 图片生成节点</button>
                  <button onClick={() => (addVideoNode(), setExpandOpen(false))}>▶ 视频生成节点</button>
                  <button onClick={() => (addTextNode(), setExpandOpen(false))}>T 文本描述节点</button>
                  <button onClick={() => (addTemplate(), setExpandOpen(false))}>◇ 通用模板节点</button>
                </div>
              )}
            </div>

            {/* 左下：节点数 / 视图开关 / 缩放 */}
            <div className="cv-status">
              <span className="cs-count">
                {nodes.length} 节点 · {edges.length} 连线
                {selectedNodes.length ? ` · 选中 ${selectedNodes.length}` : ''}
              </span>
              <span className="cs-sep" />
              <button className={miniMap ? 'on' : ''} onClick={() => setMiniMap((v) => !v)} title="小地图">
                <Icon name="map" size={15} />
              </button>
              <button className={hideWires ? 'on' : ''} onClick={() => setHideWires((v) => !v)} title="隐藏连线">
                <Icon name="wire" size={15} />
              </button>
              <button className={snap ? 'on' : ''} onClick={() => setSnap((v) => !v)} title="网格吸附">
                <Icon name="snap" size={15} stroke={2.2} />
              </button>
              <span className="cs-sep" />
              <button className="cs-zoom" onClick={() => setZoomMenu((v) => !v)}>
                {Math.round(zoom * 100)}%
              </button>
              {zoomMenu && (
                <div className="zoom-menu">
                  <button onClick={() => (rf.fitView({ padding: 0.2, duration: 300 }), setZoomMenu(false))}>
                    适应画布
                  </button>
                  {[0.5, 0.75, 1, 1.5].map((z) => (
                    <button
                      key={z}
                      onClick={() => {
                        rf.zoomTo(z, { duration: 200 })
                        setZoomMenu(false)
                      }}
                    >
                      {Math.round(z * 100)}%
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {tasksOpen && (
            <div className="rightbar">
              <div className="rb-head">
                任务
                {activeJobs.length > 0 && <span className="badge running">{activeJobs.length} 进行中</span>}
                <span className="spacer" />
                <span className="muted mono">{jobs.length}</span>
                <button className="panel-x" onClick={() => setTasksOpen(false)} title="收起面板" aria-label="收起面板">
                  <Icon name="close" size={13} />
                </button>
              </div>
              <div className="rb-body">
                {shownJobs.map((j) => (
                  <div className="job" key={j.id}>
                    <div className="jl">
                      <span className={`jdot ${j.status}`} />
                      <span className="nm">{j.label}</span>
                      {j.status === 'running' && (
                        <button className="mini" onClick={() => cancelNode(j.id)}>
                          停
                        </button>
                      )}
                    </div>
                    <div className="meta mono">
                      {j.status} · {j.elapsed ? `${Math.round(j.elapsed)}s` : '—'}
                      {j.seed ? ` · seed ${j.seed}` : ''}
                    </div>
                    {(j.outputs || []).map((o) => (
                      <div className="thumb" key={o.url}>
                        {o.kind === 'video' ? (
                          <video src={o.url} controls preload="metadata" />
                        ) : (
                          <img src={o.url} alt={o.filename} />
                        )}
                      </div>
                    ))}
                    {j.error && (
                      <div className="err-box" style={{ marginTop: 4 }}>
                        {j.error}
                      </div>
                    )}
                  </div>
                ))}
                {!jobs.length && <span className="muted">还没有任务</span>}
              </div>
              {jobs.length > 10 && (
                <div className="rb-more" onClick={() => setShowAll(!showAll)}>
                  {showAll ? '收起' : `展开全部 ${jobs.length} 条`}
                </div>
              )}
            </div>
          )}
        </div>

        {allTools && (
          <div className="alltools" onClick={() => setAllTools(false)}>
            <div className="at-box" onClick={(e) => e.stopPropagation()}>
              <div className="at-hd">
                <h3>全部功能</h3>
                <input
                  className="at-search search"
                  placeholder="搜索功能…"
                  value={toolQuery}
                  onChange={(e) => setToolQuery(e.target.value)}
                  autoFocus
                />
                <button className="at-x" onClick={() => setAllTools(false)} aria-label="关闭">
                  <Icon name="close" size={15} />
                </button>
              </div>
              <div className="at-body">
                {toolGroups.map((g) => (
                  <div className="at-group" key={g.g}>
                    <h4>{g.g}</h4>
                    <div className="at-grid">
                      {g.items.map((it) => (
                        <button
                          key={g.g + it.label}
                          className="at-item"
                          disabled={it.disabled}
                          onClick={() => {
                            it.run()
                            if (g.g !== '换模板') setAllTools(false)
                          }}
                        >
                          <span className="ai">
                            <ToolIcon glyph={it.icon} size={15} />
                          </span>
                          {it.label}
                          {it.sub && <span className="at-sub">{it.sub}</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div className="at-foot">
                {selectedNodes.length
                  ? `作用于选中的 ${selectedNodes.length} 个节点`
                  : '没选节点时「图片加工 / 产物 / 换模板」是灰的 —— 先点一个节点'}
              </div>
            </div>
          </div>
        )}

        {cheat && (
          <div className="cheat" onClick={() => setCheat(false)}>
            <div className="cheat-box" onClick={(e) => e.stopPropagation()}>
              <button className="at-x" onClick={() => setCheat(false)} aria-label="关闭">
                <Icon name="close" size={15} />
              </button>
              <div>
                <h4>创作</h4>
                <div className="cheat-row">
                  生成选中<span className="k"><kbd>R</kbd></span>
                </div>
                <div className="cheat-row">
                  生成（输入框内也行）<span className="k"><kbd>Ctrl</kbd><kbd>Enter</kbd></span>
                </div>
                <div className="cheat-row">
                  整链跑到选中<span className="k"><kbd>Shift</kbd><kbd>R</kbd></span>
                </div>
                <div className="cheat-row">
                  复制节点<span className="k"><kbd>Ctrl</kbd><kbd>D</kbd></span>
                </div>
                <div className="cheat-row">
                  删除<span className="k"><kbd>Del</kbd></span>
                </div>
              </div>
              <div>
                <h4>视图</h4>
                <div className="cheat-row">
                  适应画布<span className="k"><kbd>F</kbd></span>
                </div>
                <div className="cheat-row">
                  适应画布<span className="k"><kbd>Ctrl</kbd><kbd>0</kbd></span>
                </div>
                <div className="cheat-row">
                  整理画布<span className="k"><kbd>Alt</kbd><kbd>Shift</kbd><kbd>F</kbd></span>
                </div>
                <div className="cheat-row">
                  移动工具<span className="k"><kbd>V</kbd></span>
                </div>
                <div className="cheat-row">
                  选择工具<span className="k"><kbd>S</kbd></span>
                </div>
              </div>
              <div>
                <h4>查找</h4>
                <div className="cheat-row">
                  搜节点（转大纲）<span className="k"><kbd>Ctrl</kbd><kbd>F</kbd></span>
                </div>
                <div className="cheat-row">
                  框选<span className="k"><kbd>Shift</kbd>拖动</span>
                </div>
                <div className="cheat-row">
                  加点选<span className="k"><kbd>Ctrl</kbd>点</span>
                </div>
                <div className="cheat-row">
                  关面板<span className="k"><kbd>Esc</kbd></span>
                </div>
              </div>
              <div>
                <h4>连线</h4>
                <div className="cheat-row">
                  断开<span className="k">双击线</span>
                </div>
                <div className="cheat-row">
                  改接<span className="k">选中后拖端点</span>
                </div>
                <div className="cheat-row">
                  建节点<span className="k">拖到空白处</span>
                </div>
                <div className="cheat-row">
                  派生下游<span className="k">节点右侧 ＋</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {menu && (
          <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onMouseLeave={() => setMenu(null)}>
            {menu.title && <div className="ctx-title">{menu.title}</div>}
            {(menu.items || menuItems).map((m, i) =>
              m.sep ? (
                <div className="ctx-sep" key={i} />
              ) : (
                <button
                  key={i}
                  onClick={() => {
                    m.onClick()
                    setMenu(null)
                  }}
                >
                  {m.label}
                </button>
              )
            )}
          </div>
        )}

        {viewer && (
          <Lightbox items={viewer.items} index={viewer.index} onClose={() => setViewer(null)} />
        )}

        {split && (
          <SplitModal sample={split.url} onCancel={() => setSplit(null)} onConfirm={(r, c) => doSplit(r, c)} />
        )}

        {plan && (
          <ChainPlan
            plan={plan.plan}
            nodes={nodes}
            templates={templates}
            onCancel={() => setPlan(null)}
            onStart={startChain}
            running={!!chain}
          />
        )}

        {importOpen && (
          <WorkflowImport
            initialUse={importOpen.use}
            onClose={() => setImportOpen(null)}
            onSaved={onImported}
          />
        )}

        {toast && <div className="toast">{toast}</div>}
      </div>
    </CanvasCtx.Provider>
  )
}
