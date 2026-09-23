import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToastAutoClear } from '../lib/useToast';
import type { MatchSummary } from '@shared/types';
import { api, ApiError } from '../api';
import type { PageProps } from '../App';
import { MATCH_RESULT_LABEL, TOTAL_TOWERS_PER_SIDE } from '@shared/domain';
import MatchDetail from './MatchDetail';
import Select from '../components/Select';
import DatePicker from '../components/DatePicker';
import { confirmDialog } from '../components/Confirm';

interface Props extends PageProps {
  onCount?: (n: number) => void;
}

function today(): string {
  const d = new Date();
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default function MatchPage({ classes, classMap }: Props) {
  const [list, setList] = useState<MatchSummary[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 成功提示 2.5 秒后自动消失（报错不自动清，要留够时间看清）
  useToastAutoClear(notice, setNotice);
  const [loading, setLoading] = useState(true);

  const [form, setForm] = useState({
    date: today(),
    ourSide: '我方',
    oppSide: '',
    result: 'WIN' as MatchSummary['result'],
    ourTowersLeft: TOTAL_TOWERS_PER_SIDE,
    oppTowersLeft: 0,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.match.list();
      setList(rows);
      setError(null);
      // 这里**不能**再「没选中就自动选第一场」：那会让详情页的「返回列表」
      // 刚 setSelected(null) 就又被自动选回去，表现为返回按钮完全无效。
      // 创建对局后进入详情由 handleCreate 自己 setSelected 负责。
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const stats = useMemo(() => {
    const played = list.filter((m) => m.ourCount > 0);
    const wins = list.filter((m) => m.result === 'WIN').length;
    const filled = list.reduce((s, m) => s + m.statFilled, 0);
    return { total: list.length, wins, played: played.length, filled };
  }, [list]);

  /* 「当天第几场」：留空表示自动 —— 取当天已有场次的最大值 + 1（避免撞号）。
     原来创建表单里根本没有这个字段，所以只能建完再去详情里改。 */
  const [dayIndex, setDayIndex] = useState('');
  async function handleCreate() {
    if (!form.date) { setError('请选择日期'); return; }
    try {
      const res = await api.match.create({
        date: form.date,
        // 留空 → 当天最大 + 1；填了就用填的（至少 1）
        indexInDay: (() => {
          const auto = list.filter((m) => m.date === form.date)
            .reduce((mx, m) => Math.max(mx, m.indexInDay), 0) + 1;
          const typed = Number(dayIndex);
          return dayIndex.trim() !== '' && Number.isFinite(typed) ? Math.max(1, typed) : auto;
        })(),
        ourSide: form.ourSide,
        oppSide: form.oppSide,
        result: form.result,
        ourTowersLeft: form.ourTowersLeft,
        oppTowersLeft: form.oppTowersLeft,
      });
      setError(null);
      setNotice(`已创建对局，并从上一场继承 ${res.inherited} 名队员`);
      setForm({ ...form, oppSide: '', oppTowersLeft: 0 });
      await load();
      setSelected(res.match.id);
    } catch (err) {
      setNotice(null);
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function handleRemove(m: MatchSummary) {
    if (!await confirmDialog(`确认删除 ${m.date} 第 ${m.indexInDay} 场（${m.ourSide} vs ${m.oppSide}）？\n该场所有参战与战报会一并删除。`)) return;
    try {
      await api.match.remove(m.id);
      if (selected === m.id) setSelected(null);
      setNotice('已删除对局');
      setError(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  if (selected !== null) {
    return (
      <MatchDetail
        matchId={selected}
        classes={classes}
        classMap={classMap}
        onBack={() => { setSelected(null); void load(); }}
        onChanged={() => void load()}
      />
    );
  }

  return (
    <>
      {error && <div className="msg msg--toast error">{error}</div>}
      {notice && <div className="msg msg--toast ok">{notice}</div>}

      <div className="stat-grid" style={{ marginBottom: 12 }}>
        <div className="stat"><div className="k">对局总数</div><div className="v">{stats.total}</div></div>
        <div className="stat"><div className="k">已排阵容</div><div className="v">{stats.played}<small> 场</small></div></div>
        <div className="stat"><div className="k">胜场</div>
          <div className="v" style={{ color: 'var(--ok)' }}>{stats.wins}</div>
        </div>
        <div className="stat"><div className="k">已录战报人次</div><div className="v">{stats.filled}</div></div>
      </div>

      <div className="card">
        <h3>新建对局</h3>
        <div className="toolbar" style={{ marginBottom: 8 }}>
          <label className="field">
            <span>日期</span>
            <DatePicker className="input" value={form.date}
                   onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </label>
                    <label className="field"><span>当天第几场</span>
            <input className="input" style={{ width: 72 }} type="number" min={1}
                   placeholder="自动" value={dayIndex}
                   onChange={(e) => setDayIndex(e.target.value)} />
          </label>
          <label className="field">
            <span>我方</span>
            <input className="input" style={{ width: 110 }} value={form.ourSide}
                   onChange={(e) => setForm({ ...form, ourSide: e.target.value })} />
          </label>
          <label className="field">
            <span>对手</span>
            <input className="input" style={{ width: 130 }} placeholder="对手联盟名" value={form.oppSide}
                   onChange={(e) => setForm({ ...form, oppSide: e.target.value })} />
          </label>
          <label className="field">
            <span>胜负</span>
            <Select className="select" value={form.result}
                    onChange={(e) => setForm({ ...form, result: e.target.value as MatchSummary['result'] })}>
              <option value="WIN">胜</option>
              <option value="LOSE">负</option>
              <option value="DRAW">平</option>
            </Select>
          </label>
          <label className="field">
            <span>我方剩余塔</span>
            <input className="input" style={{ width: 62 }} type="number" min={0} max={TOTAL_TOWERS_PER_SIDE}
                   value={form.ourTowersLeft}
                   onChange={(e) => setForm({ ...form, ourTowersLeft: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span>敌方剩余塔</span>
            <input className="input" style={{ width: 62 }} type="number" min={0} max={TOTAL_TOWERS_PER_SIDE}
                   value={form.oppTowersLeft}
                   onChange={(e) => setForm({ ...form, oppTowersLeft: Number(e.target.value) })} />
          </label>
          <button className="btn primary" onClick={handleCreate}>创建并继承上场阵容</button>
        </div>
        
      </div>

      <div className="card">
        <h3>对局列表</h3>
        <div className="table-wrap" style={{ maxHeight: '48vh' }}>
          <table className="grid">
            <thead>
              <tr>
                <th style={{ width: 108 }}>日期</th>
                <th className="num" style={{ width: 60 }}>场次</th>
                <th>我方</th>
                <th>对手</th>
                <th style={{ width: 60 }}>结果</th>
                <th className="num" style={{ width: 120 }}>塔数（我/敌）</th>
                <th className="num" style={{ width: 100 }}>我方参战</th>
                <th className="num" style={{ width: 100 }}>已录战报</th>
                <th style={{ width: 130 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td className="empty" colSpan={9}>加载中…</td></tr>}
              {!loading && list.length === 0 && (
                <tr><td className="empty" colSpan={9}>还没有对局。用上面的表单创建第一场。</td></tr>
              )}
              {!loading && list.map((m) => (
                <tr key={m.id}>
                  <td>{m.date}</td>
                  <td className="num">{m.indexInDay}</td>
                  <td>{m.ourSide}</td>
                  <td>{m.oppSide}</td>
                  <td style={{ color: m.result === 'WIN' ? 'var(--ok)' : m.result === 'LOSE' ? 'var(--danger)' : 'var(--text-dim)' }}>
                    {MATCH_RESULT_LABEL[m.result]}
                  </td>
                  <td className="num">
                    {m.ourTowersLeft} / {m.oppTowersLeft}
                  </td>
                  <td className="num">{m.ourCount}</td>
                  <td className="num" style={{ color: m.statFilled < m.ourCount ? 'var(--warn)' : undefined }}>
                    {m.statFilled} / {m.ourCount}
                  </td>
                  <td className="actions">
                    <div className="row-edit" style={{ justifyContent: 'flex-end' }}>
                      <button className="btn sm primary" onClick={() => setSelected(m.id)}>进入</button>
                      <button className="btn sm danger" onClick={() => void handleRemove(m)}>删除</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
