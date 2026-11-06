import { useState } from 'react'
import NumberField from './NumberField.jsx'

/**
 * 宫格切分（LibTV 的招牌动作）。
 *
 * 九宫格图在很多场景里是「九张分镜压在一张图上」，切出来才能一个个往下走。
 * 切图走浏览器 canvas：原图同源，直接 fetch → drawImage → toBlob，
 * 再按现有上传接口落盘，切出来的每格都是一个正常的素材节点。
 */
const PRESETS = [
  { rows: 3, cols: 3, label: '3 × 3', hint: '九宫格多机位' },
  { rows: 2, cols: 2, label: '2 × 2', hint: '四宫格推演' },
  { rows: 2, cols: 3, label: '2 × 3', hint: '六格分镜' },
  { rows: 3, cols: 1, label: '3 × 1', hint: '竖三联' },
  { rows: 1, cols: 3, label: '1 × 3', hint: '横三联' },
]

export default function SplitModal({ sample, onCancel, onConfirm }) {
  const [rows, setRows] = useState(3)
  const [cols, setCols] = useState(3)
  const [busy, setBusy] = useState(false)

  const run = async () => {
    setBusy(true)
    try {
      await onConfirm(rows, cols)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-hd">
          <b>宫格切分</b>
          <span className="muted">把一张拼图拆成独立素材</span>
        </div>

        <div className="split-body">
          <div className="split-preview">
            {sample ? (
              <div className="split-img-wrap">
                <img src={sample} alt="" />
                <div
                  className="split-grid"
                  style={{
                    backgroundImage:
                      'linear-gradient(to right, rgba(140,120,255,.85) 1px, transparent 1px), linear-gradient(to bottom, rgba(140,120,255,.85) 1px, transparent 1px)',
                    backgroundSize: `${100 / cols}% ${100 / rows}%`,
                  }}
                />
              </div>
            ) : (
              <div className="preview-empty">没有图</div>
            )}
          </div>

          <div className="split-opts">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                className={`split-opt ${rows === p.rows && cols === p.cols ? 'on' : ''}`}
                onClick={() => {
                  setRows(p.rows)
                  setCols(p.cols)
                }}
              >
                <b>{p.label}</b>
                <span>{p.hint}</span>
              </button>
            ))}
            <div className="split-custom">
              <label>
                行
                <NumberField
                  value={rows}
                  min={1}
                  max={6}
                  label="行数"
                  onChange={(v) => setRows(Math.max(1, Math.min(6, Number(v) || 1)))}
                />
              </label>
              <label>
                列
                <NumberField
                  value={cols}
                  min={1}
                  max={6}
                  label="列数"
                  onChange={(v) => setCols(Math.max(1, Math.min(6, Number(v) || 1)))}
                />
              </label>
            </div>
            <div className="hint dim">切成 {rows * cols} 张，按格子顺序铺到画布右侧</div>
          </div>
        </div>

        <div className="modal-ft">
          <button onClick={onCancel}>取消</button>
          <button className="primary" disabled={busy} onClick={run}>
            {busy ? '切分中…' : `切成 ${rows * cols} 张`}
          </button>
        </div>
      </div>
    </div>
  )
}
