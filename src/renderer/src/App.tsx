import { useEffect, useState } from 'react';
import type { AppInfo, ClassInfo } from '@shared/types';
import { api, ApiError } from './api';
import RosterPage from './pages/RosterPage';
import OverviewPage from './pages/OverviewPage';
import MatchPage from './pages/MatchPage';
import BoardPage from './pages/BoardPage';
import PlayerDetailPage from './pages/PlayerDetailPage';
import SettingsPage from './pages/SettingsPage';
import PlaceholderPage from './pages/PlaceholderPage';

export interface PageProps {
  classes: ClassInfo[];
  classMap: Map<string, ClassInfo>;
}

type PageKey = 'overview' | 'roster' | 'match' | 'board' | 'rules' | 'settings';

const NAV: { key: PageKey; label: string; icon: string; ready: boolean }[] = [
  { key: 'overview', label: '总览', icon: '◈', ready: true },
  { key: 'roster', label: '成员主档', icon: '☰', ready: true },
  { key: 'match', label: '对局与战报', icon: '⚔', ready: true },
  { key: 'board', label: '数据看板', icon: '◱', ready: true },
  { key: 'rules', label: '权重与规则', icon: '⚙', ready: false },
  { key: 'settings', label: '设置', icon: '⚒', ready: true },
];

export default function App() {
  const [page, setPage] = useState<PageKey>('overview');
  const [classes, setClasses] = useState<ClassInfo[]>([]);
  const [classMap, setClassMap] = useState<Map<string, ClassInfo>>(new Map());
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [playerCount, setPlayerCount] = useState<number | null>(null);
  /** 在成员主档里点开的成员详情 */
  const [detailId, setDetailId] = useState<number | null>(null);

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
              onGo={setPage}
            />
          )}
          {page === 'roster' && (
            detailId === null
              ? <RosterPage {...props} onCount={setPlayerCount} onOpenDetail={setDetailId} />
              : <PlayerDetailPage {...props} playerId={detailId} onBack={() => setDetailId(null)} />
          )}
          {page === 'match' && <MatchPage {...props} />}
          {page === 'board' && <BoardPage {...props} />}
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
          {page === 'settings' && <SettingsPage {...props} info={info} />}
        </section>
      </main>
    </div>
  );
}
