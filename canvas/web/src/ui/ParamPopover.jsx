import NumberField from './NumberField.jsx'
import { matchOption } from '../ctx.js'

/**
 * 生成节点的二级参数面板。
 *
 * 为什么不再用长条下拉：一条 select 横过去把整块区域切成「标签 + 全宽框」
 * 的表格感，几个参数摞起来就像后台表单。
 * 比例给成形状卡（一眼看出竖的还是横的），数值给成能直接打的输入框 ——
 * 时长这类参数不是「选一个」，写 6.5 就得能写进去。
 */

function ratioOf(opt) {
  const text = String(opt?.value ?? opt ?? '')
  const m = text.match(/(\d+)\s*[:：]\s*(\d+)/)
  if (!m) return null
  return [Number(m[1]), Number(m[2])]
}

/** 比例缩略图：按真实长宽比画一个空心矩形 */
function RatioShape({ ratio }) {
  const [w, h] = ratio
  const box = 20
  const k = Math.min(box / w, box / h)
  return (
    <span className="gp-shape">
      <i style={{ width: Math.max(4, w * k), height: Math.max(4, h * k) }} />
    </span>
  )
}

function Segmented({ opt, value, onPick }) {
  return (
    <div className="gp-seg">
      {opt.map((o) => {
        const v = typeof o === 'string' ? o : o.value
        const l = typeof o === 'string' ? o : o.label
        return (
          <button
            key={v}
            type="button"
            className={`gp-pill ${String(value) === String(v) ? 'on' : ''}`}
            onClick={() => onPick(v)}
            title={l}
          >
            {l}
          </button>
        )
      })}
    </div>
  )
}

function NumberControl({ f, value, onChange }) {
  // 数值参数一律给可输入的框：时长、像素这些都不是「选一个」，
  // 用户要填 6.5 秒就得能填。小数最多两位，超了直接截。
  return (
    <div className="gp-field">
      <NumberField
        value={value}
        min={f.min}
        max={f.max}
        step={f.step || 1}
        decimals={2}
        placeholder={f.placeholder || ''}
        label={f.label}
        onChange={onChange}
      />
    </div>
  )
}

export default function ParamPopover({ fields, params, setParam, seedShown }) {
  const val = (slot) => {
    const v = params?.[slot]
    return v === undefined || v === null ? '' : v
  }

  return (
    <div
      className="gpop nodrag nowheel"
      // 浮层里的点击不该被节点的拖动/选中处理吃掉
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {fields.map((f) => {
        if (f.type === 'seed') {
          return (
            <div className="gp-sec gp-row seed" key={f.slot}>
              <div className="gp-lb">
                {f.label || '种子'}
                {seedShown && <span className="gp-note">上次 {seedShown}</span>}
              </div>
              <div className="gp-field">
                <input
                  className="gp-input"
                  type="text"
                  value={val(f.slot)}
                  placeholder="留空 = 每次随机"
                  onChange={(e) => setParam(f.slot, e.target.value)}
                />
                <button
                  type="button"
                  className="gp-btn"
                  title="清空，下次跑用新种子"
                  onClick={() => setParam(f.slot, '')}
                >
                  随机
                </button>
              </div>
            </div>
          )
        }

        if (f.type === 'select' && (f.preset === 'aspect' || f.slot === 'aspect')) {
          const opts = f.options || []
          // 旧节点里可能存着别的模板的写法（`16:9`），只要比例对得上就照常点亮
          const picked = matchOption(f, val(f.slot))
          return (
            <div className="gp-sec" key={f.slot}>
              <div className="gp-lb">{f.label}</div>
              <div className="gp-ratios">
                {opts.map((o) => {
                  const v = typeof o === 'string' ? o : o.value
                  const l = typeof o === 'string' ? o : o.label
                  const r = ratioOf(o)
                  return (
                    <button
                      key={v}
                      type="button"
                      className={`gp-ratio ${String(picked) === String(v) ? 'on' : ''}`}
                      onClick={() => setParam(f.slot, v)}
                      title={l}
                    >
                      <RatioShape ratio={r || [1, 1]} />
                      <span className="gp-rat">{r ? r.join(':') : l}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )
        }

        if (f.type === 'select') {
          return (
            <div className="gp-sec" key={f.slot}>
              <div className="gp-lb">{f.label}</div>
              <Segmented opt={f.options || []} value={val(f.slot)} onPick={(v) => setParam(f.slot, v)} />
            </div>
          )
        }

        if (f.type === 'number') {
          return (
            <div className="gp-sec gp-row" key={f.slot}>
              <div className="gp-lb">{f.label}</div>
              <NumberControl f={f} value={val(f.slot)} onChange={(v) => setParam(f.slot, v)} />
            </div>
          )
        }

        return (
          <div className="gp-sec" key={f.slot}>
            <div className="gp-lb">{f.label}</div>
            <input
              className="gp-input"
              type="text"
              value={val(f.slot)}
              placeholder={f.placeholder || ''}
              onChange={(e) => setParam(f.slot, e.target.value)}
            />
          </div>
        )
      })}
    </div>
  )
}
