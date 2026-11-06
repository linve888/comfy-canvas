/**
 * 整链运行的编排逻辑。
 *
 * 这里只做「算出该按什么顺序跑哪些节点」，不碰网络、不碰 React ——
 * 好让 tools/chaintest.mjs 能直接拿它跑单测。
 *
 * 为什么要算顺序而不是一把全提交：下游的参考图是「上游产物文件名」，
 * 提交时就得知道文件名，所以必须等上游真跑完才轮到下游。
 */

/** 有模板的节点才能提交给后端（文本节点、纯素材节点不行） */
export const isRunnable = (node) => !!node?.data?.template

export function outputsOf(node) {
  const d = node?.data || {}
  const h = d.history || []
  const v = h[d.activeVersion || 0]
  if (v?.outputs?.length) return v.outputs
  return d.outputs || []
}

export function hasOutput(node) {
  return outputsOf(node).length > 0
}

/** 沿连线反向走，收集目标节点的全部上游（含自己） */
export function upstreamOf(nodes, edges, id) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const seen = new Set()
  const out = []
  const stack = [id]
  while (stack.length) {
    const cur = stack.pop()
    if (seen.has(cur)) continue
    seen.add(cur)
    const n = byId.get(cur)
    if (n) out.push(n)
    for (const e of edges) {
      if (e.target === cur && !seen.has(e.source)) stack.push(e.source)
    }
  }
  return out
}

const byPos = (a, b) =>
  (a.position?.x || 0) - (b.position?.x || 0) || (a.position?.y || 0) - (b.position?.y || 0)

/**
 * 排出一条链的执行计划。
 *
 * 规则：
 * - 目标节点一定跑（用户点的就是它）；
 * - 上游里「没产物」或「改过参数没重跑」（dirty）的，也要跑；
 * - 某个上游要跑，它的下游就必须跟着跑（输入变了）；
 * - 其余已有产物且没改过的上游跳过，省时间。
 */
export function planChain(nodes, edges, targetId, opts = {}) {
  const { force = true } = opts
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const target = byId.get(targetId)
  if (!target) return { order: [], skipped: [], stuck: [], reason: '找不到节点' }
  if (!isRunnable(target)) return { order: [], skipped: [], stuck: [], reason: '这个节点不能运行' }

  const chain = upstreamOf(nodes, edges, targetId)
  const chainIds = new Set(chain.map((n) => n.id))
  const runnable = chain.filter(isRunnable)

  const seed = new Set()
  for (const n of runnable) {
    if (!hasOutput(n) || n.data?.dirty) seed.add(n.id)
  }
  if (force) seed.add(targetId)

  // 上游要跑 → 下游跟着跑，一直到目标为止
  const runSet = new Set(seed)
  let grew = true
  while (grew) {
    grew = false
    for (const e of edges) {
      if (!runSet.has(e.source) || runSet.has(e.target)) continue
      if (!chainIds.has(e.target)) continue
      const t = byId.get(e.target)
      if (!t || !isRunnable(t)) continue
      runSet.add(e.target)
      grew = true
    }
  }

  // 拓扑排序：只排要跑的，链外的依赖视为已就绪
  const toRun = runnable.filter((n) => runSet.has(n.id))
  const indeg = new Map(toRun.map((n) => [n.id, 0]))
  for (const e of edges) {
    if (!indeg.has(e.target) || !indeg.has(e.source)) continue
    indeg.set(e.target, indeg.get(e.target) + 1)
  }

  const queue = toRun.filter((n) => indeg.get(n.id) === 0).sort(byPos)
  const order = []
  while (queue.length) {
    const n = queue.shift()
    order.push(n.id)
    for (const e of edges) {
      if (e.source !== n.id || !indeg.has(e.target)) continue
      const v = indeg.get(e.target) - 1
      indeg.set(e.target, v)
      if (v === 0) {
        queue.push(byId.get(e.target))
        queue.sort(byPos)
      }
    }
  }

  const stuck = toRun.filter((n) => !order.includes(n.id)).map((n) => n.id)

  return {
    order,
    skipped: runnable.filter((n) => !runSet.has(n.id)).map((n) => n.id),
    stuck,
    reason: stuck.length ? '这条链里有环，排不出顺序' : '',
  }
}
