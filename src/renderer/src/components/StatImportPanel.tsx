import { useRef, useState } from 'react';
import { useToastAutoClear } from '../lib/useToast';
import type { ImportPreview, JoinMode } from '@shared/types';
import { api, ApiError } from '../api';
import type { PageProps } from '../App';
import ClassChip from './ClassChip';
import ImportWizard from './ImportWizard';
import Select from './Select';

/**
 * 批量导入战报面板（M3）
 * 两条路径：xlsx 向导（推荐，能选工作表与表头行）与直接粘贴/CSV。
 * 校验规则在 shared/statImport.ts，主进程里执行。
 */
export default function StatImportPanel({
  matchId, classes, classMap, matchLabel, onDone,
}: {
  matchId: number;
  classes: PageProps['classes'];
  classMap: PageProps['classMap'];
  matchLabel: string;
  onDone: () => void;
}) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<JoinMode>('roster');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 成功提示 2.5 秒后自动消失（报错不自动清，要留够时间看清）
  useToastAutoClear(notice, setNotice);
  const [busy, setBusy] = useState(false);
  const [wizard, setWizard] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function doPreview(payload?: string) {
    const src = payload ?? text;
    if (!src.trim()) { setError('请先粘贴战报数据'); return; }
    setBusy(true);
    try {
      const res = await api.match.importPreview(src, mode);
      setPreview(res);
      setError(null);
      setNotice(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function doCommit() {
    if (!preview) return;
    setBusy(true);
    try {
      const res = await api.match.importCommit(matchId, preview);
      setNotice(`已写入 ${res.written} 条战报${res.created ? `，并自动建档 ${res.created} 人` : ''}`);
      setPreview(null);
      setText('');
      setError(null);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function pickFile(file: File | undefined) {
    if (!file) return;
    const content = await file.text();
    setText(content);
    await doPreview(content);
    if (fileRef.current) fileRef.current.value = '';
  }

  return (
    <div className="card">
      <h3>批量导入战报</h3>
      <div className="toolbar">
        <button className="btn primary" onClick={() => setWizard(true)}>从 xlsx 导入</button>
        <input ref={fileRef} type="file" accept=".csv,.txt,.tsv" style={{ display: 'none' }}
               onChange={(e) => void pickFile(e.target.files?.[0])} />
        <button className="btn" onClick={() => fileRef.current?.click()}>选择 CSV/TSV 文件</button>
        <label className="field"><span>名单模式</span>
          <Select className="select" value={mode} onChange={(e) => setMode(e.target.value as JoinMode)}>
            <option value="roster">严格：必须在成员主档里</option>
            <option value="full">完整：不在档的自动建档</option>
          </Select>
        </label>
        <button className="btn primary" onClick={() => void doPreview()} disabled={busy}>校验预览</button>
        {preview && (
          <button className="btn primary" onClick={() => void doCommit()} disabled={busy || preview.summary.errors > 0}>
            确认写入{preview.summary.errors > 0 ? '（有错误，已禁用）' : ''}
          </button>
        )}
      </div>

      {wizard && (
        <ImportWizard
          classes={classes}
          classMap={classMap}
          mode="stat"
          matchId={matchId}
          matchLabel={matchLabel}
          onClose={() => setWizard(false)}
          onDone={(msg) => { setNotice(msg); onDone(); }}
        />
      )}

      <textarea
        className="input"
        style={{ width: '100%', minHeight: 130, fontFamily: 'Consolas, monospace', fontSize: 12 }}
        placeholder={'直接粘贴 Excel 区域（含表头），例如：\n玩家名字\t职业\t击败/清泉\t助攻\t资源\t对玩家伤害\t人伤卸甲\t对建筑伤害\t破塔卸甲\t治疗值\t承受伤害\t重伤\t复活/清泉\t焚骨'}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />

      {error && <div className="msg msg--toast error" style={{ marginTop: 10 }}>{error}</div>}
      {notice && <div className="msg msg--toast ok" style={{ marginTop: 10 }}>{notice}</div>}

      {preview && (
        <>
          <div className="stat-grid" style={{ marginTop: 12 }}>
            <div className="stat"><div className="k">数据行</div><div className="v">{preview.summary.total}</div></div>
            <div className="stat"><div className="k">匹配到主档</div><div className="v">{preview.summary.matched}</div></div>
            <div className="stat"><div className="k">未匹配</div>
              <div className="v" style={{ color: preview.summary.unmatched ? 'var(--warn)' : undefined }}>{preview.summary.unmatched}</div>
            </div>
            <div className="stat"><div className="k">错误 / 警告</div>
              <div className="v" style={{ color: preview.summary.errors ? 'var(--danger)' : undefined }}>
                {preview.summary.errors}<small> / {preview.summary.warnings}</small>
              </div>
            </div>
          </div>

          {preview.issues.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <h3 style={{ fontSize: 12 }}>校验问题（{preview.issues.length}）</h3>
              <div className="table-wrap" style={{ maxHeight: 180 }}>
                <table className="grid">
                  <thead>
                    <tr><th className="num" style={{ width: 60 }}>行</th><th style={{ width: 70 }}>级别</th><th style={{ width: 170 }}>分类</th><th style={{ width: 110 }}>对象</th><th>说明</th></tr>
                  </thead>
                  <tbody>
                    {preview.issues.map((i, idx) => (
                      <tr key={idx}>
                        <td className="num">{i.row || '—'}</td>
                        <td style={{ color: i.level === 'error' ? 'var(--danger)' : 'var(--warn)' }}>
                          {i.level === 'error' ? '错误' : '警告'}
                        </td>
                        <td style={{ color: 'var(--text-dim)' }}>{i.code}</td>
                        <td>{i.player || '—'}</td>
                        <td style={{ whiteSpace: 'normal' }}>{i.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div style={{ marginTop: 12 }}>
            <h3 style={{ fontSize: 12 }}>解析结果预览（前 60 行）</h3>
            <div className="table-wrap" style={{ maxHeight: 300 }}>
              <table className="grid">
                <thead>
                  <tr>
                    <th className="num" style={{ width: 50 }}>行</th>
                    <th style={{ width: 120 }}>队员</th>
                    <th style={{ width: 80 }}>职业</th>
                    <th style={{ width: 90 }}>匹配</th>
                    <th className="num">击败</th><th className="num">清泉</th><th className="num">助攻</th>
                    <th className="num">对玩家伤害</th><th className="num">对建筑伤害</th>
                    <th className="num">治疗值</th><th className="num">重伤</th><th className="num">焚骨</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, 60).map((r) => (
                    <tr key={r.row} style={r.issues.some((i) => i.level === 'error') ? { background: 'var(--danger-soft)' } : undefined}>
                      <td className="num">{r.row}</td>
                      <td>{r.name}</td>
                      <td><ClassChip name={r.classUsed} classMap={classMap} showIcon={false} /></td>
                      <td style={{ color: r.playerId === null ? 'var(--warn)' : 'var(--ok)' }}>
                        {r.playerId === null ? '未匹配' : '✓'}
                      </td>
                      <td className="num">{r.stat.kills}</td>
                      <td className="num">{r.stat.fountainKills}</td>
                      <td className="num">{r.stat.assists}</td>
                      <td className="num">{r.stat.dmgPlayer.toLocaleString()}</td>
                      <td className="num">{r.stat.dmgBuilding.toLocaleString()}</td>
                      <td className="num">{r.stat.healing.toLocaleString()}</td>
                      <td className="num">{r.stat.deaths}</td>
                      <td className="num">{r.stat.boneBurn}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
      
    </div>
  );
}
