#!/usr/bin/env node
/**
 * 探针：从生成节点的右侧「＋」按下拖动时，React Flow 到底从哪个 Handle 起的线。
 * 只读（拖到空白处松手），但会打印前后边数，用来查「拖一下莫名多出一条线」。
 * 用法：node canvas/tools/dragprobe.mjs http://127.0.0.1:8770
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const URL = process.argv[2] || 'http://127.0.0.1:8770'
const OUT = resolve('canvas/projects/_uishot').replace(/\\/g, '/')
const PORT = 9800 + (process.pid % 150)
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const chrome = spawn(
  CHROME,
  ['--headless=new', `--remote-debugging-port=${PORT}`, '--window-size=1500,940', '--disable-gpu',
   '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
   `--user-data-dir=${OUT}/_chrome-probe-${process.pid}`, 'about:blank'],
  { stdio: ['ignore', 'pipe', 'pipe'] }
)
const log = []
chrome.stderr.on('data', (d) => log.push(String(d)))

let ws
let seq = 0
const pending = new Map()

async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data)
          if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
        }
        return
      }
    } catch (e) { if (i === 79) log.push('fetch: ' + e.message) }
    await sleep(200)
  }
  throw new Error('连不上调试端口\n' + log.join('').slice(-400))
}
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

const edgeIds = () =>
  ev(`[...document.querySelectorAll('.react-flow__edge')].map(e => e.getAttribute('data-testid')).join(',')`)

try {
  await connect()
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.navigate', { url: URL + (URL.includes('?') ? '&' : '?') + 'v=' + Date.now() })
  await sleep(3200)

  const before = await edgeIds()
  console.log('拖动前边：', before)

  const pt = await ev(`(() => {
    const list = [...document.querySelectorAll('.node.gen')];
    let best = null, bestArea = 0;
    list.forEach((el) => {
      const r = el.getBoundingClientRect();
      const a = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) *
                Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      if (a > bestArea) { bestArea = a; best = el; }
    });
    const b = best.querySelector('.side-add.right');
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
             nodeId: best.getAttribute('data-id') };
  })()`)
  console.log('按下位置：', pt)

  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none' })
  await sleep(150)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, buttons: 1 })
  await sleep(150)
  console.log('按下后 connectingfrom：', await ev(`(() => {
    const hs = [...document.querySelectorAll('.react-flow__handle.connectingfrom')];
    return hs.length ? hs.map(h => (h.closest('.node')?.getAttribute('data-id') || '?') + '/' + (h.getAttribute('data-handleid') || h.id || '-')).join(', ') : '无';
  })()`))

  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x + 45, y: pt.y + 8, button: 'left', buttons: 1 })
  await sleep(150)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x + 100, y: pt.y + 26, button: 'left', buttons: 1 })
  await sleep(250)
  console.log('拖拽中 connectingfrom：', await ev(`(() => {
    const hs = [...document.querySelectorAll('.react-flow__handle.connectingfrom')];
    return hs.length ? hs.map(h => (h.closest('.node')?.getAttribute('data-id') || '?')).join(', ') : '无';
  })()`))
  console.log('拖拽中有虚线：', await ev(`!!document.querySelector('.react-flow__connectionline, .react-flow__connection-path')`))

  const blank = await ev(`(() => {
    const r = document.querySelector('.react-flow__pane').getBoundingClientRect();
    return { x: Math.round(r.left + 30), y: Math.round(r.bottom - 40) };
  })()`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: blank.x, y: blank.y, button: 'left', buttons: 1 })
  await sleep(200)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: blank.x, y: blank.y, button: 'left', clickCount: 1, buttons: 0 })
  await sleep(600)
  console.log('松手后边：', await edgeIds())
  console.log('新增：', (await edgeIds()) === before ? '没有（对）' : '多了（不对）')
  // 再等一会儿，看防抖保存有没有把东西写进项目
  await sleep(1500)
  console.log('静置后边：', await edgeIds())
} catch (e) {
  console.error('失败：', e.message)
  process.exitCode = 1
} finally {
  try { ws?.close() } catch {}
  chrome.kill()
}
