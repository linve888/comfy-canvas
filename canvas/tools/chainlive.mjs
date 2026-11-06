#!/usr/bin/env node
/**
 * 整链实跑验证：真点界面、真调 ComfyUI，验两件事 ——
 *   1) 上游没跑完之前，下游不会被提交；
 *   2) 下游拿到的输入，是上游这一次的新产物，不是上一次的旧图。
 *
 *   node canvas/tools/chainlive.mjs http://127.0.0.1:8772
 *
 * 会占 GPU 一两分钟，别对着用户画布跑，用临时实例 + 专用 project 文件。
 */
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'

const URL = process.argv[2] || 'http://127.0.0.1:8772'
const OUT = resolve(process.argv[3] || 'canvas/projects/_chainshot').replace(/\\/g, '/')
const PORT = 9500 + (process.pid % 300)
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--window-size=1500,940',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    `--user-data-dir=${OUT}/_cp`,
    'about:blank',
  ],
  { stdio: 'ignore' }
)

let ws
let seq = 0
const pending = new Map()

const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq
    pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })

const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result?.value
}

const api = async (p) => (await fetch(URL + p)).json()

/**
 * 每次开跑前把画布重置成「两节都没产物」的两节链。
 *
 * 节点 id 必须每次不一样：画布加载后会按 nodeId 从任务列表里把上次的产物找回来，
 * 复用 id 的话新画布一打开就带着旧图，计划立刻变成「跳过上游」。
 */
const RUN = Date.now().toString(36)
const A = `a-${RUN}`
const B = `b-${RUN}`

const FIXTURE = {
  nodes: [
    {
      id: A,
      type: 'imagegen',
      position: { x: 0, y: 60 },
      data: {
        template: 'z_image_t2i',
        params: { prompt: '空荡的走廊，尽头一扇不锈钢门，冷白顶灯，地面反光，写实电影质感', aspect: '1:1 (Square)', megapixels: 0.4, batch: 1, seed: 123456 },
        status: 'idle', outputs: [], history: [], error: '',
      },
    },
    {
      id: B,
      type: 'imagegen',
      position: { x: 420, y: 60 },
      data: {
        template: 'qwen21_edit_multi',
        params: { prompt: '把画面调成冷蓝色夜景色调，走廊尽头的门缝透出暖黄灯光，地面反光更明显', aspect: '1:1 (Square)', megapixels: 0.4, resolution: 1024, seed: 777 },
        status: 'idle', outputs: [], history: [], error: '',
      },
    },
  ],
  edges: [{ id: `e-${RUN}`, source: A, sourceHandle: 'out', target: B, targetHandle: 'in:image_1', type: 'wire' }],
  viewport: { x: 0, y: 0, zoom: 1 },
}

async function resetGraph() {
  const r = await fetch(URL + '/api/graph', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(FIXTURE),
  })
  if (!r.ok) throw new Error('重置画布失败 ' + r.status)
}

async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((res, rej) => {
          ws.onopen = res
          ws.onerror = rej
        })
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data)
          if (m.id && pending.has(m.id)) {
            pending.get(m.id)(m)
            pending.delete(m.id)
          }
        }
        return
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(200)
  }
  throw new Error('连不上调试端口')
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

try {
  await connect()
  await send('Page.enable')
  await send('Network.enable')
  // 同一个 profile 会留 HTTP 缓存，上一轮的画布会被当成本轮的初始状态
  await send('Network.setCacheDisabled', { cacheDisabled: true })
  await resetGraph()
  await send('Page.navigate', { url: URL })
  await sleep(2600)

  // 1) 打开计划：应该是 2 步（两个节点都没产物）
  const opened = await ev(
    `(() => { const b = document.querySelector('.react-flow__node[data-id="${B}"] .actions button[title^="整链"]'); if (!b) return false; b.click(); return true })()`
  )
  await sleep(400)
  const steps = await ev('document.querySelectorAll(".chain-list li:not(.chain-empty)").length')
  const domN = await ev('document.querySelectorAll(".react-flow__node").length')
  const domE = await ev('document.querySelectorAll(".wire-line").length')
  const items = await ev('[...document.querySelectorAll(".chain-list li")].map(li => li.textContent.trim()).join(" | ") || "(空)"')
  const g = await api('/api/graph')
  console.log(`     DOM ${domN} 节点 / ${domE} 线 · 计划项：${items}`)
  console.log('     后端图：', JSON.stringify((g.nodes || []).map((n) => ({ id: n.id, tpl: n.data?.template, out: (n.data?.outputs || []).length }))))
  check('计划里两节都在', opened && steps === 2, `${steps} 步`)
  if (process.env.DRY) {
    console.log('DRY：只验证计划，不真跑')
    process.exit(0)
  }

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const fs = await import('node:fs')
  fs.writeFileSync(join(OUT, 'plan.png'), Buffer.from(shot.data, 'base64'))

  // 2) 开跑。注意 before 必须在开跑「之前」取，
  //    否则第一个任务已经在列表里了，后面按 before 过滤就永远只看到 n-1 个
  const before = await api('/api/jobs?limit=20')
  await ev(`document.querySelector('.chain-modal .modal-ft button.primary').click()`)
  await sleep(1000)
  const startedAt = Date.now()

  // 3) 盯进度：同时记录「有没有出现第二个 running/queued」
  let maxConcurrent = 0
  let chip = ''
  let done = false
  for (let i = 0; i < 300; i++) {
    await sleep(1500)
    const d = await api('/api/jobs?limit=20')
    const live = d.jobs.filter((j) => j.status === 'queued' || j.status === 'running')
    maxConcurrent = Math.max(maxConcurrent, live.length)
    chip = (await ev('document.querySelector(".chain-chip")?.textContent || ""')).trim()
    const mine = d.jobs.filter((j) => !before.jobs.some((b) => b.id === j.id))
    if (mine.length >= 2 && mine.every((j) => ['done', 'error', 'canceled'].includes(j.status))) {
      done = true
      break
    }
    if (mine.some((j) => j.status === 'error' || j.status === 'canceled')) {
      done = true
      break
    }
  }
  const secs = Math.round((Date.now() - startedAt) / 1000)
  console.log(`     跑了 ${secs}s，过程中最多 ${maxConcurrent} 个任务同时在队列里`)

  const after = await api('/api/jobs?limit=20')
  const mine = after.jobs
    .filter((j) => !before.jobs.some((b) => b.id === j.id))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  check('两个节点都跑完了', done && mine.length === 2 && mine.every((j) => j.status === 'done'), mine.map((j) => j.status).join(' / '))

  if (mine.length === 2) {
    const [first, second] = mine
    const firstOut = first.outputs?.[0]?.assetId || ''
    const secondIn = second.inputs?.image_1 || ''
    check('下游拿到上游这次的新图', !!firstOut && secondIn === firstOut, `${secondIn || '(空)'} vs ${firstOut}`)
    check('两个节点是排队跑的，不是一把全提交', maxConcurrent <= 1, `并发 ${maxConcurrent}`)
  }

  const shot2 = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(join(OUT, 'done.png'), Buffer.from(shot2.data, 'base64'))
  console.log(`     期间进度条：${chip || '(空)'}`)
} catch (e) {
  console.error('实跑失败：', e.message)
  results.push({ name: 'harness', ok: false })
} finally {
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过`)
  try {
    ws?.close()
  } catch {}
  chrome.kill()
  process.exit(bad.length ? 1 : 0)
}
