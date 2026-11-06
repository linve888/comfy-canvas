/* 生成节点「LibTV 参数容器」交互回归：
 *  1. 初始：参数容器收起（gpanel 隐藏）、预览卡 + 槽位收拢行 + 常驻提示词端口在
 *  2. 点预览卡 → 容器展开
 *  3. 鼠标移开 → 容器不收（不靠 mouseleave）
 *  4. 点空白 → 容器收起
 *  5. 再点开 → 点其它节点 → 容器收起
 * 全程用 CDP Input 派发真实鼠标事件，不 dispatchEvent 造假的。 */
const http = require('http')
// 脚本在 canvas/tools 下运行，ws 装在 canvas/web/node_modules —— 兜底解析
let WebSocket
try {
  WebSocket = require('ws')
} catch {
  WebSocket = require(require('path').join(__dirname, '../web/node_modules/ws'))
}

const BASE = process.env.CDP_BASE || 'http://127.0.0.1:9223'
const APP = process.env.APP_URL || 'http://127.0.0.1:8770/'

const req = (method, path) =>
  new Promise((res, rej) => {
    const r = http.request(BASE + path, { method }, (rs) => {
      let b = ''
      rs.on('data', (c) => (b += c))
      rs.on('end', () => res(b))
    })
    r.on('error', rej)
    r.end()
  })

let msgId = 0
const pending = new Map()
class CDP {
  constructor(ws) {
    this.ws = ws
    this.events = []
    ws.on('message', (raw) => {
      const m = JSON.parse(raw)
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m)
        pending.delete(m.id)
      } else if (m.method) this.events.push(m)
    })
  }
  send(method, params = {}) {
    const id = ++msgId
    return new Promise((res) => {
      pending.set(id, res)
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  waitEvent(method, timeout = 15000) {
    const i = this.events.findIndex((e) => e.method === method)
    if (i >= 0) return Promise.resolve(this.events.splice(i, 1)[0])
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout ' + method)), timeout)
      const iv = setInterval(() => {
        const j = this.events.findIndex((e) => e.method === method)
        if (j >= 0) {
          clearTimeout(t)
          clearInterval(iv)
          res(this.events.splice(j, 1)[0])
        }
      }, 60)
    })
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let CONN = null
async function evaljs(expr, awaitPromise = false) {
  const r = await CONN.send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise,
  })
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails))
  return r.result?.result?.value
}

async function click(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await sleep(60)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await sleep(50)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  await sleep(120)
}

const centerOf = (sel) =>
  evaljs(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }
  })()`)

const panelShown = () =>
  evaljs(`(() => {
    const n = document.querySelector('.node.gen')
    const p = n && n.querySelector('.gpanel')
    return {
      panelOpen: !!(n && n.classList.contains('panel-open')),
      shown: !!p && getComputedStyle(p).display !== 'none',
      selected: !!(n && n.classList.contains('selected')),
    }
  })()`)

async function findPane() {
  const p = await evaljs(`(() => {
    for (let y = 60; y < 900; y += 30)
      for (let x = 40; x < 1460; x += 30) {
        const el = document.elementFromPoint(x, y)
        if (el && el.classList && el.classList.contains('react-flow__pane')) return { x, y }
      }
    return null
  })()`)
  if (!p) throw new Error('没找到空白 pane 点')
  return p
}

async function main() {
  const targets = JSON.parse(await req('GET', '/json/list'))
  const page = targets.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
  await new Promise((r) => ws.on('open', r))
  const cdp = new CDP(ws)
  CONN = cdp
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1250, deviceScaleFactor: 1, mobile: false })

  const loaded = cdp.waitEvent('Page.loadEventFired')
  await cdp.send('Page.navigate', { url: APP })
  await loaded
  await sleep(2500)

  const results = []
  const rec = (ok, name, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? '（' + extra + '）' : ''}`)

  // 0. 前置：画布上得有生成节点（带产物）
  const nGen = await evaljs(`document.querySelectorAll('.node.gen').length`)
  if (!nGen) throw new Error('画布上没有生成节点，先手动建一个再跑测试')

  // 1. 初始状态：容器收起、预览卡、槽位收拢行、提示词端口都在
  let st = await panelShown()
  rec(!st.shown && !st.panelOpen, '1 初始参数容器收起', `panelOpen=${st.panelOpen}`)
  const card = await centerOf('.node.gen .gcard')
  rec(!!card, '1 预览卡存在', card ? `${Math.round(card.w)}×${Math.round(card.h)}` : '')
  rec(!!(await evaljs(`!!document.querySelector('.node.gen .gslot, .node.gen .slots') || !!document.querySelector('.node.gen .slots-fold')`)), '1 槽位收拢行存在')
  rec(!!(await evaljs(`!!document.querySelector('.node.gen .gport-prompt .react-flow__handle')`)), '1 提示词端口常驻')

  // 2. 点预览卡 → 容器展开
  await click(cdp, Math.round(card.x), Math.round(card.y))
  await sleep(400)
  st = await panelShown()
  rec(st.shown && st.selected, '2 点预览卡展开参数容器', `shown=${st.shown} selected=${st.selected}`)
  const hasPrompt = await evaljs(`!!document.querySelector('.node.gen .gprompt textarea, .node.gen .gprompt .prompt-from-up')`)
  rec(!!hasPrompt, '2 容器里有提示词输入')
  const hasFt = await evaljs(`!!document.querySelector('.node.gen .gpanel-ft')`)
  rec(!!hasFt, '2 容器底部有模板选择与生成按钮')

  await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }).then(async (r) => {
    require('fs').writeFileSync('C:/Users/30543/WorkBuddy/2026-11-04-00-18-00/shot-open.png', Buffer.from(r.result.data, 'base64'))
  })

  // 2.5 悬浮形态：面板脱离文档流浮在节点下方（有空隙、不撑高节点、默认长方形、可调大小）
  const floatInfo = await evaljs(`(() => {
    const n = document.querySelector('.node.gen')
    const card = n.querySelector('.gcard')
    const p = n.querySelector('.gpanel')
    const nr = n.getBoundingClientRect()
    const cr = card.getBoundingClientRect()
    const pr = p.getBoundingClientRect()
    return {
      nodeH: Math.round(nr.height),
      gap: Math.round(pr.top - nr.bottom),
      w: Math.round(pr.width), h: Math.round(pr.height),
      pos: getComputedStyle(p).position,
      dxNode: Math.round(pr.left + pr.width / 2 - (nr.left + nr.width / 2)),
      dxCard: Math.round(pr.left + pr.width / 2 - (cr.left + cr.width / 2)),
    }
  })()`)
  rec(floatInfo.pos === 'absolute', '2.5 面板脱离文档流悬浮', `position=${floatInfo.pos}`)
  rec(floatInfo.gap >= 6, '2.5 与预览框之间有空隙（不连接）', `gap=${floatInfo.gap}px`)
  rec(floatInfo.nodeH < floatInfo.h, '2.5 面板比节点高且不撑高节点', `nodeH=${floatInfo.nodeH} panelH=${floatInfo.h}`)
  rec(floatInfo.w >= 340 && floatInfo.h >= 400, '2.5 默认长方形尺寸', `${floatInfo.w}×${floatInfo.h}`)
  rec(Math.abs(floatInfo.dxCard) <= 2, '2.5 与预览框水平中置', `Δx=${floatInfo.dxCard}px`)

  const before = await evaljs(`(() => { const r = document.querySelector('.node.gen .gpanel').getBoundingClientRect(); return { w: r.width, h: r.height } })()`)
  const grip = await evaljs(`(() => {
    const g = document.querySelector('.node.gen .gresize')
    const r = g.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })()`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grip.x, y: grip.y, button: 'none' })
  await sleep(60)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: grip.x, y: grip.y, button: 'left', clickCount: 1 })
  await sleep(40)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grip.x + 130, y: grip.y + 90, button: 'left', buttons: 1 })
  await sleep(60)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: grip.x + 130, y: grip.y + 90, button: 'left', clickCount: 1 })
  await sleep(250)
  const after = await evaljs(`(() => { const r = document.querySelector('.node.gen .gpanel').getBoundingClientRect(); return { w: r.width, h: r.height } })()`)
  const dw = Math.round(after.w - before.w)
  const dh = Math.round(after.h - before.h)
  rec(dw >= 110 && dh >= 70, '2.6 拖手柄放大容器', `Δw=${dw} Δh=${dh}`)

  // 2.7 收起再展开：尺寸记忆保留
  const pane2 = await findPane()
  await click(cdp, pane2.x, pane2.y)
  await sleep(350)
  await click(cdp, Math.round(card.x), Math.round(card.y))
  await sleep(400)
  const reopened = await evaljs(`(() => { const r = document.querySelector('.node.gen .gpanel').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } })()`)
  rec(Math.abs(reopened.w - after.w) < 2 && Math.abs(reopened.h - after.h) < 2, '2.7 重开保留调好的尺寸', `${reopened.w}×${reopened.h}`)

  await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }).then(async (r) => {
    require('fs').writeFileSync('C:/Users/30543/WorkBuddy/2026-11-04-00-18-00/shot-open.png', Buffer.from(r.result.data, 'base64'))
  })

  // 3. 鼠标挪到远处 → 容器不收
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1400, y: 900, button: 'none' })
  await sleep(700)
  st = await panelShown()
  rec(st.shown, '3 鼠标移开不收起')

  // 4. 点空白处 → 容器收起
  const pane = await findPane()
  await click(cdp, pane.x, pane.y)
  await sleep(400)
  st = await panelShown()
  rec(!st.shown && !st.selected, '4 点空白收起容器', `shown=${st.shown} selected=${st.selected}`)

  // 5. 再点开 → 点另一个节点 → 收起
  await click(cdp, Math.round(card.x), Math.round(card.y))
  await sleep(400)
  st = await panelShown()
  rec(st.shown, '5 再次点卡展开', `shown=${st.shown} selected=${st.selected}`)
  if (!st.shown) {
    const el = await evaljs(`(() => {
      const e = document.elementFromPoint(${Math.round(card.x)}, ${Math.round(card.y)})
      return e ? e.className + ' < ' + (e.closest('.node') ? e.closest('.node').className : 'no-node') : 'null'
    })()`)
    console.log('DEBUG under card point:', el)
  }
  const other = await evaljs(`(() => { const el = document.querySelector('.node:not(.gen)'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + 16), y: Math.round(r.y + 12) } })()`)
  if (other) {
    await click(cdp, Math.round(other.x), Math.round(other.y))
    await sleep(400)
    st = await panelShown()
    rec(!st.shown, '5 点其它节点收起本节点容器')
  } else {
    rec(false, '5 没有其它节点可点（画布上应至少有一个媒体节点）')
  }

  await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }).then(async (r) => {
    require('fs').writeFileSync('C:/Users/30543/WorkBuddy/2026-11-04-00-18-00/shot-closed.png', Buffer.from(r.result.data, 'base64'))
  })

  console.log(results.join('\n'))
  const fail = results.filter((r) => r.startsWith('FAIL')).length
  console.log(fail ? `\n${fail} FAILED` : '\nALL PASS')
  ws.close()
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('ERR', e.stack || e.message)
  process.exit(2)
})
