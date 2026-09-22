import { useRef, useState } from 'react';
import { useToastAutoClear } from '../lib/useToast';
import type { ImportPreview, PlayerInput, SheetGrid } from '@shared/types';
import { api, ApiError } from '../api';
import { parseTableText } from '../lib/importer';
import { gridToTsv, isEmptyRow } from '../lib/sheet';
import type { PageProps } from '../App';

type Mode = 'player' | 'stat';

interface Props extends PageProps {
  mode: Mode;
  /** 战报模式必填：目标对局 */
  matchId?: number;
  matchLabel?: string;
  onClose: () => void;
  onDone: (msg: string) => void;
}

const MODE_LABEL: Record<Mode, string> = { player: '导入成员主档', stat: '导入战报' };

/**
 * xlsx 导入向导：选文件 → 选工作表 → 确认表头行 → 预览 → 导入。
 * 关键点：旧表的表头常在第 5~6 行，所以表头行可手动调整（默认自动探测）。
 */
export default function ImportWizard({ mode, matchId, matchLabel, onClose, onDone }: Props) {
  const [fileName, setFileName] = useState('');
  const [buf, setBuf] = useState<Uint8Array | null>(null);
  const [sheets, setSheets] = useState<{ name: string; index: number }[]>([]);
  const [sheet, setSheet] = useState<string>('');
  const [grid, setGrid] = useState<SheetGrid | null>(null);
  const [joinMode, setJoinMode] = useState<'roster' | 'full'>('roster');
  const [statPreview, setStatPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 成功提示 2.5 秒后自动消失（报错不自动清，要留够时间看清）
  useToastAutoClear(notice, setNotice);
  const fileRef = useRef<HTMLInputElement>(null);

  async function pickFile(file: File | undefined) {
    if (!file) return;
    setBusy(true); setError(null); setNotice(null); setGrid(null); setStatPreview(null);
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const list = await api.meta.xlsxSheets(data);
      setBuf(data);
      setFileName(file.name);
      setSheets(list.sheets);
      // 自动挑一张像样的表：成员优先「信息数据库」，战报优先「数据导入」
      const prefer = mode === 'player'
        ? list.sheets.find((s) => s.name.includes('信息') || s.name.includes('成员'))
        : list.sheets.find((s) => s.name.includes('导入') || s.name.includes('战报'));
      const first = prefer ?? list.sheets[0];
      if (first) {
        setSheet(first.name);
        await loadGrid(data, first.name);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function loadGrid(data: Uint8Array, sheetName: string, headerRow?: number) {
    setBusy(true); setStatPreview(null);
    try {
      const g = await api.meta.xlsxGrid(data, sheetName, headerRow);
      setGrid(g);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function changeSheet(name: string) {
    setSheet(name);
    if (buf) await loadGrid(buf, name);
  }

  /** 表头行上下调整（旧表常用 5/6 行） */
  async function shiftHeader(delta: number) {
    if (!buf || !grid) return;
    const next = Math.max(1, grid.headerRow + delta);
    await loadGrid(buf, sheet, next);
  }

  async function doImport() {
    if (!grid) return;
    const tsv = gridToTsv(grid.headers, grid.rows);
    setBusy(true); setError(null); setNotice(null);
    try {
      if (mode === 'player') {
        const rows: PlayerInput[] = parseTableText(tsv);
        if (!rows.length) throw new Error('这张表里没有解析出成员记录（检查表头行是否选对）');
        const res = await api.player.import(rows);
        const msg = `导入完成：新增 ${res.inserted}，更新 ${res.updated}，跳过 ${res.skipped}`;
        setNotice(msg);
        onDone(msg);
      } else {
        if (!matchId) throw new Error('缺少目标对局');
        const preview = await api.match.importPreview(tsv, joinMode);
        setStatPreview(preview);
        if (preview.summary.errors > 0) {
          setError(`有 ${preview.summary.errors} 行存在错误，请修正后再提交（下方为校验明细）`);
        } else {
          const res = await api.match.importCommit(matchId, preview);
          const msg = `已写入 ${res.written} 条战报${res.created ? `，自动建档 ${res.created} 人` : ''}`;
          setNotice(msg);
          onDone(msg);
        }
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const dataRows = grid?.rows.filter((r) => !isEmptyRow(r.cells)) ?? [];

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal__box modal__box--wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h3>{MODE_LABEL[mode]}{matchLabel ? ` · ${matchLabel}` : ''}</h3>
          <button className="btn sm ghost" onClick={onClose}>关闭</button>
        </div>

        <div className="toolbar">
          <input ref={fileRef} type="file" accept=".xlsx,.xlsm" style={{ display: 'none' }}
                 onChange={(e) => void pickFile(e.target.files?.[0])} />
          <button className="btn primary" onClick={() => fileRef.current?.click()} disabled={busy}>
            选择 xlsx 文件
          </button>
          {fileName && <span className="meta">已选：{fileName}</span>}
          {sheets.length > 0 && (
            <label className="field"><span>工作表</span>
              <select className="select" value={sheet} onChange={(e) => void changeSheet(e.target.value)}>
                {sheets.map((s) => <option key={s.index} value={s.name}>{s.name}</option>)}
              </select>
            </label>
          )}
          {mode === 'stat' && (
            <label className="field"><span>名单模式</span>
              <select className="select" value={joinMode}
                      onChange={(e) => setJoinMode(e.target.value as 'roster' | 'full')}>
                <option value="roster">严格：必须在成员主档里</option>
                <option value="full">完整：不在档的自动建档</option>
              </select>
            </label>
          )}
        </div>

        {error && <div className="msg msg--toast error">{error}</div>}
        {notice && <div className="msg msg--toast ok">{notice}</div>}
        {busy && <div className="hint">处理中…</div>}

        {grid && (
          <>
            <div className="toolbar" style={{ marginTop: 6 }}>
              <span className="hint" style={{ margin: 0 }}>
                共 {grid.totalRows} 行，表头在第 <b>{grid.headerRow}</b> 行，
                有效数据 {dataRows.length} 行
              </span>
              <button className="btn sm" onClick={() => void shiftHeader(-1)} disabled={grid.headerRow <= 1}>表头上移</button>
              <button className="btn sm" onClick={() => void shiftHeader(1)}>表头下移</button>
              <div className="spacer grow" />
              <button className="btn primary" onClick={() => void doImport()}
                      disabled={busy || dataRows.length === 0}>
                {mode === 'player' ? '导入这些成员' : '校验并导入战报'}
              </button>
            </div>

            <div className="sheet-preview">
              <table className="grid grid--sheet">
                <thead>
                  <tr>
                    <th className="rownum">行</th>
                    {grid.headers.map((h, i) => (
                      <th key={i} title={h}>{h || <span style={{ color: 'var(--text-faint)' }}>（空列名）</span>}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {grid.previewBeforeHeader.map((r) => (
                    <tr key={r.row} className="sheet-row--before">
                      <td className="rownum">{r.row}</td>
                      {r.cells.map((c, i) => <td key={i} title={c}>{c}</td>)}
                    </tr>
                  ))}
                  {dataRows.slice(0, 40).map((r) => (
                    <tr key={r.row}>
                      <td className="rownum">{r.row}</td>
                      {r.cells.map((c, i) => <td key={i} title={c}>{c}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="hint">
              浅色行是表头之前的行（用来确认表头选对了）。下方只预览前 40 条有效数据，
              导入时会处理整张表。列名映射沿用旧表口径：角色ID / 玩家名字 / 主职业 / 副职 / 麦 / 备注 等。
            </div>

            {statPreview && (
              <div style={{ marginTop: 10 }}>
                <h3 style={{ fontSize: 12 }}>
                  校验结果：数据 {statPreview.summary.total} 行 ·
                  匹配 {statPreview.summary.matched} · 未匹配 {statPreview.summary.unmatched} ·
                  错误 {statPreview.summary.errors} · 警告 {statPreview.summary.warnings}
                </h3>
                <div className="table-wrap" style={{ maxHeight: 160 }}>
                  <table className="grid">
                    <thead>
                      <tr><th className="num" style={{ width: 60 }}>行</th><th style={{ width: 70 }}>级别</th>
                        <th style={{ width: 170 }}>分类</th><th style={{ width: 110 }}>对象</th><th>说明</th></tr>
                    </thead>
                    <tbody>
                      {statPreview.issues.length === 0 && (
                        <tr><td className="empty" colSpan={5}>没有发现问题</td></tr>
                      )}
                      {statPreview.issues.map((i, idx) => (
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
          </>
        )}

        {!grid && !busy && (
          <div className="hint" style={{ marginTop: 8 }}>
            选一个 xlsx 文件后会自动列出工作表并探测表头行。支持旧表这种「表头不在第一行」的结构。
          </div>
        )}
      </div>
    </div>
  );
}
