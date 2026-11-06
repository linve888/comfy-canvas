import { useMemo, useRef, useState } from 'react'
import * as api from '../api.js'
import Icon from './Icon.jsx'

const KIND_TEXT = {
  media: '媒体',
  prompt: '提示词',
  negative: '负向',
  seed: '种子',
  number: '数字',
  select: '选项',
  text: '文本',
}
const MEDIA_TEXT = { image: '图片', video: '视频', audio: '音频' }

function guessName(file) {
  const stem = String(file || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .toLowerCase()
  if (stem.length >= 3) return stem.slice(0, 40)
  return 'wf_' + Date.now().toString(36).slice(-5)
}

function guessLabel(file) {
  const stem = String(file || '').replace(/\.[^.]+$/, '')
  return stem.slice(0, 40) || '导入的工作流'
}

/**
 * 导入 ComfyUI API 工作流 → 模板。
 *
 * 两步：先解析出「哪些输入能做成槽位」，让人过一遍勾选和改名，再落盘成模板。
 * 不自动落盘是故意的：一张工作流里 width/height/steps/cfg 全在，全做成槽位
 * 会把生成节点撑成一屏；哪几个该露出来只有作者知道。
 */
export default function WorkflowImport({ initialUse = 'imagegen', onClose, onSaved }) {
  const [text, setText] = useState('')
  const [an, setAn] = useState(null)
  const [rows, setRows] = useState([])
  const [name, setName] = useState('')
  const [label, setLabel] = useState('')
  const [use, setUse] = useState(initialUse)
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [openMore, setOpenMore] = useState(false)
  const [needOverwrite, setNeedOverwrite] = useState(false)
  const fileRef = useRef(null)

  const parse = async (raw, fname) => {
    setErr('')
    setNeedOverwrite(false)
    setBusy(true)
    try {
      let g
      try {
        g = JSON.parse(raw)
      } catch (e) {
        throw new Error(`不是合法 JSON：${e.message}`)
      }
      const r = await api.analyzeWorkflow(g, fname)
      setAn({ ...r, graph: g, file: fname })
      setRows(r.candidates.map((c) => ({ ...c })))
      setName(guessName(fname))
      setLabel(guessLabel(fname))
      setUse(r.use || initialUse)
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  const readFile = async (f) => {
    if (!f) return
    const raw = await f.text()
    parse(raw, f.name)
  }

  const patch = (id, p) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)))

  const core = rows.filter((r) => r.priority === 0)
  const more = rows.filter((r) => r.priority !== 0)
  const picked = rows.filter((r) => r.checked)
  const mediaCount = picked.filter((r) => r.kind === 'media').length

  const save = async (createNode) => {
    if (!an) return
    if (!picked.length) return setErr('至少勾一项，否则节点上什么也没有')
    if (!name.trim()) return setErr('模板名不能为空')
    setErr('')
    setBusy(true)
    try {
      const r = await api.saveWorkflow({
        graph: an.graph,
        file: an.file,
        name: name.trim(),
        label: label.trim() || name.trim(),
        use,
        note: note.trim(),
        overwrite: needOverwrite,
        selections: picked,
      })
      onSaved?.(r.name, use, createNode, r.template, r.dropped)
    } catch (e) {
      if (/已存在/.test(e.message)) setNeedOverwrite(true)
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  const summary = useMemo(() => {
    if (!an) return ''
    const bits = []
    if (an.counts.image) bits.push(`${an.counts.image} 图`)
    if (an.counts.video) bits.push(`${an.counts.video} 视频`)
    if (an.counts.audio) bits.push(`${an.counts.audio} 音频`)
    if (an.counts.params) bits.push(`${an.counts.params} 参数`)
    return bits.join(' · ') || '没有可接入的输入'
  }, [an])

  const row = (r) => {
    const chip =
      r.kind === 'media' ? MEDIA_TEXT[r.media] || '媒体' : KIND_TEXT[r.kind] || r.kind
    const tone = r.kind === 'media' ? r.media : r.kind
    return (
      <div className={`wf-row ${r.checked ? 'on' : ''}`} key={r.id}>
        <input
          type="checkbox"
          checked={!!r.checked}
          onChange={(e) => patch(r.id, { checked: e.target.checked })}
        />
        <span className={`wf-chip t-${tone}`}>{chip}</span>
        <span className="wf-src" title={`节点 ${r.node} · ${r.input}`}>
          <b>{r.class}</b>
          <em>#{r.node}</em>
          <span className="wf-key">{r.input}</span>
        </span>
        <input
          className="wf-label"
          value={r.label || ''}
          placeholder="槽位名"
          onChange={(e) => patch(r.id, { label: e.target.value })}
        />
        <span className="wf-slot mono">{r.suggest}</span>
        {r.kind === 'media' ? (
          <label
            className={`wf-opt ${r.pruneable ? '' : 'off'}`}
            title={
              r.pruneable
                ? '勾上＝不接也能跑，未接时这路整枝剪掉'
                : r.hint || '这路接的不是自动增长口，剪掉会校验失败，只能必接'
            }
          >
            <input
              type="checkbox"
              disabled={!r.pruneable}
              checked={!!r.optional}
              onChange={(e) => patch(r.id, { optional: e.target.checked })}
            />
            可选
          </label>
        ) : (
          <span className="wf-val mono" title={r.value}>
            {r.value}
          </span>
        )}
      </div>
    )
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wf-modal">
        <div className="modal-hd">
          <b>导入工作流</b>
          <span className="muted">ComfyUI 的 API 格式 json → 生成节点上的输入槽位</span>
          <span className="spacer" />
          <button className="x-close" onClick={onClose} aria-label="关闭">
            <Icon name="close" size={15} />
          </button>
        </div>

        {!an ? (
          <div className="wf-pick">
            <div
              className="wf-drop"
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                readFile(e.dataTransfer.files?.[0])
              }}
            >
              <div className="wf-drop-ico">↑</div>
              <div>
                <b>选一个 .json，或直接拖进来</b>
                <span>
                  ComfyUI 里「工作流 → 导出（API）」，或开启开发者模式后「保存（API 格式）」
                </span>
              </div>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              style={{ display: 'none' }}
              onChange={(e) => {
                readFile(e.target.files?.[0])
                e.target.value = ''
              }}
            />
            <textarea
              className="wf-paste"
              placeholder="也可以把 API 格式的 json 直接粘在这里"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="wf-pick-ft">
              <span className="muted">
                不是界面格式的 workflow.json —— 那个要导两次，认节点表的那份才带完整入参
              </span>
              <button
                className="primary"
                disabled={!text.trim() || busy}
                onClick={() => parse(text, 'pasted.json')}
              >
                {busy ? '解析中…' : '解析粘贴的 JSON'}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="wf-info">
              <span className="wf-file mono" title={an.file}>
                {an.file}
              </span>
              <span className="muted">
                {an.nodes} 节点 · {an.kind === 'video' ? '出片' : '出图'} · {summary}
              </span>
              <span className="spacer" />
              <button className="mini ghost" onClick={() => { setAn(null); setRows([]); setErr('') }}>
                换一个
              </button>
            </div>

            {(an.warnings || []).map((w) => (
              <div className="hint warn wf-warn" key={w}>
                {w}
              </div>
            ))}

            <div className="wf-list">
              <div className="wf-sec">
                <span>输入 · 勾上的才会变成槽位</span>
                <span className="muted">{picked.length} 项</span>
              </div>
              {core.length ? core.map(row) : <div className="wf-empty">没认出输入，检查一下这个工作流</div>}

              {more.length > 0 && (
                <>
                  <button className="wf-more" onClick={() => setOpenMore((v) => !v)}>
                    {openMore ? '收起' : '展开'}其他参数（{more.length}）
                    <span className="muted">steps / cfg / 采样器这类，一般不用露出来</span>
                  </button>
                  {openMore && more.map(row)}
                </>
              )}
            </div>

            <div className="wf-form">
              <label>
                模板名
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="只收字母数字下划线，会当文件名"
                />
              </label>
              <label>
                显示名
                <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="节点标题上显示的名字" />
              </label>
              <label>
                归到
                <select value={use} onChange={(e) => setUse(e.target.value)}>
                  <option value="imagegen">图片生成节点</option>
                  <option value="videogen">视频生成节点</option>
                </select>
              </label>
              <label className="wide">
                备注
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="这个工作流是干什么的，给以后翻账用" />
              </label>
            </div>

            {err && <div className="err-box wf-err">{err}</div>}
            {mediaCount > 0 && !err && (
              <div className="hint dim wf-note">
                识别到 {mediaCount} 个媒体槽。勾了「可选」的，不接线时这一路连加载节点一起剪掉；没勾的必须接上才能跑。
              </div>
            )}

            <div className="modal-ft">
              <button className="ghost" onClick={() => { setAn(null); setRows([]) }}>
                返回
              </button>
              <span className="spacer" />
              <button disabled={busy} onClick={() => save(false)}>
                {needOverwrite ? '覆盖并创建' : '只创建模板'}
              </button>
              <button className="primary" disabled={busy} onClick={() => save(true)}>
                {busy ? '写入中…' : '创建，并加一个节点'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
