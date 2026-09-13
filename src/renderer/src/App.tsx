import { useEffect, useState } from 'react';
import type { AppInfo, ClassInfo } from '@shared/types';
import { api, ApiError } from './api';
import RosterPage from './pages/RosterPage';
import OverviewPage from './pages/OverviewPage';
import MatchPage from './pages/MatchPage';
import PlaceholderPage from './pages/PlaceholderPage';

export interface PageProps {
  classes: ClassInfo[];
  classMap: Map<string, ClassInfo>;
}

type PageKey = 'overview' | 'roster' | 'match' | 'lineup' | 'board' | 'rules' | 'settings';

const NAV: { key: PageKey; label: string; icon: string; ready: boolean }[] = [
  { key: 'overview', label: '总览', icon: '◈', ready: true },
  { key: 'roster', label: '成员主档', icon: '☰', ready: true },
  { key: 'match', label: '对局与战报', icon: '⚔', ready: true },
  { key: 'lineup', label: '阵容编排', icon: '⊞', ready: false },
  { key: 'board', label: '数据看板', icon: '◱', ready: false },
  { key: 'rules', label: '权重与规则', icon: '⚙', ready: false },
  { key: 'settings', label: '设置', icon: '⚒', ready: false },
];

export default function App() {
  const [page, setPage] = useState<PageKey>('overview');
  const [classes, setClasses] = useState<ClassInfo[]>([]);
  const [classMap, setClassMap] = useState<Map<string, ClassInfo>>(new Map());
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [playerCount, setPlayerCount] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [cls, appInfo] = await Promise.all([api.meta.classes(), api.appInfo()]);
        setClasses(cls);
        setClassMap(new Map(cls.map((c) => [c.name, c])));
        setInfo(appInfo);
      } catch (err) {
        setBootError(err instanceof ApiError ? err.message : String(err));
      }
    })();
  }, []);

  const props: PageProps = { classes, classMap };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <h1>万象<span className="dot-sep">·</span>Omnia</h1>
          <div className="sub">All leagues. One universe.</div>
          <div className="sub">万象归一，联赛集成</div>
        </div>
        <nav className="nav">
          <div className="nav-group-title">工作台</div>
          {NAV.map((n) => (
            <button
              key={n.key}
              className={`nav-item${page === n.key ? ' active' : ''}`}
              onClick={() => setPage(n.key)}
            >
              <span className="ico">{n.icon}</span>
              <span>{n.label}</span>
              {!n.ready && <span className="badge">待接入</span>}
            </button>
          ))}
        </nav>
      </aside>

      <main className="main">
        <header className="topbar">
          <h2>{NAV.find((n) => n.key === page)?.label}</h2>
          <div className="spacer" />
          {playerCount !== null && <span className="meta">成员 {playerCount} 人</span>}
          {info && <span className="meta">Electron {info.electron} · Node {info.node}</span>}
        </header>

        <section className="content">
          {bootError && (
            <div className="msg error">
              初始化失败：{bootError}
              <div style={{ marginTop: 6, opacity: 0.8 }}>
                如果提示预加载桥未注入，说明 preload 未编译或路径不对；如果是数据库错误，请看主进程弹窗里的路径。
              </div>
            </div>
          )}

          {page === 'overview' && (
            <OverviewPage
              {...props}
              info={info}
              onCount={setPlayerCount}
              onGoRoster={() => setPage('roster')}
            />
          )}
          {page === 'roster' && <RosterPage {...props} onCount={setPlayerCount} />}
          {page === 'match' && <MatchPage {...props} />}
          {page === 'lineup' && (
            <PlaceholderPage
              title="阵容编排"
              icon="⊞"
              todo={[
                '拖拽 10 支小队 × 6 人（防守一/二 各 2 支，进攻一/二 各 3 支）',
                '战术类型选择：塔后拆 / 塔前拆 / 保镖 / 防守',
                '校验：职业构成、指挥与统战是否到场、麦克风、请假与替补',
              ]}
              note="小队结构已在 shared/domain.ts 固化（SQUADS）。"
            />
          )}
          {page === 'board' && (
            <PlaceholderPage
              title="数据看板"
              icon="◱"
              todo={[
                '职业分布、出场率、请假率',
                '推塔/守塔趋势、胜率、对位差',
                '个人贡献雷达与队内 Top 榜',
              ]}
              note="原表「大盘数据可视化」是空表，需从零设计；先等评分算法确定。"
            />
          )}
          {page === 'rules' && (
            <PlaceholderPage
              title="权重与规则"
              icon="⚙"
              todo={[
                '个人权重（DPS / T / 治疗）编辑',
                '战术执行权重（推塔 / 保镖 / 防守）编辑',
                '职业平衡系数、分制常数（基础 60 / 封顶 100 / 刻度 20·40）',
                '赛季切换与规则版本化，改完立即重算预览',
              ]}
              note="评分算法由你后续决定；rule_set 表与默认值已就位。"
            />
          )}
          {page === 'settings' && (
            <PlaceholderPage
              title="设置"
              icon="⚒"
              todo={['数据库路径与备份', '与旧 xlsx 双向导入导出', '赛季管理']}
              note="当前数据库路径见「总览」页。"
            />
          )}
        </section>
      </main>
    </div>
  );
}
