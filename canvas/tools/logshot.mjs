#!/usr/bin/env node
/**
 * 拍「生成节点 + 运行日志调试条」的样子（只在 ?log=1 时才会出现这块）。
 *
 * 用法：node canvas/tools/logshot.mjs http://127.0.0.1:8770
 *       node canvas/tools/logshot.mjs http://127.0.0.1:8770 demo      # 塞假日志看排版
 *       node canvas/tools/logshot.mjs http://127.0.0.1:8770 clickgen  # 空提示词点生成，跑通日志链路
 * 产物：canvas/projects/_uishot/nodelog.png
 *
 * 只看不改：不跑任务。clickgen 用的是「提示词为空」这个必然被拦下的分支，
 * 不会提交 job、不会占 GPU。
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const BASE = process.argv[2] || 'http://127.0.0.1:8770'
const OUT = resolve('canvas/projects/_uishot').replace(/\\/g, '/')
const PORT = 9800 + (process.pid % 150)
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const chrome = spawn(
  CHROME,
  ['--headless=new', `--remote-debugging-port=${PORT}`, '--window-size=1500,1000', '--disable-gpu',
   '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
   `--user-data-dir=${OUT}/_chrome-log-${process.pid}`, 'about:blank'],
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
  await send('Page.navigate', { url: `${BASE}/?log=1&v=${Date.now()}` })
  await sleep(2500)

  // demo：往调试条里塞几行假日志，单纯看排版/配色/溢出（不经过 React，只验样式）
  if (process.argv[3] === 'demo') {
    await ev(`(() => {
      const lg = document.querySelector('.node.gen .nodelog');
      if (!lg) return 'no-strip';
      const rows = [
        ['00:12.480','gen.click','I','node=gen-3 action=run tpl=qwen21_edit_multi prompt_chars=128 media=image+image'],
        ['00:12.512','gen.submit','I','node=gen-3 tpl=qwen21_edit_multi seed=(auto) slots=image_1,image_2 params={"aspect":"9:16 (Portrait Widescreen)","megapixels":1}'],
        ['00:13.020','gen.accepted','I','node=gen-3 job=1106111244-a1b2c ms=508'],
        ['00:13.940','gen.state','I','node=gen-3 job=1106111244-a1b2c from=queued to=running secs=0.4 phase=生成中'],
        ['00:34.610','gen.state','I','node=gen-3 job=1106111244-a1b2c from=running to=done secs=21.6 phase=完成 out=1 seed=123456789'],
        ['00:35.001','gen.blocked','W','node=gen-3 why="提示词是空的 —— 写清画面里有什么再跑" reroll=false'],
        ['00:35.470','gen.submit.fail','E','node=gen-3 tpl=qwen21_edit_multi err="HTTP 500 后端炸了，这里故意写长一点看省略号"'],
      ];
      lg.innerHTML = '<div class="nodelog-hd"><span>运行日志</span><span class="nodelog-tip">最近 7 条</span></div>' +
        rows.map(([t, ev, lv, f]) =>
          '<div class="nl-row nl-' + lv.toLowerCase() + '"><span class="nl-t">' + t +
          '</span><span class="nl-ev">' + ev + '</span><span class="nl-f">' + f.replace(/</g, '&lt;') + '</span></div>'
        ).join('');
      return 'ok';
    })()`)
    await sleep(300)
  }

  // clickgen：点开组合器 → 点生成。提示词为空时前端会拦下并记 gen.blocked，
  // 正好把「点击 → 上报 → 落盘」整条路走一遍，又不碰 GPU。
  if (process.argv[3] === 'clickgen') {
    console.log('打开组合器:', await ev(`(() => {
      const n = document.querySelector('.node.gen');
      if (!n) return 'no-node';
      n.querySelector('.gstage')?.click();
      return 'ok';
    })()`))
    await sleep(700)
    console.log('点生成:', await ev(`(() => {
      const b = document.querySelector('.node.gen .gsubmit');
      if (!b) return 'no-btn';
      b.click();
      return 'ok';
    })()`))
    await sleep(1800)
    console.log('条内行数:', await ev(`document.querySelectorAll('.node.gen .nl-row').length`))
  }

  const box = await ev(`(() => {
    const n = document.querySelector('.node.gen');
    if (!n) return null;
    const r = n.getBoundingClientRect();
    const lg = n.querySelector('.nodelog');
    const q = lg ? lg.getBoundingClientRect() : null;
    return { x: Math.max(0, r.x - 24), y: Math.max(0, r.y - 24), width: r.width + 48, height: r.height + 48,
             hasLog: !!lg, logH: q ? Math.round(q.height) : 0, nodeH: Math.round(r.height) };
  })()`)
  console.log(JSON.stringify(box))
  if (!box) throw new Error('画布上没有生成节点')

  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1.6 },
    captureBeyondViewport: true,
  })
  writeFileSync(join(OUT, 'nodelog.png'), Buffer.from(shot.data, 'base64'))
  console.log('  →', join(OUT, 'nodelog.png'))
} catch (e) {
  console.error('失败：', e.message)
  process.exitCode = 1
} finally {
  try { ws?.close() } catch {}
  chrome.kill()
}
