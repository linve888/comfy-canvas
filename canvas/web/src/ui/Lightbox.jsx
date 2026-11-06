import { useEffect, useState } from 'react'

/** 全屏看图：产物集合 + 左右翻，Esc 关闭。 */
export default function Lightbox({ items, index, onClose }) {
  const [i, setI] = useState(index || 0)
  useEffect(() => setI(index || 0), [index])
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight') return setI((v) => Math.min(items.length - 1, v + 1))
      if (e.key === 'ArrowLeft') return setI((v) => Math.max(0, v - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items.length, onClose])

  if (!items?.length) return null
  const cur = items[i]

  return (
    <div className="lightbox" onClick={onClose}>
      <div className="lb-stage" onClick={(e) => e.stopPropagation()}>
        {cur.kind === 'video' ? (
          <video src={cur.url} controls autoPlay preload="metadata" />
        ) : cur.kind === 'audio' ? (
          <div className="lb-audio">
            <audio src={cur.url} controls autoPlay />
          </div>
        ) : (
          <img src={cur.url} alt={cur.filename} />
        )}
      </div>
      <div className="lb-bar" onClick={(e) => e.stopPropagation()}>
        <span className="lb-name">{cur.filename}</span>
        {items.length > 1 && (
          <span className="lb-nav">
            <button onClick={() => setI(Math.max(0, i - 1))} disabled={i === 0}>
              ‹
            </button>
            <span>
              {i + 1} / {items.length}
            </span>
            <button onClick={() => setI(Math.min(items.length - 1, i + 1))} disabled={i === items.length - 1}>
              ›
            </button>
          </span>
        )}
        <a className="lb-dl" href={cur.url} download={cur.filename}>
          下载
        </a>
        <button onClick={onClose}>关闭</button>
      </div>
    </div>
  )
}
