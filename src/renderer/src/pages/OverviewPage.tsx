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
import type { Player, SignupRow, SquadCatalog } from '@shared/types';
import { api, errText } from '../api';
import type { PageProps } from '../App';
import { CLASSES, TOTAL_MATCH_SLOTS, TOTAL_TOWERS_PER_SIDE } from '@shared/domain';
import { classIconSrc } from '../lib/assets';
type Target = 'roster' | 'match' | 'board' | 'settings';

interface Props extends PageProps {
  /** 「关于 / 运行环境」已移到设置页，首页不再需要 AppInfo */
  onCount: (n: number) => void;
  onGo: (k: Target) => void;
}

export default function OverviewPage({ onCount, onGo }: Props) {
  const [players, setPlayers] = useState<Player[]>([]);
  const [catalog, setCatalog] = useState<SquadCatalog | null>(null);
  /** 最近一场的报名表：职业只存在于报名记录里，所以职业分布按它统计 */
  const [latestSignups, setLatestSignups] = useState<SignupRow[]>([]);
  const [latestMatchLabel, setLatestMatchLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [rows, matches] = await Promise.all([api.player.list(), api.match.list()]);
      setPlayers(rows);
      onCount(rows.length);
      if (matches.length) {
        const m = matches[0];
        /* 建制已按场次独立（用户口径），总览的"可上阵槽位"要按**最近一场**统计，
           不能再拿一份全局建制（那会与实际排表页对不上）。 */
        const [board, cat] = await Promise.all([api.signup.board(m.id), api.meta.squads(m.id)]);
        setCatalog(cat);
        setLatestSignups(board.rows.filter((r) => r.signup !== null));
        setLatestMatchLabel(`${m.date} 第 ${m.indexInDay} 场`);
      } else {
        setCatalog(null);
        setLatestSignups([]);
        setLatestMatchLabel('');
      }
      setError(null);
    } catch (err) {
      setError(errText(err));
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

  /* 首屏与数据层的**双向**吸附（用户口径：「只吸附了一次」—— 之前只有向下那一次）。

     两个吸附点：首屏顶部（scrollTop = 0）与数据层顶部（.home-cover 的绝对位置）。
       向下：在首屏顶部轻推 → 吸到数据层顶部
       向上：在数据层顶部轻推 → 吸回首屏顶部

     要点：
       ① 处于吸附点时才累计，且**先 preventDefault** 拦住原生滚动
          （否则 scrollTop 会立刻离开吸附点、累计值被清零 —— 上一版栽过）；
       ② 累计满 110px 才吸（滚轮一格约 100px），不神经质；
       ③ 吸附期间上锁 600ms（补间 420ms + 余量），并在此期间 preventDefault，
          既避免连吸两次，也避免原生滚动与补间互相打架造成抖动；
       ④ rAF + easeInOutCubic 补间 420ms（用户口径：向上向下都快点）—— 仍顺滑，但更利落。

     滚动容器动态解析：能用 .content 就用，否则退回 document.scrollingElement。 */
  useEffect(() => {
    const pickScroller = (): HTMLElement => {
      const c = document.querySelector('.content') as HTMLElement | null;
      if (c && c.scrollHeight > c.clientHeight + 4) return c;
      return (document.scrollingElement as HTMLElement) || document.documentElement;
    };
    let acc = 0;
    let locked = false;
    let timer = 0;
    const glide = (sc: HTMLElement, to: number) => {
      locked = true;
      acc = 0;
      const from = sc.scrollTop;
      const t0 = performance.now();
      const ms = 420;
      const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
      const step = (now: number) => {
        const k = Math.min(1, (now - t0) / ms);
        sc.scrollTop = from + (to - from) * ease(k);
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { locked = false; }, 600);
    };
    const onWheel = (e: WheelEvent) => {
      // 动画期间**也要拦住原生滚动**：否则补间在改 scrollTop、原生滚动也在改，
      // 两边打架就是用户看到的"上下抖动"。这是上一版直接 return 造成的。
      if (locked) { e.preventDefault(); return; }
      const sc = pickScroller();
      const cover = document.querySelector('.home-cover') as HTMLElement | null;
      if (!cover) { acc = 0; return; }
      const base = sc.getBoundingClientRect().top;
      const coverTop = cover.getBoundingClientRect().top - base + sc.scrollTop;
      // 武装范围（用户口径：向上时"有一点首屏出现"就要吸附）——
      // 整个过渡区（0 … 数据层顶部）都算，而不是只在吸附点 ±6px 内。
      // 向下：还没到数据层顶部 → 轻推即滑到数据层；
      // 向上：已离开首屏顶部、且首屏已露出一部分 → 轻推即回首屏。
      // 阈值：向下 110（一格约 100，要"确实推一下"）；向上 70（更灵敏，用户要求）。
      if (e.deltaY > 0) {
        if (sc.scrollTop >= coverTop - 6) { acc = 0; return; }
        e.preventDefault();
        acc = Math.max(0, acc) + e.deltaY;
        if (acc >= 110) glide(sc, coverTop);
      } else if (e.deltaY < 0) {
        if (sc.scrollTop <= 6 || sc.scrollTop > coverTop + 6) { acc = 0; return; }
        e.preventDefault();
        acc = Math.min(0, acc) + e.deltaY;
        if (acc <= -70) glide(sc, 0);
      } else { acc = 0; }
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('wheel', onWheel);
      window.clearTimeout(timer);
    };
  }, []);
  return (
    <>
      {error && <div className="msg msg--toast error">{error}</div>}

      {/* ── 首屏：深色剧场（照 seedance2_0 视觉特征，见根目录 DESIGN.md）——
          大留白 + 超大标题 + 药丸按钮 + 职业图标托盘；钉住不动，下滑被数据层盖住 ── */}
      <section className="hero hero--pinned home-hero home-dark">
        {/* 用户口径：
            ① 快捷按钮挪到**最上面居中**
            ② 品牌块（eyebrow / 万象·Omnia / 英文 / 说明）挪到**左下角**
            ③ **职业托盘整个删掉** */}
        <div className="hero__body">
          {/* 用户口径 2026-09：首屏**不放按钮**。
              所有页面入口都在顶栏常驻导航里，首屏只留品牌块
              （原先这里有一行按钮，与顶栏导航重复）。 */}
          <div className="home-brand">
            <span className="home-eyebrow">All leagues · One universe</span>
            <h1 className="home-display">
              万象<span className="dot-sep">·</span>Omnia
            </h1>
            <div className="home-display-en">All leagues. One universe.</div>
            <p className="home-lede">
              万象归一，联赛集成。报名、排表、战报、评分、出勤都在同一处完成 ——
              职业只来自各场报名表，口径统一。
            </p>
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
          <div className="hint" style={{ marginTop: 4 }}>在帮 {active} · 本场报名 {latestSignups.length}</div>
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

      
      {/* 原先这里有一块「实战画面」（Showcase + 两张攻略图）。
          用户口径 2026-09：不需要这块，整体删除。 */}

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
                  {/* 职业名用**主色文字**，颜色只留给图标/色点。
                      职业色是高饱和亮色（实测白底对比度：妙音 1.70、惊鸿 1.76、
                      潮光 1.89），直接当字色会看不清 —— 12 个里 11 个不达 4.5。
                      这与 ClassChip 的既有口径一致（见 components/ClassChip.tsx：
                      职业色只用于色点与描边，标签文字统一用主色）。 */}
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text)', fontSize: 12 }}>
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

      {/* 用户口径 2026-09：「关于」与「运行环境」已移到**设置页 → 数据与兼容**，
          首页只保留数据相关内容，这里不再渲染这两块。 */}
      </div>
    </>
  );
}
