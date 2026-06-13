// Floating panel that shows AI-suggested next nodes. Each suggestion can be
// added to the canvas (and wired from the anchor node) with one click.
export default function SuggestionsPanel({ loading, error, suggestions, onAdd, onClose }) {
  return (
    <aside className="suggest-panel">
      <div className="suggest-panel__header">
        <span className="suggest-panel__title">✨ Suggested next steps</span>
        <button className="suggest-panel__close" title="Close" onClick={onClose}>×</button>
      </div>
      <div className="suggest-panel__body">
        {loading && <p className="suggest-panel__hint">Asking the AI service…</p>}
        {error && <p className="suggest-panel__error">{error}</p>}
        {!loading && !error && suggestions.length === 0 && (
          <p className="suggest-panel__hint">No suggestions returned.</p>
        )}
        {!loading &&
          !error &&
          suggestions.map((s, i) => (
            <div className="suggest-item" key={`${s.type}-${i}`}>
              <div className="suggest-item__main">
                <span className="suggest-item__label">{s.label || s.type}</span>
                <span className="suggest-item__type">{s.type}</span>
              </div>
              {s.reason && <p className="suggest-item__reason">{s.reason}</p>}
              <button className="suggest-item__add" onClick={() => onAdd(s)}>
                + Add
              </button>
            </div>
          ))}
      </div>
    </aside>
  )
}
