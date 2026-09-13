import { useMemo, useState } from 'react';
import {
  GEAR_CARDS, GUIDE_IMAGES, GUIDE_NOTES, MISSING_ASSETS,
  type GuideCategory, type GuideImage,
} from '../data/guideContent';

const CATEGORIES: GuideCategory[] = ['全部', '配装总览', '装备选择', '加点方案', '流派立绘'];

const asset = (file: string, folder: 'guide' | 'hero' = 'guide'): string => {
  const base = import.meta.env.BASE_URL || './';
  return `${base}${folder}/${file}`;
};

/**
 * 攻略页（M8）
 *
 * 内容全部来自原表「攻略」页的内嵌图片与文本，按主题重新组织：
 * 分类图库 + 点击放大（灯箱）+ 文字要点。
 * 原表是 29 个合并单元格里塞了 17 张 DISPIMG，桌面端改成可浏览的图库。
 */
export default function GuidePage() {
  const [cat, setCat] = useState<GuideCategory>('全部');
  const [lightbox, setLightbox] = useState<GuideImage | null>(null);

  const list = useMemo(
    () => (cat === '全部' ? GUIDE_IMAGES : GUIDE_IMAGES.filter((g) => g.category === cat)),
    [cat],
  );

  return (
    <>
      <div className="card">
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <h3 style={{ margin: 0 }}>攻略</h3>
          <span className="hint" style={{ margin: 0 }}>
            内容来自原表「攻略」页：{GUIDE_IMAGES.length} 张图 + {GUIDE_NOTES.length} 组要点
          </span>
          <div className="spacer grow" />
          {CATEGORIES.map((c) => (
            <button key={c} className={`btn sm${cat === c ? ' primary' : ''}`} onClick={() => setCat(c)}>
              {c}
              {c !== '全部' && `（${GUIDE_IMAGES.filter((g) => g.category === c).length}）`}
            </button>
          ))}
        </div>
      </div>

      <div className="gallery">
        {list.map((g) => (
          <figure
            key={g.file}
            className={`shot${g.wide ? ' shot--wide' : ''}`}
            onClick={() => setLightbox(g)}
            title="点击放大"
          >
            <img src={asset(g.file)} alt={g.title} loading="lazy"
                 className="shot__img" data-shot={g.file} />
            <figcaption>
              <b>{g.title}</b>
              <span>{g.desc}</span>
            </figcaption>
          </figure>
        ))}
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3>装备卡速查</h3>
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th style={{ width: 60 }}>图标</th>
                <th>装备名</th>
                <th style={{ width: 90 }} className="num">装等</th>
                <th style={{ width: 90 }} className="num">装评</th>
                <th style={{ width: 70 }}>品质</th>
              </tr>
            </thead>
            <tbody>
              {[...GEAR_CARDS].sort((a, b) => b.score - a.score).map((g) => (
                <tr key={g.name}>
                  <td>
                    <img src={asset(g.file)} alt={g.name}
                         style={{ height: 26, borderRadius: 3, cursor: 'zoom-in' }}
                         onClick={() => setLightbox(
                           GUIDE_IMAGES.find((x) => x.file === g.file) ?? null,
                         )} />
                  </td>
                  <td>{g.name}</td>
                  <td className="num">{g.ilvl}</td>
                  <td className="num" style={{ color: g.score >= 3500 ? 'var(--ok)' : undefined }}>
                    {g.score}
                  </td>
                  <td>{g.tag}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="hint">
          装评数字照抄原表卡片。装等优先的判断来自下面的要点，不是从图片里推出来的。
        </div>
      </div>

      <div className="notes">
        {GUIDE_NOTES.map((n) => (
          <div className="card note" key={n.title}>
            <h3>{n.title}</h3>
            <ul>
              {n.lines.map((l, i) => <li key={i}>{l}</li>)}
            </ul>
          </div>
        ))}
      </div>

      {MISSING_ASSETS.length > 0 && (
        <div className="card">
          <div className="hint" style={{ margin: 0 }}>
            素材缺口：{MISSING_ASSETS.join('、')} —— 原表「下滑预选」里 12 职业只找到 11 个图标，
            惊鸿没有图标文件（界面上会退回色点显示）。
          </div>
        </div>
      )}

      {lightbox && (
        <div className="modal lightbox" onClick={() => setLightbox(null)}>
          <div className="lightbox__box" onClick={(e) => e.stopPropagation()}>
            <div className="lightbox__head">
              <h3>{lightbox.title}</h3>
              <button className="btn sm ghost" onClick={() => setLightbox(null)}>关闭</button>
            </div>
            <img src={asset(lightbox.file)} alt={lightbox.title} className="lightbox__img" />
            <div className="hint">{lightbox.desc}</div>
          </div>
        </div>
      )}
    </>
  );
}

/** 首页用：三职业立绘卡（原表 image22 / image26） */
export function BannerCards() {
  return (
    <div className="banner-cards">
      <img src={asset('image26.png', 'guide')} alt="百战魂 · 巡影无锋 · 溯雪凌霜" />
      <img src={asset('image22.png', 'guide')} alt="流光刃 · 巡影无锋 · 溯雪凌霜" />
    </div>
  );
}
