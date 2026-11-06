import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { EdgeLabelRenderer } from '@xyflow/react'
import Icon from '../ui/Icon.jsx'

/**
 * 画布连线。
 *
 * 默认的贝塞尔边有两个毛病：一是所有线一个颜色、分不清「图」和「文本」；
 * 二是同一条线十几根汇到同一个节点时糊成一片，看不出哪根接哪个槽。
 *
 * 这里按三种流向分色，每条线给一点垂直偏移量（offset）错开，
 * 悬停时在中点浮出一枚小牌子：写明它接的是哪个槽，旁边是断开按钮。
 */
const TONE = {
  image: '#7d7a9e',
  video: '#5d8f84',
  audio: '#6b8b6f',
  prompt: '#8a7f66',
}

const cubic = (p0, p1, p2, p3, t) => {
  const u = 1 - t
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
}

function Wire({ id, sourceX, sourceY, targetX, targetY, data = {}, selected }) {
  const [hover, setHover] = useState(false)
  const timer = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])

  const tone = data.tone || 'image'
  const color = TONE[tone] || TONE.image
  const off = data.offset || 0
  const dx = Math.max(46, Math.abs(targetX - sourceX) * 0.45)

  const c1x = sourceX + dx
  const c1y = sourceY + off
  const c2x = targetX - dx
  const c2y = targetY + off
  const d = `M ${sourceX},${sourceY} C ${c1x},${c1y} ${c2x},${c2y} ${targetX},${targetY}`
  const mx = cubic(sourceX, c1x, c2x, targetX, 0.5)
  const my = cubic(sourceY, c1y, c2y, targetY, 0.5)

  // 鼠标从线挪到牌子中间会短暂离开线，给个延时，别让牌子闪掉
  const open = useCallback(() => {
    clearTimeout(timer.current)
    setHover(true)
  }, [])
  const close = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setHover(false), 200)
  }, [])

  const cls = [
    'wire',
    `t-${tone}`,
    data.empty ? 'dim' : '',
    data.active ? 'active' : '',
    selected ? 'sel' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <g className={cls}>
      {/* 命中区：线本身只有 1.8px，细到点不中 */}
      <path
        className="wire-hit"
        d={d}
        onMouseEnter={open}
        onMouseLeave={close}
        onDoubleClick={() => data.onDelete?.(id)}
      />
      {/* 不画箭头：方向靠「左进右出」的端口位置和分色去读，
          箭头压在细线上只会让端口附近糊成一坨 */}
      <path className="wire-line" d={d} style={{ stroke: color }} />

      {hover || selected ? (
        <EdgeLabelRenderer>
          <div
            className="wire-pill"
            style={{ transform: `translate(-50%, -50%) translate(${mx}px, ${my}px)` }}
            onMouseEnter={open}
            onMouseLeave={close}
          >
            <span className="wire-dot" style={{ background: color }} />
            <span className="wire-lb">{data.label || '连线'}</span>
            {data.srcName ? <span className="wire-src">← {data.srcName}</span> : null}
            <button
              className="wire-x"
              title="断开这条线（双击线也可以）"
              onClick={(e) => {
                e.stopPropagation()
                data.onDelete?.(id)
              }}
            >
              <Icon name="close" size={11} stroke={2} />
            </button>
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </g>
  )
}

export default memo(Wire)
