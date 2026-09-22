import { useCallback, useEffect, useState } from 'react';
import { useToastAutoClear } from '../lib/useToast';
import type { AppInfo, SquadCatalog } from '@shared/types';
import { api, ApiError } from '../api';
import type { PageProps } from '../App';

/** 中缝图片上限：会存成 dataURL 进 app_setting，太大既慢又占库，这里挡一下 */
const DIVIDER_IMAGE_MAX_MB = 3;

interface Props extends PageProps {
  info: AppInfo | null;
}

export default function SettingsPage({ info }: Props) {
  const [catalog, setCatalog] = useState<SquadCatalog | null>(null);
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
    await api.meta.setSetting('wallpaperImage', w.file);
    await api.meta.setSetting('wallpaperKind', w.kind);
    window.dispatchEvent(new CustomEvent('omnia:wallpaper', { detail: { kind: w.kind, file: w.file } }));
    setWallCur(w.file);
  }
  // 成功提示 2.5 秒后自动消失（报错不自动清，要留够时间看清）
  useToastAutoClear(notice, setNotice);
  const [newGroup, setNewGroup] = useState({ name: '', kind: 'attack' as 'attack' | 'defend' });
  /** 半区中缝图片（dataURL）；空 = 显示默认的竖排「万象」 */
  const [dividerImage, setDividerImage] = useState('');

  useEffect(() => {
    void api.meta.settings()
      .then((s) => setDividerImage(s.dividerImage ?? ''))
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
      setCatalog(await api.meta.squads());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
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
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  const groups = catalog?.groups ?? [];
  const squads = catalog?.squads ?? [];

  return (
    <>
      {error && <div className="msg msg--toast error">{error}</div>}
      {notice && <div className="msg msg--toast ok">{notice}</div>}

      <div className="card">
        <h3>战斗组（可新增）</h3>
        {/* 名称与类别都用 .field 包一层：原来名称是裸 input、只有「类别」带标签，
            两者顶边不在一条线上，按钮也吊在半空 —— 用户反馈「对齐一下」。 */}
        <div className="toolbar toolbar--fields">
          <label className="field"><span>战斗组名称</span>
            <input className="input" style={{ width: 180 }} placeholder="如 演练组"
                   value={newGroup.name} onChange={(e) => setNewGroup({ ...newGroup, name: e.target.value })} />
          </label>
          <label className="field"><span>类别</span>
            <select className="select" value={newGroup.kind}
                    onChange={(e) => setNewGroup({ ...newGroup, kind: e.target.value as 'attack' | 'defend' })}>
              <option value="attack">进攻</option>
              <option value="defend">防守</option>
            </select>
          </label>
          <button className="btn primary" disabled={!newGroup.name.trim()}
                  onClick={() => void run(
                    () => api.meta.createGroup({ name: newGroup.name.trim(), kind: newGroup.kind }),
                    `已新增战斗组「${newGroup.name.trim()}」`,
                  ).then(() => setNewGroup({ name: '', kind: newGroup.kind }))}>
            新增战斗组
          </button>
          
        </div>

        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th style={{ width: 160 }}>战斗组</th>
                <th style={{ width: 80 }}>类别</th>
                <th className="num" style={{ width: 90 }}>小队数</th>
                <th className="num" style={{ width: 100 }}>槽位</th>
                <th>小队</th>
                <th style={{ width: 90 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {groups.length === 0 && <tr><td className="empty" colSpan={6}>还没有战斗组</td></tr>}
              {groups.map((g) => {
                const list = squads.filter((s) => s.groupId === g.id);
                return (
                  <tr key={g.id}>
                    <td>{g.name}</td>
                    <td style={{ color: g.kind === 'defend' ? 'var(--kind-defend)' : 'var(--kind-attack)' }}>
                      {g.kind === 'defend' ? '防守' : '进攻'}
                    </td>
                    <td className="num">{list.length}</td>
                    <td className="num">{list.reduce((n, s) => n + s.size, 0)}</td>
                    <td style={{ color: 'var(--text-dim)' }}>
                      {list.length ? list.map((s) => s.name).join('、') : '—'}
                    </td>
                    <td className="actions">
                      <div className="row-edit" style={{ justifyContent: 'flex-end' }}>
                        <button className="btn sm" onClick={() => void run(
                          () => api.meta.createSquad({ groupId: g.id }),
                          `已在「${g.name}」新增小队`,
                        )}>加一队</button>
                        <button className="btn sm danger" disabled={list.length > 0}
                                title={list.length ? '请先删掉该组下的小队' : '删除战斗组'}
                                onClick={() => void run(() => api.meta.removeGroup(g.id), `已删除「${g.name}」`)}>
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h3>小队明细</h3>
        <div className="table-wrap" style={{ maxHeight: '40vh' }}>
          <table className="grid">
            <thead>
              <tr>
                <th style={{ width: 150 }}>小队</th>
                <th style={{ width: 110 }}>战斗组</th>
                <th style={{ width: 110 }}>战术</th>
                <th className="num" style={{ width: 70 }}>人数</th>
                <th className="num" style={{ width: 70 }}>序号</th>
                <th style={{ width: 90 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {squads.length === 0 && <tr><td className="empty" colSpan={6}>还没有小队</td></tr>}
              {squads.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td style={{ color: 'var(--text-dim)' }}>{s.groupName}</td>
                  <td style={{ color: 'var(--text-dim)' }}>{s.tactic || '—'}</td>
                  <td className="num">{s.size}</td>
                  <td className="num">{s.indexInGroup}</td>
                  <td className="actions">
                    <button className="btn sm danger" onClick={() => void run(
                      () => api.meta.removeSquad(s.id), `已删除小队「${s.name}」`,
                    )}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        
      </div>

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
            <button key={w.file}
              className={'wall-item' + (wallCur === w.file ? ' wall-item--on' : '')}
              title={w.name + '（' + (w.kind === 'video' ? '动态' : '静态') + '）'}
              onClick={() => void useWall(w)}>
              {w.kind === 'video'
                ? <video src={'file:///' + w.file.replace(/\\/g, '/')} muted loop playsInline preload="metadata" />
                : <img src={'file:///' + w.file.replace(/\\/g, '/')} alt="" loading="lazy" />}
              <span className="wall-item__tag">{w.kind === 'video' ? '动态' : '静态'}</span>
            </button>
          ))}
          {!wallList.length && !wallErr && (
            <div className="hint">默认找 Wallpaper Engine 创意工坊（431960）。没找到就把自己存壁纸的文件夹填到上面，点「扫描」。</div>
          )}
        </div>
      </div>

      <div className="card">
        <h3>数据与兼容</h3>
        <div className="stat-grid">
          <div className="stat">
            <div className="k">数据库文件</div>
            <div className="v" style={{ fontSize: 12, wordBreak: 'break-all' }}>{info?.dbPath ?? '—'}</div>
          </div>
          <div className="stat">
            <div className="k">建制容量</div>
            <div className="v">{catalog?.capacity ?? 0}<small> 槽（{squads.length} 队）</small></div>
          </div>
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
  );
}
