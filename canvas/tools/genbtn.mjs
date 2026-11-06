#!/usr/bin/env node
/**
 * 生成节点「功能按钮」冒烟：真点界面，但不占 GPU。
 *
 * 做法：在页面加载前把 window.fetch 换掉，只拦 POST /api/run —— 拿到按钮
 * 真正要提交的载荷就返回一个假任务，ComfyUI 一次都不碰。验的是「点了按钮，
 * 发出去的东西对不对」，尤其是换模板时参数有没有按目标模板的选项收口。
 *
 * 用法：node canvas/tools/genbtn.mjs http://127.0.0.1:8770
 * 产物：canvas/projects/_btnshot/*.png，开头备份 default.json，收尾还原。
 *
 * 覆盖：打光菜单（6 个光位）→ 点一个光位 → 载荷；三视图；九宫格；
 *      比例是否落在 qwen21_edit_multi 的选项里；图是不是当前产物。
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync, readFileSync, existsSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const BASE = process.argv[2] || 'http://127.0.0.1:8770'
const OUT = resolve('canvas/projects/_btnshot').replace(/\\/g, '/')
const GRAPH = resolve('canvas/projects/default.json')
const PORT = 9700 + (process.pid % 200)
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const backup = join(OUT, 'default.before-btnshot.json')
if (existsSync(GRAPH)) copyFileSync(GRAPH, backup)

const chrome = spawn(
  CHROME,
  ['--headless=new', `--remote-debugging-port=${PORT}`, '--window-size=1500,1000', '--disable-gpu',
   '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
   `--user-data-dir=${OUT}/_chrome-btn-${process.pid}`, 'about:blank'],
  { stdio: ['ignore', 'pipe', 'pipe'] }
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

/** 装载前替换 fetch：只拦 /api/run，其余原样透传 */
const HOOK = `(() => {
  window.__runs = [];
  const orig = window.fetch;
  window.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/api/run') && (opts?.method || 'GET').toUpperCase() === 'POST') {
      const body = JSON.parse(opts.body || '{}');
      window.__runs.push(body);
      return new Response(JSON.stringify({ job: {
        id: 'fake-' + window.__runs.length, nodeId: body.nodeId, label: body.label,
        template: body.template, params: body.params, inputs: body.inputs,
        status: 'running', phase: '排队中', createdAt: 'fake', outputs: [], elapsed: 0,
      } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return orig(url, opts);
  };
})();`

const BTN = (label) =>
  `Array.from(document.querySelectorAll('.node.gen.open .gtool')).find(b => b.textContent.includes(${JSON.stringify(label)}))`

/**
 * 打开「有图可加工」的那个生成节点，而不是 DOM 里第一个。
 * 画布上第一个 .node.gen 常常是空的视频节点；不按这个挑，
 * 后面的断言会落在别的节点上，看着全绿其实什么都没验到。
 */
const openComposer = async () => {
  const ok = await ev(`(() => {
    const n = Array.from(document.querySelectorAll('.node.gen')).find((x) =>
      Array.from(x.querySelectorAll('.gtool')).some((b) => b.textContent.includes('九宫格'))
    );
    if (!n) return false;
    n.querySelector('.gstage')?.click();
    return true;
  })()`)
  await sleep(600)
  return ok
}

const shot = async (name, sel = '.node.gen') => {
  const box = await ev(`(() => {
    const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null;
    const r = n.getBoundingClientRect();
    return { x: Math.max(0, r.x - 20), y: Math.max(0, r.y - 20), width: Math.min(r.width + 40, 1100), height: Math.min(r.height + 40, 1100) };
  })()`)
  if (!box) return
  const png = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { ...box, scale: 1.4 },
    captureBeyondViewport: true,
  })
  writeFileSync(join(OUT, name), Buffer.from(png.data, 'base64'))
}

/** 当前点开组合器的那张生成节点（测试点的是它，截图也要拍它） */
const ACTIVE = '.react-flow__node:has(.node.gen.open)'

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
  await send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK })
  await send('Page.navigate', { url: `${BASE}/?v=${Date.now()}` })
  await sleep(2600)

  // 节点本来跑的是 Krea2，比例存成 `16:9` —— 换模板时最容易炸的就是这个值
  const before = await ev(`(() => {
    const n = document.querySelector('.node.gen');
    return n ? { has: true } : { has: false };
  })()`)
  check('画布上有生成节点', before?.has)

  const opened = await openComposer()
  check('找到有产物的生成节点并展开', opened && (await ev(`!!document.querySelector('.node.gen.open .gc-tools')`)))

  // ---- 打光：菜单 6 个光位 → 选第一个
  await ev(`${BTN('打光')}.click()`)
  await sleep(350)
  const lights = await ev(`document.querySelectorAll('.node.gen.open .gmenu-sm button').length`)
  check('打光菜单出 6 个光位', lights === 6, `实际 ${lights}`)
  await shot('menu-light.png', ACTIVE)
  await ev(`document.querySelectorAll('.node.gen.open .gmenu-sm button')[0].click()`)
  await sleep(900)
  const lightRuns = await ev('window.__runs || []')
  check('打光按钮发出了 /api/run', lightRuns.length === 1, `${lightRuns.length} 次`)

  // ---- 重新载入，验九宫格（打光那次已经把节点切成 qwen 模板了）
  await send('Page.navigate', { url: `${BASE}/?v=${Date.now()}` })
  await sleep(2600)
  await openComposer()
  await ev(`${BTN('九宫格')}.click()`)
  await sleep(900)
  await shot('after-grid9.png', ACTIVE)

  const gridRuns = await ev('window.__runs || []')
  const runs = [...lightRuns, ...gridRuns]
  check('九宫格按钮发出了 /api/run', gridRuns.length === 1, `${gridRuns.length} 次`)

  const tpls = await ev(`fetch('/api/templates').then(r => r.json())`)
  const qwen = (tpls.templates || []).find((t) => t.name === 'qwen21_edit_multi')
  const aspectOpts = ((qwen?.fields || []).find((f) => f.slot === 'aspect')?.options || []).map((o) =>
    typeof o === 'string' ? o : o.value
  )

  for (const [i, r] of runs.entries()) {
    const tag = r.label || `run${i + 1}`
    check(`${tag}：模板切到 qwen21_edit_multi`, r.template === 'qwen21_edit_multi', r.template)
    check(`${tag}：比例在目标模板选项里`, aspectOpts.includes(r.params?.aspect), `${r.params?.aspect}`)
    check(`${tag}：带上了当前产物做图 1`, !!r.inputs?.image_1, r.inputs?.image_1 || '(空)')
    check(`${tag}：提示词非空`, String(r.params?.prompt || '').trim().length > 10)
  }

  const grid = runs[runs.length - 1]
  check('九宫格用的是九格提示词', /九宫格/.test(grid?.params?.prompt || ''))

  // ---- 换模型：写好的提示词不能因为换模板被清空
  const typed = '换模型时要留下的提示词'
  await ev(`(() => {
    const ta = document.querySelector('.node.gen.open .gc-input');
    if (!ta) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify('')} + '${typed}');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`)
  await sleep(300)
  await ev(`document.querySelector('.node.gen.open .gc-chip-model').click()`)
  await sleep(400)
  const picked = await ev(`(() => {
    const items = Array.from(document.querySelectorAll('.node.gen.open .gmenu-model button'));
    const other = items.find((b) => !b.querySelector('svg') && !/导入/.test(b.textContent));
    if (!other) return '';
    other.click();
    return other.textContent.trim();
  })()`)
  await sleep(500)
  const kept = await ev(`document.querySelector('.node.gen.open .gc-input')?.value || ''`)
  check('换模型后提示词还在', kept.includes(typed), `${picked} → ${kept.slice(0, 16)}`)

  // ---- 生视频：只是建节点 + 连线，不提交任务
  const cntBefore = await ev(`({ n: document.querySelectorAll('.node').length, e: document.querySelectorAll('.react-flow__edge').length })`)
  await ev(`${BTN('生视频')}.click()`)
  await sleep(700)
  const cntAfter = await ev(`({ n: document.querySelectorAll('.node').length, e: document.querySelectorAll('.react-flow__edge').length })`)
  check('生视频按钮多出一个节点', cntAfter.n === cntBefore.n + 1, `${cntBefore.n} → ${cntAfter.n}`)
  check('生视频按钮顺手连好了线', cntAfter.e === cntBefore.e + 1, `${cntBefore.e} → ${cntAfter.e}`)

  // ---- 悬浮工具条：视频节点以前漏了「全屏」，只能双击
  const vidTips = await ev(`Array.from(document.querySelectorAll('.node.gen.video .node-tools .nt')).map(b => b.title)`)
  if (vidTips.length) {
    check('视频节点的工具条里有全屏', vidTips.includes('全屏查看'), vidTips.join(' / '))
    check('视频节点的工具条里有下载', vidTips.includes('下载'), vidTips.join(' / '))
  } else {
    console.log('  · 画布上没有视频节点，跳过工具条检查')
  }

  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} 通过`)
  if (results.some((r) => !r.ok)) process.exitCode = 1
} catch (e) {
  console.error('失败：', e.message)
  process.exitCode = 1
} finally {
  try { ws?.close() } catch {}
  chrome.kill()
  // 点按钮会改节点模板并触发自动保存，收尾把画布还原成跑之前的样子
  if (existsSync(backup)) {
    copyFileSync(backup, GRAPH)
    console.log('已还原 default.json')
  }
}
