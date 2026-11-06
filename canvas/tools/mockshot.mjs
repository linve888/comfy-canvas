#!/usr/bin/env node
/**
 * 拍样张页（dist/_mock.html）：文本节点 / 通用模板节点的新排版单看一张，
 * 不碰项目数据（这页不是画布，没有节点、没有保存）。
 *
 * 用法：node canvas/tools/mockshot.mjs http://127.0.0.1:8770/_mock.html
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const URL = process.argv[2] || 'http://127.0.0.1:8770/_mock.html'
const OUT = resolve('canvas/projects/_uishot').replace(/\\/g, '/')
const PORT = 9800 + (process.pid % 150)
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const chrome = spawn(
  CHROME,
  ['--headless=new', `--remote-debugging-port=${PORT}`, '--window-size=1400,1100', '--disable-gpu',
   '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
   `--user-data-dir=${OUT}/_chrome-mock-${process.pid}`, 'about:blank'],
  { stdio: ['ignore', 'pipe', 'pipe'] }
)
const log = []
chrome.stderr.on('data', (d) => log.push(String(d)))
let ws, seq = 0
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

try {
  await connect()
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.navigate', { url: URL + (URL.includes('?') ? '&' : '?') + 'v=' + Date.now() })
  await sleep(1200)

  // 量一下有没有东西溢出去 / 叠加：两节点的宽高与关键块的位置
  const info = await ev(`(() => {
    const out = [];
    document.querySelectorAll('.node').forEach((n) => {
      const r = n.getBoundingClientRect();
      const card = n.querySelector('.tn-panel') || n.querySelector('.gstage-box') ||
                   n.querySelector('.preview') || n.querySelector('.shell') || n;
      const c = card.getBoundingClientRect();
      const o = { w: Math.round(r.width), h: Math.round(r.height), parts: {}, handles: [] };
      for (const sel of ['.tn-panel', '.gstage', '.gcomposer', '.tn-slots', '.tn-nums', '.gc-bar']) {
        const e = n.querySelector(sel);
        if (!e) continue;
        const q = e.getBoundingClientRect();
        o.parts[sel] = [Math.round(q.width), Math.round(q.height)];
      }
      // 每个连线口离「卡左沿」多远：0 表示正好压在框线上
      n.querySelectorAll('.react-flow__handle').forEach((h) => {
        const q = h.getBoundingClientRect();
        if (!q.width) return; // 隐藏的占位口不量
        o.handles.push(Math.round(q.left - c.left));
      });
      out.push(o);
    });
    return out;
  })()`)
  console.log(JSON.stringify(info))

  // 临时排查用：把任意表达式的结果打出来（node canvas/tools/mockshot.mjs <url> <shot> "<expr>"）
  if (process.argv[4]) console.log('eval:', JSON.stringify(await ev(process.argv[4]), null, 1))
  // 拍照前先点一下（用来拍展开态：菜单、浮层）
  if (process.argv[5]) {
    await ev(process.argv[5])
    await sleep(500)
  }

  const clip = await ev(`(() => {
    const w = document.querySelector('.mock-wrap');
    if (w) {
      const r = w.getBoundingClientRect();
      return { x: 0, y: 0, width: Math.round(r.width), height: Math.round(r.height), scale: 1.6 };
    }
    // 画布页：整屏拍一张
    return { x: 0, y: 0, width: innerWidth, height: innerHeight, scale: 1 };
  })()`)
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    clip,
    captureBeyondViewport: true,
  })
  writeFileSync(join(OUT, process.argv[3] || '30-mock-nodes.png'), Buffer.from(shot.data, 'base64'))
  console.log('  →', process.argv[3] || '30-mock-nodes.png')
} catch (e) {
  console.error('失败：', e.message)
  process.exitCode = 1
} finally {
  try { ws?.close() } catch {}
  chrome.kill()
}
