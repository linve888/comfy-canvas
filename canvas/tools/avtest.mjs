#!/usr/bin/env node
/**
 * H3 音视频槽位的冒烟：图片 9 / 视频 3 / 音频 3 三组要分开认，线也不能串组。
 *
 *   node canvas/tools/avtest.mjs http://127.0.0.1:8771 canvas/projects/_avshot
 *
 * 验五件事：
 *   1) 收拢行把三组数量都写出来（9图 · 3视 · 3音）
 *   2) 展开后正好三组，行数 = 自动分配 1 + 15
 *   3) 视频线拖到图片槽上会被拒（类型对不上）
 *   4) 视频线落到「自动分配」会进 ref_video_0，不是 ref_image_0
 *   5) 音频线同理进 ref_audio_0
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const URL = process.argv[2] || 'http://127.0.0.1:8771'
const OUT = resolve(process.argv[3] || 'canvas/projects/_avshot').replace(/\\/g, '/')
const PORT = 9800 + (process.pid % 150)
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const log = []
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--window-size=1500,940',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${OUT}/_chromeprofile`,
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] }
)
chrome.stderr.on('data', (d) => log.push(d.toString()))
chrome.stdout.on('data', (d) => log.push(d.toString()))

let ws
let seq = 0
const pending = new Map()

async function connect() {
  for (let i = 0; i < 60; i++) {
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
  throw new Error('连不上 Chrome 调试端口\n' + log.join('').slice(-600))
}

const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq
    pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })

const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.result?.description || ''))
  return r.result?.value
}

const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64'))
}

async function center(sel) {
  const box = await ev(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`)
  if (!box) throw new Error(`找不到元素：${sel}`)
  return box
}

const move = (x, y, buttons = 0) =>
  send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: buttons ? 'left' : 'none', buttons })

async function click(sel) {
  const p = await center(sel)
  await move(p.x, p.y)
  await sleep(60)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  await sleep(420)
}

/** 从一个节点的输出口拖到另一个元素上，中间分步移动 */
async function dragTo(fromSel, toPoint, steps = 14) {
  const from = await center(fromSel)
  await move(from.x, from.y)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 })
  for (let i = 1; i <= steps; i++) {
    await move(from.x + ((toPoint.x - from.x) * i) / steps, from.y + ((toPoint.y - from.y) * i) / steps, 1)
    await sleep(30)
  }
  await sleep(200)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toPoint.x, y: toPoint.y, button: 'left', clickCount: 1 })
  await sleep(600)
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

const G1 = '.react-flow__node[data-id="g1"]'
const slotsOf = () => ev(`document.querySelectorAll('${G1} .slot-in').length`)
const foldText = () => ev(`document.querySelector('${G1} .sf-n')?.textContent || ''`)
const wireCount = () => ev(`document.querySelectorAll('.wire-line').length`)
/** 拖线一结束节点就会收拢，每次要在展开态下操作前先点开 */
const ensureOpen = async () => {
  if (await ev(`!!document.querySelector('${G1} .slot-in')`)) return
  await ev(`document.querySelector('${G1} .slots-fold').click()`)
  await sleep(450)
}

try {
  await connect()
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Network.enable')
  await send('Network.setCacheDisabled', { cacheDisabled: true })
  await send('Page.navigate', { url: URL })
  await sleep(2800)

  check('页面加载', (await ev('document.querySelectorAll(".react-flow__node").length')) === 4)
  const t0 = await foldText()
  check('收拢行写出三组数量', /9图 · 3视 · 3音/.test(t0), `「${t0}」`)
  await shot('a0-folded.png')

  // 展开
  await ev(`document.querySelector('${G1} .slots-fold').click()`)
  await sleep(500)
  const groups = await ev(`[...document.querySelectorAll('${G1} .slot-group-hd')].map(e => e.textContent.trim())`)
  const rows = await slotsOf()
  check('展开是三个分组', groups.length === 3, groups.join(' | '))
  check('  行数 = 自动分配 + 15', rows === 16, `${rows} 行`)
  await shot('a1-opened.png')

  const before = await wireCount()

  // 视频线 → 图片槽：应被拒
  const imgHandle = await center(`${G1} .slot-group.g-image .slot-in:nth-child(3) .react-flow__handle`)
  await dragTo('.react-flow__node[data-id="mv"] .react-flow__handle.source', imgHandle)
  const afterReject = await wireCount()
  const toast = await ev(`document.querySelector('.toast')?.textContent || ''`)
  check('视频线接不进图片槽', afterReject === before, `${before} → ${afterReject}${toast ? ' · ' + toast : ''}`)
  await shot('a2-rejected.png')

  // 视频线 → 自动分配：应落 ref_video_0
  await ensureOpen()
  const autoHandle = await center(`${G1} .slot-in.auto .react-flow__handle`)
  await dragTo('.react-flow__node[data-id="mv"] .react-flow__handle.source', autoHandle)
  const afterVideo = await wireCount()
  check('视频线落到视频槽', afterVideo === before + 1, `${before} → ${afterVideo}`)

  // 拖线一松手就自动收拢了，这里直接读摘要
  await sleep(300)
  const t1 = await foldText()
  check('  收拢后只涨视频组', /图 0\/9 · 视 1\/3 · 音 0\/3/.test(t1), `「${t1}」`)

  // 音频线 → 收拢态的自动口
  const auto2 = await center(`${G1} .slots-fold .react-flow__handle`)
  await dragTo('.react-flow__node[data-id="ma"] .react-flow__handle.source', auto2)
  const t2 = await foldText()
  check('音频线落到音频槽', /图 0\/9 · 视 1\/3 · 音 1\/3/.test(t2), `「${t2}」`)
  check('  两条线都在', (await wireCount()) === before + 2, `${await wireCount()} 条`)
  await shot('a3-both.png')

  // 展开确认具体槽位
  await ev(`document.querySelector('${G1} .slots-fold').click()`)
  await sleep(500)
  const filled = await ev(`[...document.querySelectorAll('${G1} .slot-in')]
    .filter((r) => /已连接/.test(r.textContent))
    .map((r) => r.textContent.replace(/\\s+/g, ' ').trim())`)
  check('落在 ref_video_0 / ref_audio_0', filled.length === 2 && filled.some((x) => /参考视频 1/.test(x)) && filled.some((x) => /参考音频 1/.test(x)), filled.join(' | '))
  await shot('a4-filled.png')
} catch (e) {
  console.error('ERROR', e.message)
  results.push({ name: '脚本执行', ok: false })
} finally {
  const ok = results.filter((r) => r.ok).length
  console.log(`\n${ok}/${results.length} 通过`)
  try {
    await send('Browser.close')
  } catch {
    /* ignore */
  }
  chrome.kill()
  process.exit(ok === results.length ? 0 : 1)
}
