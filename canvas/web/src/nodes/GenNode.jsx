import { useEffect, useRef, useState } from 'react'
import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react'
import {
  useCanvas,
  fieldsOf,
  labelOfSlot,
  negativeHit,
  USE_OF_KIND,
  outputsOf,
  IMAGE_TOOLS,
  LIGHT_PRESETS,
  defaultParams,
  coerceParam,
} from '../ctx.js'
import NodeTools from '../ui/NodeTools.jsx'
import NumberField from '../ui/NumberField.jsx'
import Icon from '../ui/Icon.jsx'
import ParamPopover from '../ui/ParamPopover.jsx'
import NodeLog from '../ui/NodeLog.jsx'
import { startConnectFromPlus } from '../ui/sideConnect.js'
import { rlog, DEBUG } from '../log.js'

const STATUS_TEXT = {
  idle: '待运行',
  queued: '排队中',
  running: '生成中',
  done: '完成',
  error: '失败',
}

function Media({ o, onLoaded }) {
  if (o.kind === 'video')
    return <video src={o.url} controls preload="metadata" onLoadedMetadata={onLoaded} />
  if (o.kind === 'audio') return <audio src={o.url} controls style={{ width: '100%' }} />
  return <img src={o.url} alt={o.filename} draggable={false} onLoad={onLoaded} />
}

/**
 * 图片生成 / 视频生成节点。
 *
 * 两个节点共用这套实现：差别只在筛哪个 use 的模板、title 叫什么。
 * 参考图不是「必填项」而是一组槽位，接了几路就传几路——H3 的 ref_images
 * 是 AUTOGROW(min 0)，不接就是文生视频。
 */
export default function GenNode({ id, data, selected, kind }) {
  const {
    templates,
    updateNode,
    runNode,
    cancelNode,
    jobsByNode,
    getTextInput,
    attachRef,
    spawnVideoFrom,
    duplicateNode,
    openViewer,
    openSplit,
    applyTool,
    openImport,
    flash,
    compact,
    spawnDownstream,
    getMediaInputs,
    setMediaOrder,
    removeMediaEdge,
  } = useCanvas()
  const fileRef = useRef(null)

  /**
   * 输入只有一个媒体口：图 / 视频 / 音频都连在这一个点上，
   * 具体进哪个槽位由「类型 + 顺序」现算（顺序存在 node.data.mediaOrder）。
   * 顺序在下面编辑器的缩略图行里调。
   */
  const { items: mediaItems, pool: slotPool } = getMediaInputs(id)
  const mediaSummary = mediaItems.length
    ? [
        ['image', '图'],
        ['video', '视'],
        ['audio', '音'],
      ]
        .map(([k, cn]) => {
          const n = mediaItems.filter((i) => i.kind === k).length
          return n ? `${cn} ${n}` : ''
        })
        .filter(Boolean)
        .join(' · ')
    : '拖素材到这里'

  // 只在同一类型内部调序 —— 跨类型换位会把分组打乱
  /**
   * 把某个素材从 from 挪到 pos（pos 是在「抽掉它之后」的坐标）。
   * 只重排同一类型内部：这些 edgeId 本来占着全局序列里的几个固定位置，
   * 换完顺序后按原位置原位填回去，跨类型的先后关系不受影响。
   */
  const reorderMedia = (group, from, pos) => {
    const ids = group.items.map((x) => x.edgeId)
    if (from < 0 || from >= ids.length) return
    const [moved] = ids.splice(from, 1)
    const at = Math.max(0, Math.min(ids.length, pos > from ? pos - 1 : pos))
    if (at === from) return
    ids.splice(at, 0, moved)

    const all = mediaItems.map((x) => x.edgeId)
    const slots = group.items
      .map((x) => all.indexOf(x.edgeId))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)
    slots.forEach((s, k) => {
      all[s] = ids[k]
    })
    setMediaOrder(id, all)
  }

  /* ------------------------------------------------------------------
   * 拖拽排序
   *
   * 用指针事件自己算，不走 HTML5 drag：画布是带 transform 缩放的，
   * 原生的拖影按屏幕像素画，缩到 0.5 时那张图会比格子大一倍。
   * 落点用 elementFromPoint 找最近的格子（能跨行），按中线判插在前还是后，
   * 目标格子上画一条竖线当插入位标记。
   * ------------------------------------------------------------------ */
  const [drag, setDrag] = useState(null)
  const dragRef = useRef(null)

  const beginMediaDrag = (e, group, index) => {
    if (e.button !== 0 || e.target.closest('button')) return
    // 两个都留着：preventDefault 挡住图片原生拖拽和选字，
    // stopPropagation 掐掉 React Flow 的节点拖动 —— 只靠 nodrag 类不够稳，
    // 手一抖把整个节点拖走，位置就乱了。
    e.preventDefault()
    e.stopPropagation()

    const item = group.items[index]
    if (!item) return
    const sx = e.clientX
    const sy = e.clientY
    let live = false

    const onMove = (ev) => {
      if (!live) {
        if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 4) return
        live = true
        document.body.style.cursor = 'grabbing'
      }

      // 只认同组（同类型）的格子：图不能插到视频中间去
      let over = null
      let after = false
      const hit = document.elementFromPoint(ev.clientX, ev.clientY)
      const cell = hit?.closest?.('[data-gm-group]')
      if (cell && cell.dataset.gmGroup === group.key) {
        const box = cell.getBoundingClientRect()
        over = Number(cell.dataset.gmIndex)
        after = ev.clientX > box.left + box.width / 2
      }

      const next = over == null ? null : { key: group.key, from: index, over, after }
      const prev = dragRef.current
      // 落点没变就别重渲染；指针事件一秒几十个，白跑一遍整张卡片不值
      const same = prev === next || (prev && next && prev.over === next.over && prev.after === next.after)
      if (!same) {
        dragRef.current = next
        setDrag(next)
      }
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.body.style.cursor = ''
      const d = dragRef.current
      dragRef.current = null
      setDrag(null)
      if (d && d.over != null) reorderMedia(group, d.from, d.after ? d.over + 1 : d.over)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  // 接的线数量变了，端口位置得重算
  const updateNodeInternals = useUpdateNodeInternals()
  useEffect(() => {
    updateNodeInternals(id)
  }, [mediaItems.length, data.template, id, updateNodeInternals])

  const use = USE_OF_KIND[kind] || 'imagegen'
  const isVideo = kind === 'videogen'
  const options = templates.filter((t) => t.use === use)
  const tpl = templates.find((t) => t.name === data.template) || options[0]
  const status = data.status || 'idle'
  const job = jobsByNode?.[id]
  const promptIn = getTextInput ? getTextInput(id) : ''
  const busy = status === 'running' || status === 'queued'

  const fields = fieldsOf(tpl)
  const promptField = fields.find((f) => f.slot === 'prompt') || { slot: 'prompt', type: 'textarea', rows: 5 }
  const seedField = fields.find((f) => f.type === 'seed')
  const restFields = fields.filter((f) => f !== promptField && f !== seedField)
  // 除了提示词，其余参数（含种子）全进二级面板：节点上只留一行摘要
  const popFields = fields.filter((f) => f !== promptField)

  const outputs = outputsOf({ data })
  const activeOut = data.activeOut || 0
  const cur = outputs[activeOut] || outputs[0]
  const history = data.history || []
  const seedShown = job?.seed || history[data.activeVersion || 0]?.seed || ''
  const hasImage = !!cur && (cur.kind || 'image') === 'image'

  const pv = (slot) => {
    const v = data.params?.[slot]
    if (v === undefined || v === null || v === '') return ''
    return v
  }
  // 改参数就把节点标脏：整链会知道这个产物已经对不上参数了
  const setParam = (k, v) => updateNode(id, { params: { ...data.params, [k]: v }, dirty: true })
  const setTemplate = (name) => {
    const t = templates.find((x) => x.name === name)
    const old = data.params || {}
    const next = defaultParams(t)
    // 换模型不该把写了一半的提示词清掉 —— 那是这个节点的主输入，
    // 模型只是换了条执行路径。同名的其余参数也带过去，值按目标模板的
    // 选项收口（比例 `16:9` → `16:9 (Widescreen)`），种子重新随机。
    if (old.prompt) next.prompt = old.prompt
    for (const slot of Object.keys(next)) {
      if (slot === 'prompt' || slot === 'seed') continue
      if (old[slot] === undefined) continue
      const v = coerceParam(t, slot, old[slot])
      if (v !== undefined && v !== '') next[slot] = v
    }
    updateNode(id, { template: name, params: next, dirty: true })
    // 不用搬线：槽位按「类型 + 顺序」现算，换模板自动重排
  }

  const negHit = tpl && !tpl.supportsNegative ? negativeHit(promptIn || data.params?.prompt) : null

  /* ------------------------------------------------------------------
   * 三个动作各记一条运行日志。
   *
   * 记的是「按下那一刻界面上是什么」，不是提交时的状态 —— 模板显示 A、
   * 实际提交 B 这类问题（节点 data 没跟上、上游文本顶掉了输入），
   * 只有对照同一个时刻的两份快照才看得出来。
   * ------------------------------------------------------------------ */
  const clickGen = () => {
    rlog('gen.click', {
      node: id,
      action: 'run',
      tpl: tpl?.name || '(none)',
      tpl_state: data.template || '(auto)',
      prompt_chars: (promptIn || pv('prompt') || '').length,
      prompt_src: promptIn ? 'upstream' : 'inline',
      media: mediaItems.map((i) => i.kind).join('+') || 'none',
      param_keys: Object.keys(data.params || {}).length,
      status,
    })
    runNode(id)
  }
  const clickReroll = () => {
    rlog('gen.click', { node: id, action: 'reroll', tpl: tpl?.name || '', prev_seed: seedShown || '(none)' })
    runNode(id, { reroll: true })
  }
  const clickStop = () => {
    rlog('gen.click', { node: id, action: 'stop', job: job?.id || '(no-job)' })
    if (job) cancelNode(job.id)
  }

  const tools = [
    // 视频节点以前这里判的是 hasImage，结果出了片反而没有「全屏」，
    // 只能靠双击 —— 全屏组件本来就吃视频，按钮跟着产物走就行
    cur && {
      key: 'view',
      icon: '⤢',
      label: '全屏查看',
      onClick: () => openViewer(outputs, activeOut),
    },
    cur && {
      key: 'dl',
      icon: '↓',
      label: '下载',
      onClick: () => window.open(cur.url, '_blank'),
    },
    !isVideo && hasImage && {
      key: 'split',
      icon: '⧉',
      label: '宫格切分',
      onClick: () => openSplit(id),
    },
    !isVideo && hasImage && {
      key: 'video',
      icon: '▶',
      label: '用这张图生视频',
      onClick: () => spawnVideoFrom(id),
    },
    {
      key: 'dup',
      icon: '⧫',
      label: '复制节点',
      onClick: () => duplicateNode(id),
    },
    {
      key: 'del',
      icon: '✕',
      label: '删除',
      danger: true,
      onClick: () => updateNode(id, { __remove: true }),
    },
  ].filter(Boolean)

  /* ------------------------------------------------------------------
   * 节点分两块：上面是产物（预览框），下面是组合器。
   *
   * 组合器里常驻提示词，模型和参数收到底栏那行 chip 的二级面板里 ——
   * 节点上只留「扫一眼就要看到」的东西，其余点开才出现。
   * 参考的是 LibTV 的 composer：一条工具胶囊行、一行参考缩略图、
   * 一块无边框输入区、底栏一串 chip + 圆形提交。
   * ------------------------------------------------------------------ */
  // 产物真实长宽比：预览框按这个收，竖帧就不会卡在宽框里两头留黑边，
  // 也让视频的原生控制条正好压在画面上
  const [ratio, setRatio] = useState(0)
  const curUrl = (outputsOf({ data })[data.activeOut || 0] || outputsOf({ data })[0] || {}).url || ''
  useEffect(() => {
    setRatio(0)
  }, [curUrl])
  const readRatio = (e) => {
    const el = e.currentTarget
    const w = el.naturalWidth || el.videoWidth || 0
    const h = el.naturalHeight || el.videoHeight || 0
    if (w && h) setRatio(Math.round((w / h) * 1000) / 1000)
  }


  // 组合器（工具行 / 缩略图 / 提示词 / 底栏）默认不显示，点这张节点才摊开。
  // 鼠标移开不收 —— 边看画面边打字是常态；只有点空白处或别的节点才收。
  const [open, setOpen] = useState(false)
  const [pop, setPop] = useState(null) // null | 'fmt'（详细参数）| 'model'（换模板）
  // 浮层一律浮在组合器上方（不许跑到下面去）。
  // 节点贴着屏幕顶端、上方空间不够时，先压高度（内部滚动，位置不动）；
  // 实在小到压不动（< 180px），才整体往下推一点 —— 方位仍然是「在上方」
  const [popBox, setPopBox] = useState({ max: 0, shift: 0 })
  const [popBottom, setPopBottom] = useState(0)
  const [menu, setMenu] = useState(null) // 工具行里的小菜单：'light' | 'angle'
  // compact 是全局「密集布局」开关：它只决定「没点开时收成一行还是一块都不显示」，
  // 点开后一律给完整组合器（否则紧凑模式下连提示词都改不了）
  const folded = !!compact
  const promptRef = useRef(null)
  const rootRef = useRef(null)

  useEffect(() => {
    if (!open && !pop && !menu) return
    const close = () => {
      setOpen(false)
      setPop(null)
      setMenu(null)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') close()
    }
    // 点节点外面也算「收拾掉」：面板浮在上面时画布还看得见，别一挡就是一片
    const onDown = (e) => {
      const root = rootRef.current
      if (root && !root.contains(e.target)) close()
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown, true)
    }
  }, [open, pop, menu])

  /**
   * 软焦点：点画面会把光标送进提示词框（省一次点击），但这时按空格是「想平移画布」，
   * 不是想打空格。标记一下，第一次按空格就交还给画布；真开始打字以后就正常输入。
   * 用户自己点进文本框时 onPointerDown 会把这个标记清掉。
   */
  // 画布不是 100% 缩放时，getBoundingClientRect 给的是缩放后的屏幕像素；
  // 直接塞进 CSS 会被节点再缩一次，位置就偏。换算回布局单位再说。
  const zoomOf = () => {
    const root = rootRef.current
    if (!root || !root.offsetWidth) return 1
    return root.getBoundingClientRect().width / root.offsetWidth || 1
  }

  const togglePop = (which, chipEl) => {
    const next = pop === which ? null : which
    setPop(next)
    const z = zoomOf()
    if (chipEl) {
      // 锚在底栏行上只能粗略靠近按钮（chip 比这一行矮 2px），
      // 这里按按钮自己的顶边算，保证真的是「按钮上方 5px」
      const bar = chipEl.closest('.gc-bar')?.getBoundingClientRect()
      const c = chipEl.getBoundingClientRect()
      if (bar) setPopBottom(Math.round((bar.bottom - c.top) / z + 5))
    }
    if (!next) {
      setPopBox({ max: 0, shift: 0 })
      return
    }
    setTimeout(() => {
      const el = rootRef.current?.querySelector('.gpop, .gmenu-model')
      if (!el) return
      const r = el.getBoundingClientRect()
      const avail = r.bottom - 12 // 顶部留 12px 呼吸（屏幕像素）
      if (r.height <= avail) return setPopBox({ max: 0, shift: 0 })
      if (avail >= 180 * z) return setPopBox({ max: Math.round(avail / z), shift: 0 })
      setPopBox({ max: 0, shift: Math.round((12 - r.top) / z) })
    }, 0)
  }

  const softFocus = useRef(false)
  const focusPrompt = (ms = 0) => {
    softFocus.current = true
    if (ms) setTimeout(() => promptRef.current?.focus(), ms)
    else promptRef.current?.focus()
  }

  const cardDown = useRef(null)
  const onCardDown = (e) => {
    cardDown.current = { x: e.clientX, y: e.clientY }
  }
  const onCardClick = (e) => {
    const d = cardDown.current
    if (d && Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 5) return
    // 出过视频的节点，整块画面就是一个 <video>：以前这里一律 return，
    // 结果竖屏节点怎么点都不展开。改成只放过播放控制条那一条，
    // 画面其余地方照常「点一下摊开组合器」，同时拦掉播放/暂停的默认动作
    const player = e.target.closest?.('video, audio')
    if (player) {
      if (open) return
      const r = player.getBoundingClientRect()
      // 原生控制条压在画面底部，约 46px 高；点在那条里交给播放器
      if (e.clientY >= r.bottom - 46) return
      e.preventDefault()
    }
    // 参数面板不在这里收：点自己这张图不算「点别处」，
    // 面板只在点空白画布 / 其它节点 / 再点一次 chip 时收
    setMenu(null)
    if (!open) {
      // 第一次点：把组合器摊开，顺带把光标放进去，省一次点击
      setOpen(true)
      focusPrompt(40)
      return
    }
    focusPrompt()
  }

  /* ---------- 底栏摘要：一个 chip 就说清「这轮按什么参数出」 ---------- */
  const aspectField = restFields.find((f) => f.slot === 'aspect' || f.preset === 'aspect')
  const aspectVal = aspectField ? pv('aspect') || aspectField.default || '' : ''
  const aspectShort = (() => {
    const m = String(aspectVal).match(/(\d+)\s*[:：]\s*(\d+)/)
    if (m) return `${m[1]}:${m[2]}`
    const o = (aspectField?.options || []).find((x) => String(typeof x === 'string' ? x : x.value) === String(aspectVal))
    return o ? String(typeof o === 'string' ? o : o.label).split(/[\s·]/)[0] : ''
  })()
  const SHORT_UNIT = { megapixels: 'MP', resolution: 'px', duration: 's', batch: '张', steps: '步' }
  const summary = [
    aspectShort,
    ...restFields
      .filter((f) => f.type === 'number')
      .map((f) => {
        const raw = pv(f.slot) !== '' ? pv(f.slot) : f.default
        const n = Number(raw)
        if (raw === '' || raw === undefined || !Number.isFinite(n)) return ''
        return `${Math.round(n * 100) / 100}${SHORT_UNIT[f.slot] || ''}`
      }),
  ]
    .filter(Boolean)
    .join(' · ')

  // 有参考图进来就是「图生图」，否则文生图 —— 标题上直接说清这个节点在干什么
  const capName = isVideo ? '视频生成' : mediaItems.some((i) => i.kind === 'image') ? '图生图' : '文生图'
  const promptNow = pv('prompt') || ''
  const barMeta = promptNow
    ? promptNow.replace(/\s+/g, ' ').slice(0, 22) + (promptNow.length > 22 ? '…' : '')
    : promptIn
      ? '↑ 上游文本'
      : '空提示词'

  const angleTools = IMAGE_TOOLS.filter((t) => t.key.startsWith('angle_'))

  return (
    <div
      ref={rootRef}
      className={`node gen ${isVideo ? 'video' : 'image'} ${selected ? 'selected' : ''} ${status} ${
        folded ? 'folded' : ''
      } ${open ? 'open' : ''} ${pop ? 'pop-open' : ''}`}
    >
      {/* 卡外标题：种类图标 + 这节点在做什么 + 状态 + 模板说明 */}
      <div className="node-cap">
        <span className="cap-ico">
          <Icon name={isVideo ? 'play' : 'image'} size={12.5} stroke={1.8} />
        </span>
        <span className="cap-name">{capName}</span>
        <span className="cap-right">
          {status !== 'idle' && (
            <span className={`cap-state ${status}`}>
              {STATUS_TEXT[status] || status}
              {data.elapsed ? ` ${Math.round(data.elapsed)}s` : ''}
            </span>
          )}
          {tpl?.note && (
            <button
              className="cap-info nodrag"
              title={tpl.note}
              aria-label="模板说明"
              onClick={(e) => e.stopPropagation()}
            >
              <Icon name="info" size={13} />
            </button>
          )}
        </span>
      </div>

      <div className="shell">
        <div className="gwrap">
          {/* ---------- 预览框 ---------- */}
          <div className="gstage-wrap">
            {/* 预览框按产物比例收窄时，靠这层把边框当成盒子的边：
                接入口的圆点和两侧的「＋」就永远贴着画面，不会飘到节点边上 */}
            <div className={`gstage-box ${ratio && outputs.length === 1 ? 'sized' : ''}`}>
            <div
              className={`gstage ${outputs.length ? 'has' : 'empty'} ${ratio && outputs.length === 1 ? 'sized' : ''}`}
              style={
                ratio && outputs.length === 1
                  ? { width: `${Math.round(320 * ratio)}px`, aspectRatio: String(ratio) }
                  : undefined
              }
              onPointerDown={onCardDown}
              onClick={onCardClick}
              onDoubleClick={(e) => {
                if (!outputs.length) return
                e.stopPropagation()
                openViewer(outputs, activeOut)
              }}
              title={outputs.length ? '点一下展开提示词与参数 · 双击全屏查看' : '点一下写字出图'}
            >
              {outputs.length ? (
                outputs.length === 1 ? (
                  <Media o={outputs[activeOut] || outputs[0]} onLoaded={readRatio} />
                ) : (
                  <div className="thumbs gthumbs">
                    {outputs.map((o, i) => (
                      <div
                        key={o.url}
                        className={`thumb-cell ${i === activeOut ? 'on' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          updateNode(id, { activeOut: i })
                        }}
                        title={o.filename}
                      >
                        {o.kind === 'video' ? (
                          <video src={o.url} preload="metadata" muted />
                        ) : (
                          <img src={o.url} alt={o.filename} draggable={false} />
                        )}
                      </div>
                    ))}
                  </div>
                )
              ) : (
                <div className="gempty">
                  <svg viewBox="0 0 56 44" aria-hidden="true">
                    <circle cx="37" cy="11" r="5.2" fill="currentColor" opacity=".5" />
                    <path d="M1 43 19 13l9.5 13.5L35 19l20 23z" fill="currentColor" opacity=".34" />
                  </svg>
                </div>
              )}

              {/* 收起态提示：点了才摊开组合器（只悬停时出现，不吃点击） */}
              <span className="gstage-hint">
                <Icon name="edit" size={11} stroke={1.9} />
                {outputs.length ? '点一下调参数 / 改提示词' : '点一下写提示词'}
              </span>
            </div>

            {/* 连线口都藏在两侧的「＋」里：拖它 = 拉线，点它 = 原来的上传 / 派生 */}
            <div
              className="side-add left nodrag"
              role="button"
              title="拖出线接上游素材或文本 · 点一下上传素材"
              onMouseDown={(e) => startConnectFromPlus(e.currentTarget, e.nativeEvent)}
              onClick={(e) => {
                e.stopPropagation()
                fileRef.current?.click()
              }}
            >
              <Handle type="target" position={Position.Left} id="in:media" />
              {/* 文本也从这个口进：onConnect 按来源类型归到 in:prompt。
                  它指向同一位置，所以线还是落在这个加号上 */}
              <Handle
                type="target"
                position={Position.Left}
                id="in:prompt"
                style={{ pointerEvents: 'none' }}
              />
              ＋
            </div>
            <div
              className="side-add right nodrag"
              role="button"
              title={isVideo ? '拖出线接下一镜 · 点一下派生同类型节点' : '拖出线接下游 · 点一下用这张图生视频'}
              onMouseDown={(e) => startConnectFromPlus(e.currentTarget, e.nativeEvent)}
              onClick={(e) => {
                e.stopPropagation()
                spawnDownstream?.(id)
              }}
            >
              <Handle type="source" position={Position.Right} id="out" />
              ＋
            </div>
            </div>
          </div>

          {data.error && <div className="err-box">{data.error}</div>}

          {/* 调试条默认不挂载：不加 ?log=1 时连订阅都不建，正式界面零开销 */}
          {DEBUG && <NodeLog nodeId={id} />}

          {history.length > 1 && (
            <div className="gvers">
              <span className="gvers-lb">版本</span>
              {history.map((h, i) => (
                <div
                  key={h.jobId}
                  className={`ver ${i === (data.activeVersion || 0) ? 'on' : ''}`}
                  title={`${h.at || ''} seed ${h.seed || '?'}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    updateNode(id, { activeVersion: i, activeOut: 0 })
                  }}
                >
                  {h.outputs?.[0]?.kind === 'video' ? (
                    <video src={h.outputs[0].url} preload="metadata" muted />
                  ) : (
                    <img src={h.outputs?.[0]?.url} alt="" />
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ---------- 组合器 ---------- */}
          <div
            className="gcomposer nodrag nowheel"
            style={{
              '--pop-shift': `${popBox.shift}px`,
              '--pop-max': popBox.max ? `${popBox.max}px` : undefined,
              ...(popBottom ? { '--pop-bottom': `${popBottom}px` } : null),
            }}
          >
            <div className="gc-tools">
              <button className="gtool" onClick={() => fileRef.current?.click()} title="上传图片 / 视频 / 音频">
                <Icon name="plus" size={12} stroke={2.1} />
                上传
              </button>
              {mediaItems.length > 0 && (
                <span className="gtool gtool-static" title="已接入的参考素材">
                  {mediaSummary}
                </span>
              )}
              {!isVideo && hasImage && (
                <button
                  className="gtool"
                  onClick={() => applyTool(id, IMAGE_TOOLS.find((t) => t.key === 'grid9'))}
                  title="把这张图当九宫格拆成九个镜头"
                >
                  <Icon name="grid" size={12} stroke={1.9} />
                  九宫格
                </button>
              )}
              {!isVideo && hasImage && (
                <button
                  className="gtool"
                  onClick={() => applyTool(id, IMAGE_TOOLS.find((t) => t.key === 'tris'))}
                  title="同一人物的三视图"
                >
                  <Icon name="copy" size={12} stroke={1.9} />
                  三视图
                </button>
              )}
              {!isVideo && hasImage && (
                <div className="chip-wrap">
                  <button
                    className={`gtool ${menu === 'light' ? 'on' : ''}`}
                    onClick={() => setMenu((m) => (m === 'light' ? null : 'light'))}
                  >
                    <Icon name="sun" size={12} stroke={1.9} />
                    打光
                  </button>
                  {menu === 'light' && (
                    <div className="gmenu gmenu-sm" onPointerDown={(e) => e.stopPropagation()}>
                      {LIGHT_PRESETS.map((l) => (
                        <button
                          key={l.key}
                          onClick={() => {
                            setMenu(null)
                            applyTool(id, { key: l.key, label: '打光 · ' + l.label, prompt: l.text })
                          }}
                        >
                          {l.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {!isVideo && hasImage && angleTools.length > 0 && (
                <div className="chip-wrap">
                  <button
                    className={`gtool ${menu === 'angle' ? 'on' : ''}`}
                    onClick={() => setMenu((m) => (m === 'angle' ? null : 'angle'))}
                  >
                    <Icon name="refresh" size={12} stroke={1.9} />
                    角度
                  </button>
                  {menu === 'angle' && (
                    <div className="gmenu gmenu-sm" onPointerDown={(e) => e.stopPropagation()}>
                      {angleTools.map((t) => (
                        <button
                          key={t.key}
                          title={t.hint}
                          onClick={() => {
                            setMenu(null)
                            applyTool(id, t)
                          }}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {!isVideo && hasImage && (
                <button className="gtool" onClick={() => spawnVideoFrom(id)} title="拿这张图去生视频">
                  <Icon name="play" size={12} stroke={1.9} />
                  生视频
                </button>
              )}
              <span className="spacer" />
              <button
                className="gtool gtool-ico"
                onClick={() => setOpen(false)}
                title="收起（参数不丢，点节点再打开）"
                aria-label="收起"
              >
                <Icon name="chev-up" size={13} stroke={2.1} />
              </button>
            </div>

            {/* 参考缩略图：一行到底，序号就是进槽顺序，拖动换位 */}
            {mediaItems.length > 0 && (
              <div className="gc-thumbs">
                {mediaItems.map((it) => {
                  const group = { key: it.kind, items: mediaItems.filter((x) => x.kind === it.kind) }
                  const idx = group.items.indexOf(it)
                  const dragging = drag?.key === it.kind && drag.from === idx
                  const mark =
                    drag?.key === it.kind && drag.over === idx && drag.from !== idx
                      ? drag.after
                        ? ' drop-after'
                        : ' drop-before'
                      : ''
                  return (
                    <div
                      key={it.edgeId}
                      data-gm-group={it.kind}
                      data-gm-index={idx}
                      className={`gc-thumb ${it.slot ? '' : 'noslot'} ${dragging ? 'dragging' : ''}${mark}`}
                      title={
                        (it.slot ? `${it.slotLabel || it.slot} · ${it.name}` : '这个模板没有空位放它') +
                        ' — 拖动可换位'
                      }
                      onPointerDown={(e) => beginMediaDrag(e, group, idx)}
                    >
                      <span className="gc-thumb-no">{idx + 1}</span>
                      {it.url ? (
                        it.kind === 'video' ? (
                          <video src={it.url} muted preload="metadata" />
                        ) : it.kind === 'audio' ? (
                          <span className="gc-thumb-ph">♪</span>
                        ) : (
                          <img src={it.url} alt="" draggable={false} />
                        )
                      ) : (
                        <span className="gc-thumb-ph">
                          <Icon name="image" size={13} />
                        </span>
                      )}
                      <button
                        type="button"
                        className="gc-thumb-x"
                        onClick={() => removeMediaEdge(id, it.edgeId)}
                        title="断开这一条"
                      >
                        <Icon name="close" size={9} stroke={2.2} />
                      </button>
                    </div>
                  )
                })}
                <button className="gc-thumb-add" onClick={() => fileRef.current?.click()} title="再加一张参考">
                  <Icon name="plus" size={13} />
                </button>
              </div>
            )}

            <div className="gc-prompt">
              {promptIn ? (
                <div className="prompt-from-up">
                  <span className="tag up">↑ 上游文本生效</span>
                  {promptIn}
                </div>
              ) : (
                <textarea
                  ref={promptRef}
                  className="gc-input"
                  value={pv('prompt')}
                  rows={3}
                  placeholder={
                    promptField.placeholder ||
                    (isVideo
                      ? '写清画面怎么变：主体动作、镜头运动、光线变化…'
                      : '直接文字生图，或先传参考图再写编辑指令，如：把背景改成雪夜')
                  }
                  onChange={(e) => setParam('prompt', e.target.value)}
                  onPointerDown={() => {
                    softFocus.current = false
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.currentTarget.blur()
                      softFocus.current = false
                      return
                    }
                    if (e.key === ' ' && softFocus.current) {
                      // 刚点完图、还没打字：这个空格是「按住平移」，别塞进提示词
                      e.preventDefault()
                      softFocus.current = false
                      e.currentTarget.blur()
                      return
                    }
                    softFocus.current = false
                  }}
                />
              )}
            </div>

            {negHit && (
              <div className="hint warn">
                检测到否定表述「{negHit[0]}」。这个模型没有负向分支，会把提到的名词照字面生出来 —— 改写成正面描述。
              </div>
            )}

            <div className="gc-bar">
              <button
                className={`gc-chip gc-chip-model ${pop === 'model' ? 'on' : ''}`}
                onClick={(e) => togglePop('model', e.currentTarget)}
                title="换模型 / 工作流"
              >
                <span className="gc-chip-t">{tpl?.label || '选择模型'}</span>
                <Icon name="chev-down" size={11} stroke={2.2} />
              </button>

              <button
                className={`gc-chip gc-chip-fmt ${pop === 'fmt' ? 'on' : ''}`}
                onClick={(e) => togglePop('fmt', e.currentTarget)}
                title="详细参数：比例、像素、张数、种子"
              >
                <span className="gc-chip-t">{summary || '参数'}</span>
                <Icon name="chev-down" size={11} stroke={2.2} />
              </button>

              <span className="spacer" />

              {!busy && (
                <button
                  className="gc-ic"
                  title="换一个种子再跑"
                  onClick={clickReroll}
                  disabled={!tpl}
                >
                  <Icon name="refresh" size={14} />
                </button>
              )}
              {busy ? (
                <button className="gstop" onClick={clickStop} disabled={!job} title="取消">
                  停止
                </button>
              ) : (
                <button className="gsubmit" disabled={!tpl} onClick={clickGen} title="生成（R）">
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path
                      d="M8 13V3.6M8 3l-3.8 3.8M8 3l3.8 3.8"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.9"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              )}

              {/* 二级面板挂在底栏上：底边就是「按钮上方 5px」，贴着按钮往上展开 */}
              {pop === 'fmt' && (
                <ParamPopover
                  fields={popFields}
                  params={data.params || {}}
                  setParam={setParam}
                  seedShown={seedShown}
                />
              )}

              {/* 二级面板：换模型 / 工作流 */}
              {pop === 'model' && (
              <div className="gmenu gmenu-model nodrag" onPointerDown={(e) => e.stopPropagation()}>
                {!options.length && <div className="gmenu-empty">没有可用的{isVideo ? '视频' : '图片'}模板</div>}
                {options.map((t) => (
                  <button
                    key={t.name}
                    className={t.name === tpl?.name ? 'on' : ''}
                    onClick={() => {
                      setPop(null)
                      setTemplate(t.name)
                    }}
                  >
                    <span className="mm-lb">{t.label || t.name}</span>
                    {t.name === tpl?.name && <Icon name="check" size={13} stroke={2.1} />}
                  </button>
                ))}
                {tpl && !options.some((o) => o.name === tpl.name) && (
                  <button className="on" onClick={() => setPop(null)}>
                    <span className="mm-lb">{tpl.label || tpl.name}</span>
                    <Icon name="check" size={13} stroke={2.1} />
                  </button>
                )}
                <div className="gmenu-sep" />
                <button
                  onClick={() => {
                    setPop(null)
                    openImport?.(use)
                  }}
                >
                  <span className="mm-lb">＋ 导入工作流…</span>
                </button>
              </div>
              )}
            </div>
          </div>

          {/* 跑着且组合器收起时也给一个停止口，不用为了停生成把组合器点开 */}
          {busy && !open && (
            <button className="gstop-strip" onClick={clickStop}>
              停止生成
            </button>
          )}
        </div>

        {/* 折叠态：一行摘要，点开回到组合器 */}
        <div
          className="gbar"
          onClick={() => {
            setOpen(true)
            focusPrompt(40)
          }}
          title="点这展开提示词与参数"
        >
          <span className="gb-model">{tpl?.label || '—'}</span>
          <span className="gb-meta">{barMeta}</span>
          <span className="spacer" />
          <span>{compact ? '' : '展开'}</span>
        </div>
      </div>

      {/* 动作按钮浮在整张卡片上方：不压在画面上，也不挡住图 */}
      <NodeTools items={tools} />

      <input
        ref={fileRef}
        type="file"
        accept="image/*,video/*,audio/*"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          attachRef(id, e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}
