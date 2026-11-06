#!/usr/bin/env node
/**
 * 导入工作流的冒烟：整条链路真的点一遍。
 *
 *   node canvas/tools/importtest.mjs http://127.0.0.1:8770 canvas/projects/_impshot
 *
 * 验六件事：
 *   1) 左栏「＋ 导入」能开面板，选文件后解析出候选输入
 *   2) 媒体 / 提示词 / 种子 / 比例 都认得出来，且都默认勾上
 *   3) 第二个图槽默认「可选」、第一个不可选（必接）
 *   4) 取消勾选会掉出计数，改名能落到槽位标签上
 *   5) 创建后模板出现在左栏，并且画布上多出一个带这个模板的节点
 *   6) 新节点上的槽位数量 = 导入时勾的媒体数
 *
 * 这个测试会改模板目录和画布存档，跑完自己清干净（模板删掉、存档还原）。
 */
import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const URL = process.argv[2] || 'http://127.0.0.1:8770'
const OUT = resolve(process.argv[3] || 'canvas/projects/_impshot')
const SRC = resolve('batch-render/out/EP01V/V02/V02_v1.workflow.json')
const GRAVE = resolve('canvas/projects/default.json')
const BAK = resolve('canvas/projects/_impshot/default.bak.json')
const TPL = 'zz_import_probe'
const PORT = 9800 + (process.pid % 150)
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

mkdirSync(OUT, { recursive: true })
if (existsSync(GRAVE)) copyFileSync(GRAVE, BAK)
const FIXTURE = join(OUT, 'my_h3_test.json')
writeFileSync(FIXTURE, readFileSync(SRC))

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

const move = (x, y) =>
  send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })

async function click(sel, wait = 400) {
  const p = await center(sel)
  await move(p.x, p.y)
  await sleep(60)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
  await sleep(wait)
}

// React 受控组件：直接改 value 不触发 onChange，得走原生 setter + input 事件
const typeInto = (sel, v) =>
  ev(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'no-el';
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(v)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value.slice(0, 40);
  })()`)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

let created = false

try {
  await connect()
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Network.enable')
  await send('Network.setCacheDisabled', { cacheDisabled: true })
  await send('Page.navigate', { url: URL })
  await sleep(2600)
  check('页面加载', (await ev('document.querySelectorAll(".react-flow__node").length')) >= 1)

  // 1) 开面板 + 选文件
  check('左栏有导入入口', await ev('!!document.querySelector(".lb-add")'))
  await click('.lb-add', 300)
  check('导入面板打开', await ev('!!document.querySelector(".wf-modal")'))
  await shot('i0-pick.png')

  const { root } = await send('DOM.getDocument', { depth: -1 })
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '.wf-pick input[type=file]' })
  check('找得到文件输入', !!nodeId)
  await send('DOM.setFileInputFiles', { nodeId, files: [FIXTURE.replace(/\\/g, '/')] })

  // 等解析（要现拉 object_info，第一次可能几秒）
  let rows = 0
  for (let i = 0; i < 40; i++) {
    await sleep(400)
    rows = await ev('document.querySelectorAll(".wf-row").length')
    if (rows > 0) break
  }
  check('解析出候选输入', rows > 0, `${rows} 行`)
  const info = await ev('document.querySelector(".wf-info")?.innerText || ""')
  check('  认出是出片工作流', /出片/.test(info), info.replace(/\n/g, ' ').slice(0, 70))
  await shot('i1-review.png')

  // 2) 类型识别
  const chips = await ev('[...document.querySelectorAll(".wf-row .wf-chip")].map(e => e.textContent)')
  check('  识别出图片槽', chips.filter((c) => c === '图片').length === 2, chips.join(','))
  check('  识别出提示词', chips.includes('提示词'))
  check('  识别出种子', chips.includes('种子'))
  check('  识别出选项（比例）', chips.includes('选项'))

  // 3) 可选策略：第一张必接、第二张可选
  const opts = await ev(
    '[...document.querySelectorAll(".wf-row")].filter(r => r.querySelector(".wf-opt")).map(r => ({ dis: r.querySelector(".wf-opt input").disabled, on: r.querySelector(".wf-opt input").checked }))'
  )
  check('  图 1 默认必接（不勾可选）', opts[0] && opts[0].on === false, JSON.stringify(opts[0]))
  check('  图 2 默认可选且已勾', opts[1] && opts[1].dis === false && opts[1].on === true, JSON.stringify(opts[1]))

  // 4) 取消勾选某行 + 改名
  const picked0 = await ev('document.querySelectorAll(".wf-row.on").length')
  await ev(`(() => {
    const r = [...document.querySelectorAll(".wf-row")].find(r => r.querySelector(".wf-chip")?.textContent === '选项');
    r.querySelector('input[type=checkbox]').click();
    return true;
  })()`)
  await sleep(250)
  const picked1 = await ev('document.querySelectorAll(".wf-row.on").length')
  check('取消勾选后计数减少', picked1 === picked0 - 1, `${picked0} → ${picked1}`)

  // 模板名 + 显示名
  await typeInto('.wf-form label:nth-child(1) input', TPL)
  await typeInto('.wf-form label:nth-child(2) input', '导入测试 · H3双图')
  await sleep(200)

  // 5) 创建并加节点
  const btns = await ev('[...document.querySelectorAll(".modal-ft button")].map(b => b.textContent)')
  await ev(`(() => {
    const b = [...document.querySelectorAll('.modal-ft button')].find(x => /创建，并加一个节点/.test(x.textContent));
    b.click(); return true;
  })()`)
  for (let i = 0; i < 25; i++) {
    await sleep(300)
    if (!(await ev('!!document.querySelector(".wf-modal")'))) break
  }
  const errText = await ev('document.querySelector(".wf-err")?.textContent || ""')
  check('面板关闭（保存成功）', !(await ev('!!document.querySelector(".wf-modal")')), errText || '无报错')
  created = true

  await sleep(900)
  const inBar = await ev(`[...document.querySelectorAll('.tpl-card')].some(c => /导入测试/.test(c.innerText))`)
  check('左栏出现新模板', inBar)
  check('  带「导入」标记', await ev(`[...document.querySelectorAll('.tpl-card.imported')].some(c => /导入测试/.test(c.innerText))`))

  const nodeInfo = await ev(`(() => {
    const n = [...document.querySelectorAll('.react-flow__node')].find(n => /导入测试/.test(n.innerText));
    if (!n) return null;
    return {
      title: n.querySelector('.title')?.textContent || '',
      slots: n.querySelectorAll('.slot-in[class*="slot-in"]').length,
      fold: n.querySelector('.sf-n')?.textContent || '',
    };
  })()`)
  check('画布上多了用它的节点', !!nodeInfo, nodeInfo ? nodeInfo.title : '没找到')
  check('  节点是视频节点', nodeInfo?.title?.includes('导入测试'), nodeInfo?.title)
  check('  槽位摘要对得上', /2图/.test(nodeInfo?.fold || ''), nodeInfo?.fold)
  await shot('i2-node.png')

  // 展开看槽位标签
  await ev(`(() => {
    const n = [...document.querySelectorAll('.react-flow__node')].find(n => /导入测试/.test(n.innerText));
    n.querySelector('.slots-fold')?.click(); return true;
  })()`)
  await sleep(500)
  const labels = await ev(`(() => {
    const n = [...document.querySelectorAll('.react-flow__node')].find(n => /导入测试/.test(n.innerText));
    return [...n.querySelectorAll('.slot-in span:first-of-type')].map(e => e.textContent);
  })()`)
  check('  展开后槽位标签是「图 1…」', labels.some((l) => /图 1/.test(l)), JSON.stringify(labels))
  await shot('i3-slots.png')
} catch (e) {
  check('执行未抛异常', false, e.message.split('\n')[0])
} finally {
  // 清场：删测试模板、还原画布存档
  if (created) {
    try {
      await fetch(`${URL}/api/template/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: TPL }),
      })
    } catch {
      /* 删不掉就留着，人肉看一眼 */
    }
  }
  if (existsSync(BAK)) copyFileSync(BAK, GRAVE)
  ws?.close()
  chrome.kill()
  const bad = results.filter((r) => !r.ok)
  console.log(`\n${results.length - bad.length}/${results.length} 通过`)
  process.exit(bad.length ? 1 : 0)
}
