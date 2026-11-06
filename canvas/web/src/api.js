// 后端 API 封装。所有请求走相对路径，开发时由 vite proxy 转给 8770。
const J = async (url, opts = {}) => {
  const r = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
  const text = await r.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`响应不是 JSON：${text.slice(0, 200)}`)
  }
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
  return data
}

export const getHealth = () => J('/api/health')
export const getTemplates = () => J('/api/templates')
export const getGraph = () => J('/api/graph')
export const saveGraph = (g) => J('/api/graph', { method: 'PUT', body: JSON.stringify(g) })
export const getModels = (kind) => J(`/api/models?kind=${kind}`)
export const getJobs = (limit = 80) => J(`/api/jobs?limit=${limit}`)
export const getMaterials = () => J('/api/materials')
export const compileCheck = (payload) => J('/api/compile', { method: 'POST', body: JSON.stringify(payload) })

// ---- 工作流导入
export const analyzeWorkflow = (graph, file) =>
  J('/api/workflow/analyze', { method: 'POST', body: JSON.stringify({ graph, file }) })
export const saveWorkflow = (payload) =>
  J('/api/workflow/save', { method: 'POST', body: JSON.stringify(payload) })
export const deleteTemplate = (name) =>
  J('/api/template/delete', { method: 'POST', body: JSON.stringify({ name }) })

export const runJob = (payload) =>
  J('/api/run', { method: 'POST', body: JSON.stringify(payload) })
export const cancelJob = (id) => J(`/api/jobs/${id}/cancel`, { method: 'POST' })

// 上传不能走 J()：那套固定了 JSON 头，FormData 必须让浏览器自己带 boundary
export const uploadImages = async (files) => {
  const fd = new FormData()
  for (const f of files) fd.append('file', f, f.name)
  const r = await fetch('/api/upload', { method: 'POST', body: fd })
  const text = await r.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`响应不是 JSON：${text.slice(0, 200)}`)
  }
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
  return data
}
