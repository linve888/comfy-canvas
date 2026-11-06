#!/usr/bin/env node
/**
 * 侧边「＋」磁吸的冒烟测试。
 *
 * 验四件事：
 *   1. 鼠标停在加号外侧 ~30px 时，加号朝鼠标方向挪过去（不是往反方向）；
 *   2. **Handle 一动不动** —— 线的端点是量 Handle 算出来的，加号挪了 Handle 不能挪，
 *      否则一靠近，已经连好的线就跟着歪（这是这套改动最容易踩的坑）；
 *   3. 被吸过来时加号是可见的（opacity 1）；
 *   4. 在「附近但不是正中间」按下就能拉出线来，不用精确点 18px 的圆点。
 *
 * 用法：node canvas/tools/magnet.mjs http://127.0.0.1:8770
 * 产物：canvas/projects/_uishot/magnet.png（吸住那一刻的截图）
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const BASE = process.argv[2] || 'http://127.0.0.1:8770'
const OUT = resolve('canvas/projects/_uishot').replace(/\\/g, '/')
const PORT = 9500 + (process.pid % 200)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(OUT, { recursive: true })

const chrome = spawn(
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ['--headless=new', `--remote-debugging-port=${PORT}`, '--window-size=1500,950', '--disable-gpu',
   '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
   `--user-data-dir=${OUT}/_cm${process.pid}`, 'about:blank'],
  { stdio: 'ignore' }
)

let ws, seq = 0
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

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
}

/** 一次鼠标移动（真事件，走浏览器的 hit-test，不是直接改 style） */
const move = (x, y) =>
  send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })

try {
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
        break
      }
    } catch {}
    await sleep(200)
  }
  if (!ws) throw new Error('连不上调试端口')

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.navigate', { url: `${BASE}/?v=${Date.now()}` })
  await sleep(3000)

  // 挑一个在视口里的加号
  const target = await ev(`(() => {
    const vis = Array.from(document.querySelectorAll('.side-add')).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.left > 8 && r.top > 8 && r.right < innerWidth - 8 && r.bottom < innerHeight - 8;
    });
    const el = vis.find((e) => e.classList.contains('left')) || vis[0];
    if (!el) return null;
    // 打上标记：附近可能还有别的节点的加号同时被吸住，不标记就会量错元素
    el.dataset.magProbe = '1';
    const r = el.getBoundingClientRect();
    const h = el.querySelector('.react-flow__handle').getBoundingClientRect();
    return {
      side: el.classList.contains('left') ? 'left' : 'right',
      cx: r.left + r.width / 2, cy: r.top + r.height / 2,
      w: r.width, hx: h.left + h.width / 2, hy: h.top + h.height / 2,
      n: vis.length,
    };
  })()`)
  if (!target) throw new Error('画布上没有可用的加号')
  check('找到加号', true, `${target.n} 个可见 · ${target.side} · 直径 ${Math.round(target.w)}px`)

  // 停在加号外侧 30px：这个距离已经出了 18px 的本体，靠磁吸才够得着
  const dir = target.side === 'left' ? -1 : 1
  // 20px：已经出了 15px 的本体、还在隐形命中环（±25px）里，
  // 这个距离上跟随量接近上限，测得出「朝光标靠」又不至于把加号拉离节点
  const px = target.cx + dir * 20
  await move(px, target.cy)
  await sleep(220)

  const mag = await ev(`(() => {
    const el = document.querySelector('.side-add[data-mag-probe]');
    if (!el) return null;
    const on = el.classList.contains('mag');
    const r = el.getBoundingClientRect();
    const h = el.querySelector('.react-flow__handle').getBoundingClientRect();
    return {
      cx: r.left + r.width / 2, cy: r.top + r.height / 2,
      hx: h.left + h.width / 2, hy: h.top + h.height / 2,
      opacity: Number(getComputedStyle(el).opacity),
      cls: el.className, on,
    };
  })()`)
  check('加号进入了磁吸态', mag?.on, mag?.on ? 'mag' : '没吸住')

  const dx = mag ? mag.cx - target.cx : 0
  const dy = mag ? mag.cy - target.cy : 0
  const dist = Math.hypot(dx, dy)
  check('确实朝鼠标方向挪了', dist > 3, `位移 ${dist.toFixed(1)}px`)
  check('位移方向对（朝光标，不是反的）', dx * dir > 0, `dx=${dx.toFixed(1)}（光标在 ${dir < 0 ? '左' : '右'}）`)
  check('挪动幅度受控（不超过 12px）', dist <= 12.6, `${dist.toFixed(1)}px`)
  check('吸住时加号可见', (mag?.opacity || 0) > 0.9, `opacity ${mag?.opacity}`)

  const hdx = mag ? mag.hx - target.hx : 99
  const hdy = mag ? mag.hy - target.hy : 99
  check('Handle 没跟着动（线的端点不变）', Math.abs(hdx) < 0.8 && Math.abs(hdy) < 0.8,
    `handle 位移 ${hdx.toFixed(2)}, ${hdy.toFixed(2)}`)

  const png = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: Math.max(0, px - 150), y: Math.max(0, target.cy - 150), width: 320, height: 300, scale: 1.6 },
  })
  writeFileSync(join(OUT, 'magnet.png'), Buffer.from(png.data, 'base64'))

  // 在「附近但不是正中」按下，应该能拉出线
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: target.cy, button: 'left', buttons: 1, clickCount: 1 })
  await sleep(120)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px - dir * 70, y: target.cy + 90, button: 'left', buttons: 1 })
  await sleep(220)
  const pulling = await ev(`!!document.querySelector('.react-flow__connectionline, .react-flow__connection')`)
  check('在加号旁边按下就能拉线', pulling)

  // 收尾：拖回原处再松手，避免弹出「这根线接给谁」的菜单
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: target.cy, button: 'left', buttons: 1 })
  await sleep(80)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: target.cy, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(200)

  // 移开 → 归位
  await move(20, 20)
  await sleep(300)
  const after = await ev(`(() => {
    const el = document.querySelector('.side-add[data-mag-probe]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { cls: el.className, dx: r.left + r.width / 2 - ${target.cx}, mx: el.style.getPropertyValue('--mag-x') };
  })()`)
  check('移开后加号归位', after && !after.cls.includes('mag') && Math.abs(after.dx) < 1,
    `dx=${after?.dx?.toFixed(1)}`)

  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} 通过`)
  if (results.some((r) => !r.ok)) process.exitCode = 1
} catch (e) {
  console.error('失败：', e.message)
  process.exitCode = 1
} finally {
  try { ws?.close() } catch {}
  chrome.kill()
}
