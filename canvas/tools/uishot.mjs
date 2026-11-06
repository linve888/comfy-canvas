#!/usr/bin/env node
/**
 * 视觉核对截图：只做「不改变数据」的操作（悬停、选中、开面板），
 * 一个状态一张图，用来对照改样式前后的观感。
 *
 * 用法：node canvas/tools/uishot.mjs http://127.0.0.1:8781
 * 产物：canvas/projects/_uishot/*.png
 *
 * 和 uitest.mjs 的区别：那个会切图、会写项目（真跑流程）；
 * 这个只看，不动数据，改完 CSS 跑一遍就行。
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const URL = process.argv[2] || 'http://127.0.0.1:8779'
const OUT = resolve(process.argv[3] || 'canvas/projects/_uishot').replace(/\\/g, '/')
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
    `--user-data-dir=${OUT}/_chrome-${process.pid}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] }
)
const log = []
chrome.stderr.on('data', (d) => log.push(String(d)))

let ws
let seq = 0
const errors = []
const pending = new Map()

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
          if (m.method === 'Runtime.exceptionThrown') {
            errors.push(m.params.exceptionDetails?.text || 'exception')
          }
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

const shot = async (name, clip) => {
  const params = { format: 'png' }
  if (clip) {
    params.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 }
    // 节点可能高出可视区：允许截到视口之外，否则只能截到上半截
    params.captureBeyondViewport = true
  }
  const r = await send('Page.captureScreenshot', params)
  writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64'))
  console.log('  →', name)
}

async function box(sel) {
  return ev(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`)
}

async function hover(sel) {
  const p = await box(sel)
  if (!p) throw new Error('找不到 ' + sel)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' })
  await sleep(250)
  return p
}

/** 直接调 click()：主按钮有引导 toast 盖着，鼠标点会打到 toast 上 */
const jsClick = async (sel) => {
  const ok = await ev(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false; el.click(); return true;
  })()`)
  await sleep(450)
  return ok
}

/** 挑一个「看得见」的生成节点：以节点可见面积为准；require 是节点内必须有的元素 */
async function pickGen(require = '', skip = '') {
  const req = require.replace(/"/g, '')
  const no = skip.replace(/"/g, '')
  const area = () =>
    ev(`(() => {
      const list = [...document.querySelectorAll('.node.gen')];
      let best = -1, bestArea = 0;
      list.forEach((el, i) => {
        if (${JSON.stringify(req)} && !el.querySelector(${JSON.stringify(req)})) return;
        if (${JSON.stringify(no)} && el.querySelector(${JSON.stringify(no)})) return;
        if (${JSON.stringify(no)} && el.querySelector(${JSON.stringify(no)})) return;
        const r = el.getBoundingClientRect();
        const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
        const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
        const a = Math.max(0, w) * Math.max(0, h);
        if (a > bestArea) { bestArea = a; best = i; }
      });
      return bestArea > 8000 ? best : -1;
    })()`)
  let idx = await area()
  if (idx >= 0) return idx

  // 画布缩放太小（36%）时生成节点只有一百多像素，判不出来：
  // 借左侧「节点大纲」把其中一个移到画面中间（focusNode 固定 100%）
  await ev(`(() => {
    const b = [...document.querySelectorAll('.dock button')].find((x) => x.title === '节点大纲');
    if (b) b.click();
  })()`)
  await sleep(600)
  const focused = await ev(`(() => {
    const items = [...document.querySelectorAll('.ol-item')];
    const it = items.find((el) => el.textContent.includes('生成')) || items[0];
    if (!it) return false; it.click(); return true;
  })()`)
  await sleep(900)
  await ev(`document.querySelector('.leftbar .panel-x')?.click()`)
  await sleep(400)
  if (!focused) return -1
  return area()
}

/** 节点特写：2 倍像素密度，连同打开着的二级面板一起框进来 */
async function nodeShot(name, idx) {
  const w = await ev(`(() => {
    const el = [...document.querySelectorAll('.node.gen')][${idx}];
    return el ? el.getBoundingClientRect().width : 0;
  })()`)
  const dsf = w && w < 220 ? 3 : 2
  await send('Emulation.setDeviceMetricsOverride', { width: 1484, height: 845, deviceScaleFactor: dsf, mobile: false })
  await sleep(500)
  const clip = await ev(`(() => {
    const el = [...document.querySelectorAll('.node.gen')][${idx}];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    let x = r.left, y = r.top, right = r.right, bottom = r.bottom;
    el.querySelectorAll('.gpop, .gmenu-model').forEach((p) => {
      const q = p.getBoundingClientRect();
      x = Math.min(x, q.left); y = Math.min(y, q.top);
      right = Math.max(right, q.right); bottom = Math.max(bottom, q.bottom);
    });
    // 上方多留 34px：动作按钮浮在卡片上方（top:-27px），按节点框裁会把它们切掉
    const pad = 8;
    return {
      x: Math.max(0, Math.round(x - pad)),
      y: Math.max(0, Math.round(y - pad - 28)),
      width: Math.max(1, Math.round(right - x + pad * 2)),
      height: Math.max(1, Math.round(bottom - y + pad * 2 + 28)),
    };
  })()`)
  if (clip) await shot(name, clip)
  else console.log('  节点不在可视区，跳过', name)
  await send('Emulation.clearDeviceMetricsOverride')
  await sleep(300)
}

try {
  await connect()
  await send('Page.enable')
  await send('Runtime.enable')
  // 加个时间戳：不然 Chrome 会把上一次的 index.html 直接从缓存翻出来，
  // 看到的是旧样式还以为改坏了
  await send('Page.navigate', { url: URL + (URL.includes('?') ? '&' : '?') + 'v=' + Date.now() })
  await sleep(3000)

  console.log('截图：')
  await shot('01-default.png')

  // 空态那个（还没出图的）看结构，出过图的另拍一张
  const genIdx = await pickGen('', '.gstage.has')
  console.log('  选中的生成节点序号：', genIdx)

  if (genIdx >= 0) {
    // 悬停：卡外工具条 + 两侧派生钮（按索引取节点，CSS 选择器给不了序号）
    const p = await ev(`(() => {
      const el = [...document.querySelectorAll('.node.gen')][${genIdx}];
      const r = el.querySelector('.gstage').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`)
    if (p) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' })
      await sleep(300)
    }
    await shot('02-hover-node.png')
  }

  // 节点特写（收起态）：默认只留标题和画面，看这一张
  if (genIdx >= 0) await nodeShot('09-node.png', genIdx)

  // 点开节点：组合器默认是收起的
  const outIdxEarly = await pickGen('.gstage.has')
  const openNode = async (idx = genIdx) => {
    const ok = await ev(`(() => {
      const el = [...document.querySelectorAll('.node.gen')][${idx}];
      if (!el) return false;
      if (el.classList.contains('open')) return true;
      const st = el.querySelector('.gstage');
      if (!st) return false;
      st.click();
      return true;
    })()`)
    await sleep(500)
    return ok
  }
  const nodeOpen = (idx = genIdx) =>
    ev(`!![...document.querySelectorAll('.node.gen')][${idx}]?.classList.contains('open')`)

  if (genIdx >= 0 && (await openNode())) {
    console.log('  点开节点：', (await nodeOpen()) ? 'ok' : '没展开')
    await nodeShot('14-open.png', genIdx)
  }

  // 二级参数面板：拍竖屏出图节点（用户报「点了不展开」的就是它）
  const popIdx = outIdxEarly >= 0 ? outIdxEarly : genIdx
  if (popIdx >= 0) {
    await openNode(popIdx)
    const opened = await ev(`(() => {
      const el = [...document.querySelectorAll('.node.gen')][${popIdx}];
      const b = el?.querySelector('.gc-chip-fmt');
      if (!b) return false; b.click(); return true;
    })()`)
    await sleep(600)
    if (opened) {
      console.log('  参数面板：', (await ev(`!![...document.querySelectorAll('.node.gen')][${popIdx}]?.querySelector('.gpop')`)) ? 'ok' : '没打开')
      console.log('  浮层位置：', await ev(`(() => {
        const el = [...document.querySelectorAll('.node.gen')][${popIdx}];
        const p = el?.querySelector('.gpop');
        if (!p) return '没开';
        const a = p.getBoundingClientRect();
        const chip = el.querySelector('.gc-chip-fmt').getBoundingClientRect();
        const gap = chip.top - a.bottom;
        return '离按钮 ' + Math.round(gap) + 'px ' +
          (gap >= 0 && gap <= 8 ? '（贴着按钮，对）' : '（位置不对）') +
          ' · 顶出视口=' + (a.top < 0);
      })()`))
      await nodeShot('10-params.png', popIdx)
      await ev(`(() => {
        const el = [...document.querySelectorAll('.node.gen')][${popIdx}];
        el?.querySelector('.gc-chip-fmt')?.click();
      })()`)
      await sleep(300)
    }
  }

  // 换模型菜单
  if (popIdx >= 0) {
    await openNode(popIdx)
    const opened = await ev(`(() => {
      const el = [...document.querySelectorAll('.node.gen')][${popIdx}];
      const b = el?.querySelector('.gc-chip-model');
      if (!b) return false; b.click(); return true;
    })()`)
    await sleep(500)
    if (opened) {
      await nodeShot('11-model.png', popIdx)
      await ev(`(() => {
        const el = [...document.querySelectorAll('.node.gen')][${popIdx}];
        el?.querySelector('.gc-chip-model')?.click();
      })()`)
      await sleep(300)
    }
  }

  // 收起：点组合器右上角那个箭头，应该回到「只剩标题和画面」
  if (genIdx >= 0) {
    const folded = await ev(`(() => {
      const el = [...document.querySelectorAll('.node.gen')][${genIdx}];
      const b = el?.querySelector('.gtool-ico');
      if (!b) return false; b.click(); return true;
    })()`)
    await sleep(400)
    if (folded) {
      console.log('  收起后：', (await nodeOpen()) ? '还开着（不对）' : '已收起')
      await nodeShot('13-folded.png', genIdx)
      await openNode()
    }
  }

  // 已经出过图的那个：拍「收起 + 悬停」——这时画面底部有播放条，
  // 悬停提示得让开它，也顺便确认竖屏节点点一下能展开
  const outIdx = await pickGen('.gstage.has')
  if (outIdx >= 0) {
    await ev(`(() => {
      const el = [...document.querySelectorAll('.node.gen')][${outIdx}];
      const b = el?.querySelector('.gtool-ico');
      if (el?.classList.contains('open') && b) b.click();
    })()`)
    await sleep(400)
    const hp = await ev(`(() => {
      const el = [...document.querySelectorAll('.node.gen')][${outIdx}];
      const r = el.querySelector('.gstage').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hp.x, y: hp.y, button: 'none' })
    await sleep(500)
    await nodeShot('12-output.png', outIdx)
  } else console.log('  没找到已出图的节点')

  // 底部工具条上按标题点按钮（toast 可能盖住 dock，用 click() 更稳）
  const dockClick = async (title) => {
    const ok = await ev(`(() => {
      const b = [...document.querySelectorAll('.dock button')].find((x) => x.title === ${JSON.stringify(title)});
      if (!b) return false; b.click(); return true;
    })()`)
    await sleep(500)
    return ok
  }

  // 左抽屉：素材 / 模板
  if (await dockClick('素材库')) await shot('04-drawer-lib.png')
  // 任务抽屉
  if (await dockClick('任务')) await shot('05-drawer-tasks.png')
  if (await dockClick('任务')) await sleep(300) // 关掉，别挡后面的判读

  // 全部功能 / 快捷键
  const opened = await ev(`(() => {
    const b = [...document.querySelectorAll('.dock button')].find((x) => x.title === '全部功能');
    if (!b) return false; b.click(); return true;
  })()`)
  if (opened) {
    await sleep(700)
    await shot('06-alltools.png')
    const c = await ev(`(() => {
      const b = document.querySelector('.at-hd .at-x'); if (!b) return false; b.click(); return true;
    })()`)
    await sleep(400)
    console.log('  关闭按钮：', c ? 'ok' : '没找到')
  } else {
    console.log('  没找到「全部功能」按钮')
  }

  // 导入工作流弹窗：抽屉可能正开着（再点一次就关了），先看有没有入口
  let imp = await ev(`(() => {
    const b = document.querySelector('.lb-add'); if (!b) return false; b.click(); return true;
  })()`)
  if (!imp) {
    await dockClick('素材库')
    imp = await ev(`(() => {
      const b = document.querySelector('.lb-add'); if (!b) return false; b.click(); return true;
    })()`)
  }
  if (imp) {
    await sleep(700)
    await shot('07-import.png')
    await ev(`document.querySelector('.modal-hd .at-x, .modal .at-x')?.click()`)
    await ev(`document.querySelectorAll('.modal').length && [...document.querySelectorAll('.modal button')].find(b => b.textContent.trim() === '取消')?.click()`)
    await sleep(400)
  } else console.log('  没找到导入入口')

  // 画布右键菜单
  const pane = await ev(`(() => {
    const r = document.querySelector('.react-flow__pane').getBoundingClientRect();
    return { x: Math.round(r.left + 200), y: Math.round(r.bottom - 160) };
  })()`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pane.x, y: pane.y, button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pane.x, y: pane.y, button: 'right', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pane.x, y: pane.y, button: 'right', clickCount: 1 })
  await sleep(500)
  await shot('08-ctx-menu.png')

  const bad = await ev(`(() => {
    const out = [];
    document.querySelectorAll('*').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width && r.height && (r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || r.left < -1)) {
        const c = el.className;
        if (typeof c === 'string' && c && !c.includes('react-flow')) out.push(c.split(' ')[0]);
      }
    });
    return [...new Set(out)].slice(0, 12);
  })()`)
  console.log('溢出视口的元素：', bad?.length ? bad.join(', ') : '无')
  console.log('控制台错误：', errors.length ? errors.join(' | ') : '无')
} catch (e) {
  console.error('失败：', e.message)
} finally {
  try { ws?.close() } catch {}
  chrome.kill()
}
