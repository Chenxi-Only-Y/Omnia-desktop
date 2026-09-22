import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToastAutoClear } from '../lib/useToast';
import type { PersonalWeights, RuleSet, RuleSetInput, RuleSetValidation } from '@shared/types';
import { api, ApiError } from '../api';
import type { PageProps } from '../App';

type Role = 'DPS' | 'T' | 'HEAL';
type Kind = 'push' | 'guard' | 'defend';

const ROLE_LABEL: Record<Role, string> = { DPS: 'DPS / 输出', T: 'T / 铁衣', HEAL: '治疗 / 素问·妙音' };
const KIND_LABEL: Record<Kind, string> = { push: '推塔型（塔后拆 / 塔前拆）', guard: '保镖型', defend: '防守型' };

/** 各定位会用到哪些个人权重项（用于渲染输入框） */
const PERSONAL_FIELDS: { key: keyof PersonalWeights; label: string }[] = [
  { key: 'kill', label: '有效击杀' },
  { key: 'dmg', label: '有效人伤' },
  { key: 'tower', label: '有效塔伤' },
  { key: 'assist', label: '助攻' },
  { key: 'fountain', label: '清泉' },
  { key: 'bone', label: '焚骨' },
  { key: 'heal', label: '治疗量' },
  { key: 'taken', label: '承伤' },
  { key: 'revive', label: '复活' },
];

const EXEC_FIELDS: Record<Kind, { key: string; label: string }[]> = {
  push: [
    { key: 'progress', label: '推塔进度' },
    { key: 'flag', label: '大旗（胜负）' },
    { key: 'tower', label: '小队塔伤' },
    { key: 'kill', label: '小队击杀' },
  ],
  guard: [
    { key: 'kill', label: '小队击杀' },
    { key: 'taken', label: '小队承伤' },
    { key: 'lowDeath', label: '低死亡' },
  ],
  defend: [
    { key: 'keepRate', label: '守塔率' },
    { key: 'kill', label: '小队击杀' },
    { key: 'lowDeath', label: '低死亡' },
  ],
};

const sum = (o: Record<string, number | undefined>): number =>
  Object.values(o).reduce<number>((a, b) => a + (typeof b === 'number' ? b : 0), 0);

export default function RulesPage({ classes }: PageProps) {
  const [list, setList] = useState<RuleSet[]>([]);
  const [editing, setEditing] = useState<RuleSetInput | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [validation, setValidation] = useState<RuleSetValidation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 成功提示 2.5 秒后自动消失（报错不自动清，要留够时间看清）
  useToastAutoClear(notice, setNotice);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setList(await api.rules.list());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** 打开某套规则进行编辑（拷贝一份，改完再保存） */
  function edit(rs: RuleSet) {
    const { id, seasonId, version, active, createdAt, ...input } = rs;
    void id; void seasonId; void version; void active; void createdAt;
    setEditing(JSON.parse(JSON.stringify(input)) as RuleSetInput);
    setEditingId(rs.id);
    setValidation(null);
    setNotice(null);
  }

  async function startFromDefaults() {
    try {
      const d = await api.rules.defaults();
      setEditing(JSON.parse(JSON.stringify(d)) as RuleSetInput);
      setEditingId(null);
      setValidation(null);
      setNotice('已载入内置默认值（可用「另存为新规则集」保存）');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  /** 每次改动都跑一次校验，实时提示 */
  const patch = useCallback((next: RuleSetInput) => {
    setEditing(next);
    void api.rules.validate(next).then(setValidation).catch(() => setValidation(null));
  }, []);

  useEffect(() => {
    if (editing) void api.rules.validate(editing).then(setValidation).catch(() => setValidation(null));
  }, [editing?.name]);   // 仅用于首次载入时给个校验结果

  async function save() {
    if (!editing) return;
    setBusy(true);
    try {
      if (editingId === null) {
        await api.rules.create(editing);
        setNotice(`已新建规则集「${editing.name}」`);
      } else {
        await api.rules.update(editingId, editing);
        setNotice(`已保存对「${editing.name}」的修改`);
      }
      setError(null);
      setEditing(null);
      setEditingId(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function run(fn: () => Promise<unknown>, okMsg: string) {
    setBusy(true);
    try {
      await fn();
      setNotice(okMsg);
      setError(null);
      await load();
    } catch (err) {
      setNotice(null);
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function exportJson(rs: RuleSet) {
    const { id, seasonId, version, active, createdAt, ...input } = rs;
    void id; void seasonId; void version; void active; void createdAt;
    const blob = new Blob([JSON.stringify(input, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Omnia规则_${rs.name}_v${rs.version}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const errors = useMemo(() => validation?.issues.filter((i) => i.level === 'error') ?? [], [validation]);
  const warns = useMemo(() => validation?.issues.filter((i) => i.level === 'warn') ?? [], [validation]);

  return (
    <>
      {error && <div className="msg msg--toast error">{error}</div>}
      {notice && <div className="msg msg--toast ok">{notice}</div>}

      <div className="card">
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <h3 style={{ margin: 0 }}>规则集（评分参数）</h3>
          <div className="spacer grow" />
          <button className="btn" disabled={busy} onClick={() => void startFromDefaults()}>
            载入内置默认值
          </button>
          <button className="btn ghost" onClick={() => void load()}>刷新</button>
        </div>
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table className="grid">
            <thead>
              <tr>
                <th style={{ width: 60 }}>版本</th>
                <th>名称</th>
                <th style={{ width: 70 }}>激活</th>
                <th style={{ width: 200 }}>分制</th>
                <th style={{ width: 200 }}>刻度 / 扣分</th>
                <th style={{ width: 200 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.length === 0 && <tr><td className="empty" colSpan={6}>还没有规则集</td></tr>}
              {list.map((rs) => (
                <tr key={rs.id} style={rs.active ? { background: 'var(--accent-soft)' } : undefined}>
                  <td className="num">v{rs.version}</td>
                  <td>
                    {rs.name}
                    <span style={{ color: 'var(--text-faint)', marginLeft: 6, fontSize: 11 }}>{rs.createdAt}</span>
                  </td>
                  <td>
                    {rs.active
                      ? <span className="badge-state active">使用中</span>
                      : <button className="btn sm" disabled={busy}
                                onClick={() => void run(() => api.rules.setActive(rs.id), `已切换到「${rs.name}」`)}>
                          设为使用中
                        </button>}
                  </td>
                  <td style={{ color: 'var(--text-dim)' }}>
                    基础 {rs.baseScore} · 封顶 {rs.capScore} · 塔 {rs.totalTowers}
                  </td>
                  <td style={{ color: 'var(--text-dim)' }}>
                    团队 ×{rs.scaleTeam} · 个人 ×{rs.scalePersonal} · 死亡 {rs.deathPen}
                  </td>
                  <td className="actions">
                    <div className="row-edit" style={{ justifyContent: 'flex-end' }}>
                      <button className="btn sm" onClick={() => edit(rs)}>编辑</button>
                      <button className="btn sm" disabled={busy}
                              onClick={() => void run(() => api.rules.duplicate(rs.id), '已另存为新版本')}>
                        另存
                      </button>
                      <button className="btn sm ghost" onClick={() => exportJson(rs)}>导出</button>
                      <button className="btn sm danger" disabled={busy || rs.active}
                              title={rs.active ? '使用中的规则不能删除' : '删除'}
                              onClick={() => void run(() => api.rules.remove(rs.id), '已删除')}>
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="hint">
          规则集版本化：改动会保留历史版本，可随时切回。<strong>评分算法本身还没定</strong>，
          所以这里只管参数；算法落定后这些参数会被评分引擎直接读取。
        </div>
      </div>

      {editing && (
        <>
          <div className="card">
            <div className="toolbar">
              <h3 style={{ margin: 0 }}>
                {editingId === null ? '新建规则集' : `编辑规则集（id=${editingId}）`}
              </h3>
              <div className="spacer grow" />
              <button className="btn primary" disabled={busy || (validation ? !validation.ok : false)}
                      onClick={() => void save()}>
                {editingId === null ? '另存为新规则集' : '保存修改'}
              </button>
              <button className="btn ghost" onClick={() => { setEditing(null); setEditingId(null); }}>放弃</button>
            </div>

            {errors.length > 0 && (
              <div className="msg error">
                <b>有 {errors.length} 项错误，无法保存：</b>
                <ul style={{ margin: '4px 0 0 18px' }}>
                  {errors.map((i, n) => <li key={n}>{i.field}：{i.message}</li>)}
                </ul>
              </div>
            )}
            {warns.length > 0 && (
              <div className="msg warn">
                <b>提示（不阻止保存）：</b>
                <ul style={{ margin: '4px 0 0 18px' }}>
                  {warns.map((i, n) => <li key={n}>{i.field}：{i.message}</li>)}
                </ul>
              </div>
            )}

            <div className="toolbar">
              <label className="field"><span>名称</span>
                <input className="input" style={{ width: 260 }} value={editing.name}
                       onChange={(e) => patch({ ...editing, name: e.target.value })} />
              </label>
              <label className="field"><span>基础分</span>
                <input className="input" style={{ width: 74 }} type="number" value={editing.baseScore}
                       onChange={(e) => patch({ ...editing, baseScore: Number(e.target.value) })} />
              </label>
              <label className="field"><span>封顶分</span>
                <input className="input" style={{ width: 74 }} type="number" value={editing.capScore}
                       onChange={(e) => patch({ ...editing, capScore: Number(e.target.value) })} />
              </label>
              <label className="field"><span>团队刻度</span>
                <input className="input" style={{ width: 74 }} type="number" value={editing.scaleTeam}
                       onChange={(e) => patch({ ...editing, scaleTeam: Number(e.target.value) })} />
              </label>
              <label className="field"><span>个人刻度</span>
                <input className="input" style={{ width: 74 }} type="number" value={editing.scalePersonal}
                       onChange={(e) => patch({ ...editing, scalePersonal: Number(e.target.value) })} />
              </label>
              <label className="field"><span>死亡扣分/次</span>
                <input className="input" style={{ width: 74 }} type="number" value={editing.deathPen}
                       onChange={(e) => patch({ ...editing, deathPen: Number(e.target.value) })} />
              </label>
              <label className="field"><span>每方塔数</span>
                <input className="input" style={{ width: 74 }} type="number" value={editing.totalTowers}
                       onChange={(e) => patch({ ...editing, totalTowers: Number(e.target.value) })} />
              </label>
            </div>
          </div>

          <div className="card">
            <h3>个人权重（按定位；每行权重之和应为 1）</h3>
            <div className="table-wrap">
              <table className="grid">
                <thead>
                  <tr>
                    <th style={{ width: 170 }}>定位</th>
                    {PERSONAL_FIELDS.map((f) => <th key={f.key} className="num">{f.label}</th>)}
                    <th className="num" style={{ width: 90 }}>合计</th>
                  </tr>
                </thead>
                <tbody>
                  {(['DPS', 'T', 'HEAL'] as Role[]).map((role) => {
                    const w = editing.personalWeights[role] ?? {};
                    const total = sum(w as Record<string, number | undefined>);
                    return (
                      <tr key={role}>
                        <td>{ROLE_LABEL[role]}</td>
                        {PERSONAL_FIELDS.map((f) => {
                          const v = (w as Record<string, number | undefined>)[f.key];
                          const show = v !== undefined;
                          return (
                            <td key={f.key} className="num">
                              {show ? (
                                <input className="input cell-num" type="number" step="0.05" min={0}
                                       value={v}
                                       onChange={(e) => patch({
                                         ...editing,
                                         personalWeights: {
                                           ...editing.personalWeights,
                                           [role]: { ...w, [f.key]: Number(e.target.value) },
                                         },
                                       })} />
                              ) : <span style={{ color: 'var(--text-faint)' }}>—</span>}
                            </td>
                          );
                        })}
                        <td className="num" style={{ color: Math.abs(total - 1) < 1e-6 ? 'var(--ok)' : 'var(--warn)' }}>
                          {total.toFixed(2)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="hint">
              空白格表示该定位不使用该项（例如治疗不参与清泉/焚骨）。清空某项请把值设为 0 而不是删除键，
              以免与「不使用」混淆。
            </div>
          </div>

          <div className="card">
            <h3>战术执行权重（按战术类型；每行权重之和应为 1）</h3>
            <div className="table-wrap">
              <table className="grid">
                <thead>
                  <tr>
                    <th style={{ width: 220 }}>战术类型</th>
                    <th className="num">项</th>
                    <th className="num">值</th>
                    <th className="num" style={{ width: 90 }}>合计</th>
                  </tr>
                </thead>
                <tbody>
                  {(['push', 'guard', 'defend'] as Kind[]).map((kind) => {
                    const w = editing.execWeights[kind] as Record<string, number | undefined>;
                    const fields = EXEC_FIELDS[kind];
                    const total = sum(w);
                    return fields.map((f, idx) => (
                      <tr key={`${kind}-${f.key}`}>
                        {idx === 0 && <td rowSpan={fields.length}>{KIND_LABEL[kind]}</td>}
                        <td className="num">{f.label}</td>
                        <td className="num">
                          <input className="input cell-num" type="number" step="0.05" min={0}
                                 value={w[f.key] ?? 0}
                                 onChange={(e) => patch({
                                   ...editing,
                                   execWeights: {
                                     ...editing.execWeights,
                                     [kind]: { ...w, [f.key]: Number(e.target.value) },
                                   },
                                 })} />
                        </td>
                        {idx === 0 && (
                          <td rowSpan={fields.length} className="num"
                              style={{ color: Math.abs(total - 1) < 1e-6 ? 'var(--ok)' : 'var(--warn)' }}>
                            {total.toFixed(2)}
                          </td>
                        )}
                      </tr>
                    ));
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <h3>职业平衡系数</h3>
            <div className="coef-grid">
              {classes.map((c) => (
                <label key={c.name} className="coef-item">
                  <span style={{ color: c.color }}>{c.name}</span>
                  <input className="input cell-num" type="number" step="0.05" min={0.1}
                         value={editing.classCoef[c.name] ?? 1}
                         onChange={(e) => patch({
                           ...editing,
                           classCoef: { ...editing.classCoef, [c.name]: Number(e.target.value) },
                         })} />
                </label>
              ))}
            </div>
            <div className="hint">
              个人换算分 = 个人比例 × 个人刻度 × 职业系数。系数大于 1 表示该职业更难拿分、给予补偿。
            </div>
          </div>

          <div className="card">
            <h3>附加分</h3>
            <div className="toolbar">
              {Object.entries(editing.bonus).map(([k, v]) => (
                <label key={k} className="field"><span>{k}</span>
                  <input className="input" style={{ width: 84 }} type="number" step="0.5" min={0} value={v}
                         onChange={(e) => patch({
                           ...editing,
                           bonus: { ...editing.bonus, [k]: Number(e.target.value) },
                         })} />
                </label>
              ))}
            </div>
          </div>
        </>
      )}

      <div className="card">
        <div className="hint" style={{ margin: 0 }}>
          默认值来源：原表「数据处理1」第 4 行的权重与系数 + 设计基准 v2 的战术权重推导
          （推塔 60%、其中塔进度 7/9、大旗 2/9）。<b>评分算法尚未确定</b>，
          所以本页只负责参数与版本管理；等算法落定，评分引擎会读「使用中」的那套规则。
        </div>
      </div>
    </>
  );
}
