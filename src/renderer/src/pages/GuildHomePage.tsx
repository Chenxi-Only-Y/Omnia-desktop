import { useEffect, useState } from 'react';
import type { DashboardData, GuildMeta } from '@shared/types';
import { api, errText } from '../api';
import { localUrl } from '../lib/localFile';

/**
 * 帮会首页（二级页签第一个）：这个帮会的"门面 + 速览"。
 *
 * 用户口径 2026-09-27：**封面在左侧（竖向），右侧 2×2 四张卡片**。
 * 数据全部来自当前帮会自己的库（切帮会时外层按 guild.id 重挂，所以这里不用管切换）。
 */
export default function GuildHomePage({ guild }: { guild: GuildMeta }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.dashboard.data().then(setData).catch((err) => setError(errText(err)));
  }, []);

  const t = data?.totals;
  const cover = localUrl(guild.cover);

  /* 右侧 2×2 的四张卡：取最"硬"的四个数（成员 / 场次 / 参战 / 完整度）。
     场均上场挪到底部那行说明里 —— 不是删数据，只是不占卡片位。 */
  const cards = [
    { k: '成员总数', v: t ? String(t.players) : '—', unit: '' },
    { k: '对局场次', v: t ? String(t.matches) : '—', unit: '' },
    { k: '参战记录', v: t ? String(t.participations) : '—', unit: '' },
    { k: '战报完整度', v: t ? String(Math.round(t.statRate * 100)) : '—', unit: ' %' },
  ];

  return (
    <>
      <div className="card guild-home">
        {/* 左：封面（竖向 9:16）+ 帮会名 / 简介 */}
        <div className="guild-home__side">
          <div className="guild-home__poster">
            {cover
              ? (
                <>
                  {/* 留白**按图片自己的背景补**：同图铺满 + 模糊当底；主图 contain 不裁 */}
                  <img className="guild-home__blur" src={cover} alt="" aria-hidden draggable={false} />
                  <img className="guild-home__cover" src={cover} alt="" draggable={false} />
                </>
              )
              : <div className="guild-home__cover guild-home__cover--text"><span>{guild.name.slice(0, 6)}</span></div>}
          </div>
          <div className="guild-home__name">{guild.name}</div>
          <div className="guild-home__note">{guild.note || '（还没写简介 —— 点上方「帮会设置」补上）'}</div>
        </div>

        {/* 右：2×2 四张卡片 */}
        <div className="guild-home__grid" data-guild-stats>
          {cards.map((c) => (
            <div className="gstat" key={c.k}>
              <div className="gstat__k">{c.k}</div>
              <div className="gstat__v">{c.v}{c.unit && <small>{c.unit}</small>}</div>
            </div>
          ))}
        </div>
      </div>

      {error && <div className="msg error" style={{ marginTop: 10 }}>{error}</div>}

      <div className="hint" style={{ marginTop: 10 }}>
        场均上场 {t ? t.avgLineup.toFixed(1) : '—'} 人 · 这套数据完全属于「{guild.name}」：
        换到别的帮会时，成员 / 对局 / 排表 / 战报 / 评分都是另一套。
      </div>
    </>
  );
}
