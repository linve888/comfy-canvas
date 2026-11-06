#!/usr/bin/env node
/**
 * 整链编排的单测。纯逻辑，不连 ComfyUI，秒出结果。
 *
 *   node canvas/tools/chaintest.mjs
 *
 * 为什么值得单独测：链跑错顺序不会报错，只会拿旧图去生成新图，
 * 结果看着像「模型不听话」。这种东西必须用断言钉住。
 */
import { planChain, upstreamOf, hasOutput } from '../web/src/chain.js'

let bad = 0
const eq = (name, got, want) => {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) {
    console.log(`OK   ${name}`)
  } else {
    bad++
    console.log(`FAIL ${name}\n     got  ${g}\n     want ${w}`)
  }
}

const gen = (id, x, { out = 0, dirty = false, tpl = 'z_image_t2i' } = {}) => ({
  id,
  type: 'imagegen',
  position: { x, y: 0 },
  data: {
    template: tpl,
    dirty,
    outputs: out ? [{ assetId: `${id}-a`, url: '/x.png', kind: 'image' }] : [],
    history: out ? [{ jobId: `${id}-j`, outputs: [{ assetId: `${id}-a`, url: '/x.png', kind: 'image' }] }] : [],
  },
})

const text = (id, x) => ({ id, type: 'text', position: { x, y: 0 }, data: { text: '描述' } })
const media = (id, x) => ({
  id,
  type: 'media',
  position: { x, y: 0 },
  data: { url: '/m.png', outputs: [{ assetId: id, url: '/m.png', kind: 'image' }], history: [] },
})
const edge = (s, t) => ({ id: `e-${s}-${t}`, source: s, target: t })

// 1) 基础：A 有产物且没改，B 没产物，C 是目标 → 只跑 B、C
{
  const nodes = [gen('A', 0, { out: 1 }), gen('B', 300), gen('C', 600, { out: 1 })]
  const edges = [edge('A', 'B'), edge('B', 'C')]
  const p = planChain(nodes, edges, 'C')
  eq('跳过已有产物的上游', p.order, ['B', 'C'])
  eq('  跳过名单', p.skipped, ['A'])
}

// 2) 上游改过参数（dirty）→ 整条链都要重跑
{
  const nodes = [gen('A', 0, { out: 1, dirty: true }), gen('B', 300, { out: 1 }), gen('C', 600, { out: 1 })]
  const edges = [edge('A', 'B'), edge('B', 'C')]
  eq('上游 dirty 则全链重跑', planChain(nodes, edges, 'C').order, ['A', 'B', 'C'])
}

// 3) 两条分支 → 按 x 排，先左后右，都排在目标前
{
  const nodes = [gen('L', 0), gen('R', 0), gen('C', 600)]
  nodes[0].position.y = 0
  nodes[1].position.y = 200
  const edges = [edge('L', 'C'), edge('R', 'C')]
  eq('同层按位置排', planChain(nodes, edges, 'C').order, ['L', 'R', 'C'])
}

// 4) 目标有产物也要跑（用户点的就是它）
{
  const nodes = [gen('A', 0, { out: 1 }), gen('C', 600, { out: 1 })]
  eq('目标强制跑', planChain(nodes, [edge('A', 'C')], 'C').order, ['C'])
}

// 5) 文本节点不参与排序，也不占步骤
{
  const nodes = [text('T', 0), gen('B', 300), gen('C', 600)]
  const edges = [edge('T', 'B'), edge('B', 'C')]
  const p = planChain(nodes, edges, 'C')
  eq('文本节点不进队列', p.order, ['B', 'C'])
  eq('  但有 2 个可跑节点', p.skipped.length, 0)
}

// 6) 素材节点（无模板）同样不跑
{
  const nodes = [media('M', 0), gen('C', 300)]
  eq('素材节点不跑', planChain(nodes, [edge('M', 'C')], 'C').order, ['C'])
}

// 7) 环：排不出来要报出来，不能瞎跑
//    A↔B 互指，C 挂在 B 后面 —— 三个都排不出来，环上的和环下游都不许跑
{
  const nodes = [gen('A', 0), gen('B', 300), gen('C', 600)]
  const edges = [edge('A', 'B'), edge('B', 'A'), edge('B', 'C')]
  const p = planChain(nodes, edges, 'C')
  eq('环及其下游都被拦住', p.stuck.sort(), ['A', 'B', 'C'])
  eq('  并给出原因', /环/.test(p.reason), true)
}

// 8) 目标不是可运行节点
{
  const nodes = [text('T', 0)]
  eq('文本节点当目标被拒', planChain(nodes, [], 'T').order, [])
}

// 9) 五张图汇到一个节点：全部没产物 → 顺序里目标在最后
{
  const nodes = [0, 1, 2, 3, 4].map((i) => gen(`M${i}`, i * 10))
  const c = gen('C', 600)
  nodes.push(c)
  const edges = [0, 1, 2, 3, 4].map((i) => edge(`M${i}`, 'C'))
  const p = planChain(nodes, edges, 'C')
  eq('五路汇流目标在末位', p.order[p.order.length - 1], 'C')
  eq('  步骤数', p.order.length, 6)
}

// 10) upstreamOf 不重复、不遗漏
{
  const nodes = [gen('A', 0), gen('B', 100), gen('C', 200)]
  const edges = [edge('A', 'B'), edge('A', 'C'), edge('B', 'C')]
  eq('上游去重', upstreamOf(nodes, edges, 'C').map((n) => n.id).sort(), ['A', 'B', 'C'])
}

// 11) hasOutput 认版本历史
{
  const n = gen('X', 0)
  n.data.history = [{ jobId: 'h', outputs: [{ assetId: 'z', url: '/z.png' }] }]
  n.data.activeVersion = 0
  eq('历史里的产物算有产物', hasOutput(n), true)
}

console.log(bad ? `\n${bad} 项失败` : '\n全部通过')
process.exit(bad ? 1 : 0)
