interface Props {
  title: string;
  icon: string;
  todo: string[];
  note?: string;
}

export default function PlaceholderPage({ title, icon, todo, note }: Props) {
  return (
    <div className="card">
      <div className="placeholder">
        <div className="big">{icon}</div>
        <div style={{ fontSize: 15, color: 'var(--text)' }}>{title} · 待接入</div>
        <div style={{ maxWidth: 640, textAlign: 'left', marginTop: 8 }}>
          <div style={{ color: 'var(--text-dim)', marginBottom: 6 }}>本模块计划包含：</div>
          <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-dim)' }}>
            {todo.map((t) => <li key={t} style={{ marginBottom: 3 }}>{t}</li>)}
          </ul>
          {note && <div className="hint" style={{ marginTop: 10 }}>{note}</div>}
        </div>
      </div>
    </div>
  );
}
