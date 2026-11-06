import React from 'react'
import ReactDOM from 'react-dom/client'
import { ReactFlowProvider } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './style.css'
import App from './App.jsx'
import { rlog } from './log.js'

// 前端报错上报：画布跑在本地后端里，出问题时把错误回传，便于排查
// （开发时看不到浏览器控制台，这是唯一可靠的通道）
// 同时走一条 rlog：崩溃和生成链路写进同一条时间线，能看出「是点了生成之后崩的」
const report = (kind, detail) => {
  const msg = String(detail).slice(0, 2000)
  try {
    fetch('/api/error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, detail: msg, url: location.href }),
    }).catch(() => {})
  } catch {
    /* 上报失败不影响主流程 */
  }
  if (kind !== 'boot') rlog(`ui.${kind}`, { detail: msg.split('\n')[0] }, 'E')
}

window.addEventListener('error', (e) =>
  report('error', `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`)
)
window.addEventListener('unhandledrejection', (e) => report('rejection', e.reason?.stack || e.reason))

try {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <ReactFlowProvider>
        <App />
      </ReactFlowProvider>
    </React.StrictMode>
  )
  report('boot', 'react mounted')
} catch (e) {
  report('fatal', e?.stack || e)
  document.getElementById('root').innerHTML =
    '<pre style="color:#d88;padding:20px">启动失败：' + String(e) + '</pre>'
}
