/**
 * 攻略内容（M8）
 *
 * 全部来自逆向解说原表「攻略」页的内嵌图片与文本单元格，**逐张看图后归类**，
 * 不做推测：
 *   - 配装总览：原表 2 张（点击「切换」在两套之间切）→ 帮战·防守保镖 / 帮战·拆塔
 *   - 装备卡：7 张，每张带装备名 + 装等 + 装评（数字直接照抄卡面）
 *   - 加点方案：2 张技能树，同一棵树的两条路线
 *   - 流派立绘：2 张三职业立绘卡（流光刃 / 百战魂）
 *   - 文本：原表攻略页的文本单元格（装等优先、独珍替换、大节点等）
 */

export type GuideCategory = '全部' | '配装总览' | '装备选择' | '加点方案' | '流派立绘';

export interface GearCard {
  /** 装备名（照抄卡面） */
  name: string;
  /** 装等 */
  ilvl: number;
  /** 装评 */
  score: number;
  /** 卡面图标（"珍"/"特"等标记） */
  tag: string;
  file: string;
}

export interface GuideImage {
  file: string;
  title: string;
  desc: string;
  category: Exclude<GuideCategory, '全部'>;
  /** 大图在灯箱里用大尺寸渲染 */
  wide?: boolean;
}

/** 装备卡：名称/装等/装评按卡面照抄 */
export const GEAR_CARDS: GearCard[] = [
  { name: '仙迹·海棠花环', ilvl: 169, score: 3415, tag: '珍', file: 'image15.png' },
  { name: '项羽·霸王腕', ilvl: 169, score: 3415, tag: '珍', file: 'image16.png' },
  { name: '赤水·素手执局', ilvl: 171, score: 3846, tag: '珍', file: 'image17.png' },
  { name: '公孙情·同心穗', ilvl: 169, score: 3473, tag: '珍', file: 'image18.png' },
  { name: '牧野弥·赤目戒', ilvl: 169, score: 3531, tag: '珍', file: 'image19.png' },
  { name: '如意·錾花锁', ilvl: 169, score: 4012, tag: '珍', file: 'image20.png' },
  { name: '萨迪雅·铁鹰铃', ilvl: 169, score: 3473, tag: '珍', file: 'image24.png' },
];

export const GUIDE_IMAGES: GuideImage[] = [
  {
    file: 'image14.png', category: '配装总览', wide: false,
    title: '帮战 · 防守保镖',
    desc: '原表「切换」两套配装之一。适合承担保护与防守职责时使用。',
  },
  {
    file: 'image23.png', category: '配装总览', wide: false,
    title: '帮战 · 拆塔',
    desc: '原表「切换」两套配装之一。适合承担拆塔输出职责时使用。',
  },
  ...GEAR_CARDS.map((g): GuideImage => ({
    file: g.file, category: '装备选择', wide: false,
    title: g.name,
    desc: `装等 ${g.ilvl} · 装评 ${g.score} · ${g.tag}`,
  })),
  {
    file: 'image21.png', category: '加点方案', wide: true,
    title: '加点方案 A（金线节点更多）',
    desc: '同一棵天赋树的路线之一，金色连线为点亮路径；节点数更多、覆盖更广。',
  },
  {
    file: 'image25.png', category: '加点方案', wide: true,
    title: '加点方案 B（金线节点更少）',
    desc: '另一条路线，点亮节点更少且保留一个锁定节点。两份对照看更清楚差异。',
  },
  {
    file: 'image22.png', category: '流派立绘', wide: true,
    title: '流光刃 · 巡影无锋 · 溯雪凌霜',
    desc: '三职业流派立绘卡（流光刃 / 巡影无锋 / 溯雪凌霜）。',
  },
  {
    file: 'image26.png', category: '流派立绘', wide: true,
    title: '百战魂 · 巡影无锋 · 溯雪凌霜',
    desc: '三职业流派立绘卡（百战魂 / 巡影无锋 / 溯雪凌霜）。',
  },
];

/** 原表攻略页的文本内容（原样保留，按主题重排） */
export interface GuideNote {
  title: string;
  lines: string[];
}

export const GUIDE_NOTES: GuideNote[] = [
  {
    title: '装等优先',
    lines: [
      '171 竞技百炼 > 171 副本百炼 > 169 竞技百炼',
      '装等优先于其他词缀考量。',
    ],
  },
  {
    title: '独珍替换建议',
    lines: [
      '赤水独珍手（无蛊毒）> 项羽独珍护腕',
      '无蛊毒！无蛊毒！无蛊毒！重要的事情说 3 遍 —— 别带着蛊毒吸队友血。',
      '压力太大带独珍头；正常抗拆带铁鹰；偷拆才带公孙情；正常就带这个。',
      '保镖或防守压力大带独珍头；神相可以选带（攻击大号）。',
      '没出橙戒的才带公孙情；没橙戒的该挨打。',
    ],
  },
  {
    title: '大节点选择',
    lines: [
      '方案一：大节点韩飞瑛 + 老头必带；剩下一个神相带炎光，其他职业优先流光；另一个等周五更新看点哪里。',
      '方案二：大节点老头 + 岳飞必带；炎光 / 韩飞瑛 / 怒浪 / 戚少商谁分高带谁；剩下一个等周五更新，武蕴可能也有改动。',
    ],
  },
  {
    title: '附加分档位',
    lines: [
      '橙武 2.5',
      'K 龙 5',
      '指挥 2.5',
      '统战 5',
    ],
  },
];

/** 职业图标里的"惊鸿"缺素材，攻略页里明确标出来 */
export const MISSING_ASSETS = ['惊鸿职业图标'];
