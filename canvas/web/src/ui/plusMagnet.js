/**
 * 侧边「＋」的磁吸跟随。
 *
 * 加号只有 18px，还悬在节点框外 22px 的空档里，缩放小的时候很难精确点中。
 * 这里让它在鼠标靠近时朝光标方向靠过去（最多 12px），离得越近跟得越多，
 * 光标落到它身上就停住不再推 —— 再配合 .side-add::after 那圈 16px 的隐形命中环，
 * 半径 ~35px 内按下就能拉线，不用瞄准。
 *
 * 两条红线：
 * 1. **Handle 不能动**。线端点的坐标是 React Flow 从 Handle 的 box 量出来的，
 *    加号整体平移时必须给 Handle 反向抵消同样的距离（见 style.css），
 *    否则一靠近，已连的线就会跟着歪。
 * 2. **按下那一刻不能抖**。所以内部半径内冻结当前偏移，不做二次求解；
 *    否则指针一旦落进按钮，按钮会继续朝指针推、把指针顶到边缘，来回跳。
 */

const REACH = 40 // 进入这个半径（px）才开始跟
const HOLD = 14 // 指针进到这么近就停住，别把按钮从指针底下推走
const MAX = 12 // 最多挪这么远：再多加号就离开节点太远了

const ZERO = { x: 0, y: 0 }
const applied = new WeakMap()

function apply(el, x, y) {
  const d = applied.get(el) || ZERO
  if (Math.abs(d.x - x) < 0.2 && Math.abs(d.y - y) < 0.2) return
  applied.set(el, { x, y })
  el.style.setProperty('--mag-x', `${x.toFixed(2)}px`)
  el.style.setProperty('--mag-y', `${y.toFixed(2)}px`)
  el.classList.toggle('mag', !!x || !!y)
}

function reset(el) {
  const d = applied.get(el) || ZERO
  if (!d.x && !d.y) return
  applied.set(el, ZERO)
  el.style.removeProperty('--mag-x')
  el.style.removeProperty('--mag-y')
  el.classList.remove('mag')
}

export function installPlusMagnet() {
  let raf = 0
  let ptr = null

  const all = () => Array.from(document.querySelectorAll('.side-add'))

  // 拖节点、拖线、平移画布的途中不跟：那时候端口得钉死不动
  const busy = () =>
    !!document.querySelector('.react-flow__node.dragging, .react-flow__connectionline')

  const frame = () => {
    raf = 0
    if (!ptr) return
    if (busy()) {
      for (const el of all()) reset(el)
      return
    }
    for (const el of all()) {
      const d = applied.get(el) || ZERO
      const r = el.getBoundingClientRect()
      // rect 是「已经带上偏移」的位置，减掉自己施加的偏移才是基准中心，
      // 不然会拿着推算的结果再推算，一路飘走
      const cx = r.left + r.width / 2 - d.x
      const cy = r.top + r.height / 2 - d.y
      const dx = ptr.x - cx
      const dy = ptr.y - cy
      const dist = Math.hypot(dx, dy)

      if (dist > REACH) {
        reset(el)
        continue
      }
      if (dist < HOLD) continue // 指针已经在按钮上：保持现状
      // 从 REACH 收到 HOLD，跟随量从 0 渐增到 MAX
      const k = (REACH - dist) / (REACH - HOLD)
      const len = MAX * Math.min(1, Math.max(0, k))
      apply(el, (dx / dist) * len, (dy / dist) * len)
    }
  }

  const onMove = (e) => {
    ptr = { x: e.clientX, y: e.clientY }
    if (!raf) raf = requestAnimationFrame(frame)
  }

  const clear = () => {
    ptr = null
    if (raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
    for (const el of all()) reset(el)
  }

  // 画布滚出视野 / 切走标签页时把偏移收干净，回来不会看到一排歪掉的加号
  document.addEventListener('pointermove', onMove, { passive: true })
  document.addEventListener('pointerleave', clear)
  window.addEventListener('blur', clear)

  return () => {
    document.removeEventListener('pointermove', onMove)
    document.removeEventListener('pointerleave', clear)
    window.removeEventListener('blur', clear)
    clear()
  }
}
