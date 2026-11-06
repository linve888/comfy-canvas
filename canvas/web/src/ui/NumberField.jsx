import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 数字输入 + 自绘上下箭头。
 *
 * 为什么不用 <input type="number"> 的原生 spinner：
 * Chromium 把「箭头正被按住」记在 spin button 自己身上，靠 mouseup 收尾。这一次
 * mouseup 只要落在箭头外面（松手时鼠标已经挪开、输入框被重渲染、窗口失焦），
 * 这个状态就漏掉了 —— 表现就是「只点了一下，松开后鼠标一动值还跟着跳」。
 * 这里改成自己管定时器：只有指针真的按着才重复，pointerup / pointercancel /
 * 指针离开按钮 / 窗口失焦都会停，而且全程不读鼠标位置，所以值不可能跟着鼠标走。
 */

const HOLD_DELAY = 380 // 按住多久开始连续加减
const HOLD_REPEAT = 70 // 连续加减的间隔

function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const t = String(v ?? '').trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

function decimalsOf(step) {
  const s = String(step)
  const i = s.indexOf('.')
  return i < 0 ? 0 : s.length - i - 1
}

export default function NumberField({
  value,
  min,
  max,
  step = 1,
  decimals, // 最多保留几位小数（时长这种要能自己填，又不想要 5.123456）
  placeholder = '',
  onChange,
  onBlur,
  disabled = false,
  className = '',
  label,
}) {
  const show = (v) => (v === '' || v === null || v === undefined ? '' : String(v))
  const [text, setText] = useState(show(value))
  const inputRef = useRef(null)
  const holdRef = useRef(null)
  // 连续加减跑在定时器里，闭包只会拿到旧渲染的值，所以统一从 ref 读最新配置
  const live = useRef({ value, min, max, step, onChange })
  live.current = { value, min, max, step, onChange }

  useEffect(() => {
    // 外部改了值（换模板、重跑换种子）就跟着同步；用户正在里面打字时不动它
    if (document.activeElement === inputRef.current) return
    setText(show(value))
  }, [value])

  const apply = useCallback((next) => {
    const { min: lo, max: hi, onChange: cb, value: v } = live.current
    let n = next
    if (typeof lo === 'number' && n < lo) n = lo
    if (typeof hi === 'number' && n > hi) n = hi
    setText(String(n))
    if (toNumber(v) === n) return // 已经顶到边界：别空刷父组件
    cb?.(n)
  }, [])

  const bump = useCallback(
    (dir) => {
      const { value: v, min: lo, step: s } = live.current
      const stepNum = toNumber(s) || 1
      const base = toNumber(v)
      // 空着点箭头：落到下界（没有下界就给 ±一个步长），不要跳到一个莫名其妙的数
      if (base === null) return apply(typeof lo === 'number' ? lo : dir * stepNum)
      const p = decimalsOf(stepNum)
      const raw = base + dir * stepNum
      apply(p ? Number(raw.toFixed(p)) : Math.round(raw))
    },
    [apply]
  )

  const stopHold = useCallback(() => {
    const h = holdRef.current
    holdRef.current = null
    if (h) {
      clearTimeout(h.delay)
      if (h.repeat) clearInterval(h.repeat)
    }
    window.removeEventListener('pointerup', stopHold, true)
    window.removeEventListener('pointercancel', stopHold, true)
    window.removeEventListener('blur', stopHold, true)
  }, [])

  // 卸载时别把定时器留着
  useEffect(() => stopHold, [stopHold])

  const startHold = (dir) => (e) => {
    if (disabled) return
    if (e.button) return // 只吃左键
    e.preventDefault() // 别让输入框失焦、别选中文字
    e.stopPropagation()
    stopHold()
    bump(dir)
    const h = { delay: null, repeat: null }
    h.delay = setTimeout(() => {
      h.repeat = setInterval(() => bump(dir), HOLD_REPEAT)
    }, HOLD_DELAY)
    holdRef.current = h
    // 松手不一定发生在按钮上，所以挂到 window 上收尾
    window.addEventListener('pointerup', stopHold, true)
    window.addEventListener('pointercancel', stopHold, true)
    window.addEventListener('blur', stopHold, true)
  }

  const onText = (e) => {
    let raw = e.target.value
    if (raw !== '' && !/^-?\d*\.?\d*$/.test(raw)) return // 只收数字与小数点
    if (decimals != null) {
      // 超出的位数直接截掉，不做四舍五入 —— 边打字边改数值会跳
      const m = raw.match(/^(-?\d*)(?:\.(\d*))?$/)
      if (m && m[2] && m[2].length > decimals) raw = `${m[1]}.${m[2].slice(0, decimals)}`
    }
    setText(raw)
    const cb = live.current.onChange
    if (raw === '') return cb?.('')
    const n = Number(raw)
    if (Number.isFinite(n)) cb?.(n)
  }

  const finish = () => {
    stopHold()
    const n = toNumber(text)
    if (n === null) {
      // "-"、"1." 这种半截输入：还原成真实值，别留在框里骗人
      setText(show(live.current.value))
      onBlur?.()
      return
    }
    const { min: lo, max: hi, value: v } = live.current
    let c = n
    if (typeof lo === 'number' && c < lo) c = lo
    if (typeof hi === 'number' && c > hi) c = hi
    if (decimals != null) c = Number(c.toFixed(decimals))
    setText(String(c))
    if (c !== toNumber(v)) live.current.onChange?.(c)
    onBlur?.()
  }

  const onKeyDown = (e) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      bump(1)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      bump(-1)
    } else if (e.key === 'Enter') {
      e.currentTarget.blur()
    }
  }

  const lo = typeof min === 'number' ? min : undefined
  const hi = typeof max === 'number' ? max : undefined
  const now = toNumber(text)

  return (
    <div className={`numfield nodrag ${className}`}>
      <input
        ref={inputRef}
        type="text"
        inputMode="decimal"
        role="spinbutton"
        aria-label={label}
        aria-valuenow={now === null ? undefined : now}
        aria-valuemin={lo}
        aria-valuemax={hi}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onChange={onText}
        onBlur={finish}
        onKeyDown={onKeyDown}
      />
      <div className="numstep">
        <button
          type="button"
          tabIndex={-1}
          aria-label="加一"
          disabled={disabled || (hi !== undefined && now !== null && now >= hi)}
          onPointerDown={startHold(1)}
          onPointerLeave={stopHold}
          onClick={(e) => e.preventDefault()}
        >
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2.4 6.6 5 4l2.6 2.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-label="减一"
          disabled={disabled || (lo !== undefined && now !== null && now <= lo)}
          onPointerDown={startHold(-1)}
          onPointerLeave={stopHold}
          onClick={(e) => e.preventDefault()}
        >
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2.4 3.4 5 6l2.6-2.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  )
}
