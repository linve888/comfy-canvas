#!/usr/bin/env node
/**
 * 画布 UI 冒烟：用 Chrome DevTools Protocol 真点界面，不靠人眼。
 *
 * 用法：
 *   node canvas/tools/uitest.mjs http://127.0.0.1:8771   # 截图落到 canvas/projects/_smoke/
 *
 * 为什么要有这个：画布是本地单页应用，改了节点交互只能靠截图猜。
 * 这里直接量 DOM（节点数、弹窗是否出现）+ 截图，改完跑一遍就知道有没有砸。
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const URL = process.argv[2] || 'http://127.0.0.1:8771'
const OUT = resolve(process.argv[3] || 'canvas/projects/_smoke').replace(/\\/g, '/')
const PORT = 9400 + (process.pid % 400)
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const chromeLog = []
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
    '--disable-extensions',
    `--user-data-dir=${OUT}/_chromeprofile`,
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] }
)
chrome.stderr.on('data', (d) => chromeLog.push(d.toString()))
chrome.stdout.on('data', (d) => chromeLog.push(d.toString()))

let ws
let seq = 0
const pending = new Map()

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await r.json()
      const page = list.find((t) => t.type === 'page')
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((res, rej) => {
          ws.onopen = res
          ws.onerror = rej
        })
        ws.onmessage = (ev) => {
          const m = JSON.parse(ev.data)
          if (m.id && pending.has(m.id)) {
            pending.get(m.id)(m)
            pending.delete(m.id)
          }
        }
        return
      }
    } catch (e) {
      if (i === 59) chromeLog.push('\nfetch: ' + e.message)
    }
    await sleep(200)
  }
  throw new Error('连不上 Chrome 调试端口\n' + chromeLog.join('').slice(-800))
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
  return name
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

async function moveTo(sel) {
  const p = await center(sel)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' })
  await sleep(120)
  return p
}

async function click(sel, button = 'left') {
  const p = await center(sel)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' })
  await sleep(60)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button, clickCount: 1 })
  await sleep(450)
}

async function key(k, code = k) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: k === 'Escape' ? 27 : 0 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code })
  await sleep(300)
}

/** 按住 left 从 from 拖到 to，中间给几步 mouseMoved，否则 React Flow 认不出是拖线 */
async function drag(from, to, steps = 10) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 })
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps
    const y = from.y + ((to.y - from.y) * i) / steps
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
    await sleep(28)
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 })
  await sleep(420)
}


/** 给受控输入框赋值：直接改 value 不会触发 React，得走原生 setter 再派发 input */
async function setVal(sel, val) {
  const ok = await ev(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(val))});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`)
  await sleep(250)
  return ok
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

try {
  await connect()
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.navigate', { url: URL })
  await sleep(2600)
  check('页面加载', (await ev('document.querySelectorAll(".react-flow__node").length')) > 0)

  const nodesAtStart = await ev('document.querySelectorAll(".node").length')
  check('节点渲染', nodesAtStart >= 3, `${nodesAtStart} 个`)

  // 1) 文本节点 → 提示词：节点里应显示"上游文本生效"
  const upTag = await ev('!!document.querySelector(".prompt-from-up")')
  check('文本节点连到提示词', upTag)

  // 2) 悬停出现工具条
  await moveTo('.node.gen.image')
  const toolsVisible = await ev(`(() => {
    const t = document.querySelector('.node.gen.image .node-tools');
    return !!t && getComputedStyle(t).display !== 'none';
  })()`)
  check('悬停显示节点工具条', toolsVisible)

  // 3) 全屏看图
  await click('.node.gen.image .preview')
  const lb = await ev('!!document.querySelector(".lightbox")')
  check('全屏查看打开', lb)
  await shot('t1-lightbox.png')
  await key('Escape')
  check('Esc 关闭全屏', !(await ev('!!document.querySelector(".lightbox")')))

  // 4) 宫格切分：开弹窗 → 切成 9 张 → 节点数 +9
  await moveTo('.node.gen.image')
  await click('.node.gen.image .node-tools .nt[title="宫格切分"]')
  check('切分弹窗打开', await ev('!!document.querySelector(".modal")'))
  await shot('t2-split.png')
  await click('.modal-ft .primary')
  await sleep(2500)
  const nodesAfter = await ev('document.querySelectorAll(".node").length')
  check('切出 9 个素材节点', nodesAfter === nodesAtStart + 9, `${nodesAtStart} → ${nodesAfter}`)
  await shot('t3-split-done.png')

  // 5) 右键菜单（点画布空白处：取 pane 左下角，避开节点）
  const p = await ev(`(() => {
    const r = document.querySelector('.react-flow__pane').getBoundingClientRect();
    return { x: r.left + 140, y: r.bottom - 140 };
  })()`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'right', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'right', clickCount: 1 })
  await sleep(400)
  check('右键菜单', await ev('!!document.querySelector(".ctx-menu")'), `@${Math.round(p.x)},${Math.round(p.y)}`)
  await shot('t4-menu.png')
  await key('Escape')

  // 6) 图生图工具（点一下应该开始跑：状态变排队/生成）
  await moveTo('.node.gen.image')
  const chip = await ev('document.querySelectorAll(".node.gen.image .toolrow .chip").length')
  check('图生图工具行', chip >= 2, `${chip} 个按钮`)

  // 6.5) 整链：计划里该跑几个、跳过几个
  // 注意：切分出来的九个格子会盖在视频节点上，鼠标点不一定打得中按钮，
  // 这里直接触发 onclick —— 测的是整链逻辑，不是命中测试
  const openChainUI = async () => {
    const ok = await ev(
      `(() => { const b = document.querySelector('.node.gen.video .actions button[title^="整链"]'); if (!b) return false; b.click(); return true })()`
    )
    await sleep(400)
    return ok
  }
  const opened1 = await openChainUI()
  const planOpen = await ev('!!document.querySelector(".chain-modal")')
  console.log('     整链按钮触发', opened1, '| 弹窗', planOpen)
  const steps1 = await ev('document.querySelectorAll(".chain-list li:not(.chain-empty)").length')
  const skip1 = await ev('document.querySelector(".chain-skip")?.textContent || ""')
  check(
    '整链计划弹窗',
    planOpen && steps1 === 1,
    `${steps1} 步 · 跳过「${skip1 ? skip1.replace(/^跳过[^（]*：/, '').trim() : '无'}」`
  )
  await shot('t8-chain-plan.png')
  await click('.chain-modal .modal-ft button:not(.primary)')
  check('整链计划可取消', !(await ev('!!document.querySelector(".chain-modal")')))

  // 改一下上游节点的参数 → 它变脏 → 计划里应该多出一步
  const touched = await setVal('.node.gen.image .row2 input[type=number]', '512')
  await openChainUI()
  const steps2 = await ev('document.querySelectorAll(".chain-list li:not(.chain-empty)").length')
  check('上游改过参数就一起跑', touched && steps2 === 2, `${steps2} 步`)
  await shot('t9-chain-plan-2.png')
  await click('.chain-modal .modal-ft button:not(.primary)')

  // 7) 连线：条数对得上，且按流向分了色
  const edgeInfo = await ev(`(() => {
    const lines = [...document.querySelectorAll('.wire-line')];
    const colors = new Set(lines.map(l => getComputedStyle(l).stroke));
    return { n: lines.length, colors: [...colors] };
  })()`)
  check('连线渲染', edgeInfo.n === 4, `${edgeInfo.n} 条`)
  check('连线按流向分色', edgeInfo.colors.length >= 2, edgeInfo.colors.join(' / '))

  // 8) 悬停连线 → 中点浮出槽位名
  let hoveredAt = -1
  for (let i = 0; i < edgeInfo.n; i++) {
    const mp = await ev(`(() => {
      const el = document.querySelectorAll('.wire-hit')[${i}];
      if (!el) return null;
      const p = el.getPointAtLength(el.getTotalLength() * 0.5);
      const m = el.getScreenCTM();
      return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f };
    })()`)
    if (!mp) continue
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mp.x, y: mp.y, button: 'none' })
    await sleep(220)
    if (await ev('!!document.querySelector(".wire-pill")')) {
      hoveredAt = i
      break
    }
  }
  const pillText = await ev('document.querySelector(".wire-pill .wire-lb")?.textContent || ""')
  check('悬停连线显示槽位名', hoveredAt >= 0 && !!pillText, `第 ${hoveredAt + 1} 条 → ${pillText}`)
  const pillRect = await ev(`(() => {
    const el = document.querySelector('.wire-pill');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  })()`)
  if (pillRect) console.log(`     牌子位置 ${JSON.stringify(pillRect)}`)
  await shot('t5-wire-pill.png')

  // 9) 从输出口拖到空白处松手 → 就地建节点的菜单
  const src = await center('.react-flow__node-imagegen .react-flow__handle.source')
  const blank = await ev(`(() => {
    const pane = document.querySelector('.react-flow__pane').getBoundingClientRect();
    const boxes = [...document.querySelectorAll('.react-flow__node')].map(n => n.getBoundingClientRect());
    for (let y = pane.top + 60; y < pane.bottom - 60; y += 24) {
      for (let x = pane.left + 60; x < pane.right - 60; x += 24) {
        if (!boxes.some(r => x > r.left - 14 && x < r.right + 14 && y > r.top - 14 && y < r.bottom + 14)) return { x, y };
      }
    }
    return null;
  })()`)
  if (blank) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: src.x, y: src.y, button: 'none' })
    await sleep(80)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: src.x, y: src.y, button: 'left', clickCount: 1 })
    await sleep(80)
    let started = false
    const steps = 10
    for (let i = 1; i <= steps; i++) {
      const x = src.x + ((blank.x - src.x) * i) / steps
      const y = src.y + ((blank.y - src.y) * i) / steps
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
      await sleep(30)
      if (i === 3) started = await ev('!!document.querySelector(".react-flow__connection")')
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: blank.x, y: blank.y, button: 'left', clickCount: 1 })
    await sleep(450)
    const menuTitle = await ev('document.querySelector(".ctx-menu .ctx-title")?.textContent || ""')
    check(
      '拖线到空白处可建节点',
      /接给谁|谁供给/.test(menuTitle),
      `拉起了连接=${started} 落点=${JSON.stringify(blank)} 「${menuTitle}」`
    )
    await shot('t6-drop-menu.png')
    await key('Escape')
  } else {
    check('拖线到空白处可建节点', false, '找不到空白落点')
  }

  // 10) 选中连线 → 出现可拖动的接头；再点牌子上的 ✕ 断开
  if (hoveredAt >= 0) {
    const before = await ev('document.querySelectorAll(".wire-line").length')
    const mp = await ev(`(() => {
      const el = document.querySelectorAll('.wire-hit')[${hoveredAt}];
      if (!el) return null;
      const p = el.getPointAtLength(el.getTotalLength() * 0.5);
      const m = el.getScreenCTM();
      return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f };
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mp.x, y: mp.y, button: 'none' })
    await sleep(200)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mp.x, y: mp.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mp.x, y: mp.y, button: 'left', clickCount: 1 })
    await sleep(350)
    const upd = await ev('document.querySelectorAll(".react-flow__edgeupdater").length')
    check('选中连线可拖线头改接', upd >= 1, `${upd} 个接头`)
    await shot('t7-wire-selected.png')

    await click('.wire-pill .wire-x')
    const after = await ev('document.querySelectorAll(".wire-line").length')
    check('一键断开连线', after === before - 1, `${before} → ${after}`)
  }
} catch (e) {
  console.error('测试失败：', e.message)
  results.push({ name: 'harness', ok: false, detail: e.message })
} finally {
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过`)
  try {
    ws?.close()
  } catch {}
  chrome.kill()
  process.exit(bad.length ? 1 : 0)
}
