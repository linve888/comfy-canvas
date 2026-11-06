// 侧边「＋」和连线口不是同一个东西：
//   —— Handle 必须留在节点边缘（线的端点在那儿，不能动）
//   —— 加号挪到了外侧 -44px（不然贴着节点太挤）
// React Flow 只认 Handle 自己身上的 mousedown，所以按下加号时把这一下转发给 Handle，
// 拖拽仍然从 Handle 开始，画面上一根线都不受影响。
export function startConnectFromPlus(el, event) {
  if (!el || !event) return
  // 真按在 Handle 上（两条箱体有 2px 交叠）就让它自己走，别再补一枪，否则会开两条线
  if (event.target instanceof Element && event.target.closest('.react-flow__handle')) return
  const handle = el.querySelector('.react-flow__handle')
  if (!handle) return
  const r = handle.getBoundingClientRect()
  handle.dispatchEvent(
    new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      buttons: 1,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
    })
  )
}
