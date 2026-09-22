/**
 * 总览（首页）
 *
 * 版式：主视觉区在上、数据在下 —— 对齐用户要求「以大图/立绘为主视觉，数据压到下方」。
 *
 * 关于主视觉素材：原表「首页」的 DISPIMG 大图（image12）实测是**空图**
 * （237 万像素里 alpha>0 仅 46 万、颜色全为白/透明），作者的原画在某次保存时丢失。
 * 因此这里先用「深色渐变 + 品牌字 + 职业图标阵」做成体面的占位，
 * 一旦拿到立绘，只需把图片放到 src/renderer/public/hero/ 并填 HERO_IMAGE 即可切换。
 */
import { useCallback, useEffect, useState } from 'react';
import type { AppInfo, Player, SignupRow, SquadCatalog } from '@shared/types';
import { api, ApiError } from '../api';
import type { PageProps } from '../App';
import { CLASSES, TOTAL_MATCH_SLOTS, TOTAL_TOWERS_PER_SIDE } from '@shared/domain';
import { classIconSrc } from '../lib/assets';
type Target = 'roster' | 'match' | 'board' | 'settings';

interface Props extends PageProps {
  info: AppInfo | null;
  onCount: (n: number) => void;
  onGo: (k: Target) => void;
}

export default function OverviewPage({ onCount, onGo, info }: Props) {
  const [players, setPlayers] = useState<Player[]>([]);
  const [catalog, setCatalog] = useState<SquadCatalog | null>(null);
  /** 最近一场的报名表：职业只存在于报名记录里，所以职业分布按它统计 */
  const [latestSignups, setLatestSignups] = useState<SignupRow[]>([]);
  const [latestMatchLabel, setLatestMatchLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [rows, cat, matches] = await Promise.all([
        api.player.list(), api.meta.squads(), api.match.list(),
      ]);
      setPlayers(rows);
      setCatalog(cat);
      onCount(rows.length);
      if (matches.length) {
        const m = matches[0];
        const board = await api.signup.board(m.id);
        setLatestSignups(board.rows.filter((r) => r.signup !== null));
        setLatestMatchLabel(`${m.date} 第 ${m.indexInDay} 场`);
      } else {
        setLatestSignups([]);
        setLatestMatchLabel('');
      }
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [onCount]);

  useEffect(() => { void load(); }, [load]);

  // 职业分布：按最近一场报名表里的主职业统计
  const byClass = new Map<string, number>();
  for (const r of latestSignups) {
    if (!r.mainClass) continue;
    byClass.set(r.mainClass, (byClass.get(r.mainClass) ?? 0) + 1);
  }
  const active = players.filter((p) => p.status === 'active').length;
  const ready = latestSignups.filter((r) => r.signup === 'JOIN').length;
  const capacity = catalog?.capacity ?? TOTAL_MATCH_SLOTS;

  return (
    <>
      {error && <div className="msg msg--toast error">{error}</div>}

      {/* ── 首屏：深色剧场（照 seedance2_0 视觉特征，见根目录 DESIGN.md）——
          大留白 + 超大标题 + 药丸按钮 + 职业图标托盘；钉住不动，下滑被数据层盖住 ── */}
      <section className="hero hero--pinned home-hero home-dark">
        <div className="hero__body">
          <span className="home-eyebrow">All leagues · One universe</span>
          <h1 className="home-display">
            万象<span className="dot-sep">·</span>Omnia
          </h1>
          <div className="home-display-en">All leagues. One universe.</div>
          <p className="home-lede">
            万象归一，联赛集成。报名、排表、战报、评分、出勤都在同一处完成 ——
            职业只来自各场报名表，口径统一。
          </p>

          <div className="home-cta">
            <button className="home-btn" onClick={() => onGo('match')}>录入对局与战报</button>
            <button className="home-btn home-btn--ghost" onClick={() => onGo('roster')}>成员主档</button>
            <button className="home-btn home-btn--ghost" onClick={() => onGo('board')}>数据看板</button>
            <button className="home-btn home-btn--ghost" onClick={() => onGo('settings')}>战斗组与小队</button>
          </div>

          {/* 12 职业原色图标托盘：深色圆托 + 原色图标（图标禁止重染） */}
          <div className="home-tray" aria-hidden="true">
            {CLASSES.map((c) => {
              const src = classIconSrc(c.name);
              return (
                <span key={c.name} className="home-tray__item" title={c.name}>
                  <span className="home-tray__plate">
                    {src
                      ? <img src={src} alt="" />
                      : <i style={{ display: 'block', width: 14, height: 14, borderRadius: '50%', background: c.color }} />}
                  </span>
                  <span className="home-tray__label">{c.name}</span>
                </span>
              );
            })}
          </div>
        </div>

        <div className="home-scroll" aria-hidden="true">
          <span>下滑查看数据</span>
          <span>↓</span>
        </div>
      </section>

      {/* ── 数据层：**白底**（照 seedance2_0 滚动区），下滑时从下往上盖住首屏 ── */}
      <div className="hero-cover home-cover">
        <div className="home-section" style={{ paddingBottom: 0 }}>
          <span className="home-eyebrow">Overview</span>
          <h2 className="home-h2">今天的盘子</h2>
        </div>
      <div className="stat-grid">
        <div className="stat">
          <div className="k">成员总数</div>
          <div className="v">{players.length}<small> 人</small></div>
          <div className="hint" style={{ marginTop: 4 }}>在队 {active} · 本场报名 {latestSignups.length}</div>
        </div>
        <div className="stat">
          <div className="k">本场可上阵</div>
          <div className="v" style={{ color: ready >= capacity ? 'var(--ok)' : 'var(--warn)' }}>
            {ready}<small> / {capacity} 槽位</small>
          </div>
          <div className="hint" style={{ marginTop: 4 }}>
            {catalog ? `${catalog.squads.length} 支小队 · ${catalog.groups.length} 个战斗组` : '读取建制作战中…'}
          </div>
        </div>
        <div className="stat">
          <div className="k">每方塔数</div>
          <div className="v">{TOTAL_TOWERS_PER_SIDE}<small> 座（含高地塔）</small></div>
          
        </div>
        <div className="stat">
          <div className="k">分制</div>
          <div className="v">60<small> 基础 · 封顶 100</small></div>
          
        </div>
      </div>

      {/* 媒体展示区（照 seedance2_0 的视频卡阵）——
          目前用旧表抽出来的立绘占位；有真视频时把 <img> 换成 <video src autoplay muted loop playsinline /> */}
      <div className="home-section" style={{ paddingBottom: 8 }}>
        <span className="home-eyebrow">Showcase</span>
        <h2 className="home-h2">实战画面</h2>
        <p className="home-lede">
          一场对局从报名到结算的完整链路，都在同一屏里跑完。
        </p>
        <div className="home-media">
          <div className="home-media__frame">
            <img src={`${import.meta.env.BASE_URL}guide/image26.png`} alt="防守半区" />
            <span className="home-media__cap">防守半区</span>
          </div>
          <div className="home-media__frame">
            <img src={`${import.meta.env.BASE_URL}guide/image22.png`} alt="进攻半区" />
            <span className="home-media__cap">进攻半区</span>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <h3>职业分布（按本场报名表）{latestMatchLabel ? ` · ${latestMatchLabel}` : ''}</h3>
        {players.length === 0 ? (
          <div className="hint" style={{ padding: '12px 0' }}>
            还没有成员数据。去
            <button className="btn sm" style={{ margin: '0 6px' }} onClick={() => onGo('roster')}>成员主档</button>
            添加，或导入旧表名单。
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 6 }}>
            {CLASSES.map((c) => {
              const n = byClass.get(c.name) ?? 0;
              const max = Math.max(1, ...byClass.values());
              const iconSrc = classIconSrc(c.name);
              return (
                <div key={c.name} style={{ display: 'grid', gridTemplateColumns: '104px 1fr 52px', alignItems: 'center', gap: 10 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: c.color, fontSize: 12 }}>
                    {iconSrc
                      ? <img src={iconSrc} alt="" style={{ width: 17, height: 17, objectFit: 'contain' }} />
                      : <i style={{ width: 7, height: 7, borderRadius: '50%', background: c.color, display: 'inline-block' }} />}
                    {c.name}
                  </span>
                  <div className="ratebar ratebar--wide" style={{ background: 'var(--surface-2)' }}>
                    <i style={{ width: `${(n / max) * 100}%`, background: c.color }} />
                  </div>
                  <span className="num" style={{ textAlign: 'right', color: n ? 'var(--text)' : 'var(--text-faint)' }}>{n}</span>
                </div>
              );
            })}
          </div>
        )}
        
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
      </div>
    </>
  );
}
