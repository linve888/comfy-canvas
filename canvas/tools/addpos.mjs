#!/usr/bin/env node
/**
 * 只读核对：加号回到 -44px 之后
 *   1. 加号离节点边缘多远（应当 22px 空档）
 *   2. Handle 的箱体是否还在原处（中心在节点外侧 13px，线的端点不动）
 *   3. 在「加号」上按下 + 拖动，能不能把连线拉起来（转发 mousedown 是否生效）
 * 不点节点、不打字、不建连线（拖到空白处松手），不写项目文件。
 *
 * 用法：node canvas/tools/addpos.mjs http://127.0.0.1:8770
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const URL = process.argv[2] || 'http://127.0.0.1:8770'
const OUT = resolve('canvas/projects/_uishot').replace(/\\/g, '/')
const PORT = 9800 + (process.pid % 150)
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

mkdirSync(OUT, { recursive: true })
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
    '--no-default-browser-check',
    '--disable-extensions',
    `--user-data-dir=${OUT}/_chrome-add-${process.pid}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] }
)
const log = []
chrome.stderr.on('data', (d) => log.push(String(d)))

let ws
let seq = 0
const pending = new Map()
const errors = []

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
          if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.text || 'exception')
          if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
            errors.push(m.params.args?.map((a) => a.value ?? a.description).join(' '))
          }
          if (m.id && pending.has(m.id)) {
            pending.get(m.id)(m)
            pending.delete(m.id)
          }
        }
        return
      }
    } catch (e) {
      if (i === 79) log.push('fetch: ' + e.message)
    }
    await sleep(200)
  }
  throw new Error('连不上调试端口\n' + log.join('').slice(-600))
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

async function shot(name, clip) {
  const params = { format: 'png' }
  if (clip) {
    params.clip = { ...clip, scale: 2 }
    params.captureBeyondViewport = true
  }
  const r = await send('Page.captureScreenshot', params)
  writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64'))
  console.log('  →', name)
}

// 挑一个面积最大的可见生成节点
const pick = () =>
  ev(`(() => {
    const list = [...document.querySelectorAll('.node.gen')];
    let best = -1, bestArea = 0;
    list.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
      const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
      const a = Math.max(0, w) * Math.max(0, h);
      if (a > bestArea) { bestArea = a; best = i; }
    });
    return bestArea > 8000 ? best : -1;
  })()`)

const measure = (idx) =>
  ev(`(() => {
    const el = [...document.querySelectorAll('.node.gen')][${idx}];
    if (!el) return null;
    // 加号的定位基准是画面框，不是节点根：竖屏节点根比画面宽得多，拿节点根量会得出反的结论
    const card = el.querySelector('.gstage-box') || el.querySelector('.preview') || el;
    const c = card.getBoundingClientRect();
    const n = el.getBoundingClientRect();
    const out = { node: { w: Math.round(n.width) }, card: { w: Math.round(c.width) }, sides: {} };
    for (const side of ['left', 'right']) {
      const b = el.querySelector('.side-add.' + side);
      if (!b) continue;
      const r = b.getBoundingClientRect();
      const h = b.querySelector('.react-flow__handle')?.getBoundingClientRect();
      const isL = side === 'left';
      out.sides[side] = {
        gap: Math.round(isL ? c.left - r.right : r.left - c.right),
        // React Flow 取的是箱体的边：Left 取 left 边、Right 取 right 边。这里量这个边到框线的距离
        anchor: h ? Math.round((isL ? h.left : h.right) - (isL ? c.left : c.right)) : null,
        handleW: h ? Math.round(h.width) : null,
        btnVisible: getComputedStyle(b).opacity,
      };
    }
    return out;
  })()`)

// 真正的判据：每条连线两端的坐标，离最近的那条「画面框边线」多远
const edgeEnds = () =>
  ev(`(() => {
    const cards = [];
    document.querySelectorAll('.node').forEach((el) => {
      const c = el.querySelector('.gstage-box') || el.querySelector('.preview') || el;
      const r = c.getBoundingClientRect();
      cards.push({ l: r.left, r: r.right, t: r.top, b: r.bottom });
    });
    const out = [];
    // 线是自定义的 Wire，路径挂在 .wire-line 上（没有 .react-flow__edge-path）
    document.querySelectorAll('.wire-line, .react-flow__edge-path').forEach((path) => {
      const m = path.getScreenCTM();
      const toScreen = (pt) => ({ x: m.a * pt.x + m.c * pt.y + m.e, y: m.b * pt.x + m.d * pt.y + m.f });
      const len = path.getTotalLength();
      [0, len].forEach((at, i) => {
        const p = toScreen(path.getPointAtLength(at));
        let best = 1e9, which = '';
        cards.forEach((c) => {
          if (p.y < c.t - 2 || p.y > c.b + 2) return;
          for (const [name, x] of [['左边线', c.l], ['右边线', c.r]]) {
            const d = Math.abs(p.x - x);
            if (d < best) { best = d; which = name; }
          }
        });
        out.push({ at: i ? '终点' : '起点', dx: Math.round(best * 10) / 10, line: which });
      });
    });
    return out;
  })()`)

try {
  await connect()
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.navigate', { url: URL + (URL.includes('?') ? '&' : '?') + 'v=' + Date.now() })
  await sleep(3200)

  let idx = await pick()
  if (idx < 0) {
    // 画布缩得太小就用节点大纲把第一个生成节点拉到眼前
    await ev(`(() => {
      const b = [...document.querySelectorAll('.dock button')].find((x) => x.title === '节点大纲');
      if (b) b.click();
    })()`)
    await sleep(700)
    await ev(`(() => {
      const items = [...document.querySelectorAll('.ol-item')];
      const it = items.find((el) => el.textContent.includes('生成')) || items[0];
      if (it) it.click();
    })()`)
    await sleep(1000)
    await ev(`document.querySelector('.leftbar .panel-x')?.click()`)
    await sleep(400)
    idx = await pick()
  }
  console.log('生成节点序号：', idx)
  if (idx < 0) throw new Error('没找到可见的生成节点')

  const m = await measure(idx)
  console.log('节点宽：', m.node.w, '· 画面框宽：', m.card.w)
  for (const [side, s] of Object.entries(m.sides)) {
    console.log(`  ${side}: 加号离画面 ${s.gap}px · 端点边到框线 ${s.anchor}px（应为 0）· Handle 宽 ${s.handleW} · 加号透明度 ${s.btnVisible}`)
  }
  const ends = await edgeEnds()
  const worst = ends.reduce((a, e) => Math.max(a, e.dx), 0)
  console.log(`  连线端点 ${ends.length} 个，离最近框线的最大距离 ${worst}px`, worst <= 2 ? '（贴着框，对）' : '（还飘在外面，不对）')

  // 加号的显示时机：平时藏着，靠近节点 / 靠近它自己才亮，走开后过一会儿灭
  const ops = () => ev(`[...document.querySelectorAll('.side-add')].map(b => +getComputedStyle(b).opacity)`)
  const genPt = (sel) =>
    ev(`(() => {
      const el = [...document.querySelectorAll('.node.gen')][${idx}];
      const r = el.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`)
  const move = async (p, wait = 260) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' })
    await sleep(wait)
  }
  const fmt = (a) => a.join(',')

  console.log('  不碰鼠标时：', fmt(await ops()), '（应全 0）')
  await move(await genPt('.gstage'))
  console.log('  鼠标进节点：', fmt(await ops()), '（该节点的两个应为 1）')
  const plusPt = await ev(`(() => {
    const el = [...document.querySelectorAll('.node.gen')][${idx}];
    const r = el.querySelector('.side-add.right').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`)
  await move(plusPt)
  console.log('  鼠标停到加号上：', fmt(await ops()), '（应保持 1）')
  // 亮着的特写：看加号大小、离框多远
  {
    const c = await ev(`(() => {
      const el = [...document.querySelectorAll('.node.gen')][${idx}];
      const n = el.getBoundingClientRect();
      let x = n.left, y = n.top - 30, right = n.right, bottom = n.bottom;
      el.querySelectorAll('.side-add').forEach((b) => {
        const r = b.getBoundingClientRect();
        x = Math.min(x, r.left); right = Math.max(right, r.right);
      });
      const pad = 12;
      return { x: Math.max(0, Math.round(x - pad)), y: Math.max(0, Math.round(y - pad)),
               width: Math.round(right - x + pad * 2), height: Math.round(bottom - y + pad * 2) };
    })()`)
    await shot('22-plus-hover.png', c)
  }
  // 加号尺寸
  console.log('  加号尺寸（屏幕 px）：', await ev(`(() => {
    const el = [...document.querySelectorAll('.node.gen')][${idx}];
    const b = el.querySelector('.side-add.right').getBoundingClientRect();
    return Math.round(b.width) + '×' + Math.round(b.height);
  })()`))
  // 中途那 20 来 px 是画布，node 的 hover 已经断了：靠 .32s 的延迟撑着，不能在这个空档里灭掉
  const gapPt = await ev(`(() => {
    const el = [...document.querySelectorAll('.node.gen')][${idx}];
    const c = el.querySelector('.gstage-box').getBoundingClientRect();
    const b = el.querySelector('.side-add.right').getBoundingClientRect();
    return { x: Math.round((c.right + b.left) / 2), y: Math.round(b.top + b.height / 2) };
  })()`)
  await move(gapPt, 120)
  console.log('  走到中间空档（0.12s）：', fmt(await ops()), '（还是 1，才够得着）')
  const far = await ev(`(() => {
    const r = document.querySelector('.react-flow__pane').getBoundingClientRect();
    return { x: Math.round(r.left + 30), y: Math.round(r.bottom - 40) };
  })()`)
  await move(far, 700)
  console.log('  鼠标走开 0.7s 后：', fmt(await ops()), '（应回到全 0）')

  // 左右两个加号都要能拖出线
  const dragFrom = async (side) => {
    const pt = await ev(`(() => {
      const el = [...document.querySelectorAll('.node.gen')][${idx}];
      const b = el.querySelector('.side-add.${side}');
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`)
    const dir = side === 'right' ? 1 : -1
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none' })
    await sleep(150)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, buttons: 1 })
    await sleep(120)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x + 40 * dir, y: pt.y + 10, button: 'left', buttons: 1 })
    await sleep(120)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x + 90 * dir, y: pt.y + 30, button: 'left', buttons: 1 })
    await sleep(250)
    const dragging = await ev(`!!document.querySelector('.react-flow__connectionline, .react-flow__connection-path')`)
    console.log(`  从${side === 'right' ? '右' : '左'}侧加号拖出连线：`, dragging ? 'ok（拉起来了）' : '没反应（不对）')
    if (side === 'right') await shot('20-drag-from-plus.png')
    // 松在空白处：不成边，不写项目
    const blank = await ev(`(() => {
      const r = document.querySelector('.react-flow__pane').getBoundingClientRect();
      return { x: Math.round(r.left + 30), y: Math.round(r.bottom - 40) };
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: blank.x, y: blank.y, button: 'left', buttons: 1 })
    await sleep(150)
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: blank.x, y: blank.y, button: 'left', clickCount: 1, buttons: 0 })
    await sleep(400)
    console.log('  松手后边数：', await ev(`document.querySelectorAll('.react-flow__edge').length`))
  }
  await dragFrom('right')
  await dragFrom('left')

  // 全页巡检：每个加号离它自己的定位框多远（应当都是 22px 左右，正数=在外侧）
  const audit = await ev(`(() => {
    const rows = [];
    document.querySelectorAll('.node').forEach((el, i) => {
      const kind = el.querySelector('.side-add') ? (el.className.match(/node\\s+(\\w+)/)?.[1] || '?') : null;
      if (!kind) return;
      const anchor = el.querySelector('.gstage-box') || el.querySelector('.preview') || el;
      const a = anchor.getBoundingClientRect();
      el.querySelectorAll('.side-add').forEach((b) => {
        const r = b.getBoundingClientRect();
        const side = b.classList.contains('left') ? 'L' : 'R';
        const gap = side === 'L' ? a.left - r.right : r.left - a.right;
        rows.push(kind + '#' + i + ' ' + side + '=' + Math.round(gap));
      });
    });
    return rows.join(' · ');
  })()`)
  console.log('全页加号间距：', audit)

  // 特写：节点 + 两侧加号
  const clip = await ev(`(() => {
    const el = [...document.querySelectorAll('.node.gen')][${idx}];
    const n = el.getBoundingClientRect();
    let x = n.left, y = n.top - 30, right = n.right, bottom = n.bottom;
    el.querySelectorAll('.side-add').forEach((b) => {
      const r = b.getBoundingClientRect();
      x = Math.min(x, r.left); right = Math.max(right, r.right);
    });
    const pad = 10;
    return { x: Math.max(0, Math.round(x - pad)), y: Math.max(0, Math.round(y - pad)),
             width: Math.round(right - x + pad * 2), height: Math.round(bottom - y + pad * 2) };
  })()`)
  await shot('21-node-plus.png', clip)

  if (errors.length) console.log('页面报错：', errors.slice(0, 5))
  else console.log('页面无报错')
} catch (e) {
  console.error('失败：', e.message)
  process.exitCode = 1
} finally {
  try { ws?.close() } catch {}
  chrome.kill()
}
