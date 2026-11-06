/**
 * 运行日志（前端 → 后端 projects/runtime.log）
 *
 * 为什么要有这条通道：画布跑在后端进程里，开发时看不到浏览器控制台。
 * 生成链路上的关键一步（点了生成 / 参数是什么 / 后端收没收到 / 状态怎么变 /
 * 错在哪）都从这里回传，和后端的任务生命周期写进同一个文件、同一条时间线。
 *
 * 两条出路，互不影响：
 *   1. 本地环形缓冲 —— 节点上的调试条（?log=1）直接读它，不发请求；
 *   2. 攒批回传 —— 够 40 条或 1.2 秒发一次，页面关闭时用 sendBeacon 兜底。
 *
 * 用法：rlog('gen.submit', { node: id, tpl, prompt_chars: 128 })
 *       rlog('gen.blocked', { node: id, why }, 'W')
 */
import { useEffect, useState } from 'react'

const T0 = Date.now()
// 一次页面生命周期一个 session：日志里能把「这一轮」的所有动作串起来
const SESSION = Math.random().toString(36).slice(2, 8)
const RING_MAX = 300
const FLUSH_MS = 1200
const FLUSH_MAX = 40
const MAX_TRY = 3

const ring = []
const queue = []
const subs = new Set()
let timer = 0
let seq = 0

/** 值压成短串：对象转 JSON，长文本截断，避免一条日志撑爆一行 */
const short = (v) => {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v).slice(0, 140)
    } catch {
      return '[object]'
    }
  }
  return String(v).replace(/\s+/g, ' ').slice(0, 160)
}

const payload = (batch) =>
  batch.map((e) => ({ ev: e.ev, lvl: e.lvl, node: e.node, t: e.at, f: e.f }))

function send(batch) {
  const body = JSON.stringify({ session: SESSION, entries: payload(batch) })
  fetch('/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  })
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
    })
    .catch(() => {
      // 后端没起来 / 正在重启：退回去重试，但只给 3 次，别把内存耗光
      for (const e of batch) if (++e.try < MAX_TRY) queue.push(e)
    })
}

/**
 * 立刻发出去。keepalive=true 走 sendBeacon —— 页面正在关闭时 fetch 会被砍掉，
 * beacon 是唯一还有机会送出去的路径。
 */
export function flush(keepalive = false) {
  if (timer) {
    clearTimeout(timer)
    timer = 0
  }
  if (!queue.length) return
  const batch = queue.splice(0, queue.length)
  if (keepalive && navigator.sendBeacon) {
    try {
      const blob = new Blob([JSON.stringify({ session: SESSION, entries: payload(batch) })], {
        type: 'application/json',
      })
      if (navigator.sendBeacon('/api/log', blob)) return
    } catch {
      /* 落到下面的 fetch */
    }
  }
  send(batch)
}

/**
 * 记一条运行日志。
 * @param {string} ev    事件名，点号分段：gen.submit / job.done
 * @param {object} fields 附带字段（node 单独提出来，方便后端按节点过滤）
 * @param {'I'|'W'|'E'} level
 */
export function rlog(ev, fields = {}, level = 'I') {
  const e = { seq: ++seq, at: Date.now() - T0, ev, lvl: level, node: '', f: {} }
  for (const [k, v] of Object.entries(fields || {})) {
    const s = short(v)
    if (!s) continue
    if (k === 'node') e.node = s
    else e.f[k] = s
  }
  ring.push(e)
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX)
  for (const fn of subs) {
    try {
      fn()
    } catch {
      /* 订阅者崩了不影响记录 */
    }
  }

  queue.push(e)
  if (queue.length >= FLUSH_MAX) flush()
  else if (!timer) timer = setTimeout(flush, FLUSH_MS)

  if (DEBUG) console.debug(`[rlog] ${ev}`, e.f)
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => flush(true))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true)
  })
}

/** 节点上的调试条只在 ?log=1 时出现（默认不打扰界面） */
export const DEBUG = (() => {
  try {
    return new URLSearchParams(window.location.search).has('log')
  } catch {
    return false
  }
})()

/** 读本地缓冲里某个节点的日志，供调试条渲染 */
export function useNodeLog(nodeId, limit = 10) {
  const [, bump] = useState(0)
  useEffect(() => {
    const fn = () => bump((x) => x + 1)
    subs.add(fn)
    return () => subs.delete(fn)
  }, [])
  return ring.filter((e) => !nodeId || e.node === String(nodeId)).slice(-limit)
}

/** 调试条的字段串：k=v k=v */
export const fmtFields = (e) =>
  Object.entries(e.f)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')

/** 相对时间（本页加载起算），mm:ss.mmm */
export const fmtAt = (ms) => {
  const s = Math.floor(ms / 1000)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(Math.floor(s / 60))}:${p(s % 60)}.${p(ms % 1000, 3)}`
}
