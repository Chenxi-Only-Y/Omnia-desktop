import { useCallback, useEffect, useState } from 'react';
import type { AppInfo, Player } from '@shared/types';
import { api, ApiError } from '../api';
import type { PageProps } from '../App';
import { CLASSES, SQUADS, TOTAL_MATCH_SLOTS, TOTAL_TOWERS_PER_SIDE, classIconUrl } from '@shared/domain';

interface Props extends PageProps {
  info: AppInfo | null;
  onCount: (n: number) => void;
  onGoRoster: () => void;
}

export default function OverviewPage({ classes, onCount, onGoRoster, info }: Props) {
  const [players, setPlayers] = useState<Player[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const rows = await api.player.list();
      setPlayers(rows);
      onCount(rows.length);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [onCount]);

  useEffect(() => { void load(); }, [load]);

  const byClass = new Map<string, number>();
  for (const p of players) {
    if (!p.mainClass) continue;
    byClass.set(p.mainClass, (byClass.get(p.mainClass) ?? 0) + 1);
  }
  const maxClass = Math.max(1, ...byClass.values());
  const activeCount = players.filter((p) => p.status === 'active').length;
  const withMain = players.filter((p) => p.mainClass).length;
  const readyToPlay = players.filter((p) => p.status === 'active' && p.mainClass).length;

  return (
    <>
      {error && <div className="msg error">{error}</div>}

      <div className="stat-grid">
        <div className="stat">
          <div className="k">成员总数</div>
          <div className="v">{players.length}<small> 人</small></div>
        </div>
        <div className="stat">
          <div className="k">在队（可上场）</div>
          <div className="v">{activeCount}<small> 人</small></div>
        </div>
        <div className="stat">
          <div className="k">可编入阵容</div>
          <div className="v" style={{ color: readyToPlay >= TOTAL_MATCH_SLOTS ? 'var(--ok)' : 'var(--warn)' }}>
            {readyToPlay}<small> / {TOTAL_MATCH_SLOTS} 个槽位</small>
          </div>
        </div>
        <div className="stat">
          <div className="k">职业信息完整度</div>
          <div className="v">
            {players.length ? Math.round((withMain / players.length) * 100) : 0}<small> %</small>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <h3>职业分布（主职业）</h3>
        {players.length === 0 ? (
          <div className="hint" style={{ padding: '12px 0' }}>
            还没有成员数据。去
            <button className="btn sm" style={{ margin: '0 6px' }} onClick={onGoRoster}>成员主档</button>
            添加，或导入旧表的成员名单。
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 6 }}>
            {CLASSES.map((c) => {
              const n = byClass.get(c.name) ?? 0;
              const pct = (n / maxClass) * 100;
              const icon = classIconUrl(c.name);
              const iconSrc = icon ? `${import.meta.env.BASE_URL}${icon.replace(/^\.\//, '')}` : null;
              return (
                <div key={c.name} style={{ display: 'grid', gridTemplateColumns: '104px 1fr 52px', alignItems: 'center', gap: 10 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: c.color, fontSize: 12 }}>
                    {iconSrc
                      ? <img src={iconSrc} alt="" style={{ width: 17, height: 17, objectFit: 'contain' }} />
                      : <span style={{ width: 7, height: 7, borderRadius: '50%', background: c.color, display: 'inline-block' }} />}
                    {c.name}
                    {!iconSrc && <span title="缺图标素材" style={{ color: 'var(--warn)' }}>·</span>}
                  </span>
                  <div style={{ background: '#171a22', borderRadius: 4, height: 16, overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: c.color, opacity: 0.85 }} />
                  </div>
                  <span className="num" style={{ textAlign: 'right', color: n ? 'var(--text)' : 'var(--text-faint)' }}>{n}</span>
                </div>
              );
            })}
          </div>
        )}
        <div className="hint">12 职业的口径与平衡系数来自原表「下滑预选」，未登记的职业会在成员列表里标黄问号。</div>
      </div>

      <div className="card">
        <h3>当前配置（来自设计基准 v2）</h3>
        <div className="stat-grid">
          <div className="stat"><div className="k">上场结构</div>
            <div className="v" style={{ fontSize: 15 }}>
              10 支小队 × 6 人 <small>= {TOTAL_MATCH_SLOTS} 槽</small>
            </div>
            <div className="hint" style={{ marginTop: 4 }}>
              {SQUADS.filter((s) => s.group.startsWith('防守')).length} 支防守队 ·{' '}
              {SQUADS.filter((s) => s.group.startsWith('进攻')).length} 支进攻队
            </div>
          </div>
          <div className="stat"><div className="k">每方塔数</div>
            <div className="v">{TOTAL_TOWERS_PER_SIDE}<small> 座（含高地塔）</small></div>
            <div className="hint" style={{ marginTop: 4 }}>拆高地塔 → 大旗；大旗不单独录，由胜负代替</div>
          </div>
          <div className="stat"><div className="k">分制</div>
            <div className="v">60 <small>基础 · 封顶 100</small></div>
            <div className="hint" style={{ marginTop: 4 }}>团队分 0–20 · 个人分 0–40（算法待定）</div>
          </div>
          <div className="stat"><div className="k">已登记职业</div>
            <div className="v">{classes.length}<small> / 12</small></div>
            <div className="hint" style={{ marginTop: 4 }}>惊鸿图标素材缺失，可在设置里补</div>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>关于</h3>
        <div style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-dim)' }}>
          <div style={{ fontSize: 15, color: 'var(--text)', letterSpacing: '.3px' }}>
            万象<span style={{ color: 'var(--accent)' }}>·</span>Omnia
          </div>
          <div style={{ fontStyle: 'italic' }}>All leagues. One universe.</div>
          <div>万象归一，联赛集成。</div>
        </div>
      </div>

      <div className="card">
        <h3>运行环境</h3>
        {info ? (
          <div style={{ display: 'grid', gap: 4, fontSize: 12, color: 'var(--text-dim)' }}>
            <div>应用版本：{info.version}</div>
            <div>Electron {info.electron} · Chromium {info.chrome} · Node {info.node}</div>
            <div>平台：{info.platform}</div>
            <div style={{ wordBreak: 'break-all' }}>数据库：{info.dbPath}</div>
          </div>
        ) : (
          <div className="hint">读取中…</div>
        )}
      </div>
    </>
  );
}
