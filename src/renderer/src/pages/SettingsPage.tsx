import { useCallback, useEffect, useState } from 'react';
import { useToastAutoClear } from '../lib/useToast';
import { localUrl } from '../lib/localFile';
import type { AppInfo } from '@shared/types';
import { api, errText } from '../api';
import type { PageProps } from '../App';
import RulesPage from './RulesPage';

/** 中缝图片上限：会存成 dataURL 进 app_setting，太大既慢又占库，这里挡一下 */
const DIVIDER_IMAGE_MAX_MB = 3;

/**
 * 设置页的页签。
 *
 * 用户口径 2026-09：「设置」与「权重与规则」合并成一个页 —— 导航项只留「设置」，
 * 进来用页签分块。复用全站既有的 `.tab` 样式（与对局详情页签同源），不新造控件。
 */
type SettingsTab = 'rules' | 'wallpaper' | 'data' | 'info';

const SETTINGS_TABS: { key: SettingsTab; label: string }[] = [
  { key: 'rules', label: '权重与规则' },
  { key: 'wallpaper', label: '壁纸' },
  { key: 'data', label: '数据与兼容' },
  /* 用户口径：「关于 / 运行环境」单独列一项「全部信息」 */
  { key: 'info', label: '全部信息' },
];

interface Props extends PageProps {
  info: AppInfo | null;
}

export default function SettingsPage({ info, classes, classMap }: Props) {
  /** 当前页签：默认「权重与规则」（评分参数是最常来设置页改的东西） */
  const [tab, setTab] = useState<SettingsTab>('rules');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 壁纸库：地址由用户填入 → 扫描 → 缩略图选（静态/动态都可）
  // 默认壁纸库 = Wallpaper Engine 创意工坊；没有就让用户填
  const [wallPath, setWallPath] = useState('C:\\Program Files (x86)\\Steam\\steamapps\\workshop\\content\\431960');
  const [wallList, setWallList] = useState<import('@shared/types').WallpaperItem[]>([]);
  const [wallErr, setWallErr] = useState<string | null>(null);
  const [wallCur, setWallCur] = useState('');
  async function scanWall(): Promise<void> {
    try {
      // 参数走 app_setting（IPC 会丢参数），再触发扫描
      await api.meta.setSetting('wallpaperLibrary', wallPath.trim());
      const list = await api.player.listWallpapers();
      setWallList(list);
      setWallErr(list.length ? null : '没扫到壁纸（换个目录再试）');
    } catch (err) { setWallErr(String(err)); }
  }
  async function useWall(w: import('@shared/types').WallpaperItem): Promise<void> {
    // 落库失败也不挡切换：本项目部分 IPC 会丢参数，不能让 setSetting 的异常
    // 把「切换壁纸」这件事一起带没。
    // 双保险：先写渲染层（一定成功），再尽量落库
    try { window.localStorage.setItem('omnia:wallpaper', JSON.stringify({ kind: w.kind, file: w.file })); } catch { /* 存不了就算了 */ }
    let saved = true;
    try {
      await api.meta.setSetting('wallpaperImage', w.file);
      await api.meta.setSetting('wallpaperKind', w.kind);
    } catch { saved = false; }
    window.dispatchEvent(new CustomEvent('omnia:wallpaper', { detail: { kind: w.kind, file: w.file } }));
    setWallCur(w.file);
    setNotice('已切换壁纸：' + w.name + '（' + (w.kind === 'video' ? '动态' : '静态') + '）'
      + (saved ? '' : ' —— 但设置没保存成功，重启后会回到默认'));
  }
  // 渲染模式 / 适应方式（照 Wallpaper Engine 的设置面板）
  const [wallMode, setWallMode] = useState('dynamic');
  const [wallFit, setWallFit] = useState('cover');
  async function pickMode(m: string): Promise<void> {
    setWallMode(m);
    try { await api.meta.setSetting('wallpaperRenderMode', m); } catch { /* IPC 偶发丢参数 */ }
    window.dispatchEvent(new CustomEvent('omnia:wallpaper-mode', { detail: m }));
    setNotice('渲染模式：' + (m === 'dynamic' ? '动态' : m === 'static' ? '静态帧' : '关闭壁纸'));
  }
  async function pickFit(f: string): Promise<void> {
    setWallFit(f);
    try { await api.meta.setSetting('wallpaperFit', f); } catch { /* IPC 偶发丢参数 */ }
    window.dispatchEvent(new CustomEvent('omnia:wallpaper-fit', { detail: f }));
    setNotice('适应方式：' + (f === 'cover' ? '铺满裁剪' : f === 'contain' ? '完整缩放' : '拉伸铺满'));
  }
  // 声音：默认静音（用户口径），可取消
  const [wallMuted, setWallMuted] = useState(true);
  async function pickMuted(m: boolean): Promise<void> {
    setWallMuted(m);
    try { await api.meta.setSetting('wallpaperMuted', m ? '1' : '0'); } catch { /* IPC 偶发丢参数 */ }
    window.dispatchEvent(new CustomEvent('omnia:wallpaper-muted', { detail: m }));
    setNotice(m ? '壁纸已静音' : '壁纸已取消静音（有声音）');
  }
  // 壁纸图加载不出来时的回声（file:// 受限 / 文件不存在）
  useEffect(() => {
    const onErr = (e: Event) => setNotice(String((e as CustomEvent<string>).detail ?? '壁纸加载失败'));
    window.addEventListener('omnia:wallpaper-error', onErr);
    return () => window.removeEventListener('omnia:wallpaper-error', onErr);
  }, []);
  // 成功提示 2.5 秒后自动消失（报错不自动清，要留够时间看清）
  useToastAutoClear(notice, setNotice);
  /** 半区中缝图片（dataURL）；空 = 显示默认的竖排「万象」 */
  const [dividerImage, setDividerImage] = useState('');

  useEffect(() => {
    void api.meta.settings()
      .then((s) => {
        setDividerImage(s.dividerImage ?? '');
        // 壁纸四项状态也要从库读回：原先只写了 useState 默认值，从没读库 ——
        // 于是库里存着 contain，界面却显示「铺满裁剪」，用户以为设置没生效。
        if (s.wallpaperImage) setWallCur(s.wallpaperImage);
        if (s.wallpaperRenderMode) setWallMode(s.wallpaperRenderMode);
        if (s.wallpaperFit) setWallFit(s.wallpaperFit);
        if (s.wallpaperMuted) setWallMuted(s.wallpaperMuted !== '0');
        // 库里的壁纸库地址回填输入框（默认值只覆盖「从没设过」的情况）
        if (s.wallpaperLibrary) setWallPath(s.wallpaperLibrary);
      })
      .catch(() => { /* 读不到就保持默认 */ });
  }, []);

  /** 选图片 → 读成 dataURL → 存进 app_setting（渲染时 object-fit:cover 横向铺满裁剪） */
  function pickDividerImage(file: File | undefined) {
    if (!file) return;
    if (file.size > DIVIDER_IMAGE_MAX_MB * 1024 * 1024) {
      setNotice(null);
      setError(`图片太大（${(file.size / 1024 / 1024).toFixed(1)}MB），请控制在 ${DIVIDER_IMAGE_MAX_MB}MB 以内`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? '');
      void run(() => api.meta.setSetting('dividerImage', url), '中缝图片已更新（回「排表」查看）')
        .then(() => {
          setDividerImage(url);
          // 通知正在挂载的看板立刻换图（否则要切页重新挂载才生效）
          window.dispatchEvent(new CustomEvent('omnia:divider-image', { detail: url }));
        });
    };
    reader.onerror = () => setError('读取图片失败');
    reader.readAsDataURL(file);
  }

  const load = useCallback(async () => {
    try {
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function run(fn: () => Promise<unknown>, okMsg: string) {
    try {
      await fn();
      setError(null);
      setNotice(okMsg);
      await load();
    } catch (err) {
      setNotice(null);
      setError(errText(err));
    }
  }


  return (
    <>
      {error && <div className="msg msg--toast error">{error}</div>}
      {notice && <div className="msg msg--toast ok">{notice}</div>}

      {/* 页签：与「对局详情」用同一套 .tab 样式，全站一致 */}
      <div className="tabs" role="tablist">
        {SETTINGS_TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`tab${tab === t.key ? ' active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* 权重与规则：直接复用原独立页的面板（它自带卡片与提示条） */}
      {tab === 'rules' && <RulesPage classes={classes} classMap={classMap} />}


      {tab === 'wallpaper' && (
      <>
      <div className="card">
        <h3>壁纸</h3>
        <div className="toolbar toolbar--fields" style={{ marginBottom: 10 }}>
          <label className="field"><span>壁纸库地址</span>
            <input className="input" style={{ width: 340 }} placeholder="例如 D:\\我的壁纸库"
                   value={wallPath} onChange={(e) => setWallPath(e.target.value)} />
          </label>
          <button className="btn" onClick={() => void scanWall()}>扫描</button>
        </div>
        {wallErr && <div className="msg error">{wallErr}</div>}
        <div className="wall-grid">
          {wallList.map((w) => (
            /* key 用 kind|file：只用 w.file 会撞 —— WE 场景型作品目录里只有
               preview.jpg，多个作品各有一张，早期扫描器还可能同时收录
               preview.jpg 与 preview.gif，于是出现重复 key（React 警告
               在 SettingsPage.tsx:265）。 */
            <button key={w.kind + '|' + w.file}
              className={'wall-item' + (wallCur === w.file ? ' wall-item--on' : '')}
              title={w.name + '（' + (w.kind === 'video' ? '动态' : '静态') + '）'}
              onClick={() => void useWall(w)}>
              {w.kind === 'video'
                ? <video src={localUrl(w.file)} muted loop playsInline preload="metadata" />
                : <img src={localUrl(w.file)} alt="" loading="lazy" />}
              <span className="wall-item__tag">{w.kind === 'video' ? '动态' : '静态'}</span>
            </button>
          ))}
          <div className="wall-seg">
            <span className="wall-seg__k">渲染模式</span>
            {([['dynamic', '动态'], ['static', '静态帧'], ['off', '关闭壁纸']] as const).map(([v, label]) => (
              <button key={v} className={'wall-seg__b' + (wallMode === v ? ' on' : '')}
                      onClick={() => void pickMode(v)}>{label}</button>
            ))}
            <span className="wall-seg__k" style={{ marginLeft: 22 }}>声音</span>
            {([[true, '静音'], [false, '取消静音']] as const).map(([v, label]) => (
              <button key={String(v)} className={'wall-seg__b' + (wallMuted === v ? ' on' : '')}
                      onClick={() => void pickMuted(v)}>{label}</button>
            ))}
            <span className="wall-seg__k" style={{ marginLeft: 22 }}>适应方式</span>
            {([['cover', '铺满裁剪'], ['contain', '完整缩放'], ['stretch', '拉伸铺满']] as const).map(([v, label]) => (
              <button key={v} className={'wall-seg__b' + (wallFit === v ? ' on' : '')}
                      onClick={() => void pickFit(v)}>{label}</button>
            ))}
          </div>
          {!wallList.length && !wallErr && (
            <div className="hint">默认找 Wallpaper Engine 创意工坊（431960）。没找到就把自己存壁纸的文件夹填到上面，点「扫描」。</div>
          )}
        </div>
      </div>
      </>
      )}

      {/* 用户口径 2026-09：「关于」「运行环境」单独归到「全部信息」页签，
          不再混在「数据与兼容」里。 */}
      {tab === 'info' && (
      <>
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
            <div>数据库结构版本：v{info.schemaVersion}</div>
          </div>
        ) : (
          <div className="hint">读取中…</div>
        )}
      </div>
      </>
      )}

      {tab === 'data' && (
      <>
      <div className="card">
        <h3>数据与兼容</h3>
        <div className="stat-grid">
          <div className="stat">
            <div className="k">数据库文件</div>
            <div className="v" style={{ fontSize: 12, wordBreak: 'break-all' }}>{info?.dbPath ?? '—'}</div>
          </div>
          {/* 「建制容量」那一格已删：建制按场次独立（用户口径），
              容量各场不同，放在全局设置页里没有意义 —— 排表页会显示本场槽位。 */}
          <div className="stat">
            <div className="k">数据库版本</div>
            <div className="v">v{info?.schemaVersion ?? '—'}<small> schema 迁移</small></div>
          </div>
        </div>
        
      </div>

      <div className="card">
        <h3>排表 · 半区中缝</h3>
        <div className="toolbar">
          <label className="btn" style={{ cursor: 'pointer' }}>
            选择图片
            <input type="file" accept="image/*" style={{ display: 'none' }}
                   onChange={(e) => { pickDividerImage(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
          {dividerImage && (
            <button className="btn danger" onClick={() => {
              void run(
                () => api.meta.setSetting('dividerImage', ''), '已恢复默认（竖排「万象」）',
              ).then(() => {
                setDividerImage('');
                window.dispatchEvent(new CustomEvent('omnia:divider-image', { detail: '' }));
              });
            }}>
              清除图片
            </button>
          )}
          
        </div>
        {dividerImage && (
          <div className="divider-preview">
            <img src={dividerImage} alt="中缝预览" />
            
          </div>
        )}
      </div>
      </>
      )}
    </>
  );
}
