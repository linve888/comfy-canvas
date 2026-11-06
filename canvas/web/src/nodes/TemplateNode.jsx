import { useEffect, useRef, useState } from 'react'
import { Handle, Position, useStore } from '@xyflow/react'
import { useCanvas, NUMERIC_SLOTS, HIDDEN_SLOTS, isMediaSlot } from '../ctx.js'
import { startConnectFromPlus } from '../ui/sideConnect.js'
import Icon from '../ui/Icon.jsx'

const STATUS_TEXT = {
  idle: '待运行',
  queued: '排队中',
  running: '生成中',
  done: '完成',
  error: '失败',
}

// 模板节点的产物可能是图 / 视频 / 音频，统一塞进同一块预览框
function Preview({ outputs }) {
  return outputs.map((o) =>
    o.kind === 'video' ? (
      <video key={o.url} src={o.url} controls preload="metadata" />
    ) : o.kind === 'audio' ? (
      <audio key={o.url} src={o.url} controls style={{ width: '100%' }} />
    ) : (
      <img key={o.url} src={o.url} alt={o.filename} draggable={false} />
    )
  )
}

/**
 * 通用模板节点：一个工作流 + 它的槽位，没有生成节点那套「整链/派生」的花活。
 *
 * 排版跟生成节点对齐：卡外标题一行，里面是「预览框 + 组合器」两块。
 * 模板不再用长条 select（点开是一列菜单），数字参数是小格子，
 * 提示词直接写在面板上，跑起来只用右下角那一颗圆按钮。
 */
export default function TemplateNode({ id, data, selected }) {
  const { templates, updateNode, runNode, cancelNode, jobsByNode, getInputs, getTextInput, openChain, openViewer, spawnDownstream } =
    useCanvas()
  const tpl = templates.find((t) => t.name === data.template)
  const status = data.status || 'idle'
  const job = jobsByNode?.[id]
  // 连接状态从连线实时派生，不存进节点数据，避免两边不同步
  const linked = getInputs(id)
  const outputs = data.outputs || []

  const [menu, setMenu] = useState(false)
  const rootRef = useRef(null)

  // 点别处把模板菜单收掉（跟生成节点的浮层一个规矩）
  useEffect(() => {
    if (!menu) return
    const onDown = (e) => {
      if (!rootRef.current?.contains(e.target)) setMenu(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [menu])

  const setParam = (k, v) => updateNode(id, { params: { ...data.params, [k]: v }, dirty: true })

  const linkFrom = useStore((s) => {
    const c = s.connection
    if (!c.inProgress || !c.fromNode) return ''
    if (c.fromNode.id === id) return ''
    return c.fromNode.type || 'node'
  })
  const hintOf = (isPromptSlot) => {
    if (!linkFrom) return ''
    return (linkFrom === 'text') === isPromptSlot ? 'ok' : 'no'
  }
  const setTemplate = (name) => {
    const t = templates.find((x) => x.name === name)
    const params = {}
    for (const s of t?.slots || []) {
      if (HIDDEN_SLOTS.has(s) || isMediaSlot(s, t)) continue
      if (s === 'prompt') params[s] = data.params?.prompt || ''
      else if (s === 'negative') params[s] = '' // 负向不生效，别给默认值误导用户
      else if (s === 'width') params[s] = 752
      else if (s === 'height') params[s] = 1344
      else if (s === 'resolution') params[s] = 1024
      else if (s === 'duration') params[s] = 5
      else params[s] = ''
    }
    updateNode(id, { template: name, params, status: 'idle', outputs: [], error: '', jobId: null, dirty: true })
  }

  // 通用模板节点只画图片槽：视频/音频槽要专门的加载节点，这里连上也跑不了
  // 分组直接用后端算好的 imageSlots，别按名字猜（ref_image_size 是参数，不是图槽）
  const imageSlots = tpl?.imageSlots || []
  const fieldSlots = (tpl?.slots || []).filter((s) => !HIDDEN_SLOTS.has(s) && !isMediaSlot(s, tpl))
  const showNegative = tpl?.supportsNegative === true
  const textSlots = fieldSlots.filter((s) => {
    if (s === 'prompt') return true
    if (s === 'negative') return showNegative
    return false
  })
  const numSlots = fieldSlots.filter((s) => s !== 'prompt' && s !== 'negative')

  // 否定句在这类模型上不可靠：cfg=1 没有负向分支，模型只会照字面生成提到的名词
  const promptIn = getTextInput ? getTextInput(id) : ''
  const promptText = promptIn || data.params?.prompt || ''
  const NEG_RE = /(不要|不能|不得|禁止|避免|不出现|别让|没有(?!人)|\bno\b|\bwithout\b|\bavoid\b)/i
  const negHit = NEG_RE.exec(promptText)

  const busy = status === 'running' || status === 'queued'

  return (
    <div ref={rootRef} className={`node tplnode ${selected ? 'selected' : ''} ${status}`}>
      <Handle type="target" position={Position.Left} id="in:__unused" style={{ opacity: 0, pointerEvents: 'none' }} />

      <div className="node-cap">
        <span className="cap-ico">
          <Icon name="template" size={12.5} stroke={1.8} />
        </span>
        <span className="cap-name">
          {tpl?.label || (tpl?.model ? tpl.model.replace('.safetensors', '') : '') || '通用模板'}
        </span>
        <span className="cap-right">
          <span className={`cap-state ${status}`}>
            {STATUS_TEXT[status] || status}
            {data.elapsed ? ` ${Math.round(data.elapsed)}s` : ''}
          </span>
        </span>
      </div>

      <div className="shell">
        <div className="gwrap">
          {/* ---------- 预览框 ---------- */}
          <div className="gstage-wrap">
            <div className="gstage-box">
              <div
                className={`gstage tstage ${outputs.length ? 'has' : 'empty'}`}
                title={outputs.length ? '双击全屏查看' : '还没有产物，跑一次就有了'}
                onDoubleClick={(e) => {
                  if (!outputs.length) return
                  e.stopPropagation()
                  openViewer?.(outputs, 0)
                }}
              >
                {outputs.length ? (
                  <Preview outputs={outputs} />
                ) : (
                  <div className="gempty">
                    <Icon name="template" size={26} stroke={1.2} />
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ---------- 组合器：模板 chip + 槽位 + 提示词 + 数字 + 底栏 ---------- */}
          <div className="gcomposer nodrag nowheel">
            <div className="gc-tools">
              <div className="chip-wrap">
                <button
                  className={`gc-chip gc-chip-model ${menu ? 'on' : ''}`}
                  onClick={() => setMenu((m) => !m)}
                  title="换模板"
                >
                  <Icon name="template" size={11} stroke={2} />
                  <span className="gc-chip-t">{tpl?.label || data.template || '选择模板'}</span>
                  <Icon name="chev-down" size={11} stroke={2.2} />
                </button>
                {menu && (
                  <div className="gmenu gmenu-model" onPointerDown={(e) => e.stopPropagation()}>
                    {templates.length ? (
                      templates.map((t) => (
                        <button
                          key={t.name}
                          className={t.name === data.template ? 'on' : ''}
                          onClick={() => {
                            setMenu(false)
                            setTemplate(t.name)
                          }}
                        >
                          <span className="gc-chip-t">{t.label || t.name}</span>
                          {t.name === data.template && <Icon name="check" size={12} />}
                        </button>
                      ))
                    ) : (
                      <div className="gmenu-empty">还没有导入模板</div>
                    )}
                  </div>
                )}
              </div>
              <span className="spacer" />
            </div>

            {/* 图片槽：一行一个，接入口贴在卡边（离面板 15px，正好落在框线上） */}
            {imageSlots.length > 0 && (
              <div className="tn-slots">
                {imageSlots.map((slot) => (
                  <div key={slot} className={`tn-slot ${linked[slot] ? 'filled' : ''} ${hintOf(false)}`}>
                    <Handle
                      type="target"
                      position={Position.Left}
                      id={`in:${slot}`}
                      style={{ left: -15, top: '50%' }}
                    />
                    <span className="tn-slot-lb">{slot}</span>
                    <span className="tn-slot-st">{linked[slot] ? '已连接' : '拖入'}</span>
                  </div>
                ))}
              </div>
            )}

            {textSlots.map((slot) => (
              <div className={`gc-prompt ${hintOf(slot === 'prompt')}`} key={slot}>
                {slot === 'prompt' ? (
                  <>
                    <Handle
                      type="target"
                      position={Position.Left}
                      id="in:prompt"
                      style={{ left: -15, top: '50%' }}
                    />
                    {promptIn ? (
                      <div className="prompt-from-up">
                        <span className="tag up">↑ 上游文本生效</span>
                        {promptIn}
                      </div>
                    ) : (
                      <textarea
                        className="gc-input"
                        value={data.params?.prompt ?? ''}
                        onChange={(e) => setParam('prompt', e.target.value)}
                        rows={4}
                        placeholder="只写画面里有什么：物件、材质、光位、景别…"
                      />
                    )}
                  </>
                ) : (
                  <div className="field">
                    <label>负向</label>
                    <textarea
                      value={data.params?.[slot] ?? ''}
                      onChange={(e) => setParam(slot, e.target.value)}
                      rows={2}
                      placeholder="不想要什么…"
                    />
                  </div>
                )}
              </div>
            ))}

            {negHit && (
              <div className="hint warn">
                检测到否定表述「{negHit[0]}」。这个模型没有负向分支，会把提到的名词照字面生出来 —— 改写成正面描述，只写画面里有什么。
              </div>
            )}
            {tpl && !showNegative && (
              <div className="tn-note">
                {tpl.cfg === 1 ? 'cfg=1' : '无负向输入'} · 负向不生效，已隐藏
              </div>
            )}

            {numSlots.length > 0 && (
              <div className="tn-nums">
                {numSlots.map((slot) => (
                  <label className="tn-num" key={slot}>
                    <span>{slot}</span>
                    <input
                      type={NUMERIC_SLOTS.has(slot) ? 'number' : 'text'}
                      value={data.params?.[slot] ?? ''}
                      onChange={(e) => setParam(slot, e.target.value)}
                      placeholder={slot === 'seed' ? '留空=随机' : ''}
                    />
                  </label>
                ))}
              </div>
            )}

            {data.error && <div className="err-box">{data.error}</div>}

            <div className="gc-bar">
              <button
                className="gc-ic"
                title="整链：先把上游按顺序跑完，再跑这个节点"
                onClick={() => openChain?.(id)}
                disabled={!data.template || busy}
              >
                <Icon name="link" size={13} />
              </button>
              <span className="spacer" />
              {busy ? (
                <button className="gstop" onClick={() => cancelNode(job?.id)} disabled={!job} title="取消">
                  停止
                </button>
              ) : (
                <button
                  className="gsubmit"
                  disabled={!data.template}
                  onClick={() => runNode(id)}
                  title="运行（R）"
                >
                  <Icon name="play" size={14} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 右侧「＋」：连线入口，点一下派生一个下游节点 */}
      <div
        className="side-add right nodrag"
        role="button"
        title="拖出线接下游 · 点一下派生一个节点"
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
  )
}
