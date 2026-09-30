import { useRef, useState } from 'react';
import { useToastAutoClear } from '../lib/useToast';
import type { ImportPreview, JoinMode } from '@shared/types';
import { api, errText } from '../api';
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
  /* 对方帮会的行要不要存下来（用户口径选项 A）：
     默认**存**，但只作对比数据 —— 不进主档/报名/出勤，也不参与评分。 */
  const [storeOpp, setStoreOpp] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);

  async function doPreview(payload?: string, modeOverride?: JoinMode) {
    const src = payload ?? text;
    const useMode = modeOverride ?? mode;   // 允许显式指定模式：setMode 是异步的，闭包里拿不到新值
    if (!src.trim()) { setError('请先粘贴战报数据'); return; }
    setBusy(true);
    try {
      const res = await api.match.importPreview(src, useMode);
      setPreview(res);
      setError(null);
      setNotice(null);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * 提交入库。
   *
   * `skipped` = 被跳过的行数（勾了"不存对方"时才 >0）。
   * 对方行能不能走到这里由主进程按 opts.opp 决定，见 ipc.matchImportCommit。
   */
  async function doCommit(pv = preview, skipped = 0) {
    if (!pv) return;
    setBusy(true);
    try {
      const res = await api.match.importCommit(matchId, pv, { opp: storeOpp ? 'store' : 'skip' });
      setNotice(
        `已写入自己人 ${res.written} 条战报`
        + (res.created ? `（自动建档 ${res.created} 人）` : '')
        + (res.oppWritten
          ? `；对方帮会 ${res.oppWritten} 条已存为对比数据`
            + (res.oppCreated ? `（新建 ${res.oppCreated} 人）` : '')
            + '，不进主档、不参与评分（可在「对方数据」页签查看 / 清空）'
          : '')
        + (skipped > 0 ? `；跳过对方 ${skipped} 行` : ''),
      );
      setPreview(null);
      setText('');
      setError(null);
      onDone();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  /* ── 校验结果的几种口径（都从 preview 派生，避免多处各算一遍）─────────
     用户反馈过「批量导入战报导入不进去」：严格模式下只要有一个人不在主档，
     「确认写入」就整批被拦住。现在的口径是：
       · 「不在主档（NOT_IN_ROSTER）」= 对方帮会的人 → 按下面的勾选存或跳，不拦；
       · 数字不对 / 同一人重复 这类硬错误 → 仍然拦住（那是真问题）。
     用户口径 2026-09：「表内出现别的帮会 —— 不纳入评分机制，纯数据对比」。 */

  /** 有硬错误（非"不在主档"）的行 */
  const hardRows = preview
    ? preview.rows.filter((r) => r.issues.some((i) => i.level === 'error' && i.code !== 'NOT_IN_ROSTER'))
    : [];
  /** 不在主档的行（多半是对方帮会）：只有这一类错误，可按选项存下来。
      判据必须带 level==='error' —— 完整模式下同一行的 NOT_IN_ROSTER 只是 warn，
      语义是"自动建档成自己人"，那时它不算对方。 */
  const oppRows = preview
    ? preview.rows.filter((r) => r.playerId === null
        && r.issues.some((i) => i.code === 'NOT_IN_ROSTER' && i.level === 'error')
        && !r.issues.some((i) => i.level === 'error' && i.code !== 'NOT_IN_ROSTER'))
    : [];
  const ourRows = preview ? preview.rows.length - oppRows.length - hardRows.length : 0;
  const notInRoster = preview
    ? preview.issues.filter((i) => i.code === 'NOT_IN_ROSTER' && i.level === 'error').length
    : 0;
  /** 表头都没认出来（粘贴内容不对）——这时给的是格式提示，而不是"没匹配上" */
  const headerBad = preview
    ? preview.summary.total === 0 && preview.issues.some((i) => i.code === 'HEADER_NOT_FOUND')
    : false;
  const canCommit = !!preview && !headerBad && hardRows.length === 0 && preview.rows.length > 0;

  /** 入库当前预览：只滤掉硬错误行，对方行交给主进程按 storeOpp 处理 */
  function commitPreview() {
    if (!preview || !canCommit) return;
    const rows = preview.rows.filter((r) =>
      !r.issues.some((i) => i.level === 'error' && i.code !== 'NOT_IN_ROSTER'));
    const skipped = storeOpp ? 0 : rows.length - ourRows;
    void doCommit({
      ...preview,
      rows,
      summary: {
        ...preview.summary,
        total: rows.length,
        matched: rows.filter((r) => r.playerId !== null).length,
        errors: Math.max(0, preview.summary.errors - notInRoster),
      },
    }, skipped);
  }

  const commitLabel = hardRows.length > 0
    ? `确认写入（${hardRows.length} 行有硬错误，需先修）`
    : oppRows.length > 0
      ? (storeOpp
        ? `确认写入：自己人 ${ourRows} 行 + 对方 ${oppRows.length} 行（对方只对比、不评分）`
        : `确认写入：只写自己人 ${ourRows} 行，跳过对方 ${oppRows.length} 行`)
      : '确认写入';

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
        {/* 对方帮会的行（战报整场导出里必然混着对手）怎么处理 —— 见 shared/types.ts 的 OppImportMode */}
        <label className="check" title="对方帮会的数据只作对比基准：不进成员主档 / 报名 / 出勤，也不参与评分">
          <input type="checkbox" checked={storeOpp} onChange={(e) => setStoreOpp(e.target.checked)} />
          <span>存下对方数据</span>
        </label>
        <button className="btn primary" onClick={() => void doPreview()} disabled={busy}>校验预览</button>
        {preview && !headerBad && (
          <button className="btn primary" disabled={busy || !canCommit} onClick={commitPreview}>
            {commitLabel}
          </button>
        )}
      </div>

      {/* ⚠️ 「导入不进去」的出路（用户反馈）：
          严格模式下只要有一个人不在主档，整批就被拦住。这里把原因摆出来，并给一键出路 ——
          ① 改用完整模式重新校验（不在档的自动建档）；② 把对不上的行按"对方帮会"存下来
          （用户口径选项 A：不评分，纯对比）或直接跳过。
          表头都没认出来时给的是"格式提示"，不再让用户对着"未匹配 0"发懵。 */}
      {preview && headerBad && (
        <div className="msg warn" style={{ marginTop: 10, whiteSpace: 'normal' }}>
          没认出表头 —— 粘贴的内容里找不到「玩家名字 / 角色ID」列。
          请把 Excel 的**表头行一起**复制进来，第一行要含「玩家名字」（或「角色ID」），
          后面至少要有「击败/清泉」「助攻」「对玩家伤害」这类列。当前识别到的问题：
          {preview.issues.map((i) => i.message).join('；')}
        </div>
      )}
      {preview && !headerBad && (oppRows.length > 0 || hardRows.length > 0) && (
        <div className="msg warn" style={{ marginTop: 10, whiteSpace: 'normal' }}>
          {hardRows.length > 0 ? (
            <>
              有 <b>{hardRows.length}</b> 行过不了校验（数字不对 / 同一人重复 这类硬错误，需要先修）；
              另有 <b>{notInRoster}</b> 行不在你的成员主档里（多半是对方的人）。
            </>
          ) : (
            <>
              整场导出里混了别的帮会：<b>{oppRows.length}</b> 行不在你的成员主档里（对方的人）。
              按你的口径，对方<b>不纳入评分</b>，只会作为
              <b>纯对比数据</b>存下来 —— 不进成员主档、报名表、出勤统计。
            </>
          )}
          <span className="toolbar" style={{ marginTop: 8, marginBottom: 0 }}>
            {canCommit && (
              <button className="btn primary sm" disabled={busy} onClick={commitPreview}>
                {commitLabel}
              </button>
            )}
            {notInRoster > 0 && (
              <button className="btn sm" disabled={busy}
                      onClick={() => { setMode('full'); void doPreview(undefined, 'full'); }}>
                改用「完整」模式（不在档的自动建档成自己人）
              </button>
            )}
            {oppRows.length > 0 && (
              <label className="check">
                <input type="checkbox" checked={storeOpp} onChange={(e) => setStoreOpp(e.target.checked)} />
                <span>把这 {oppRows.length} 行存为对方数据（只对比、不评分）</span>
              </label>
            )}
          </span>
        </div>
      )}

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
            <div className="stat"><div className="k">对方 / 未匹配</div>
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
                  {preview.rows.slice(0, 60).map((r) => {
                    /* 对方行 = 只是"不在我主档"（多半是别的帮会），与真错误区分显示：
                       它们不会被丢掉，而是按勾选存成对比数据（或跳过）。 */
                    const isOpp = r.playerId === null
                      && r.issues.some((i) => i.code === 'NOT_IN_ROSTER' && i.level === 'error');
                    const hard = r.issues.some((i) => i.level === 'error' && i.code !== 'NOT_IN_ROSTER');
                    return (
                      <tr key={r.row} style={hard ? { background: 'var(--danger-soft)' } : isOpp ? { opacity: .72 } : undefined}>
                        <td className="num">{r.row}</td>
                        <td>{r.name}</td>
                        <td><ClassChip name={r.classUsed} classMap={classMap} showIcon={false} /></td>
                        <td style={{ color: r.playerId !== null ? 'var(--ok)' : isOpp ? 'var(--warn)' : 'var(--danger)' }}>
                          {r.playerId !== null ? '✓' : isOpp ? '对方' : '未匹配'}
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
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
      
    </div>
  );
}
