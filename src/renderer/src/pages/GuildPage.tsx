import { useState } from 'react';
import type { GuildMeta } from '@shared/types';
import { api, errText } from '../api';
import { localUrl } from '../lib/localFile';
import { useToastAutoClear } from '../lib/useToast';

/**
 * 帮会页（一级页签之一）：**竖向高卡片、向右横向滚动**，末尾一张「＋ 新建帮会」。
 *
 * 用户口径 2026-09：
 *   「点击什么帮会才能进入某帮会整个数据库」
 *   「帮会选择也是按卡片，以竖向卡片向右滚动，点进去才能选择 成员主档 对局与战报 排表 数据看板」
 *   「帮会选择可以添加图片 没有图片卡片就默认加个帮会名」
 * 用户口径 2026-09-27：
 *   「卡片上不要出现改名/封面，那些放帮会设置（单开页面）」——
 *   所以卡片只负责"看一眼 + 进入"，任何管理操作都不放在卡片上。
 */
export default function GuildPage({
  guilds, onEnter, onChanged,
}: {
  guilds: GuildMeta[];
  /** 点卡片进入：由 App 负责 open（= 切换当前库）并重挂页面；
   *  第二个参数是**被点的封面元素**，供转场动画"以图片为基准"飞过去。 */
  onEnter: (g: GuildMeta, coverEl?: HTMLElement | null) => void;
  /** 新建之后让 App 重新拉列表 */
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useToastAutoClear(notice, setNotice);
  const [busy, setBusy] = useState(false);
  /** 新建帮会浮层（**只用于新建**；改名 / 封面 / 删除在「帮会设置」页） */
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [coverPath, setCoverPath] = useState<string | null>(null);

  function openCreate() {
    setCreating(true);
    setName('');
    setNote('');
    setCoverPath(null);
    setError(null);
  }

  async function pickCover() {
    try {
      const p = await api.guild.pickCover();
      if (p) setCoverPath(p);
    } catch (err) {
      setError(errText(err));
    }
  }

  async function create() {
    const n = name.trim();
    if (!n) { setError('帮会名不能为空'); return; }
    setBusy(true);
    try {
      const g = await api.guild.create(n, note);
      if (coverPath) await api.guild.setCover(g.id, coverPath);
      setNotice(`已新建帮会「${g.name}」`);
      setCreating(false);
      setError(null);
      onChanged();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card guild-page">
      <div className="toolbar" style={{ marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>帮会（{guilds.length}）</h3>
        <span className="hint" style={{ margin: 0 }}>
          每个帮会一套独立数据库；点卡片进入后才能用成员主档 / 对局与战报 / 排表 / 数据看板
        </span>
        <div className="spacer grow" />
        <button className="btn primary" onClick={openCreate}>＋ 新建帮会</button>
      </div>

      {error && <div className="msg msg--toast error" style={{ marginBottom: 8 }}>{error}</div>}
      {notice && <div className="msg msg--toast ok" style={{ marginBottom: 8 }}>{notice}</div>}

      {/* 竖向高卡片 + 横向滚动：卡片区自己滚，不带动整页 */}
      <div className="gcard-row">
        {guilds.length === 0 && (
          <div className="gcard-empty">
            <div className="gcard-empty__t">还没有帮会</div>
            <div className="gcard-empty__d">点「＋ 新建帮会」开始 —— 每个帮会有自己独立的一套数据。</div>
            <button className="btn primary" onClick={openCreate}>＋ 新建帮会</button>
          </div>
        )}

        {guilds.map((g) => (
          <div key={g.id} className="gcard" data-guild-id={g.id}
               onClick={(e) => onEnter(g, (e.currentTarget.querySelector('.gcard__cover') as HTMLElement | null)
                 ?? e.currentTarget)}
               title={`进入「${g.name}」`}>
            {/* 封面：有图用图，没有就用帮会名当大字底（用户口径） */}
            {g.cover
              ? (
                <>
                  {/* 缺的部分**按图片自己的背景补**：同一张图铺满 + 模糊当底；主图 contain 不裁 */}
                  <img className="gcard__blur" src={localUrl(g.cover)} alt="" aria-hidden draggable={false} />
                  <img className="gcard__cover" src={localUrl(g.cover)} alt="" draggable={false} />
                </>
              )
              : <div className="gcard__cover gcard__cover--text"><span>{g.name.slice(0, 4)}</span></div>}
            <div className="gcard__shade" />
            <div className="gcard__body">
              <div className="gcard__name">{g.name}</div>
              {g.note && <div className="gcard__note">{g.note}</div>}
              <div className="gcard__meta">{g.createdAt ? `建于 ${g.createdAt.slice(0, 10)}` : ''}</div>
            </div>
          </div>
        ))}

        <button className="gcard gcard--new" onClick={openCreate} title="新建帮会">
          <div className="gcard__plus">＋</div>
          <div className="gcard__newlabel">新建帮会</div>
        </button>
      </div>

      {creating && (
        <div className="modal" onClick={() => setCreating(false)}>
          <div className="modal__box" onClick={(e) => e.stopPropagation()}>
            <div className="modal__head"><h3>新建帮会</h3></div>
            <label className="field"><span>帮会名 *</span>
              <input className="input" style={{ width: 260 }} value={name}
                     placeholder="例如 霜序客" autoFocus
                     onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field" style={{ marginTop: 8 }}><span>简介 / 备注（帮会首页显示）</span>
              <input className="input" style={{ width: 360 }} value={note}
                     placeholder="例如 主帮 / 联盟：xxx"
                     onChange={(e) => setNote(e.target.value)} />
            </label>
            <div className="toolbar" style={{ marginTop: 12, marginBottom: 0 }}>
              <button className="btn" onClick={() => void pickCover()}>选择封面图…</button>
              <span className="hint" style={{ margin: 0 }}>
                {coverPath ? `已选：${coverPath.split(/[\\/]/).pop()}` : '不选就用帮会名当封面'}
              </span>
              <div className="spacer grow" />
              <button className="btn" onClick={() => setCreating(false)}>取消</button>
              <button className="btn primary" disabled={busy} onClick={() => void create()}>创建</button>
            </div>
            {error && <div className="msg error" style={{ marginTop: 8 }}>{error}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
