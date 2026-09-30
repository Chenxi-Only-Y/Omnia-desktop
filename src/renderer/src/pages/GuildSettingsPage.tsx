import { useEffect, useState } from 'react';
import type { AppInfo, GuildMeta } from '@shared/types';
import { api, errText } from '../api';
import { localUrl } from '../lib/localFile';
import { confirmDialog } from '../components/Confirm';
import { useToastAutoClear } from '../lib/useToast';

/**
 * 帮会设置（**单开页面**）。
 *
 * 用户口径 2026-09-27：改名 / 换封面这类操作**不要出现在帮会卡片的 hover 上**，
 * 收进一个独立的「帮会设置」页 —— 卡片只负责"看一眼 + 进入"。
 * 删除也在这一页，且明确写出"会连库文件一起删"，避免误触。
 *
 * 入口：帮会首页右上角「帮会设置」；返回：左上角「← 返回帮会首页」。
 */
export default function GuildSettingsPage({
  guild, info, onBack, onSaved, onRemoved,
}: {
  guild: GuildMeta;
  info: AppInfo | null;
  onBack: () => void;
  /** 保存成功后把新的帮会元数据回传给 App（更新顶栏「← 名字」与列表） */
  onSaved: (g: GuildMeta) => void;
  /** 删除成功后回列表 */
  onRemoved: () => void;
}) {
  const [name, setName] = useState(guild.name);
  const [note, setNote] = useState(guild.note);
  const [cover, setCover] = useState(guild.cover);
  /** 刚选好、还没落盘的封面文件（保存时才拷进 guilds/<id>/cover.png） */
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useToastAutoClear(notice, setNotice);

  // 切帮会（外层按 guild.id 整块重挂）或外部改了元数据之后，重新同步表单
  useEffect(() => {
    setName(guild.name);
    setNote(guild.note);
    setCover(guild.cover);
    setPicked(null);
    setError(null);
  }, [guild]);

  const dirty = name.trim() !== guild.name || note !== guild.note || picked !== null;

  async function pickCover() {
    try {
      const p = await api.guild.pickCover();
      if (p) setPicked(p);
    } catch (err) {
      setError(errText(err));
    }
  }

  async function save() {
    const n = name.trim();
    if (!n) { setError('帮会名不能为空'); return; }
    setBusy(true);
    try {
      let g = await api.guild.update(guild.id, { name: n, note });
      if (picked) {
        g = await api.guild.setCover(guild.id, picked);
        setCover(g.cover);
        setPicked(null);
      }
      setNotice(`已保存「${g.name}」`);
      setError(null);
      onSaved(g);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeGuild() {
    const ok = await confirmDialog(
      `删除帮会「${guild.name}」？\n\n这会**删掉它的整个数据库文件**`
      + `（成员 / 对局 / 排表 / 战报 / 评分全部），无法撤销。`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      await api.guild.remove(guild.id);
      onRemoved();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  }

  const shownCover = picked ?? cover;

  return (
    <div className="card">
      <div className="toolbar">
        <button className="btn sm" onClick={onBack}>← 返回帮会首页</button>
        <h3 style={{ margin: 0 }}>帮会设置</h3>
        <div className="spacer grow" />
        <button className="btn" disabled={busy || !dirty} onClick={() => { setPicked(null); setError(null); }}>放弃改动</button>
        <button className="btn primary" disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>

      {error && <div className="msg error" style={{ marginTop: 8 }}>{error}</div>}
      {notice && <div className="msg msg--toast ok" style={{ marginTop: 8 }}>{notice}</div>}

      <div style={{ display: 'flex', gap: 14, marginTop: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* 封面：选了还没保存就标出来，避免"选了以为生效了" */}
        <div className="gset-cover">
          {shownCover
            ? (
              <>
                <img className="gset-cover__blur" src={localUrl(shownCover)} alt="" aria-hidden />
                <img className="gset-cover__img" src={localUrl(shownCover)} alt="" />
              </>
            )
            : <div className="gset-cover__empty"><span>{guild.name.slice(0, 4)}</span></div>}
          {picked && <div className="gset-cover__badge">未保存</div>}
        </div>

        <div style={{ minWidth: 320, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label className="field"><span>帮会名 *</span>
            <input className="input" style={{ width: 280 }} value={name}
                   onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field"><span>简介 / 备注（帮会首页显示）</span>
            <input className="input" style={{ width: 380 }} value={note}
                   placeholder="例如 主帮 / 联盟：xxx"
                   onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="toolbar" style={{ margin: 0 }}>
            <button className="btn" onClick={() => void pickCover()}>选择封面图…</button>
            <span className="hint" style={{ margin: 0 }}>
              {picked ? `已选：${picked.split(/[\\/]/).pop()}（点保存生效）`
                : '不选就用帮会名当封面；图片会拷进应用目录，原图删了也不影响'}
            </span>
          </div>
        </div>
      </div>

      <div className="hint" style={{ marginTop: 12 }}>
        这个帮会的库文件：<code>{info?.dbPath || '（未知）'}</code>
        <br />
        每个帮会一套独立数据库：这里的成员 / 对局 / 排表 / 战报 / 评分，换到别的帮会就是另一套。
      </div>

      {/* 危险操作单独分区，离上面的输入框远一点 */}
      <div className="danger-zone">
        <div>
          <div className="danger-zone__t">删除这个帮会</div>
          <div className="danger-zone__d">
            连数据库文件一起删（成员 / 对局 / 排表 / 战报 / 评分全部），无法撤销。其余帮会不受影响。
          </div>
        </div>
        <button className="btn danger" disabled={busy} onClick={() => void removeGuild()}>删除帮会</button>
      </div>
    </div>
  );
}
