import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useToastAutoClear } from '../lib/useToast';
import type { Match, PartState, Player, PlayerInput, SignupStatus } from '@shared/types';
import { api, ApiError } from '../api';
import type { PageProps } from '../App';
import ImportWizard from '../components/ImportWizard';
import { parseTableText, toCsv } from '../lib/importer';
import Select from '../components/Select';
import { confirmDialog } from '../components/Confirm';

interface Props extends PageProps {
  onCount: (n: number) => void;
  /** 打开成员详情 */
  onOpenDetail: (playerId: number) => void;
}

interface Draft {
  /** 「ID名」与「昵称」已合并为单一字段 ID */
  id: string;
  joinedOrder: string;
  mic: Player['mic'];
  noteRole: Player['noteRole'];
  /** 橙武（空 = 没有） */
  orangeWeapon: string;
  status: string;
  remark: string;
}

const EMPTY_DRAFT: Draft = {
  id: '', joinedOrder: '', mic: '', noteRole: '', orangeWeapon: '', status: 'active', remark: '',
};

/** 可排序的列（表头点击） */
type SortKey = 'order' | 'id' | 'signup' | 'status' | 'mic' | 'role' | 'orange' | 'remark';

/** 报名状态排序权重：参加 → 替补 → 请假 → 未填表 */
function signupRank(s: SignupStatus | null): number {
  if (s === 'JOIN') return 0;
  if (s === 'BENCH') return 1;
  if (s === 'LEAVE') return 2;
  return 3;
}

const STATUS_LABEL: Record<string, string> = { active: '在队', inactive: '暂离', left: '离队' };

export default function RosterPage({ classes, classMap, onCount, onOpenDetail }: Props) {
  const [players, setPlayers] = useState<Player[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 成功提示 2.5 秒后自动消失（报错不自动清，要留够时间看清）
  useToastAutoClear(notice, setNotice);
  const [filterStatus, setFilterStatus] = useState('');
  /** 新增成员弹层（用户口径：新增改成单独按钮打开） */
  const [showAdd, setShowAdd] = useState(false);
  /* 浮层收起动画：关闭时保持挂载 180ms */
  const [addClosing, setAddClosing] = useState(false);
  const closeAdd = () => {
    setShowAdd(false);
    setAddClosing(true);
    window.setTimeout(() => setAddClosing(false), 180);
  };
  /** 当前场次：用于判定「未填表」（报名表是分场次的） */
  const [matches, setMatches] = useState<Match[]>([]);
  const [matchId, setMatchId] = useState<number | null>(null);
  /** playerId → 本场报名状态（null 表示未填表） */
  const [signupOf, setSignupOf] = useState<Map<number, SignupStatus | null>>(new Map());
  /**
   * playerId → 本场排表状态。
   * 用户口径：「排表里有就显示在队」—— 即状态列以**排表**为准，
   * 而不是主档里那个基本没人维护的状态字段。
   */
  const [lineupOf, setLineupOf] = useState<Map<number, PartState>>(new Map());
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editId, setEditId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY_DRAFT);
  const [wizard, setWizard] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  /** 拖拽换位：正在拖的、以及当前悬停的目标 */
  const [dragId, setDragId] = useState<number | null>(null);
  /** 拖动时的插入位置：目标卡片 + 插在它上面还是下面（决定细线画在哪条缝里） */
  const [dropAt, setDropAt] = useState<{ id: number; below: boolean } | null>(null);
  /** 正在编辑「序」的那一行（null = 全部按纯文字显示，没有白框） */
  const [orderEditId, setOrderEditId] = useState<number | null>(null);
  /** 「定位 ID」：输入片段就滚到那个人并高亮；找不到给提示 */
  const [locateQ, setLocateQ] = useState('');
  const [locateMsg, setLocateMsg] = useState('');
  const [locateMiss, setLocateMiss] = useState(false);
  const [foundId, setFoundId] = useState<number | null>(null);
  const foundTimer = useRef<number | null>(null);
  /** 「序」输入中的草稿（失焦/回车才提交，避免边打字边存导致光标跳） */
  const [orderDraft, setOrderDraftState] = useState<string>('');
  /**
   * 表头排序：默认按「序」。点表头只改**查看顺序**，不动库里的序；
   * 换列排序后拖动换位仍按当前显示顺序写回序（见 moveTo 的说明）。
   */
  const [sortKey, setSortKey] = useState<SortKey>('order');
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  /** 列表容器：拖动到边缘时自动滚动 */
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.player.list();
      setPlayers(rows);
      onCount(rows.length);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [onCount]);

  useEffect(() => { void load(); }, [load]);

  // 场次列表：默认选最新一场（报名表是按场次导入的）
  useEffect(() => {
    void api.match.list().then((ms) => {
      setMatches(ms);
      setMatchId((cur) => cur ?? (ms.length ? ms[0].id : null));
    }).catch(() => { /* 没有场次时保持空 */ });
  }, []);

  // 拉该场的报名状态与排表状态：「未填表 / 参加 / 请假」以及「在队」都按本场判定
  useEffect(() => {
    if (matchId === null) { setSignupOf(new Map()); setLineupOf(new Map()); return; }
    void api.signup.board(matchId).then((b) => {
      setSignupOf(new Map(b.rows.map((r) => [r.playerId, r.signup])));
    }).catch(() => setSignupOf(new Map()));
    void api.match.participations(matchId).then((parts) => {
      setLineupOf(new Map(
        parts.filter((r) => r.side === 'our').map((r) => [r.playerId, r.state]),
      ));
    }).catch(() => setLineupOf(new Map()));
  }, [matchId]);

  /**
   * 状态列的显示值。
   * 用户口径「排表里有就显示在队」：已选场次时以**该场排表**为准 ——
   *   排表里上场 → 在队；替补 → 替补；请假 → 请假；没进排表 → 未排表。
   * 未选场次时退回主档里存的状态（在队/暂离/离队）。
   */
  function statusOf(p: Player): { label: string; kind: string } {
    if (matchId === null) {
      return { label: STATUS_LABEL[p.status] ?? p.status, kind: p.status };
    }
    const st = lineupOf.get(p.id);
    if (st === 'PLAY') return { label: '在队', kind: 'active' };
    if (st === 'BENCH') return { label: '替补', kind: 'inactive' };
    if (st === 'LEAVE') return { label: '请假', kind: 'left' };
    return { label: '未排表', kind: 'none' };
  }

  const filtered = useMemo(() => {
    return players.filter((p) => !filterStatus || p.status === filterStatus);
  }, [players, filterStatus]);

  /** 列表顺序：默认按「序」（没填序的排最后，同序按 id）；点表头可临时换列 */
  const sorted = useMemo(() => {
    const val = (p: Player): string | number => {
      switch (sortKey) {
        case 'order': return p.joinedOrder ?? Number.MAX_SAFE_INTEGER;
        case 'id': return p.gameId.toLowerCase();
        case 'signup': return signupRank(signupOf.get(p.id) ?? null);
        case 'status': return statusOf(p).label;
        case 'mic': return p.mic || '';
        case 'role': return p.noteRole || '';
        case 'orange': return p.orangeWeapon === '有' ? 0 : 1;
        case 'remark': return p.remark || '';
        default: return p.id;
      }
    };
    const cmp = (a: Player, b: Player): number => {
      const va = val(a);
      const vb = val(b);
      let r: number;
      if (typeof va === 'number' && typeof vb === 'number') r = va - vb;
      else r = String(va).localeCompare(String(vb), 'zh-Hans-CN');
      if (r === 0) r = a.id - b.id;      // 稳定：同值按 id
      return r * sortDir;
    };
    return [...filtered].sort(cmp);
  }, [filtered, sortKey, sortDir, signupOf]);

  /** 点表头：同一列再点切换升/降；换列则回到升序 */
  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(k); setSortDir(1); }
  }

  /**
   * 一键填满序：按**当前显示顺序**把序写成 1、2、3…
   * 导入进来的人序都是空的，先铺一遍再拖会顺手很多。
   */
  async function fillOrder() {
    if (!sorted.length) return;
    if (!await confirmDialog(`按当前显示顺序把 ${sorted.length} 人的「序」重写为 1…${sorted.length}？`)) return;
    try {
      await api.player.reorder(sorted.map((x) => x.id));
      setSortKey('order');
      setSortDir(1);
      setError(null);
      setNotice(`已把 ${sorted.length} 人的序填为 1…${sorted.length}`);
      await loadKeepingScroll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  /** 拖动到列表上/下边缘时自动滚动，才能把第 60 人拖到第 2 位 */
  function autoScroll(e: React.DragEvent) {
    const el = listRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 44;
    if (e.clientY < r.top + margin) el.scrollTop -= 14;
    else if (e.clientY > r.bottom - margin) el.scrollTop += 14;
  }

  /**
   * 把某人挪到第 ordinal 位（插入语义）。
   *
   * 用户口径：改序号不该和已有的重复，前面后面的要往上/往下顺移。
   * 做法是按**当前显示顺序**把人抽出来插到目标位置，再整批写回 1..N ——
   * 这样编号永远连续、不可能重复（原来直接写一个数字，就会出现两个 40）。
   */
  async function moveToOrdinal(playerId: number, ordinal: number) {
    const ids = sorted.map((x) => x.id);
    const from = ids.indexOf(playerId);
    if (from < 0) return;
    const to = Math.min(Math.max(1, Math.round(ordinal)), ids.length) - 1;
    if (to === from) return;
    ids.splice(from, 1);
    ids.splice(to, 0, playerId);
    try {
      await api.player.reorder(ids);
      // 写回后就是按序排列，把排序切回「序」否则显示顺序和刚改的对不上
      setSortKey('order');
      setSortDir(1);
      setError(null);
      await loadKeepingScroll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  /** 提交「序」：空值 = 排到最后 */
  async function commitOrder(p: Player) {
    const raw = orderDraft.trim();
    setOrderEditId(null);
    const target = raw === '' ? sorted.length : Number(raw);
    if (!Number.isFinite(target) || target < 1) { setOrderDraftState(''); return; }
    setOrderDraftState('');
    await moveToOrdinal(p.id, target);
  }

  /**
   * 拖拽换位：把 fromId 挪到 toId 的位置，然后整批写回「序」。
   * 只用当前**列表顺序**（sorted）算新顺序，所以拖完立即与界面一致。
   */
  /**
   * 定位到某个成员：滚到它、高亮一下。
   * 匹配顺序：**整串包含** → **字符按顺序出现**（模糊，例如「珺菌」能命中「珺珺不是菌子」）。
   * reset=true（边打字边找）跳到第一个命中；reset=false（回车）跳到下一个命中。
   */
  async function loadKeepingScroll() {
    const snap = Array.from(document.querySelectorAll<HTMLElement>('*'))
      .filter((el) => el.scrollTop > 0)
      .map((el) => [el, el.scrollTop] as const);
    await (load)();
    const restore = () => {
      if (document.querySelector('.roster-card--dragging')) return;
      snap.forEach(([el, top]) => { el.scrollTop = top; });
    };
    restore();
    requestAnimationFrame(restore);
  }

  /* 详情 / 编辑 / 删除等操作会调 load() 重建列表，滚动位置随之丢失。
     统一走上面的 loadKeepingScroll：重拉前记下所有已滚动元素的位置，重拉后恢复。
     与上一版（已回退）的关键差别是 drag guard —— 恢复前先看有没有拖拽在进行，
     有就完全不碰 scrollTop。上一版用 60/180/400ms 定时器多次恢复，
     在拖动过程中改写 scrollTop，直接打断了 HTML5 拖拽，导致拖不动。 */
  function locateNext(query: string, reset: boolean) {
    const key = query.trim().toLowerCase();
    if (!key) { setLocateMsg(''); setLocateMiss(false); setFoundId(null); return; }
    const fuzzy = (id: string) => {
      const s = id.toLowerCase();
      if (s.includes(key)) return true;
      let i = 0;
      for (const ch of s) { if (ch === key[i]) i += 1; if (i >= key.length) return true; }
      return false;
    };
    const matches = sorted.filter((p) => fuzzy(p.gameId));
    if (!matches.length) {
      setFoundId(null);
      setLocateMiss(true);
      setLocateMsg(`没有匹配「${query.trim()}」的 ID（列表共 ${sorted.length} 人）`);
      return;
    }
    let idx = 0;
    if (!reset && foundId !== null) {
      const cur = matches.findIndex((p) => p.id === foundId);
      idx = cur >= 0 ? (cur + 1) % matches.length : 0;
    }
    const target = matches[idx];
    setFoundId(target.id);
    setLocateMiss(false);
    setLocateMsg(matches.length > 1
      ? `找到 ${matches.length} 个 · 第 ${idx + 1} 个：${target.gameId}（回车看下一个）`
      : `找到：${target.gameId}`);

    // 滚到列表可视区中间（列表自己是滚动容器）
    requestAnimationFrame(() => {
      const el = listRef.current?.querySelector(`[data-player-id="${target.id}"]`);
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    /* 用户口径：找到的人要**一直高亮**，不能自己消失。
       原来这里 2.5 秒后把 foundId 清空，两个后果：
         ① 高亮还没看清就没了（"找到了没有提示位置在哪"）；
         ② foundId 变 null 后，下一次回车又从第 1 个匹配重新开始，
            表现为"第二个回车没反应"（其实是回到第一个了）。
       现在不清空 —— 高亮保留，回车也能正常往下轮。
       只有在搜索框被清空时才会清掉（见上面 key 为空那一段）。 */
    if (foundTimer.current) { window.clearTimeout(foundTimer.current); foundTimer.current = 0; }
  }

  async function moveTo(fromId: number, toId: number, below = false) {    const ids = sorted.map((x) => x.id);
    const from = ids.indexOf(fromId);
    const target = ids.indexOf(toId);
    if (from < 0 || target < 0) return;
    // 先把人抽出来，再按"插在目标上面还是下面"决定插入点 ——
    // 抽走之后目标的下标可能前移，所以上面那种情况要减 1。
    ids.splice(from, 1);
    let to = below ? target + 1 : target;
    if (from < to) to -= 1;
    to = Math.min(Math.max(0, to), ids.length);
    ids.splice(to, 0, fromId);
    try {
      await api.player.reorder(ids);
      setError(null);
      setNotice(`已按新顺序保存（${ids.length} 人）`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  const stats = useMemo(() => {
    const byStatus: Record<string, number> = {};
    let noMic = 0;
    for (const p of players) {
      byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
      if (!p.mic) noMic++;
    }
    // 「未填表」= 在队但本场没有报名记录（报名表是分场次的）
    const active = players.filter((p) => p.status === 'active');
    const notFilled = matchId === null
      ? 0
      : active.filter((p) => (signupOf.get(p.id) ?? null) === null).length;
    const joined = active.filter((p) => signupOf.get(p.id) === 'JOIN').length;
    const leave = active.filter((p) => signupOf.get(p.id) === 'LEAVE').length;
    return { byStatus, noMic, notFilled, joined, leave };
  }, [players, signupOf, matchId]);

  async function handleCreate() {
    const id = draft.id.trim();
    if (!id) { setError('ID 必填'); return; }
    try {
      await api.player.create({
        gameId: id,
        name: id,   // ID 名与昵称已合并，两处同值
        joinedOrder: draft.joinedOrder === '' ? null : Number(draft.joinedOrder),
        mic: draft.mic,
        noteRole: draft.noteRole,
        orangeWeapon: draft.orangeWeapon,
        status: draft.status,
        remark: draft.remark,
      });
      setDraft(EMPTY_DRAFT);
      setError(null);
      setNotice(`已添加 ${id}`);
      await loadKeepingScroll();
    } catch (err) {
      setNotice(null);
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  function startEdit(p: Player) {
    setEditId(p.id);
    setEditDraft({
      id: p.gameId,
      joinedOrder: p.joinedOrder === null ? '' : String(p.joinedOrder),
      mic: p.mic, noteRole: p.noteRole,
      orangeWeapon: p.orangeWeapon ?? '', status: p.status, remark: p.remark,
    });
  }

  async function saveEdit() {
    if (editId === null) return;
    try {
      const id = editDraft.id.trim();
      await api.player.update(editId, {
        gameId: id,
        name: id,
        // 序**不在这里直接写**：直接写数字会和别人撞号（截图里的两个 40 就是这么来的），
        // 统一改走 moveToOrdinal 的插入语义，在下面处理。
        mic: editDraft.mic,
        noteRole: editDraft.noteRole,
        orangeWeapon: editDraft.orangeWeapon,
        status: editDraft.status,
        remark: editDraft.remark,
      });
      // 序变了 → 插到目标位置，其余人自动顺移（编号恒为连续 1..N）
      const rawOrder = editDraft.joinedOrder.trim();
      const target = rawOrder === '' ? sorted.length : Number(rawOrder);
      const cur = players.find((x) => x.id === editId)?.joinedOrder ?? null;
      const changed = Number.isFinite(target) && target >= 1 && target !== cur;
      setEditId(null);
      if (changed) await moveToOrdinal(editId, target);
      else { setError(null); await loadKeepingScroll(); }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function handleRemove(p: Player) {
    if (!await confirmDialog(`确认删除成员「${p.gameId}」？`)) return;
    try {
      await api.player.remove(p.id);
      setError(null);
      setNotice(`已删除 ${p.gameId}`);
      await loadKeepingScroll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function handleFile(file: File | undefined) {
    if (!file) return;
    try {
      const text = await file.text();
      const rows: PlayerInput[] = file.name.toLowerCase().endsWith('.json')
        ? (JSON.parse(text) as PlayerInput[])
        : parseTableText(text);
      if (!Array.isArray(rows) || rows.length === 0) throw new Error('文件里没有解析出任何记录');
      const res = await api.player.import(rows);
      setError(null);
      setNotice(
        `导入完成：新增 ${res.inserted}，更新 ${res.updated}，跳过 ${res.skipped}` +
        (res.errors.length ? `；提示 ${res.errors.length} 条（见控制台）` : ''),
      );
      if (res.errors.length) console.warn('[import] 提示:', res.errors);
      await loadKeepingScroll();
    } catch (err) {
      setNotice(null);
      setError(`导入失败：${err instanceof ApiError ? err.message : String(err)}`);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function handleExport() {
    try {
      const rows = await api.player.export();
      const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `万象Omnia_成员主档_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      setNotice(`已导出 ${rows.length} 条记录`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <>
      {error && <div className="msg msg--toast error">{error}</div>}
      {notice && <div className="msg msg--toast ok">{notice}</div>}

      <div className="stat-grid" style={{ marginBottom: 12 }}>
        <div className="stat"><div className="k">成员总数</div><div className="v">{players.length}</div></div>
        <div className="stat"><div className="k">在队 / 暂离 / 离队</div>
          <div className="v">{stats.byStatus.active ?? 0}<small> / {stats.byStatus.inactive ?? 0} / {stats.byStatus.left ?? 0}</small></div>
        </div>
        <div className="stat"><div className="k">本场未填表</div>
          <div className="v" style={{ color: stats.notFilled ? 'var(--warn)' : undefined }}>{stats.notFilled}</div>
        </div>
        <div className="stat"><div className="k">本场参加 / 请假</div>
          <div className="v">{stats.joined}<small> / {stats.leave}</small></div>
        </div>
        <div className="stat"><div className="k">缺麦克风信息</div>
          <div className="v" style={{ color: stats.noMic ? 'var(--warn)' : undefined }}>{stats.noMic}</div>
        </div>
      </div>

      <div className="card">

        <div className="toolbar" style={{ marginBottom: 0 }}>

          {/* 「未填表」是相对某一场的报名表而言，所以这里必须选场次 */}
          <Select className="select" value={matchId ?? ''}
                  onChange={(e) => setMatchId(e.target.value === '' ? null : Number(e.target.value))}
                  title="选择场次：用于判定成员是否已填报名表">
            <option value="">（不比对场次）</option>
            {matches.map((m) => (
              <option key={m.id} value={m.id}>
                {m.date} 第 {m.indexInDay} 场 · {m.oppSide}
              </option>
            ))}
          </Select>
          <Select className="select" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
            <option value="">全部状态</option>
            <option value="active">在队</option><option value="inactive">暂离</option><option value="left">离队</option>
          </Select>
          {/* 弹性间隔：左边是「筛选」，右边是「操作」，中间留白分开 */}
          <span className="grow" />

          <button className="btn" onClick={() => void fillOrder()} disabled={!sorted.length}
                  title="按当前显示顺序把「序」写成 1…N（导入进来的人序都是空的）">
            一键填满序
          </button>
          {/* 导入 / 导出收进一个「数据」下拉（用户选定方案 B） */}
          <details className="sel menu">
            <summary className="sel__btn">数据</summary>
            <div className="sel__list">
              <button type="button" className="sel__opt" onClick={() => setWizard(true)}>从 xlsx 导入</button>
              <button type="button" className="sel__opt" onClick={() => fileRef.current?.click()}>导入 CSV / JSON</button>
              <button type="button" className="sel__opt" onClick={handleExport}
                      disabled={!players.length}>导出 CSV</button>
            </div>
          </details>
          <button className="btn ghost" onClick={() => void load()}>刷新</button>
          <input ref={fileRef} type="file" accept=".csv,.txt,.json" style={{ display: 'none' }}
                 onChange={(e) => void handleFile(e.target.files?.[0])} />
        </div>
        
      </div>

      {wizard && (
        <ImportWizard
          classes={classes}
          classMap={classMap}
          mode="player"
          onClose={() => setWizard(false)}
          onDone={(msg) => { setNotice(msg); void load(); }}
        />
      )}

      <div className="card">
        {/* toolbar--fields：这一行里有带小标签的字段（定位 ID），
            底边对齐才不会让标题和说明文字浮在半空 */}
        <div className="toolbar toolbar--fields" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>成员列表（{filtered.length} / {players.length}）</h3>
          <div className="spacer grow" />
          {/* 提示放在**左边**（用户口径：不希望它出现在右边把按钮挤动）。 */}
          {locateMsg && (
            <span className={`hint roster-locate-msg${locateMiss ? ' roster-locate-msg--miss' : ''}`}
                  style={{ margin: 0 }}>
              {locateMsg}
            </span>
          )}
          {/* 定位框：不是筛选（筛选用上面的搜索），而是**直接滚到那个人并高亮**。
              支持模糊：先按整串包含匹配，不行再按"字符按顺序出现"匹配。 */}
          <label className="field">
            <span>定位 ID</span>
            <input
              className="input" style={{ width: 170 }} placeholder="输入 ID 片段，回车找下一个"
              value={locateQ}
              onChange={(e) => { setLocateQ(e.target.value); locateNext(e.target.value, true); }}
              onKeyDown={(e) => { if (e.key === 'Enter') locateNext(locateQ, false); }}
            />
          </label>
          {/* 用户口径：定位 ID 与新增成员并在一起，浮层锚在这个按钮下方 */}
          <span className="pop-wrap">
            <button className="btn primary"
                    onClick={() => { if (showAdd) { closeAdd(); return; } setDraft((d) => ({ ...d, id: '', joinedOrder: '', remark: '' })); setShowAdd(true); }}>
              + 新增成员
            </button>
            {(showAdd || addClosing) && (
              <div className={'pop' + (showAdd ? ' pop--in' : ' pop--out')} onClick={(e) => e.stopPropagation()}>
                <div className="pop__head">
                  <h3 style={{ margin: 0 }}>新增成员</h3>
                  <span className="grow" />
                  <button className="btn ghost sm" onClick={closeAdd}>关闭</button>
                </div>
                {/* 字段顺序：入帮序 / ID / 麦克风 / 备注角色 / 橙武 / 备注 */}
                <div className="toolbar" style={{ marginBottom: 0 }}>
                  <input className="input" placeholder="入帮序" style={{ width: 90 }}
                         value={draft.joinedOrder} onChange={(e) => setDraft({ ...draft, joinedOrder: e.target.value })} />
                  <input className="input" placeholder="ID *" style={{ width: 200 }}
                         value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} />
                  <Select className="select" value={draft.mic}
                          onChange={(e) => setDraft({ ...draft, mic: e.target.value as Player['mic'] })}>
                    <option value="">麦克风</option>
                    <option value="有">有</option><option value="无">无</option><option value="无需作答">无需作答</option>
                  </Select>
                  <Select className="select" value={draft.noteRole}
                          onChange={(e) => setDraft({ ...draft, noteRole: e.target.value as Player['noteRole'] })}>
                    <option value="">备注角色</option>
                    {['指挥', '统战', 'K龙', '替补指挥', '长期请假'].map((r) => <option key={r} value={r}>{r}</option>)}
                  </Select>
                  <Select className="select" value={draft.orangeWeapon}
                          onChange={(e) => setDraft({ ...draft, orangeWeapon: e.target.value })}>
                    <option value="">橙武</option>
                    <option value="有">有</option>
                  </Select>
                  <input className="input" placeholder="备注（技能/装备标签）" style={{ width: 200 }}
                         value={draft.remark} onChange={(e) => setDraft({ ...draft, remark: e.target.value })} />
                  <span className="grow" />
                  <button className="btn primary" onClick={() => { void handleCreate(); setShowAdd(false); }}>添加</button>
                </div>
              </div>
            )}
          </span>

          
        </div>

        <div className="roster-cards" ref={listRef} onDragOver={autoScroll}>
          {loading && <div className="hint">加载中…</div>}
          {!loading && filtered.length === 0 && (
            <div className="hint">暂无成员。可以用上面的表单添加，或导入旧表的成员主档。</div>
          )}
          {/* 表头：用与卡片完全相同的列宽，所以标题与内容逐列对齐
              （改成卡片时曾把表头漏掉，每列是什么只能靠猜） */}
          {!loading && filtered.length > 0 && (
            <div className="roster-cards__head">
              <span />
              {([
                ['order', '序'], ['id', 'ID'], ['signup', '本场报名'], ['status', '状态'],
                ['mic', '麦克风'], ['role', '备注角色'], ['orange', '橙武'], ['remark', '备注'],
              ] as [SortKey, string][]).map(([k, label]) => (
                <span key={k} className={`th${sortKey === k ? ' th--active' : ''}`}
                      title="点击排序（再点一次反序）"
                      // 序这一列的内容是居中的（.roster-card__order-text），
                      // 表头也得居中才对得上（原来表头一律左对齐 → 用户反馈"序没对齐"）
                      style={k === 'order' ? { textAlign: 'center' } : undefined}
                      onClick={() => toggleSort(k)}>
                  {label}{sortKey === k ? (sortDir === 1 ? ' ↑' : ' ↓') : ''}
                </span>
              ))}
              <span style={{ textAlign: 'right' }}>操作</span>
            </div>
          )}
          {!loading && sorted.map((p, idx) => {
            const st = statusOf(p);
            const dropLine = dropAt && dropAt.id === p.id && dragId !== null && dragId !== p.id
              ? (dropAt.below ? ' roster-card--drop-below' : ' roster-card--drop-above')
              : '';
            return (
              <div
                key={p.id}
                data-player-id={p.id}
                className={`roster-card${dragId === p.id ? ' roster-card--dragging' : ''}${dropLine}${foundId === p.id ? ' roster-card--found' : ''}`}
                draggable
                onDragStart={(e) => {
                  setDragId(p.id);
                  e.dataTransfer.effectAllowed = 'move';
                  // 某些环境必须 setData 才会触发后续 dragOver
                  e.dataTransfer.setData('text/plain', String(p.id));
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  // 指针在卡片上半 → 插到它上面；下半 → 插到它下面
                  const r = e.currentTarget.getBoundingClientRect();
                  setDropAt({ id: p.id, below: e.clientY > r.top + r.height / 2 });
                }}
                onDragLeave={() => setDropAt((cur) => (cur && cur.id === p.id ? null : cur))}
                onDragEnd={() => { setDragId(null); setDropAt(null); }}
                onDrop={(e) => {
                  e.preventDefault();
                  const fromId = Number(e.dataTransfer.getData('text/plain')) || dragId;
                  const below = dropAt && dropAt.id === p.id ? dropAt.below : false;
                  setDragId(null);
                  setDropAt(null);
                  if (fromId && fromId !== p.id) void moveTo(fromId, p.id, below);
                }}
              >
                <span className="roster-card__handle" title="拖动换位">⠿</span>
                {/* 序：可直接改，改完列表按序重排 */}
                {/* 平时是纯文字（没有白框、也不像输入框）；点一下才变输入框。
                    输入 N 会把这个人插到第 N 位，前后的人自动顺移。 */}
                {orderEditId === p.id ? (
                  <input
                    className="input roster-card__order"
                    type="number" min={1} max={sorted.length} autoFocus
                    value={orderDraft}
                    onChange={(e) => setOrderDraftState(e.target.value)}
                    onBlur={() => void commitOrder(p)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void commitOrder(p);
                      if (e.key === 'Escape') { setOrderEditId(null); setOrderDraftState(''); }
                    }}
                  />
                ) : (
                  <button className="roster-card__order-text" title="点击修改序（其余人会自动顺移）"
                          onClick={() => { setOrderEditId(p.id); setOrderDraftState(String(p.joinedOrder ?? idx + 1)); }}>
                    {p.joinedOrder ?? idx + 1}
                  </button>
                )}
                <button className="roster-card__id" onClick={() => onOpenDetail(p.id)}
                        title="查看个人详情">{p.gameId}</button>

                <span className={`badge-state ${signupOf.get(p.id) === 'JOIN' ? 'active' : signupOf.get(p.id) === 'LEAVE' ? 'left' : 'inactive'}`}>
                  {matchId === null ? '—'
                    : signupOf.get(p.id) === 'JOIN' ? '参加'
                      : signupOf.get(p.id) === 'LEAVE' ? '请假'
                        : signupOf.get(p.id) === 'BENCH' ? '替补' : '未填表'}
                </span>
                <span className={`badge-state ${st.kind}`}>{st.label}</span>

                {/* 只留值 —— 列名在表头上，格子里再写一遍就是重复（用户指出的） */}
                <span className="roster-card__meta">
                  <span>{p.mic || '—'}</span>
                  <span>{p.noteRole || '—'}</span>
                  {/* 橙武只有有/无（默认无）：有 → 这一项直接显示橙色「橙武」；
                      没有 → 显示「-」。设置入口在「编辑」里，卡片上不放输入框。 */}
                  {p.orangeWeapon === '有'
                    ? <b className="roster-orange--yes" title="有橙武">橙武</b>
                    : <b style={{ color: 'var(--text-faint)', fontWeight: 400 }} title="无橙武">-</b>}
                  <span title={p.remark || undefined}>{p.remark || '—'}</span>
                </span>

                <span className="roster-card__actions">
                  <button className="btn sm" onClick={() => onOpenDetail(p.id)}>详情</button>
                  <button className="btn sm" onClick={() => startEdit(p)}>编辑</button>
                  <button className="btn sm danger" onClick={() => void handleRemove(p)}>删除</button>
                </span>

                {/* 编辑栏与表头逐列对应：控件落在自己那一列下面，列头就是标签 */}
                {editId === p.id && (
                  <div className="roster-card__edit">
                    <span />
                    <input className="input" value={editDraft.joinedOrder} placeholder="序"
                           onChange={(e) => setEditDraft({ ...editDraft, joinedOrder: e.target.value })} />
                    <input className="input" value={editDraft.id}
                           onChange={(e) => setEditDraft({ ...editDraft, id: e.target.value })} />
                    <span />
                    <Select className="select" value={editDraft.status}
                            onChange={(e) => setEditDraft({ ...editDraft, status: e.target.value })}>
                      <option value="active">在队</option>
                      <option value="inactive">暂离</option>
                      <option value="left">离队</option>
                    </Select>
                    <Select className="select" value={editDraft.mic}
                            onChange={(e) => setEditDraft({ ...editDraft, mic: e.target.value as Player['mic'] })}>
                      <option value="">—</option>
                      <option value="有">有</option><option value="无">无</option>
                      <option value="无需作答">无需作答</option>
                    </Select>
                    <Select className="select" value={editDraft.noteRole}
                            onChange={(e) => setEditDraft({ ...editDraft, noteRole: e.target.value as Player['noteRole'] })}>
                      <option value="">—</option>
                      {['指挥', '统战', 'K龙', '替补指挥', '长期请假'].map((r) => <option key={r} value={r}>{r}</option>)}
                    </Select>
                    <Select className="select" value={editDraft.orangeWeapon}
                            onChange={(e) => setEditDraft({ ...editDraft, orangeWeapon: e.target.value })}>
                      <option value="">无</option>
                      <option value="有">有</option>
                    </Select>
                    <input className="input" value={editDraft.remark}
                           onChange={(e) => setEditDraft({ ...editDraft, remark: e.target.value })} />
                    <div className="roster-card__edit-actions">
                      <button className="btn sm primary" onClick={() => void saveEdit()}>保存</button>
                      <button className="btn sm ghost" onClick={() => setEditId(null)}>取消</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

    </>
  );
}
