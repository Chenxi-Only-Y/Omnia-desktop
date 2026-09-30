import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppInfo, ClassInfo, GuildMeta } from '@shared/types';
import { api, errText } from './api';
// 挂全局壁纸层（body 下的 fixed 容器，切页/滚动都不动）
import './lib/wallpaper';
import RosterPage from './pages/RosterPage';
import OverviewPage from './pages/OverviewPage';
import MatchPage from './pages/MatchPage';
import BoardPage from './pages/BoardPage';
import PlayerDetailPage from './pages/PlayerDetailPage';
import LineupPage from './pages/LineupPage';
import SettingsPage from './pages/SettingsPage';
import GuildPage from './pages/GuildPage';
import GuildHomePage from './pages/GuildHomePage';
import GuildSettingsPage from './pages/GuildSettingsPage';
import ConfirmHost from './components/Confirm';
import { installSmoothScroll } from './lib/smoothScroll';
import { flyCoverTo } from './lib/guildTransition';
// 自绘滚动条浮层：原生滚动条画不到导航栏那一段（容器从 y=52 开始），只能自绘
import { installScrollbar } from './lib/scrollbar';

export interface PageProps {
  classes: ClassInfo[];
  classMap: Map<string, ClassInfo>;
}

/**
 * 一级页签（用户口径 2026-09-27）：**总览 / 帮会 / 设置**。
 * `总览` 与 `设置` 保持原样；四张业务页（成员主档 / 对局与战报 / 排表 / 数据看板）
 * 全部收进「帮会」里 —— 点某个帮会卡片进入该帮会的库之后才出现。
 */
type TopKey = 'overview' | 'guilds' | 'settings';

/** 进入帮会之后的二级页签（用户口径：第一个是帮会首页介绍，其次这 4 个） */
type GuildTab = 'home' | 'roster' | 'match' | 'lineup' | 'board';
/** 「帮会设置」是帮会页里的**第 6 个页签**（用户口径 2026-09-27：放在那排页签里），
    放改名 / 简介 / 封面 / 删除 —— 卡片上不放这些操作。 */
type GuildView = GuildTab | 'settings';

/**
 * 顶部导航。
 *
 * 用户口径（2026-09）：删掉左侧边栏，导航移到**页面顶部**，
 * 样式与首屏那 4 个按钮一致 —— 当前页 = 白底黑字，其余 = 透明底白字 + 细线框。
 * 2026-09-27：一级只留 3 个；四张业务页改成"进入帮会后的二级页签"。
 *
 * ⚠️ label 是自检探针的查找依据（`button.nav-item` + 文案），改文案要同步改自检 ——
 * 二级页签因此**沿用同一个 `nav-item` 类名**，探针不必先"进帮会"也能按文案点到。
 */
const NAV: { key: TopKey; label: string }[] = [
  { key: 'overview', label: '总览' },
  { key: 'guilds', label: '帮会' },
  { key: 'settings', label: '设置' },
];

const GUILD_TABS: { key: GuildView; label: string }[] = [
  { key: 'home', label: '帮会首页' },
  { key: 'roster', label: '成员主档' },
  { key: 'match', label: '对局与战报' },
  { key: 'lineup', label: '排表' },
  { key: 'board', label: '数据看板' },
  /* 「帮会设置」也放这排页签里（用户口径 2026-09-27：「帮会设置放在这里」），
     它是管理页而不是业务页，所以排在最后。 */
  { key: 'settings', label: '帮会设置' },
];

export default function App() {
  const [top, setTop] = useState<TopKey>('overview');
  const [guildTab, setGuildTab] = useState<GuildView>('home');
  /** 当前**进入**的帮会；null = 停在帮会列表 */
  const [guild, setGuild] = useState<GuildMeta | null>(null);
  const [guilds, setGuilds] = useState<GuildMeta[]>([]);
  const [classes, setClasses] = useState<ClassInfo[]>([]);
  const [classMap, setClassMap] = useState<Map<string, ClassInfo>>(new Map());
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  /** 页面入场动画二选一：'fly' = 进帮会（动画由飞图承担，页面本身不动画）；
   *  'tab' = 点页签（从按钮位置从小到大）。用户口径：两者**不能同时出现**。 */
  const [anim, setAnim] = useState<'fly' | 'tab'>('fly');
  /** 页签切换动画的起点（被点按钮中心相对内容区的横坐标）与触发计数
   *  —— 用户口径 2026-09-27：点上面的页签时内容"从按钮位置展开"。 */
  const [tabFx, setTabFx] = useState({ l: 0, r: 0, n: 0 });
  // 顶栏只保留「收起导航」按钮；成员人数不再显示（setter 仍被别处调用）
  const [, setPlayerCount] = useState<number | null>(null);
  /** 在成员主档里点开的成员详情 */
  const [detailId, setDetailId] = useState<number | null>(null);

  /** 只在**首次加载**自动进入上次的帮会；之后刷新列表不要把人从列表里"拽"进帮会 */
  const bootstrapped = useRef(false);

  const reloadGuilds = useCallback(async () => {
    try {
      const [list, active] = await Promise.all([api.guild.list(), api.guild.active()]);
      setGuilds(list);
      if (!bootstrapped.current) {
        bootstrapped.current = true;
        /* 启动时**自动进入上次用的帮会**：否则四张业务页每次都要手点一遍才能进去。
           想换帮会就点一级「帮会」→ 卡片列表里挑（「← 帮会名」也能退回列表）。 */
        setGuild(active);
      }
    } catch (err) {
      setBootError(errText(err));
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [cls, appInfo] = await Promise.all([api.meta.classes(), api.appInfo()]);
        setClasses(cls);
        setClassMap(new Map(cls.map((c) => [c.name, c])));
        setInfo(appInfo);
        setGuild(appInfo.guild);
      } catch (err) {
        setBootError(errText(err));
      }
    })();
    void reloadGuilds();
  }, [reloadGuilds]);

  /** 进入某个帮会：切换当前库（不重启）→ 重挂这个帮会的页面 → 落在帮会首页
   *  fromEl = 被点的卡片封面元素：先克隆再切状态（切完卡片就卸载了），
   *  切完由它飞到帮会首页的封面位，落位后页面内容再展开。 */
  const enterGuild = useCallback(async (g: GuildMeta, fromEl?: HTMLElement | null) => {
    const fly = fromEl
      ? { clone: fromEl.cloneNode(true) as HTMLElement, rect: fromEl.getBoundingClientRect() }
      : null;
    try {
      const opened = await api.guild.open(g.id);
      setGuild(opened);
      setGuildTab('home');
      setDetailId(null);
      setTop('guilds');
      setAnim('fly');           // 进帮会 = 只飞图，页面内容不做缩放动画
      setBootError(null);
      if (fly) void flyCoverTo(fly.clone, fly.rect, () => document.querySelector('.guild-home__poster'));
    } catch (err) {
      setBootError(errText(err));
    }
  }, []);

  /** 返回帮会列表：把首页封面飞回那张卡片（反向同理） */
  const backToGuilds = useCallback((fromEl?: HTMLElement | null) => {
    const id = fromEl ? guild?.id : undefined;
    const fly = fromEl
      ? { clone: fromEl.cloneNode(true) as HTMLElement, rect: fromEl.getBoundingClientRect() }
      : null;
    setTop('guilds');
    setGuild(null);
    setDetailId(null);
    void reloadGuilds();
    if (fly && id) {
      void flyCoverTo(fly.clone, fly.rect,
        () => document.querySelector(`.gcard[data-guild-id="${id}"] .gcard__cover`));
    }
  }, [guild, reloadGuilds]);

  const props: PageProps = { classes, classMap };

  // 全站滚轮平滑（只装一次）
  installSmoothScroll();
  // 自绘滚动条浮层（只装一次）
  installScrollbar();

  /* 切页/切帮会重置滚动位置：滚动是 .content 这个容器在滚，容器不会因为换页而重建，
     所以从别的页面（已经滚下去）切回来时会带着上一页的滚动位置。
     用户口径：切到首页时首页位置不应该变 —— 这里在每次切换时把它归零。 */
  useEffect(() => {
    const sc = document.querySelector('.content') as HTMLElement | null;
    if (sc) sc.scrollTop = 0;
  }, [top, guildTab, guild?.id]);

  return (
    <div className="app">
      <main className="main">
        {/* 顶部导航：**常驻**（用户口径 2026-09：导航栏不需要收缩了，一直显示）。
            这里刻意不放徽标与品牌字 —— 首屏已有完整品牌块，两处都放会重复。
            配色在 CSS 里写死：当前页白底黑字，其余透明底白字 + 细线框。 */}
        <header className={`topbar${top === 'overview' ? ' topbar--home' : ''}`}>
          <nav className="nav">
            {NAV.map((n) => {
              /* 高亮口径：进入帮会之后，**当前页是二级页签**（帮会那一项不再算"当前页"）。
                 这样"谁是当前页"永远只有一个答案 —— 自检探针也按 aria-current 找当前导航。 */
              const active = n.key === 'guilds' ? (top === 'guilds' && guild === null) : top === n.key;
              return (
                <button
                  key={n.key}
                  className={`nav-item home-btn${active ? '' : ' home-btn--ghost'}`}
                  onClick={() => {
                    /* 在帮会里点「帮会」= 返回帮会列表：封面飞回那张卡片（用户口径：返回同理）。
                       顶栏不再有"当前帮会"按钮，返回就靠这个一级页签。 */
                    if (n.key === 'guilds' && guild) {
                      backToGuilds(document.querySelector('.guild-home__poster') as HTMLElement | null);
                      return;
                    }
                    setTop(n.key);
                    /* 顺手重拉一次列表，保证看到的是最新的（比如在别处改过注册表）。 */
                    if (n.key === 'guilds') { setGuild(null); void reloadGuilds(); }
                    if (n.key === 'guilds' || n.key === 'settings') setDetailId(null);
                  }}
                  aria-current={active ? 'page' : undefined}
                  aria-label={n.label}
                >
                  {n.label}
                </button>
              );
            })}

            {/* 当前帮会：**纯文字**（用户口径：不要 ▾ 下拉），点了回帮会列表。
                放右侧（margin-left:auto），与左边三个一级页签分开 —— 顶栏从此最多 4 个元素，
                再窄的窗口也不会互相压住。 */}
          </nav>
        </header>

        <section className={`content${top === 'overview' ? ' content--flush-top' : ''}${
          /* 个人主页要"一屏一屏翻"：吸附属性得挂在真正的滚动元素 .content 上。
             这里由 App 直接算 —— 之前用 effect 手动加 class，会被 React 重渲染冲掉。 */
          /* 只要在成员详情页就挂 md-snap —— 之前写成 top/guildTab 三个条件相与 ✗，
             运行时实测常常不成立（.content 上没有这个类）→ 所有 .content.md-snap 的规则
             全部静默失效 ✗（统计区去卡片化、隐藏滚动条、吸附…）。详情页本身已蕴含其它条件 ✓ */
          detailId !== null ? ' md-snap' : ''
        }`}>
          {bootError && (
            <div className="msg error">
              初始化失败：{bootError}
              <div style={{ marginTop: 6, opacity: 0.8 }}>
                如果提示预加载桥未注入，说明 preload 未编译或路径不对；如果是数据库错误，请看主进程弹窗里的路径。
              </div>
            </div>
          )}

          {/* 帮会二级页签：**只在帮会页可见**（用户口径：下沉到帮会页内），
              但其它页也留在 DOM 里（display:none）—— 两个原因：
                ① 从"总览/设置"点二级页签时能同步切过去（隐藏元素 click() 照样触发 onClick）；
                ② 自检探针是同步点导航的，页签不在 DOM 里就得改成异步，容易抢跑。
              渲染位置就在内容区顶部，所以在帮会页里看就是"页内页签"。 */}
          {guild && (
            <div className="ptabs" data-guild-tabs
                 style={{ display: top === 'guilds' ? undefined : 'none' }}>
              {GUILD_TABS.map((t) => (
                <button
                  key={t.key}
                  className={`ptab${guildTab === t.key ? ' active' : ''}`}
                  onClick={(e) => {
                    /* 量出按钮中心相对内容区的位置 → 供"从按钮位置展开"的动画用 */
                    const box = (document.querySelector('.content') as HTMLElement | null)
                      ?.getBoundingClientRect();
                    const b = e.currentTarget.getBoundingClientRect();
                    if (box) {
                      const l = Math.max(0, b.left + b.width / 2 - box.left);
                      setTabFx((s) => ({ l, r: Math.max(0, box.width - l), n: s.n + 1 }));
                    }
                    setTop('guilds');
                    setAnim('tab');     // 点页签 = 只做"从按钮位置从小到大"
                    /* 还在帮会列表（guild === null）时点二级页签：先把当前帮会进回来再落页。
                       否则渲染的是列表，看起来"点了没反应"（自检探针也会等超时）。 */
                    if (!guild) {
                      const g = guilds.find((x) => x.id === info?.guild?.id) ?? guilds[0];
                      if (g) {
                        void enterGuild(g).then(() => {
                          setGuildTab(t.key);
                          if (t.key === 'roster') setDetailId(null);
                        });
                        return;
                      }
                    }
                    setGuildTab(t.key);
                    if (t.key === 'roster') setDetailId(null);
                  }}
                  aria-current={guildTab === t.key ? 'page' : undefined}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}

          {top === 'overview' && (
            <OverviewPage
              {...props}
              onCount={setPlayerCount}
              onGo={(k) => {
                // 总览里的快捷入口：四张业务页现在属于帮会，先确保"已进入帮会"再切页
                if (k === 'settings') { setTop('settings'); return; }
                setTop('guilds');
                if (!guild) {
                  // 从帮会列表点了「总览」再走快捷入口：先把当前帮会进回来，再落到目标页
                  const g = guilds[0];
                  if (g) { void enterGuild(g).then(() => setGuildTab(k)); return; }
                }
                setGuildTab(k);
              }}
            />
          )}

          {top === 'settings' && <SettingsPage {...props} info={info} />}

          {top === 'guilds' && (
            guild === null ? (
              <GuildPage
                guilds={guilds}
                onEnter={(g, el) => void enterGuild(g, el)}
                onChanged={() => void reloadGuilds()}
              />
            ) : (
              /* key=帮会 id：切帮会时整块重挂，所有页面重新取数（等于换了一整套库） */
              <div
                /* key 带上页签与触发计数：换页签时重挂，展开动画才会重新跑 */
                key={`${guild.id}:${guildTab}:${tabFx.n}`}
                className={`gpage${anim === 'tab' && detailId === null ? ' gpage--tab' : ''}`}
                style={{ '--tab-l': `${tabFx.l}px`, '--tab-r': `${tabFx.r}px` } as React.CSSProperties}
              >
                {/* 帮会首页不再放「帮会设置」按钮：它就是页签排的最后一项 */}
                {guildTab === 'home' && <GuildHomePage guild={guild} />}
                {guildTab === 'roster' && (
                  detailId === null
                    ? <RosterPage {...props} onCount={setPlayerCount} onOpenDetail={setDetailId} />
                    : <PlayerDetailPage {...props} playerId={detailId} onBack={() => setDetailId(null)} />
                )}
                {guildTab === 'match' && <MatchPage {...props} />}
                {guildTab === 'lineup' && <LineupPage {...props} />}
                {guildTab === 'board' && <BoardPage />}
                {guildTab === 'settings' && (
                  <GuildSettingsPage
                    guild={guild}
                    info={info}
                    onBack={() => setGuildTab('home')}
                    /* 保存后：顶栏「← 名字」与列表都要跟着变 */
                    onSaved={(g) => { setGuild(g); void reloadGuilds(); }}
                    onRemoved={() => { setGuild(null); setTop('guilds'); void reloadGuilds(); }}
                  />
                )}
              </div>
            )
          )}
        </section>
      </main>
      <ConfirmHost />
    </div>
  );
}
