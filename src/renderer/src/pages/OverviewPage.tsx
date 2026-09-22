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
/** 换成真实立绘时填文件名，例如 'hero/cover.png'（相对 public/） */
const HERO_IMAGE: string | null = null;

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
  // 用户口径：首页背景就用那套**渐变铺满**（不用上传的图），首屏钉住不动。
  // 上传的中缝图仍然只用于排表中缝，两者互不影响。
  const heroSrc = HERO_IMAGE ? `${import.meta.env.BASE_URL}${HERO_IMAGE}` : null;

  return (
    <>
      {error && <div className="msg msg--toast error">{error}</div>}

      {/* ── 首屏：渐变铺满、钉住不动（下滑时下面的数据层盖上来） ── */}
      <section className="hero hero--pinned">
        {heroSrc && <img className="hero__img" src={heroSrc} alt="" />}
        <div className="hero__veil" aria-hidden="true" />
        <div className="hero__body">
          <div className="hero__brand">
            万象<span className="dot-sep">·</span>Omnia
          </div>
          <div className="hero__slogan">All leagues. One universe.</div>
          <div className="hero__slogan hero__slogan--cn">万象归一，联赛集成</div>

          <div className="hero__cta">
            <button className="hero__btn hero__btn--primary" onClick={() => onGo('match')}>录入对局与战报</button>
            <button className="hero__btn" onClick={() => onGo('roster')}>成员主档</button>
            <button className="hero__btn" onClick={() => onGo('board')}>数据看板</button>
            <button className="hero__btn" onClick={() => onGo('settings')}>战斗组与小队</button>
          </div>
        </div>

        {/* 职业图标阵 —— 既是装饰也是"这个系统认识哪些职业"的表达 */}
        <div className="hero__classes" aria-hidden="true">
          {CLASSES.map((c) => {
            const src = classIconSrc(c.name);
            return (
              <span key={c.name} className="hero__class" title={c.name}>
                {src
                  ? <img src={src} alt="" />
                  : <i style={{ background: c.color }} />}
                <em style={{ color: c.color }}>{c.name}</em>
              </span>
            );
          })}
        </div>

        {/* 下滑提示：告诉用户下面还有东西 */}
        <div className="hero__scroll" aria-hidden="true">
          <span>下滑查看数据</span>
          <span className="hero__scroll-arrow">↓</span>
        </div>
      </section>

      {/* ── 数据层：不透明背景 + 更高层级 → 滚动时从下往上盖住首屏 ── */}
      <div className="hero-cover">
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
          <div className="hint" style={{ marginTop: 4 }}>拆高地塔 → 大旗；大旗由胜负代替</div>
        </div>
        <div className="stat">
          <div className="k">分制</div>
          <div className="v">60<small> 基础 · 封顶 100</small></div>
          <div className="hint" style={{ marginTop: 4 }}>团队分 0–20 · 个人分 0–40（算法待定）</div>
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
        <div className="hint">职业不再存在成员主档里 —— 它来自各场次的报名表，因此这里统计的是最有参考价值的「本场报名」分布。12 职业口径与平衡系数来自原表「下滑预选」。</div>
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
        <div className="hint">
          首屏用的是主题渐变（原表「首页」的大图实测是空图，作者原画已丢失）。
          首屏钉住不动，向下滚动时数据层会从下往上盖住它。
        </div>
      </div>
      </div>
    </>
  );
}
