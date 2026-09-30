import {  useCallback, useEffect, useMemo, useState   } from 'react';
import { createPortal } from 'react-dom';
import type { PlayerDetail, PlayerMatchRow } from '@shared/types';
import { api, errText } from '../api';
import type { PageProps } from '../App';
import ClassChip from '../components/ClassChip';
import RadarChart from '../components/RadarChart';
import { localUrl } from '../lib/localFile';
import { PART_STATE_LABEL } from '@shared/domain';

interface Props extends PageProps {
  playerId: number;
  onBack: () => void;
}


const num = (v: number): string => (v === 0 ? '—' : v.toLocaleString());

export default function PlayerDetailPage({ playerId, classMap, onBack }: Props) {
  const [detail, setDetail] = useState<PlayerDetail | null>(null);
  const [scores, setScores] = useState<Record<number, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [onlyFilled, setOnlyFilled] = useState(false);

  /** 页点数 = 第 1 屏 + 4 个内容块（改页面结构要同步改） */
  const PAGE_COUNT = 6;   /* 第 1 屏 + 信息页 + 概览 3 页 + 逐场 1 页 */
  const [pageIdx, setPageIdx] = useState(0);

  /* 页点：监听滚动容器，取"离容器顶部最近的那一页"；
     顺便把自绘滚动条（.sb-track，挂在 body 上）藏起来 —— 本页改用页点。 */
  useEffect(() => {
    const sc = document.querySelector('.content') as HTMLElement | null;
    if (!sc) return;
    const bars = Array.from(document.querySelectorAll<HTMLElement>('.sb-track'));
    bars.forEach((b) => { b.style.display = 'none'; });
    /* 翻页：**自己缓动**（rAF + easeOutCubic），不依赖浏览器原生 smooth。
       · 落点 = 各页真实 offsetTop（不是 n×每页高 —— 两者差 70px，会让浏览器再吸一下）
       · 动画期间临时把 scroll-snap 关掉，避免"动画 + 吸附"互相拉扯（就是"不丝滑"的根源）
       · 一次滚轮 = 翻一页；650ms 锁住防连翻 */
    const scroller = sc;
    const easeOutCubic = (p: number) => 1 - Math.pow(1 - p, 3);
    const sections = () => Array.from(document.querySelectorAll<HTMLElement>('.md-hero, .md-block'));
    const pageOffsets = () => {
      const top = scroller.getBoundingClientRect().top;
      return sections().map((el) => Math.round(el.getBoundingClientRect().top - top + scroller.scrollTop));
    };
    const nearestPage = () => {
      const offs = pageOffsets();
      let best = 0;
      let bestD = Number.POSITIVE_INFINITY;
      offs.forEach((o, i) => {
        const d = Math.abs(o - scroller.scrollTop);
        if (d < bestD) { bestD = d; best = i; }
      });
      return best;
    };
    let anim = 0;
    let lock = 0;
    let last = -1;
    const animateTo = (target: number) => {
      window.cancelAnimationFrame(anim);
      const from = scroller.scrollTop;
      const dist = target - from;
      if (Math.abs(dist) < 1) return;
      const dur = Math.min(700, 320 + Math.abs(dist) * 0.25);
      const t0 = performance.now();
      const prevSnap = scroller.style.scrollSnapType;
      scroller.style.scrollSnapType = 'none';        // 动画期间关吸附，避免互相拉扯
      const step = (now: number) => {
        const p = Math.min(1, (now - t0) / dur);
        scroller.scrollTop = from + dist * easeOutCubic(p);
        if (p < 1) anim = window.requestAnimationFrame(step);
        else scroller.style.scrollSnapType = prevSnap;
      };
      anim = window.requestAnimationFrame(step);
    };
    const go = (i: number) => {
      const offs = pageOffsets();
      const n = Math.min(offs.length - 1, Math.max(0, i));
      animateTo(offs[n]);
      last = n;
      setPageIdx(n);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const now = Date.now();
      if (now < lock) return;
      lock = now + 650;
      go(nearestPage() + (e.deltaY > 0 ? 1 : -1));
    };
    let raf = 0;
    const tick = () => {
      const n = nearestPage();
      if (n !== last) { last = n; setPageIdx(n); }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    scroller.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.cancelAnimationFrame(raf);
      window.cancelAnimationFrame(anim);
      scroller.removeEventListener('wheel', onWheel);
      scroller.style.scrollSnapType = '';
      bars.forEach((b) => { b.style.display = ''; });
    };  }, [detail]);

  const load = useCallback(async () => {
    try {
      const d = await api.player.detail(playerId);
      setDetail(d);
      // 逐场得分：按参与记录 id 关联（分数按规则集分开存，这里取该场当前分数）
      const pairs = await Promise.all(d.matches.map(async (m) => {
        const s = await api.match.scores(m.matchId);
        return [m.matchId, s] as const;
      }));
      const map: Record<number, number> = {};
      for (const [matchId, list] of pairs) {
        const hit = list.find((x) => x.playerId === playerId);
        if (hit) map[matchId] = hit.total;
      }
      setScores(map);
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
  }, [playerId]);

  useEffect(() => { void load(); }, [load]);

  /** 趋势：按日期正序（画线用），只取有战报的上场场次 */
  const trend = useMemo(() => {

    if (!detail) return [];
    return detail.matches
      .filter((m) => m.state === 'PLAY' && m.statFilled)
      .slice()
      .reverse();
  }, [detail]);

  const maxTrend = useMemo(() => {
    const vals = trend.flatMap((m) => [m.effDmg, m.effTower]);
    return Math.max(1, ...vals);
  }, [trend]);

  /* 出错时**必须留退路**（用户反馈：「卡住」）——
     原来这里只 return 一个红条，连「← 成员主档」都没有：一旦成员被删掉
     （比如列表是旧的/刚被别处删了），详情页就变成一个没有出口的红条。
     现在给：返回 + 重试，并对"这个人已经不存在"给出人话解释。 */
  if (error) {
    const gone = /不存在|已删除/.test(error);
    /* 翻页吸附：真正的滚动元素是外层 .content，所以进本页给它加 .md-snap，离开时摘掉 */  return (
      <div className="md-block">
        <div className="toolbar" style={{ marginBottom: 8 }}>
          <button className="btn" onClick={onBack}>← 成员主档</button>
          <h3 style={{ margin: 0 }}>成员详情</h3>
          <div className="spacer grow" />
          <button className="btn ghost" onClick={() => void load()}>重试</button>
        </div>
        <div className="msg error">{error}</div>
        {gone && (
          <div className="hint">
            这个人可能已经被删掉了（列表里已经不存在）。点「← 成员主档」回去即可，那边会自动刷新。
          </div>
        )}
      </div>
    );
  }
  if (!detail) return <div className="md-block"><div className="hint">加载中…</div></div>;

  const { player, totals, radar, teamAverage } = detail;
  // 职业不再挂在主档上：用该成员最近一场报名表里的主职业着色
  const latestCls = detail.matches.map((m) => m.classUsed).find((c) => c) ?? '';
  const clsColor = classMap.get(latestCls)?.color ?? 'var(--fg)';
  const listRows = onlyFilled
    ? detail.matches.filter((m) => m.statFilled)
    : detail.matches;
  /** 有分数的场次（用于均分与趋势） */
  const scoredRows = detail.matches.filter((m) => scores[m.matchId] !== undefined);
  const avgScore = scoredRows.length
    ? scoredRows.reduce((n, m) => n + scores[m.matchId], 0) / scoredRows.length
    : null;

  const cell = (v: number, extra?: string) => (
    <td className="num" style={v === 0 ? { color: 'var(--text-faint)' } : undefined}>
      {v === 0 ? '—' : v.toLocaleString()}{extra}
    </td>
  );

  const bgUrl = localUrl(player.bgMedia);
  const isVideo = /\.(mp4|webm|mov|mkv)$/i.test(player.bgMedia || '');


  return (
    <>
      {/* 整页背景层（除顶部导航栏外）：有背景媒体就播它，否则透出默认壁纸。
          渐变只有这一层、连续加深 —— 第 1 屏到第 2 屏平滑过渡，所以不会出现分界线。 */}
      {createPortal(
        <div className="md-bg" aria-hidden="true">
        {/* 素材自己的模糊放大版铺满整屏（补左侧那条缝，做法同帮会封面） */}
        {bgUrl && (isVideo
          ? <video className="md-bg__blur" src={bgUrl} autoPlay muted loop playsInline />
          : <img className="md-bg__blur" src={bgUrl} alt="" />)}
        {bgUrl && (isVideo
          ? (
            <video
              className="md-bg__sharp"
              src={bgUrl}
              autoPlay muted loop playsInline
              /* 显式再 play 一次：Chromium 的自动播放策略偶尔仍会把 <video> 挂起，
                 表现就是"导入了但背景不动"（停在第一帧）。ref 回调不是 hook，安全。 */
              /* 起播要等数据就绪：挂载时立刻 play() 常常因"还没拿到 src"被拒（实测 paused 一直 true），
                 所以在 onLoadedData 里再试一次。 */
              ref={(el) => { if (el) el.muted = true; }}
              onLoadedData={(e) => { const el = e.currentTarget; el.muted = true; void el.play().catch(() => { /* 等用户手势 */ }); }}
            />
          )
          : <img className="md-bg__sharp" src={bgUrl} alt="" />)}
        {/* 第 1 屏色调与首屏一致：左→右渐变（左暗右透） */}
        <div className="md-bg__tone" />
        {/* 滚下去之后的额外压暗：透明度由滚动位置连续给值 */}
          <div className="md-bg__dark" />
        </div>,
        document.body,
      )}

      {/* 第 1 屏：左下角大字号 ID；其上 介绍（3 行最小字）→ 个性签名 → 橙武标 */}
      <section className="md-hero">
        <button className="md-hero__back btn" onClick={onBack}>← 成员主档</button>
        <div className="md-hero__left">
          {player.orangeWeapon === '有' && <span className="md-ow">⚜ 橙武</span>}
          {player.signature && <div className="md-hero__sign">{player.signature}</div>}
          {player.intro && <div className="md-hero__intro">{player.intro}</div>}
          <h1 className="md-hero__id">{player.gameId}</h1>
        </div>
      </section>

      {/* 右侧页点：每页一个点，当前页那个填充满。
           ⚠️ 必须 Portal 到 body：本页外层有带 transform 的祖先（.gpage 的页签动画），
           否则 fixed 会被降级成 absolute，页点就跟着内容滚了（用户实测"页点不固定"）。 */}
      {createPortal(
        <div className="md-dots">
          {Array.from({ length: PAGE_COUNT }).map((_, i) => (
            <button
              key={i}
              type="button"
              className={`md-dot${i === pageIdx ? ' md-dot--on' : ''}`}
              title={`第 ${i + 1} 页`}
              onClick={() => {
                const sc = document.querySelector('.content') as HTMLElement | null;
                if (sc) sc.scrollTo({ top: i * (window.innerHeight - 52), behavior: 'smooth' });
              }}
            />
          ))}
        </div>,
        document.body,
      )}

      <div className="md-block">
        <div className="toolbar" style={{ marginBottom: 8 }}>
          <button className="btn" onClick={onBack}>← 成员主档</button>
          <h3 style={{ margin: 0 }}>{player.gameId}</h3>
          {/* 职业来自报名表（分场次），这里显示最近一场用过的职业 */}
          {latestCls && <ClassChip name={latestCls} classMap={classMap} />}
          {player.noteRole && <span className="badge-note">{player.noteRole}</span>}
          {/* 历史用名：改名前的旧名（旧战报/旧报名靠它认人） */}
          {(player.aliases?.length ?? 0) > 0 && (
            <span className="alias-badge"
                  title={`历史用名：${(player.aliases ?? []).join('、')}`}>
              曾用 {(player.aliases ?? []).join('、')}
            </span>
          )}
          <span className={`badge-state ${player.status}`}>
            {player.status === 'active' ? '在帮' : player.status === 'left' ? '离帮' : '暂离'}
          </span>
          <div className="spacer grow" />
          <span className="meta">入帮序 {player.joinedOrder ?? '—'} · 麦 {player.mic || '—'}</span>
        </div>
        {player.remark && <div className="hint">备注：{player.remark}</div>}
      </div>

      <div className="stat-grid" style={{ marginTop: 12 }}>
        <div className="stat"><div className="k">有记录场次</div><div className="v">{totals.matches}</div>
          <div className="hint" style={{ marginTop: 4 }}>
            上场 {totals.plays} · 替补 {totals.benches} · 请假 {totals.leaves}
          </div>
        </div>
        <div className="stat">
          <div className="k">战报完整度</div>
          <div className="v" style={{ color: totals.statFilled === totals.plays ? 'var(--ok)' : 'var(--warn)' }}>
            {totals.statFilled}<small> / {totals.plays} 场</small>
          </div>
          
        </div>
        <div className="stat"><div className="k">有效击杀（含清泉）</div><div className="v">{num(totals.effKills)}</div></div>
        <div className="stat"><div className="k">有效人伤</div>
          <div className="v" style={{ fontSize: 18 }}>{totals.effDmg.toLocaleString()}</div></div>
        <div className="stat"><div className="k">有效塔伤</div>
          <div className="v" style={{ fontSize: 18 }}>{totals.effTower.toLocaleString()}</div></div>
        <div className="stat"><div className="k">治疗 / 承伤</div>
          <div className="v" style={{ fontSize: 16 }}>
            {totals.healing.toLocaleString()}<small> / {totals.taken.toLocaleString()}</small>
          </div>
        </div>
        <div className="stat"><div className="k">重伤 / 复活</div>
          <div className="v" style={{ fontSize: 18 }}>{totals.deaths}<small> / {totals.revives}</small></div>
          <div className="hint" style={{ marginTop: 4 }}>
            场均重伤 {totals.statFilled ? (totals.deaths / totals.statFilled).toFixed(2) : '—'}
          </div>
        </div>
        <div className="stat"><div className="k">已有评分的场次</div>
          <div className="v">{scoredRows.length}<small> 场</small></div>
          <div className="hint" style={{ marginTop: 4 }}>
            {avgScore === null
              ? '还没算过分（去对局的「本场评分」页签计算）'
              : `平均 ${avgScore.toFixed(1)} 分`}
          </div>
        </div>
      </div>


        <>
          <div className="md-block">
            <h3>六维对比（个人场均 vs 团队人均）</h3>
            {totals.statFilled === 0 ? (
              <div className="hint">这个人还没有填写过战报，无法做能力对比。</div>
            ) : (
              <div className="radar-wrap">
                <RadarChart axes={radar} color={clsColor} size={300} />
                <div className="radar-legend">
                  <div className="radar-legend__row">
                    <span className="lg" style={{ background: clsColor || 'var(--line-strong)' }} />
                    <b>{player.name}</b> 场均
                  </div>
                  <div className="radar-legend__row">
                    <span className="lg lg--base" />
                    团队人均（虚线基准圈 = 1.0）
                  </div>
                  <div className="radar-legend__hint">
                    最外圈 = 团队人均的 2 倍。比值越靠外，说明这项相对队内越突出。
                  </div>
                  <table className="grid" style={{ marginTop: 8 }}>
                    <thead>
                      <tr><th>维度</th><th className="num">本人场均</th><th className="num">团队人均</th><th className="num">比值</th></tr>
                    </thead>
                    <tbody>
                      {radar.map((a) => (
                        <tr key={a.key}>
                          <td>{a.label}</td>
                          <td className="num">{Math.round(a.self).toLocaleString()}</td>
                          <td className="num" style={{ color: 'var(--text-dim)' }}>{Math.round(a.teamAvg).toLocaleString()}</td>
                          <td className="num" style={{
                            color: a.ratio >= 1.15 ? 'var(--ok)' : a.ratio >= 0.85 ? 'var(--text)' : 'var(--warn)',
                          }}>
                            {a.teamAvg > 0 ? a.ratio.toFixed(2) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          <div className="md-block">
            <h3>逐场趋势（有效人伤 / 有效塔伤）</h3>
            {trend.length < 2 ? (
              <div className="hint">至少需要 2 场有战报的记录才能画趋势（当前 {trend.length} 场）。</div>
            ) : (
              <div className="trend">
                {trend.map((m) => (
                  <div className="trend__col" key={m.matchId} title={`${m.matchLabel} ${m.oppSide}`}>
                    <div className="trend__bars">
                      <span className="trend__bar trend__bar--dmg"
                            style={{ height: `${Math.max(2, (m.effDmg / maxTrend) * 100)}%` }} />
                      <span className="trend__bar trend__bar--tower"
                            style={{ height: `${Math.max(2, (m.effTower / maxTrend) * 100)}%` }} />
                    </div>
                    <div className="trend__label">{m.date.slice(5)}<br />{m.indexInDay}</div>
                  </div>
                ))}
                <div className="trend__legend">
                  <span className="lg lg--dmg" />有效人伤
                  <span className="lg lg--tower" style={{ marginLeft: 10 }} />有效塔伤
                  <div style={{ color: 'var(--text-faint)', marginTop: 4 }}>柱高按本人最大值归一</div>
                </div>
              </div>
            )}
          </div>

          <div className="md-block">
            <h3>团队基准（所有我方上场记录的人均）</h3>
            <div className="table-wrap">
              <table className="grid">
                <thead>
                  <tr>
                    <th className="num">有效击杀</th><th className="num">助攻</th><th className="num">有效人伤</th><th className="num">有效塔伤</th>
                    <th className="num">治疗量</th><th className="num">承伤</th><th className="num">重伤</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="num">{Math.round(teamAverage.effKills).toLocaleString()}</td>
                    <td className="num">{Math.round(teamAverage.assists).toLocaleString()}</td>
                    <td className="num">{Math.round(teamAverage.effDmg).toLocaleString()}</td>
                    <td className="num">{Math.round(teamAverage.effTower).toLocaleString()}</td>
                    <td className="num">{Math.round(teamAverage.healing).toLocaleString()}</td>
                    <td className="num">{Math.round(teamAverage.taken).toLocaleString()}</td>
                    <td className="num">{teamAverage.deaths.toFixed(2)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </>

         /* 同上：逐场内容也一直渲染 */
        <div className="md-block">
          <div className="toolbar">
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={onlyFilled} onChange={(e) => setOnlyFilled(e.target.checked)} />
              只看已填战报的场次
            </label>
            <div className="spacer grow" />
            <button className="btn ghost" onClick={() => void load()}>刷新</button>
          </div>
          <div className="table-wrap" style={{ maxHeight: '56vh' }}>
            <table className="grid">
              <thead>
                <tr>
                  <th style={{ width: 120 }}>场次</th>
                  <th style={{ width: 60 }}>结果</th>
                  <th>对手</th>
                  <th style={{ width: 100 }}>小队</th>
                  <th style={{ width: 80 }}>职业</th>
                  <th style={{ width: 70 }}>状态</th>
                  <th className="num" style={{ width: 80 }}>总分</th>
                  <th className="num">有效击杀</th>
                  <th className="num">助攻</th>
                  <th className="num">有效人伤</th>
                  <th className="num">有效塔伤</th>
                  <th className="num">治疗</th>
                  <th className="num">承伤</th>
                  <th className="num">重伤</th>
                  <th className="num">复活</th>
                </tr>
              </thead>
              <tbody>
                {listRows.length === 0 && (
                  <tr><td className="empty" colSpan={14}>没有记录</td></tr>
                )}
                {listRows.map((m: PlayerMatchRow) => (
                  <tr key={m.matchId} style={m.state !== 'PLAY' ? { opacity: .6 } : undefined}>
                    <td>{m.matchLabel}</td>
                    <td style={{ color: m.result === 'WIN' ? 'var(--ok)' : m.result === 'LOSE' ? 'var(--danger)' : 'var(--text-dim)' }}>
                      {m.result === 'WIN' ? '胜' : m.result === 'LOSE' ? '负' : '平'}
                    </td>
                    <td>{m.oppSide}</td>
                    <td>{m.squad || <span style={{ color: 'var(--text-faint)' }}>未分配</span>}</td>
                    <td><ClassChip name={m.classUsed} classMap={classMap} showIcon={false} /></td>
                    <td>
                      <span className={`badge-state ${m.state === 'PLAY' ? 'active' : m.state === 'LEAVE' ? 'left' : 'inactive'}`}>
                        {PART_STATE_LABEL[m.state]}
                      </span>
                    </td>
                    {m.statFilled ? (
                      <>
                        <td className="num" style={{ fontWeight: 600, color: scores[m.matchId] !== undefined ? 'var(--text)' : 'var(--text-faint)' }}>
                          {scores[m.matchId] !== undefined ? scores[m.matchId].toFixed(2) : '未算'}
                        </td>
                        {cell(m.effKills)}{cell(m.assists)}
                        {cell(m.effDmg)}{cell(m.effTower)}
                        {cell(m.healing)}{cell(m.taken)}
                        {cell(m.deaths)}{cell(m.revives)}
                      </>
                    ) : (
                      <td colSpan={9} style={{ color: 'var(--text-faint)' }}>未填战报</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          
        </div>
    </>
  );
}
