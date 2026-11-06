#!/usr/bin/env node
/**
 * 输入槽位收拢的冒烟：真的按鼠标拖一遍，量 DOM。
 *
 *   node canvas/tools/foldtest.mjs http://127.0.0.1:8771 canvas/projects/_foldshot
 *
 * 验四件事：
 *   1) 生成节点默认只显示一行「输入」，不铺开九个槽位
 *   2) 手动点开 / 收拢都生效
 *   3) 拖一根媒体线靠近节点时才展开；拖线途中离开节点不会又收回去（否则端口乱跳）
 *   4) 松手后自动收拢，并且落到第一个空槽（摘要变成「已连 1/9」）
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const URL = process.argv[2] || 'http://127.0.0.1:8771'
const OUT = resolve(process.argv[3] || 'canvas/projects/_foldshot').replace(/\\/g, '/')
const PORT = 9600 + (process.pid % 300)
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
  await sleep(400)
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

const G1 = '.react-flow__node[data-id="g1"]'
const V1 = '.react-flow__node[data-id="v1"]'
const slotsOf = (sel) => ev(`document.querySelectorAll('${sel} .slot-in').length`)

try {
  await connect()
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Network.enable')
  await send('Network.setCacheDisabled', { cacheDisabled: true })
  await send('Page.navigate', { url: URL })
  await sleep(2800)

  check('页面加载', (await ev('document.querySelectorAll(".react-flow__node").length')) >= 4)
  await shot('f0-loaded.png')

  // 1) 默认收拢
  check('图片节点默认收拢', await ev(`!!document.querySelector('${G1} .slots-fold')`))
  check('  槽位没铺开', (await slotsOf(G1)) === 0, `${await slotsOf(G1)} 个 .slot-in`)
  check('视频节点默认收拢', await ev(`!!document.querySelector('${V1} .slots-fold')`))
  const foldText = await ev(`document.querySelector('${G1} .sf-n')?.textContent || ''`)
  check('  摘要显示槽位数', /9 个槽位/.test(foldText), `「${foldText}」`)

  // 2) 手动展开 / 收拢（qwen21_edit_multi 是 9 槽 + 自动分配 1 行）
  await click(`${G1} .slots-fold`)
  const opened = await slotsOf(G1)
  check('点开显示全部槽位', opened === 10, `${opened} 行（9 槽 + 自动分配）`)
  await shot('f1-opened.png')
  await click(`${G1} .slots-ft .ghost`)
  check('点收拢回到一行', (await slotsOf(G1)) === 0)

  // 2.5) 本来就不吃图的模板（文生图）：摘要写「参考图」，展开只有探测口
  const T2 = '.react-flow__node[data-id="t2"]'
  const t2fold = await ev(`document.querySelector('${T2} .sf-n')?.textContent || ''`)
  check('无槽模板的摘要写参考图', t2fold === '参考图', `「${t2fold}」`)
  const t2hit = await ev(`(() => {
    const el = document.querySelector('${T2} .slots-fold');
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      hit: hit ? hit.className || hit.tagName : 'null',
      inView: r.top > 40 && r.bottom < window.innerHeight - 30,
    };
  })()`)
  console.log('     t2 收拢行', JSON.stringify(t2hit))
  // 页面 fitView 后节点可能被推到侧栏底下，直接触发 onclick 更可靠
  await ev(`document.querySelector('${T2} .slots-fold').click()`)
  await sleep(400)
  const t2rows = await slotsOf(T2)
  const t2auto = await ev(`document.querySelectorAll('${T2} .slot-in.auto').length`)
  check('  只有探测口，没有自动分配', t2rows === 1 && t2auto === 0, `${t2rows} 行 / ${t2auto} 个自动口`)
  await click(`${T2} .slots-ft .ghost`)

  // 3) 拖线靠近才展开
  const from = await center('.react-flow__node[data-id="m1"] .react-flow__handle.source')
  const rect = await ev(`(() => {
    const r = document.querySelector('${G1}').getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height };
  })()`)
  const target = { x: rect.left + 24, y: rect.top + rect.h * 0.55 }

  await move(from.x, from.y)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 })
  // 先横向走一段，此时离节点还远，不应展开
  for (let i = 1; i <= 6; i++) {
    await move(from.x + ((target.x - from.x) * i * 0.5) / 6, from.y + ((target.y - from.y) * i * 0.5) / 6, 1)
    await sleep(40)
  }
  check('  拖线到半路还没展开', (await slotsOf(G1)) === 0)

  // 再走近节点
  for (let i = 1; i <= 8; i++) {
    await move(
      from.x + (target.x - from.x) * (0.5 + (0.5 * i) / 8),
      from.y + (target.y - from.y) * (0.5 + (0.5 * i) / 8),
      1
    )
    await sleep(45)
  }
  await sleep(320)
  const nearOpen = await slotsOf(G1)
  check('靠近节点自动展开', nearOpen === 10, `${nearOpen} 行`)
  await shot('f2-drag-open.png')

  // 拖线途中离开节点：不能收回去，否则端口位置会跳
  await move(target.x - 260, target.y - 200, 1)
  await sleep(360)
  const stillOpen = await slotsOf(G1)
  check('拖线中离开也不会收', stillOpen === 10, `${stillOpen} 行`)

  // 4) 回到「自动分配」口松手 → 落第一个空槽
  const auto = await center(`${G1} .slot-in.auto .react-flow__handle`)
  await move(auto.x - 60, auto.y, 1)
  await sleep(120)
  await move(auto.x, auto.y, 1)
  await sleep(320)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: auto.x, y: auto.y, button: 'left', clickCount: 1 })
  await sleep(700)

  const afterText = await ev(`document.querySelector('${G1} .sf-n')?.textContent || ''`)
  check('松手后自动收拢', (await slotsOf(G1)) === 0 && (await ev(`!!document.querySelector('${G1} .slots-fold')`)))
  check('落到第一个空槽', /已连 1\/9/.test(afterText), `「${afterText}」`)

  // 收拢态下边必须还在：handle 一被卸载，线就画不出来，看着像断了
  let wires = 0
  for (let i = 0; i < 12; i++) {
    wires = await ev('document.querySelectorAll(".wire-line").length')
    if (wires > 0) break
    await sleep(250)
  }
  check('收拢态连线还在', wires === 1, `${wires} 条`)
  await shot('f3-after-drop.png')

  // 5) 展开确认落的是 image_1
  await click(`${G1} .slots-fold`)
  const firstFilled = await ev(`[...document.querySelectorAll('${G1} .slot-in')]
    .map((r) => r.textContent.replace(/\\s+/g, ' ').trim())`)
  check('接在第一个槽上', /已连接/.test(firstFilled[1] || ''), `第 1 行「${firstFilled[1]}」`)
  await shot('f4-reopened.png')
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
