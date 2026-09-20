/**
 * 首页用：流派立绘卡（原表 image22 / image26）
 *
 * 从原「攻略页」拆出来单独放 —— 攻略页是临时草稿区，已按要求删除，
 * 但首页要的这两张立绘留着。
 */
const asset = (file: string, folder: 'guide' | 'hero' = 'guide'): string => {
  const base = import.meta.env.BASE_URL || './';
  return `${base}${folder}/${file}`;
};

export function BannerCards() {
  return (
    <div className="banner-cards">
      <img src={asset('image26.png', 'guide')} alt="百战魂 · 巡影无锋 · 溯雪凌霜" />
      <img src={asset('image22.png', 'guide')} alt="流光刃 · 巡影无锋 · 溯雪凌霜" />
    </div>
  );
}
