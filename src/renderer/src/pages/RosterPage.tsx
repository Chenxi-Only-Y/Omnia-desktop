import { localUrl } from '../lib/localFile';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useToastAutoClear } from '../lib/useToast';
import { PART_STATE_LABEL } from '@shared/domain';
import type { AttendanceRow, Match, PartState, Player, PlayerInput, SignupStatus } from '@shared/types';
import { api, errText } from '../api';
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
  /** 历史用名（`/` 或 `、` 分隔的文本，提交时拆成数组）—— 改名后旧数据靠它认人 */
  aliases: string;
  joinedOrder: string;
  mic: Player['mic'];
  noteRole: Player['noteRole'];
  /** 橙武（空 = 没有） */
  orangeWeapon: string;
  status: string;
  remark: string;
  intro: string;
  signature: string;
}

const EMPTY_DRAFT: Draft = {
  id: '', aliases: '', joinedOrder: '', mic: '', noteRole: '', orangeWeapon: '', status: 'active', remark: '',
  intro: '',
  signature: '',
};

/** 「旧名A/旧名B、旧名C」→ ['旧名A','旧名B','旧名C']（与导入解析同一套分隔符） */
function splitAliases(text: string): string[] {
  return text.split(/[\/、,，|;；]+/).map((x) => x.trim()).filter(Boolean);
}

/** 可排序的列（表头点击） */
type SortKey = 'order' | 'id' | 'signup' | 'status' | 'mic' | 'role' | 'orange' | 'remark';

/** 报名状态排序权重：参加 → 替补 → 请假 → 未填表 */
function signupRank(s: SignupStatus | null): number {
  if (s === 'JOIN') return 0;
  if (s === 'BENCH') return 1;
  if (s === 'LEAVE') return 2;
  return 3;
}

/* 主档状态（帮会口径）。注意与**排表状态**区分（用户口径：
   「在队只是排表里有，未在队就是不在排表里」）——
   所以主档状态一律用「帮」字：在帮 / 暂离 / 离帮；
   「在队」这个词只留给状态列里表示"这场排表里有他"。 */
const STATUS_LABEL: Record<string, string> = { active: '在帮', inactive: '暂离', left: '离帮' };

export default function RosterPage({ classes, classMap, onCount, onOpenDetail }: Props) {
  const [players, setPlayers] = useState<Player[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 成功提示 2.5 秒后自动消失（报错不自动清，要留够时间看清）
  useToastAutoClear(notice, setNotice);
  /** 新增成员弹层（用户口径：新增改成单独按钮打开） */
  const [showAdd, setShowAdd] = useState(false);
  /* 在帮 / 离帮两张表（用户口径 2026-09：「成员主档在在帮的基础上，有现在离帮的（能查到历史记录）」
     + 「额外新加表：离帮人员的表」+「哪里都不藏，只加筛选」）——
     所以离帮的人一条都不删、在别处照样出现，这里只是给他们一张单独的表。 */
  const [view, setView] = useState<'active' | 'left'>('active');

  /* 侧边抽屉（用户口径：点卡片打开右侧抽屉，编辑 / 详情 / 删除都放进去）。
     存的是成员 id，数据每次都从 players 里现取，所以保存后抽屉内容自动是最新的。 */
  const [drawerId, setDrawerId] = useState<number | null>(null);

  /* 反馈动效（用户口径：「添加反馈动效」）：
       · okBtn  —— 抽屉里刚成功的那个按钮（保存 / 添加），1.2 秒内绿一下并打勾；
       · flashId —— 刚被保存的那张卡片，在列表里闪一圈光圈，把"改的是他"指出来。
     纯视觉状态，超时自动清掉，不影响任何数据。 */
  const [okBtn, setOkBtn] = useState<'save' | 'add' | null>(null);
  const [flashId, setFlashId] = useState<number | null>(null);
  const okTimer = useRef(0);
  const flashTimer = useRef(0);
  function feedback(kind: 'save' | 'add', pid?: number) {
    setOkBtn(kind);
    window.clearTimeout(okTimer.current);
    okTimer.current = window.setTimeout(() => setOkBtn(null), 1200);
    if (pid !== undefined) {
      setFlashId(pid);
      window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setFlashId(null), 1400);
    }
  }

  /** 危险操作（删除）的反馈：按钮先抖一下，再弹确认框 —— 让人知道"我点到了" */
  function warnThen(e: React.MouseEvent<HTMLButtonElement>, fn: () => void) {
    const el = e.currentTarget;
    el.classList.remove('is-warn');
    void el.offsetWidth;              // 强制回流，连续点也能重播动画
    el.classList.add('is-warn');
    window.setTimeout(() => el.classList.remove('is-warn'), 320);
    fn();
  }
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

  /* 实测（CDP 逐帧采样）证据：
       静止不动时列表容器（当年叫 .roster-cards，现在是卡片网格 .mcard-grid）的
       scrollTop 稳定在 400，自己不会清零；点一次「详情」后它变成 0 ——
       说明是「详情」这个动作把它清了。
     详情走的是父级传进来的 onOpenDetail（切到详情视图）→ 成员主档被卸载再重建，
     容器是新建的节点，scrollTop 自然是 0。
     修法：把列表滚动位置记在 window 上（跨卸载保留），挂载时恢复、滚动时记录。
     这样不碰 load()，所以不会影响拖拽（之前全局替换 load 就是栽在这里）。
     放在 window 上是为了避免在本文件顶部找不到合适的插入锚点。 */
  useEffect(() => {
    const w = window as unknown as { __rosterScroll?: number };
    const sc = listRef.current;
    if (!sc) return;
    sc.scrollTop = w.__rosterScroll ?? 0;
    const onScroll = () => { w.__rosterScroll = sc.scrollTop; };
    sc.addEventListener('scroll', onScroll, { passive: true });
    return () => sc.removeEventListener('scroll', onScroll);
  }, []);

  /* 用户反馈：只在上面的挂载 effect 里恢复**不够**（详情返回仍然跳回顶部）。
     原因是数据是异步到的 —— 挂载时列表还没渲染（或随后又被重建），
     我恢复的那个节点已经不是最终那个了。
     所以再加一次：**等 players 到位后再恢复一次**，且只做一次
     （用 ref 记住做过没有，避免之后每次改动 players 都把用户拽回去）。 */
  /* 实测（全元素 hook）证据：保存之后 roster-cards.scrollTop 变成 0，
     但**没有任何写入记录** —— 说明 .roster-cards 这个元素被整个替换了
     （新元素天生是 0），而不是被谁设成 0。
     上一版我加了个"只恢复一次"的守卫（restoredRef），
     结果第一次之后就不再恢复 —— 保存后自然还是跳。
     现在改成：**每次 players 变化都恢复**。
     重载只发生在保存/删除/导入这类明确动作上，用户正常滚动不会改 players，
     所以不会打扰正常浏览。 */
  useEffect(() => {
    const w = window as unknown as { __rosterScroll?: number };
    const sc = listRef.current;
    if (!sc || !players.length) return;
    const want = w.__rosterScroll ?? 0;
    if (want > 0 && sc.scrollTop !== want) sc.scrollTop = want;
  }, [players]);
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY_DRAFT);
  const [wizard, setWizard] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  /** 拖拽换位：正在拖的是谁（只在这两个时刻变：开始拖、结束拖） */
  const [dragId, setDragId] = useState<number | null>(null);
  /* ── 拖动性能（用户反馈：「拖动反应卡卡的」）──────────────────────────
     原来的写法是**每张卡**挂 onDragOver，里面 `getBoundingClientRect()` 量自己：
     dragover 每秒 60+ 次、每次都要强制同步布局（80 张卡 + 网格），
     实测 480 个事件里全是强制布局 —— 这才是"卡卡的"的原因（React 那边只改了 4 次 DOM，不是瓶颈）。
     现在改成：
       · 拖动开始时**量一次**所有卡片的矩形，存进 ref；
       · dragover 只在网格上监听一次，用 rAF 合并到每帧一次；
       · 命中判定纯算术（含自动滚动的偏移补偿），不再读布局；
       · 落点细线/提示文字**直接改 DOM**，拖动全程不触发 React 重渲染。 */
  const dragRects = useRef<{ id: number; idx: number; left: number; right: number; top: number; bottom: number }[]>([]);
  const dragGridRect = useRef<{ top: number; bottom: number; scrollTop: number } | null>(null);
  const dragPos = useRef<{ x: number; y: number } | null>(null);
  const dragFrame = useRef(0);
  const dragLabel = useRef('');
  /** 拖动开始时被拖的人在第几位（提示条要按 moveTo 的插入语义算出"最终第几位"） */
  const dragFromIdx = useRef(-1);
  const dropHit = useRef<{ id: number; below: boolean; idx: number } | null>(null);
  /** 当前画着落点细线的那张卡（直接改 DOM，避免拖动中走 React 重渲染） */
  const dropDecor = useRef<HTMLElement | null>(null);
  /** 拖动提示条（`:empty` 时不显示，所以拖动结束只要清空文本） */
  const dragHintRef = useRef<HTMLSpanElement>(null);
  /* 卡片式改版后，行内的「序」输入框没有了：改序走抽屉里的「序」字段
     （保存时同样走 moveToOrdinal 的插入语义），所以 orderEditId / orderDraft
     这两个状态已删除。 */
  /** 「定位 ID」：输入片段就滚到那个人并高亮；找不到给提示 */
  const [locateQ, setLocateQ] = useState('');
  const [locateMsg, setLocateMsg] = useState('');
  const [locateMiss, setLocateMiss] = useState(false);
  const [foundId, setFoundId] = useState<number | null>(null);
  const foundTimer = useRef<number | null>(null);
  /**
   * 排序：默认按「序」。卡片式没有表头可点，改成工具栏里的下拉（功能不变）；
   * 只改**查看顺序**，不动库里的序；换列排序后拖动换位仍按当前显示顺序写回序。
   */
  const [sortKey, setSortKey] = useState<SortKey>('order');
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  /** 列表容器：拖动到边缘时自动滚动（.mcard-grid 自己滚，保持滚动位置不回弹） */
  const listRef = useRef<HTMLDivElement>(null);

  /**
   * 拉取成员列表。
   *
   * `silent`：**不进入 loading 态**，用于"写完之后刷一下"。
   * 为什么必须静默：卡片列表是 `{!loading && sorted.map(...)}` 门控的，
   * 一旦 loading=true，八十张卡片会整体卸载 —— 列表当场塌成一行「加载中…」
   * （用户反馈：「拖动过后会卡顿且会收缩一下」就是这么来的），
   * 数据回来后还要把八十张卡（带 backdrop-filter / 呼吸灯）重新挂一遍，非常卡。
   * 静默刷新时 key 不变，React 只会就地更新，卡片不会卸载。
   */
  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const rows = await api.player.list();
      setPlayers(rows);
      onCount(rows.length);
      setError(null);
    } catch (err) {
      setError(errText(err));
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, [onCount]);

  // 首次挂载要显示「加载中…」；之后所有刷新都是静默的（见 load 的注释）
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
   * 卡片右上角**三角标**的状态（用户口径 2026-09：只保留三种，其余全删）
   *   · 在队   = 本场排表里有他（浅绿）
   *   · 未排表 = 本场排表里没有（浅黄）
   *   · 离帮   = 主档状态是离帮（灰）
   * 原来还有 替补 / 请假 / 暂离 三种显示，已按要求删除（数据仍然保留，
   * 只在抽屉的「状态」下拉里能改，卡片上不再区分）。
   */
  function cardStatus(p: Player): { key: 'play' | 'unfilled' | 'left'; label: string } {
    if (p.status === 'left') return { key: 'left', label: '离帮' };
    if (matchId !== null && lineupOf.get(p.id) === 'PLAY') return { key: 'play', label: '在队' };
    return { key: 'unfilled', label: '未排表' };
  }

  /* 先把人按视图分流（用户反馈：离帮的人出现在「在帮成员」列表里，
     而且页签写 78、列表却列出 79 行）。
     「在帮成员」= 在帮 + 暂离；「离帮人员」= 离帮，两张表互斥、加起来正好是全体。
     用户口径 2026-09：「不要这个」—— 原来的「全部状态」下拉已删除：
     在帮/暂离的区分本来就在卡片的在队/未排表角标里看得到，多一个筛选只是多一层遮挡。 */
  const scoped = useMemo(
    () => players.filter((p) => (view === 'left' ? p.status === 'left' : p.status !== 'left')),
    [players, view],
  );

  /** 列表顺序：默认按「序」（没填序的排最后，同序按 id）；点表头可临时换列 */
  const sorted = useMemo(() => {
    const val = (p: Player): string | number => {
      switch (sortKey) {
        case 'order': return p.joinedOrder ?? Number.MAX_SAFE_INTEGER;
        case 'id': return p.gameId.toLowerCase();
        case 'signup': return signupRank(signupOf.get(p.id) ?? null);
        case 'status': return cardStatus(p).label;
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
    return [...scoped].sort(cmp);
  }, [scoped, sortKey, sortDir, signupOf]);

  /* 卡片式改版后没有表头可点了：排序改由工具栏的下拉直接 setSortKey/setSortDir，
     原来的 toggleSort（点表头切升降）已删除。 */

  /**
   * 当前视图顺序 + 其余成员（另一张表里的人）接在后面。
   *
   * 所有会**整批重写「序」**的操作（一键填满序、拖动换位、改序）都必须用这份完整名单：
   * 只重排当前可见的人，另一张表里的人会留着旧序号，两边就会撞号。
   */
  const orderedIds = useCallback((): number[] => {
    const inView = new Set(sorted.map((x) => x.id));
    return [...sorted.map((x) => x.id), ...players.filter((p) => !inView.has(p.id)).map((p) => p.id)];
  }, [sorted, players]);

  /**
   * 一键填满序：按**当前显示顺序**把序写成 1、2、3…
   * 导入进来的人序都是空的，先铺一遍再拖会顺手很多。
   */
  async function fillOrder() {
    if (!sorted.length) return;
    const ids = orderedIds();
    if (!await confirmDialog(`按当前显示顺序把 ${ids.length} 人的「序」重写为 1…${ids.length}？`)) return;
    try {
      await api.player.reorder(ids);
      setSortKey('order');
      setSortDir(1);
      setError(null);
      setNotice(`已把 ${ids.length} 人的序填为 1…${ids.length}`);
      await load({ silent: true });
    } catch (err) {
      setError(errText(err));
    }
  }

  /** 拖动到列表上/下边缘时自动滚动，才能把第 60 人拖到第 2 位。
      用拖动开始时量好的网格矩形判断，不在事件里读布局。 */
  function scrollEdge(clientY: number) {
    const el = listRef.current;
    const r = dragGridRect.current;
    if (!el || !r) return;
    const margin = 48;
    if (clientY < r.top + margin) el.scrollTop -= 16;
    else if (clientY > r.bottom - margin) el.scrollTop += 16;
  }

  /** 命中判定：用缓存的矩形 + 当前滚动偏移算，**不读布局** */
  function hitTest(x: number, y: number) {
    const el = listRef.current;
    const g = dragGridRect.current;
    if (!el || !g) return null;
    const shift = el.scrollTop - g.scrollTop;      // 拖动期间自动滚动造成的整体位移
    for (const r of dragRects.current) {
      const top = r.top - shift;
      const bottom = r.bottom - shift;
      if (y < top || y > bottom || x < r.left || x > r.right) continue;
      return { id: r.id, idx: r.idx, below: x > r.left + (r.right - r.left) / 2 };
    }
    return null;
  }

  /** 把落点画到 DOM 上（细线 + 目标卡淡色底），并更新提示条文字。全程不触发 React 重渲染。 */
  function decorateDrop(hit: { id: number; below: boolean; idx: number } | null) {
    const prev = dropDecor.current;
    if (prev) {
      prev.classList.remove('mcard--drop-before', 'mcard--drop-after', 'mcard--drop-target');
      dropDecor.current = null;
    }
    const hint = dragHintRef.current;
    if (!hit) {
      dropHit.current = null;
      if (hint) hint.textContent = dragLabel.current ? `${dragLabel.current}　拖到目标位置松手即可换位` : '';
      return;
    }
    /* 拖到自己身上：不画线（画了很怪），提示"原位" —— moveTo 里 from===target 也会直接返回 */
    if (hit.id === dragId) {
      dropHit.current = null;
      if (hint) hint.textContent = `${dragLabel.current}　放开＝原位不动`;
      return;
    }
    dropHit.current = hit;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-player-id="${hit.id}"]`) ?? null;
    if (el) {
      el.classList.add(hit.below ? 'mcard--drop-after' : 'mcard--drop-before', 'mcard--drop-target');
      dropDecor.current = el;
    }
    if (hint) {
      /* 位置按 moveTo 的真实插入语义算：先取"插在目标前/后"的下标，
         再因为自己已经被抽走（from < to）而前移一位 —— 否则往前拖会差一位。 */
      let to = hit.idx + (hit.below ? 1 : 0);
      const from = dragFromIdx.current;
      if (from >= 0 && from < to) to -= 1;
      hint.textContent = `${dragLabel.current}　→　放开后在第 ${to + 1} 位`;
    }
  }

  /** 拖动开始：量一次几何、写提示、标记网格（只在这一次触发 React 重渲染） */
  function beginDrag(e: React.DragEvent, p: Player, idx: number) {
    setDragId(p.id);
    e.dataTransfer.effectAllowed = 'move';
    // 某些环境必须 setData 才会触发后续 dragOver
    e.dataTransfer.setData('text/plain', String(p.id));
    dragFromIdx.current = idx;
    dragLabel.current = `拖动「${p.gameId}」（当前第 ${idx + 1} 位）`;
    const grid = listRef.current;
    if (grid) {
      const gr = grid.getBoundingClientRect();
      dragGridRect.current = { top: gr.top, bottom: gr.bottom, scrollTop: grid.scrollTop };
      dragRects.current = [...grid.querySelectorAll<HTMLElement>('[data-player-id]')].map((el, i) => {
        const r = el.getBoundingClientRect();
        return {
          id: Number(el.dataset.playerId), idx: i,
          left: r.left, right: r.right, top: r.top, bottom: r.bottom,
        };
      });
    }
    const hint = dragHintRef.current;
    if (hint) hint.textContent = `${dragLabel.current}　拖到目标位置松手即可换位`;
  }

  /** 拖动结束（放在网格上或取消）：清掉细线、提示、拖动态 */
  function endDrag() {
    if (dragFrame.current) { cancelAnimationFrame(dragFrame.current); dragFrame.current = 0; }
    decorateDrop(null);
    dragPos.current = null;
    dragRects.current = [];
    dragGridRect.current = null;
    dragLabel.current = '';
    dragFromIdx.current = -1;
    const hint = dragHintRef.current;
    if (hint) hint.textContent = '';
    setDragId(null);
  }

  /** 网格上的 dragover：滚动 + 命中判定合并到每帧一次（原来是每个卡片每次都算） */
  function onGridDragOver(e: React.DragEvent) {
    if (dragId === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    scrollEdge(e.clientY);
    dragPos.current = { x: e.clientX, y: e.clientY };
    if (dragFrame.current) return;
    dragFrame.current = requestAnimationFrame(() => {
      dragFrame.current = 0;
      const pos = dragPos.current;
      if (!pos) return;
      const hit = hitTest(pos.x, pos.y);
      const cur = dropHit.current;
      // 命中没变就别碰 DOM（避免每帧都做无效的类名增删）
      if (cur && hit && cur.id === hit.id && cur.below === hit.below) return;
      if (!cur && !hit) return;
      decorateDrop(hit);
    });
  }

  /** 网格上的落点：用 dragover 记下的命中结果，不需要再读一次布局 */
  function onGridDrop(e: React.DragEvent) {
    e.preventDefault();
    const fromId = Number(e.dataTransfer.getData('text/plain')) || dragId;
    const hit = dropHit.current;
    endDrag();
    if (fromId && hit && hit.id !== fromId) void moveTo(fromId, hit.id, hit.below);
  }

  /**
   * 把某人挪到第 ordinal 位（插入语义）。
   *
   * 用户口径：改序号不该和已有的重复，前面后面的要往上/往下顺移。
   * 做法是按**当前显示顺序**把人抽出来插到目标位置，再整批写回 1..N ——
   * 这样编号永远连续、不可能重复（原来直接写一个数字，就会出现两个 40）。
   */
  async function moveToOrdinal(playerId: number, ordinal: number) {
    const ids = orderedIds();
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
      await load({ silent: true });
    } catch (err) {
      setError(errText(err));
    }
  }

  /* 行内「序」输入框已随卡片式改版移除：改序在抽屉的「序」字段里做，
     保存时由 saveEdit → moveToOrdinal 走同一套插入语义（编号恒为连续 1..N）。 */

  /**
   * 拖拽换位：把 fromId 挪到 toId 的位置，然后整批写回「序」。
   * 只用当前**列表顺序**（sorted）算新顺序，所以拖完立即与界面一致。
   */
  /**
   * 定位到某个成员：滚到它、高亮一下。
   * 匹配顺序：**整串包含** → **字符按顺序出现**（模糊，例如「珺菌」能命中「珺珺不是菌子」）。
   * reset=true（边打字边找）跳到第一个命中；reset=false（回车）跳到下一个命中。
   */
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

  /**
   * 本地先把顺序和「序」写对（乐观更新）：IPC 还没回来，界面已经在新位置了。
   * 这样拖完不需要重拉列表 —— 不重拉就不会卸载卡片、不会塌、也不会跳滚动条。
   */
  function applyOrderLocally(ids: number[]) {
    const rank = new Map(ids.map((id, i) => [id, i + 1]));
    setPlayers((cur) => {
      const next = cur.map((p) => (rank.has(p.id) ? { ...p, joinedOrder: rank.get(p.id) ?? null } : p));
      next.sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
      return next;
    });
  }

  async function moveTo(fromId: number, toId: number, below = false) {
    /* ⚠️ 必须用**完整名单**（orderedIds）：本文件 315-320 行写明"所有会整批重写序的
       操作都必须用完整名单" —— 原来只用当前视图（sorted），离帮/在帮另一张表的人会
       保留旧序号 → 库里出现重复「序」且静默写坏（审计 2026-09-30）。 */
    const ids = orderedIds();
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
    /* 乐观更新：先就地改本地顺序与「序」，再落库。
       落库失败才回滚（静默重拉一次，把真实顺序拿回来）。
       用户口径：「保持卡片可以随意移动的情况，修改保存删除详情后且不会回弹」——
       所以成功路径**不重拉**，也就不会有塌陷/回弹。 */
    applyOrderLocally(ids);
    setSortKey('order');
    setSortDir(1);
    try {
      await api.player.reorder(ids);
      setError(null);
      setNotice(`已按新顺序保存（${ids.length} 人）`);
    } catch (err) {
      setError(errText(err));
      await load({ silent: true });
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
        aliases: splitAliases(draft.aliases),
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
      feedback('add');          // 按钮绿一下 + 打勾，告诉用户真的加上了
      await load({ silent: true });
    } catch (err) {
      setNotice(null);
      setError(errText(err));
    }
  }

  /** 选背景（mp4 / 图片）：主进程负责拷进应用目录，成功后就地刷新抽屉 */
  async function pickBg(pid: number) {
    try {
      const src = await api.player.pickBg();
      if (!src) return;
      await api.player.setBg(pid, src);
      /* 抽屉里的画面是从 players 派生出来的（useMemo），刷新列表即可 */
      setPlayers(await api.player.list());
      setError(null);
    } catch (err) { setError(errText(err)); }
  }

  /** 移除背景（回到默认背景 = 全局壁纸） */
  async function clearBg(pid: number) {
    try {
      await api.player.clearBg(pid);
      setPlayers(await api.player.list());
      setError(null);
    } catch (err) { setError(errText(err)); }
  }

  /** 点击卡片 → 共享元素动画：卡片上的「媒体 + ID」放大飞入详情页，其它卡片向右移出 */
  function cardFlyTo(p: Player, e: React.MouseEvent<HTMLElement>) {
    const card = e.currentTarget;
    const media = card.querySelector<HTMLElement>('.mcard__media img, .mcard__media video');
    const idEl = card.querySelector<HTMLElement>('.mcard__id');
    const W = window.innerWidth;
    const H = window.innerHeight;
    const layer = document.createElement('div');
    layer.className = 'fly-layer';
    document.body.appendChild(layer);
    /* 跳转过程中**左侧逐步变黑**（用户口径 2026-09-27）：
       用和详情页左侧渐变**同一套值**，所以接上去看不出切换，也不会露出空白。 */
    const shade = document.createElement("div");
    shade.className = "fly-leftshade";
    layer.appendChild(shade);
    /* ⚠️ 必须**同步**点亮：原来放在 requestAnimationFrame 里 ✗ —— 窗口不在前台时 rAF
       会被节流/推迟，那两层就停在上面的 `opacity:0`，用户看到的就是"黑渐变没了 + 一条
       分割线"（运行时实测 60ms 时 opacity 仍为 0 ✓）。这里同步置 1，并关掉 .18s 淡入，
       与详情页背景层"立刻出现"的表现一致 ✓ */
    shade.style.transition = "none";
    shade.style.opacity = "1";
    /* 与详情页 .md-bg__dark 对应的一层：**底部压暗 + 横向遮罩（只压左侧）** ——
       用户口径 2026-09-27：动画的左侧必须和主页背景层构成一致 ✓ */
    const shadeDark = document.createElement("div");
    shadeDark.className = "fly-leftdark";
    layer.appendChild(shadeDark);
    shadeDark.style.transition = "none";
    shadeDark.style.opacity = "1";

    /* 媒体 → 详情页全屏背景（.md-bg：top 52，素材中心在横向 70%） */
    if (media) {
      const r = media.getBoundingClientRect();
      const c = media.cloneNode(true) as HTMLElement;
      c.classList.add('fly-clone');
      c.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;`;
      /* 飞行中的媒体也戴上**详情页那层渐变色调**（直接复用 .md-bg__tone 规则），
         这样飞行画面与落定后的画面是同一套色调，中间不会"变一下颜色"。 */
      const tone = document.createElement('span');
      tone.className = 'md-bg__tone';
      c.appendChild(tone);
      layer.appendChild(c);
      /* 落点要和详情页一致：详情页素材是 140%（等比放大），所以克隆也放到 140% */
      /* 落点 = 详情页素材的**真实盒子**：高 = 视口高 − 52，宽 = 高 × 素材自身比例，中心在横向 70%。
         卡片媒体框的比例（约 2.25）和详情页盒子（约 1.71）不同，所以 x/y 要**分别缩放**，
         只用一个 scale 的话落点比例必然对不上（用户实测"放大比例不一致"）。
         盒子内部是 object-fit: cover，所以分别缩放不会让画面变形。 */
      const boxH = H - 52;
      /* **落点 = 主页素材的真实盒子**（用户口径 2026-09-27）：
         卡片媒体现在就是"整帧 contain"，元素比例 == 素材比例 ✓，
         所以"宽按比例 / 高按比例"这两个缩放系数本来就相等 → 只用一个等比 k 即可，
         而且**严丝合缝**（之前用 max() 是"盖住"目标盒，会落大 1~2px ✗）。 */
      const k = boxH / r.height;
      const dx = W * 0.7 - (r.left + r.width / 2);
      const dy = 52 + boxH / 2 - (r.top + r.height / 2);
      c.style.transition = "transform .42s cubic-bezier(.2, .8, .2, 1), opacity .22s ease";
      void c.offsetWidth;   /* 同上：强制重排，保证起点尺寸真的生效 */
      requestAnimationFrame(() => { c.style.transform = `translate(${dx}px, ${dy}px) scale(${k})`; });
    }

    /* ID → 详情页左下角的大字号。
       做法：克隆体**直接套详情页自己的 .md-hero__id 类**（字号/行高/字重/字距全一致），
       用"左下角"锚定，起始再 scale 到卡片 ID 的字号大小 —— 这样落定时的**字形位置与详情页完全对齐**。
       （上一版拿卡片 ID 自己的排版去放大：行高不同 → 底边虽对齐，字看着偏 ✗） */
    if (idEl) {
      const r = idEl.getBoundingClientRect();
      const c = idEl.cloneNode(true) as HTMLElement;
      c.className = 'md-hero__id fly-clone fly-clone--id';
      c.style.cssText = `left:${r.left}px;bottom:${H - r.bottom}px;width:auto;height:auto;`;
      layer.appendChild(c);
      const cardFs = parseFloat(getComputedStyle(idEl).fontSize) || 20;
      const k = cardFs / 76;                                   /* 详情页字号 76 → 卡片字号 */
      /* 详情页真身 ID 实测在 left = 75px（4vw = 57px 之外还有约 18px 内边距），所以补上这 18px */
      const dx = (W * 0.04 + 18) - r.left;
      const dy = (H - H * 0.07) - r.bottom;                    /* 详情页下内边距 7vh */
      c.style.scale = `${k}`;   /* 起点 = 卡片上那个 ID 的真实比例（数学上精确的起点） */
      void c.offsetWidth;   /* **强制重排**：不这样做，起点会被浏览器跟终点合并掉 ✗ */
      /* 用户口径 2026-09-27：**直线路径 + 同时长 + 同曲线** ——
         位置和尺寸都是一条 .45s 的 ease-in-out，均匀推进（不是"先跑完一样再跑另一样" ✗）。
         之前用 cubic-bezier(.2,.8,.2,1) 那种"前快后慢"，会让缩放先做完 ✗，
         看起来就像"只往下滑、没变大" —— 换成均匀曲线，两者全程一起变 ✓ */
      c.style.transition = 'translate .45s ease-in-out, scale .45s ease-in-out, opacity .2s ease';
      requestAnimationFrame(() => {
        c.style.translate = `${dx}px ${dy}px`;
        c.style.scale = '1';
      });
    }

    /* 其它卡片向右移出；稍后再切页，让退场看得见 */
    document.body.classList.add('roster-leaving');
    window.setTimeout(() => onOpenDetail(p.id), 80);   /* 早点切页：重活别落在动画中段 */
    window.setTimeout(() => {
      layer.remove();
      document.body.classList.remove('roster-leaving');
    }, 620);
  }

  function startEdit(p: Player) {
    setEditId(p.id);
    setEditDraft({
      id: p.gameId,
      aliases: (p.aliases ?? []).join('/'),
      joinedOrder: p.joinedOrder === null ? '' : String(p.joinedOrder),
      mic: p.mic, noteRole: p.noteRole,
      orangeWeapon: p.orangeWeapon ?? '', status: p.status, remark: p.remark,
      intro: p.intro ?? '', signature: p.signature ?? '',
    });
  }

  async function saveEdit(pid: number | null = editId) {
    if (pid === null) return;
    try {
      const id = editDraft.id.trim();
      await api.player.update(pid, {
        gameId: id,
        name: id,
        // 历史用名：整份覆盖（清空就等于删掉全部旧名）；改名时后端会把旧 ID 自动并进来
        aliases: splitAliases(editDraft.aliases),
        // 序**不在这里直接写**：直接写数字会和别人撞号（截图里的两个 40 就是这么来的），
        // 统一改走 moveToOrdinal 的插入语义，在下面处理。
        mic: editDraft.mic,
        noteRole: editDraft.noteRole,
        orangeWeapon: editDraft.orangeWeapon,
        status: editDraft.status,
        remark: editDraft.remark,
        intro: editDraft.intro,
        signature: editDraft.signature,
      });
      // 序变了 → 插到目标位置，其余人自动顺移（编号恒为连续 1..N）
      const rawOrder = editDraft.joinedOrder.trim();
      const target = rawOrder === '' ? sorted.length : Number(rawOrder);
      const cur = players.find((x) => x.id === pid)?.joinedOrder ?? null;
      const changed = Number.isFinite(target) && target >= 1 && target !== cur;
      if (changed) await moveToOrdinal(pid, target);
      else {
        const ps = await api.player.list();
        setPlayers(ps);
        setError(null);
      }
      setEditId(null);
      /* 成功反馈：按钮绿一下 + 卡片闪一下 + 一条 toast —— 原来保存后界面纹丝不动，
         用户不知道到底存上没有（用户口径：「添加反馈动效」）。 */
      feedback('save', pid);
      setNotice(`已保存「${id || drawerPlayer?.gameId || ''}」`);
    } catch (err) {
      setError(errText(err));
    }
  }

  /** 离帮人员：主档状态 = left（离帮）的成员。历史战报/参与记录一条没删，
      点「详情 · 历史」就是原来那个成员详情页（逐场明细里有全部记录）。 */
  const leftPlayers = useMemo(
    () => players.filter((p) => p.status === 'left'),
    [players],
  );

  /* 抽屉 / 卡片要用的派生数据。
     attendance 原来是"只在离帮视图里拉"，现在抽屉里也要显示历史战局，
     所以改成常驻拉一次（数据看板同一个接口，代价可接受）。 */
  const [attendance, setAttendance] = useState<Map<number, AttendanceRow>>(new Map());
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const d = await api.dashboard.data();
        if (alive) setAttendance(new Map(d.attendance.map((a) => [a.playerId, a])));
      } catch { /* 拿不到出勤就少显示几项，不影响其它功能 */ }
    })();
    return () => { alive = false; };
  }, [players]);

  /** 抽屉里正在看的成员（保存后 players 更新，这里自动跟着变） */
  const drawerPlayer = useMemo(
    () => (drawerId === null ? null : players.find((p) => p.id === drawerId) ?? null),
    [players, drawerId],
  );

  /** 打开抽屉（同时把编辑草稿铺好：抽屉里所有字段都是可改的） */
  function openDrawer(p: Player) {
    startEdit(p);
    setDrawerId(p.id);
  }

  function closeDrawer() {
    setDrawerId(null);
    setEditId(null);
  }

  /** 卡片顶部 3px 色带：未填表 = 橙黄呼吸灯（提醒去催）/ 已填表 = 静谧绿 */
  function bandOf(playerId: number): 'none' | 'filled' | 'unfilled' {
    if (matchId === null) return 'none';       // 没选场次判不了
    return (signupOf.get(playerId) ?? null) === null ? 'unfilled' : 'filled';
  }

  /** 离帮 → 恢复到在帮（只改主档状态；历史数据本来就没动过） */
  async function restorePlayer(p: Player) {
    try {
      await api.player.update(p.id, { status: 'active' });
      setError(null);
      setNotice(`「${p.gameId}」已恢复到在帮`);
      await load({ silent: true });
    } catch (err) {
      setError(errText(err));
    }
  }

  /**
   * 离帮人员的「删除」。
   *
   * ⚠️ 后果必须说清楚：`participation.player_id` 是 **ON DELETE CASCADE**，
   * 删掉成员会连他所有参战记录与战报一起删掉，不可恢复 ——
   * 而"不想让他再上场"其实用「离帮」状态就够了（历史全保留）。
   * 所以这里把要连带删掉的场次数直接写进确认框。
   */
  async function handleRemoveLeft(p: Player) {
    const n = attendance.get(p.id)?.matches ?? 0;
    const cost = n > 0
      ? `他的 ${n} 场参战记录与战报会一并删除，且不可恢复。`
      : '他没有参战记录，删除不会影响战局数据。';
    const ok = await confirmDialog(
      `确认删除成员「${p.gameId}」？${cost}`
      + '如果只是不想让他再上场，请改用「离帮」状态 —— 那样历史会完整保留。',
    );
    if (!ok) return;
    try {
      await api.player.remove(p.id);
      setError(null);
      setNotice(`已删除 ${p.gameId}`);
      await load({ silent: true });
    } catch (err) {
      setError(errText(err));
    }
  }

  async function handleRemove(p: Player) {
    if (!await confirmDialog(
      `确认删除成员「${p.gameId}」？他的参战记录与战报会一并删除，且不可恢复。`
      + '（只是不想让他上场的话，用「编辑」把状态改成离帮即可。）',
    )) return;
    try {
      await api.player.remove(p.id);
      setError(null);
      setNotice(`已删除 ${p.gameId}`);
      await load({ silent: true });
    } catch (err) {
      setError(errText(err));
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
      await load({ silent: true });
    } catch (err) {
      setNotice(null);
      setError(`导入失败：${errText(err)}`);
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
      setError(errText(err));
    }
  }

  return (
    <>
      {error && <div className="msg msg--toast error">{error}</div>}
      {notice && <div className="msg msg--toast ok">{notice}</div>}

      {/* 在帮 / 离帮两张表：离帮的人不删不藏，只是换一张表看（点详情就是原有历史页） */}
      <div className="tabs" style={{ marginBottom: 8 }}>
        <button className={`tab${view === 'active' ? ' active' : ''}`}
                onClick={() => setView('active')}>
          在帮成员（{(stats.byStatus.active ?? 0) + (stats.byStatus.inactive ?? 0)}）
        </button>
        <button className={`tab${view === 'left' ? ' active' : ''}`}
                onClick={() => setView('left')}>
          离帮人员（{leftPlayers.length}）
        </button>
      </div>

      <div className="card">

        <div className="toolbar" style={{ marginBottom: 0 }}>

          {/* 场次下拉**两张表都要有**（用户口径：离帮那边这里是空白，因为「几月几号第几场」没了）——
              两张表现在共用同一份列表，离帮也有「本场报名」这一列，判定同样要选场次。 */}
          <Select className="select" value={matchId ?? ''}
                  onChange={(e) => setMatchId(e.target.value === '' ? null : Number(e.target.value))}
                  title="选择场次：用于判定成员是否已填报名表（卡片顶部色带也按它判定）">
            <option value="">（不比对场次）</option>
            {matches.map((m) => (
              <option key={m.id} value={m.id}>
                {m.date} 第 {m.indexInDay} 场 · {m.oppSide}
              </option>
            ))}
          </Select>
          {/* 排序：卡片式没有表头可点，改成下拉（原来的点表头排序功能保留在这里） */}
          <Select className="select" value={`${sortKey}:${sortDir}`}
                  title="排序：先选列，再选升/降"
                  onChange={(e) => {
                    const [k, d] = e.target.value.split(':');
                    setSortKey(k as SortKey); setSortDir(d === '1' ? 1 : -1);
                  }}>
            <option value="order:1">序 ↑</option>
            <option value="order:-1">序 ↓</option>
            <option value="id:1">ID ↑</option>
            <option value="id:-1">ID ↓</option>
            <option value="signup:1">本场报名 ↑</option>
            <option value="signup:-1">本场报名 ↓</option>
            <option value="status:1">状态 ↑</option>
            <option value="status:-1">状态 ↓</option>
            <option value="mic:1">麦克风 ↑</option>
            <option value="mic:-1">麦克风 ↓</option>
            <option value="role:1">备注角色 ↑</option>
            <option value="role:-1">备注角色 ↓</option>
            <option value="orange:1">橙武优先</option>
            <option value="orange:-1">无橙武优先</option>
            <option value="remark:1">备注 ↑</option>
            <option value="remark:-1">备注 ↓</option>
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
          <button className="btn ghost" onClick={() => void load({ silent: true })}>刷新</button>
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
          onDone={(msg) => { setNotice(msg); void load({ silent: true }); }}
        />
      )}

      <div className="card">
        {/* toolbar--fields：这一行里有带小标签的字段（定位 ID），
            底边对齐才不会让标题和说明文字浮在半空 */}
        <div className="toolbar toolbar--fields" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>
            {view === 'left'
              ? `离帮人员（${leftPlayers.length}）—— 历史记录都在，点「详情 · 历史」查看`
              : `成员列表（${scoped.length}）`}
          </h3>
          <div className="spacer grow" />
          {/* 拖动提示条：文字由 beginDrag / decorateDrop **直接写 DOM**（拖动中不重渲染），
              没有内容时靠 CSS 的 :empty 隐藏，所以不需要额外的 state。 */}
          <span className="drag-hint" ref={dragHintRef} />
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
          {/* 用户口径：定位 ID 与新增成员并在一起。
              注意：抽屉本体**不能**放在这里 —— 这张 .card 有 backdrop-filter，
              它会让 position:fixed 的后代以卡片为包含块（实测面板被挤成 y=190 的"半铺"）。
              抽屉已经挪到组件根部，与编辑抽屉同级。 */}
          <button className="btn primary"
                  onClick={() => {
                    if (showAdd) { closeAdd(); return; }
                    // 站在「离帮人员」表上新增 → 默认建成离队（免得建完看不见，以为没建上）
                    setDraft((d) => ({
                      ...d, id: '', joinedOrder: '', remark: '',
                      status: view === 'left' ? 'left' : 'active',
                    }));
                    setShowAdd(true);
                  }}>
            {view === 'left' ? '+ 新增离帮人员' : '+ 新增成员'}
          </button>

        </div>

        {/* 两张表共用**同一份列表**（用户口径：格式要和在帮的一样）——
            原来离帮是另写的一张 table.grid，列名、行高、按钮全都对不上；
            现在只是数据范围不同（在帮表 = 在帮+暂离，离帮表 = 离帮），排版完全一致：
            同样的卡片行、同样的表头、同样的列；差别只有两个按钮：
            在帮那边是「编辑」，离帮这边换成「恢复到在帮」。
            ⚠️ 这类注释必须用 JSX 的花括号包起来，裸写会被当成正文渲染到页面上。 */}
        <div className={`mcard-grid${dragId !== null ? ' mcard-grid--dragging' : ''}`} ref={listRef}
             onDragOver={onGridDragOver} onDrop={onGridDrop}
             onDragLeave={(e) => {
               // 只有真的离开网格（而不是在卡与卡之间移动）才清掉落点
               if (!e.currentTarget.contains(e.relatedTarget as Node)) decorateDrop(null);
             }}>
          {loading && <div className="hint">加载中…</div>}
          {!loading && scoped.length === 0 && (
            <div className="hint">
              {view === 'left'
                ? '没有离帮人员。把某人的状态改成「离帮」他就会出现在这里（历史记录全部保留）。'
                : '暂无成员。可以用上面的表单添加，或导入旧表的成员主档。'}
            </div>
          )}
          {/* 个人卡片式列表（用户口径：一排 5 个）。
              卡片结构：顶部 3px 色带（未填表 = 橙黄呼吸 / 已填表 = 静谧绿）→
              ID（醒目）→ 曾用名（极小浅灰）→ 标签（橙武 = 淡橙底橙字 / 备注角色 = 白底黑字）
              → 右上角状态角标、右下角麦角标（白 = 有 / 黄 = 无）→
              默认只露一个「…」，hover 时卡片上浮、底部浮现快捷操作，点卡片开右侧抽屉。 */}
          {!loading && sorted.map((p, idx) => {
            const st = cardStatus(p);
            const band = bandOf(p.id);
            return (
              <div key={p.id} data-player-id={p.id}
                   /* 落点细线由 decorateDrop 直接加类名（拖动中不走 React），
                      所以这里的 className 只表达"静止态" */
                   className={`mcard${dragId === p.id ? ' mcard--dragging' : ''}${foundId === p.id ? ' mcard--found' : ''}${flashId === p.id ? ' mcard--flash' : ''}`}
                   draggable
                   onDragStart={(e) => beginDrag(e, p, idx)}
                   /* 拖动中松手后可能**不**落在任何卡片上（落在网格空白/中缝），
                      所以清理挂在卡片自己的 dragend 上，落点判定挂在网格上 */
                   onDragEnd={endDrag}
                   /* 用户口径 2026-09-27：「成员卡片点开是成员详情」——整张卡开详情；
                      编辑 / 删除走卡片上的「···」抽屉。 */
                   onClick={(e) => cardFlyTo(p, e)}
                   title={`${p.gameId} · 点击打开成员详情（拖动可换位）`}>
            {/* 卡片背景：有媒体就用静帧（视频取**第一帧**）；**没有就用半透明黑**（用户口径 2026-09-27） */}
            <div className="mcard__media" aria-hidden="true">
              {p.bgMedia && (/\.(mp4|webm|mov|mkv)$/i.test(p.bgMedia)
                ? (
                  <video
                    src={localUrl(p.bgMedia)}
                    preload="auto" muted playsInline
                    ref={(el) => {
                      if (!el) return;
                      el.addEventListener('loadedmetadata', () => { el.currentTime = 0; }, { once: true });
                    }}
                  />
                )
                : <img src={localUrl(p.bgMedia)} alt="" />)}
              <span className="mcard__mediaTone" />
            </div>
                {/* 顶部内发光：未填表 = 橙黄呼吸灯；已填表 = 静谧绿（用户口径：
                    「色块呼吸灯：换成顶部内发光」） */}
                <span className={`mcard__glow mcard__glow--${band}`} />
                {/* 序：仍然可以拖动换位；抽屉里也能直接改 */}
                <span className="mcard__order" title={`序 ${p.joinedOrder ?? idx + 1}（拖动卡片换位）`}>
                  {p.joinedOrder ?? idx + 1}
                </span>
                {/* 右上角：状态**三角标**（只有三种：在队浅绿 / 未排表浅黄 / 离帮灰） */}
                <span className={`mcard__tri mcard__tri--status mcard__tri--${st.key}`}
                      title={`状态：${st.label}`} />
                {/* 右下角：麦克风**三角标**（白 = 有麦，黄 = 没有） */}
                <span className={`mcard__tri mcard__tri--mic mcard__tri--mic-${p.mic === '有' ? 'yes' : p.mic === '无' ? 'no' : 'unknown'}`}
                      title={`麦克风：${p.mic || '未填'}`} />

                <div className="mcard__body">
                  <div className="mcard__id">{p.gameId}</div>
                  <div className="mcard__alias" title={(p.aliases ?? []).join('、')}>
                    {(p.aliases?.length ?? 0) > 0 ? `曾用 ${(p.aliases ?? []).join('、')}` : '\u00A0'}
                  </div>
                  <div className="mcard__tags">
                    {/* 标签只留这两个（用户口径：橙武 = 淡橙底橙字 / 备注角色 = 白底黑字）；
                        「本场报名 / 本场上场」两个多余状态标签已删 —— 报名与否由顶部内发光表达。 */}
                    {p.orangeWeapon === '有' && <span className="mcard__tag mcard__tag--ow">橙武</span>}
                    {p.noteRole && <span className="mcard__tag mcard__tag--role">{p.noteRole}</span>}
                  </div>
                </div>

                <button className="mcard__more" title="更多（打开侧边抽屉）"
                        onClick={(e) => { e.stopPropagation(); openDrawer(p); }}>···</button>
                {/* hover 时从底部丝滑浮现的快捷操作 */}
                <div className="mcard__quick" onClick={(e) => e.stopPropagation()}>
                  {/* 「详情」按钮已删：点卡片本身就是开详情（用户口径 2026-09-27） */}
                  {view === 'left' ? (
                    <button className="mcard__qbtn" title="恢复到在帮（历史数据不变）"
                            onClick={() => void restorePlayer(p)}>复帮</button>
                  ) : (
                    <button className="mcard__qbtn" title="编辑（打开侧边抽屉）"
                    onClick={() => openDrawer(p)}>编辑</button>
                  )}
                  <button className="mcard__qbtn mcard__qbtn--danger" title="删除"
                          onClick={(e) => warnThen(e, () => (view === 'left' ? void handleRemoveLeft(p) : void handleRemove(p)))}>删除</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 总体数据放在**最后**（用户口径：「总体数据放在最后」）——
          卡片列表是主体，统计是附录，看完人再往下看总量。 */}
      <div className="stat-grid" style={{ marginTop: 12 }}>
        <div className="stat"><div className="k">成员总数</div><div className="v">{players.length}</div></div>
        <div className="stat"><div className="k">在帮 / 暂离 / 离帮</div>
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

      {/* ═══ 侧边抽屉：编辑 / 详情 / 删除全在这里（用户口径）═══════════════
          点卡片打开；保存后不关抽屉（数据会自己刷新），删除后成员没了 → 抽屉自动收起。 */}
      {drawerPlayer && (
        <div className="drawer-mask" onClick={closeDrawer}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <header className="drawer__head">
              <div className="drawer__title">
                <div className="drawer__id">{drawerPlayer.gameId}</div>
                {(drawerPlayer.aliases?.length ?? 0) > 0 && (
                  <div className="drawer__alias">曾用 {(drawerPlayer.aliases ?? []).join('、')}</div>
                )}
              </div>
              <button className="btn ghost sm" onClick={closeDrawer}>关闭</button>
            </header>

            <div className="drawer__tags">
              <span className={`badge-state ${drawerPlayer.status}`}>{STATUS_LABEL[drawerPlayer.status] ?? drawerPlayer.status}</span>
              <span className={`badge-mic`}>{drawerPlayer.mic === '有' ? '有麦' : drawerPlayer.mic === '无' ? '无麦' : '麦未填'}</span>
              {drawerPlayer.orangeWeapon === '有' && <span className="mcard__tag mcard__tag--ow">橙武</span>}
              {drawerPlayer.noteRole && <span className="mcard__tag mcard__tag--role">{drawerPlayer.noteRole}</span>}
            </div>

            {/* 本场信息 + 历史战局 */}
            <dl className="drawer__info">
              <div><dt>本场报名</dt><dd>
                {matchId === null ? '（未选场次）'
                  : (() => { const s = signupOf.get(drawerPlayer.id) ?? null;
                      return s === 'JOIN' ? '参加' : s === 'LEAVE' ? '请假' : s === 'BENCH' ? '替补' : '未填表'; })()}
              </dd></div>
              <div><dt>本场排表</dt><dd>{PART_STATE_LABEL[lineupOf.get(drawerPlayer.id) ?? 'LEAVE'] ?? '未在名单'}</dd></div>
              <div><dt>历史战局</dt><dd>
                {(() => { const a = attendance.get(drawerPlayer.id);
                  return a ? `参与 ${a.matches} 场 · 上场 ${a.plays} · 已填战报 ${a.filled}` : '—'; })()}
              </dd></div>
              {drawerPlayer.remark && <div><dt>备注</dt><dd>{drawerPlayer.remark}</dd></div>}
            </dl>

            {/* 编辑表单：字段与原来的编辑行完全一致 */}
            <div className="drawer__form">
              <label className="field"><span>序</span>
                <input className="input" value={editDraft.joinedOrder} placeholder="空 = 排到最后"
                       onChange={(e) => setEditDraft({ ...editDraft, joinedOrder: e.target.value })} /></label>
              <label className="field"><span>ID</span>
                <input className="input" value={editDraft.id}
                       onChange={(e) => setEditDraft({ ...editDraft, id: e.target.value })} /></label>
              <label className="field field--wide"><span>历史用名（多个用 / 分隔）</span>
                <input className="input" value={editDraft.aliases}
                       title="改名前的旧名（多个用 / 分隔）。改这里会整份覆盖；留空 = 清空旧名"
                       onChange={(e) => setEditDraft({ ...editDraft, aliases: e.target.value })} /></label>
              <label className="field"><span>状态</span>
                <Select className="select" value={editDraft.status}
                        onChange={(e) => setEditDraft({ ...editDraft, status: e.target.value })}>
                  <option value="active">在帮</option>
                  <option value="inactive">暂离</option>
                  <option value="left">离帮</option>
                </Select></label>
              <label className="field"><span>麦克风</span>
                <Select className="select" placeholder value={editDraft.mic}
                        onChange={(e) => setEditDraft({ ...editDraft, mic: e.target.value as Player['mic'] })}>
                  <option value="">未填</option>
                  <option value="有">有</option><option value="无">无</option>
                </Select></label>
              <label className="field"><span>备注角色</span>
                <Select className="select" placeholder value={editDraft.noteRole}
                        onChange={(e) => setEditDraft({ ...editDraft, noteRole: e.target.value as Player['noteRole'] })}>
                  <option value="">—</option>
                  {['指挥', '统战', 'K龙', '替补指挥', '长期请假'].map((r) => <option key={r} value={r}>{r}</option>)}
                </Select></label>
              <label className="field"><span>橙武</span>
                <Select className="select" value={editDraft.orangeWeapon}
                        onChange={(e) => setEditDraft({ ...editDraft, orangeWeapon: e.target.value })}>
                  <option value="">无</option><option value="有">有</option>
                </Select></label>
              <label className="field field--wide"><span>备注</span>
                <input className="input" value={editDraft.remark}
                       onChange={(e) => setEditDraft({ ...editDraft, remark: e.target.value })} /></label>
              <label className="field field--wide"><span>自定义介绍（个人主页第 1 屏，3 行小字）</span>
                <input className="input" value={editDraft.intro} placeholder="这个人是谁 / 打什么位置…"
                       onChange={(e) => setEditDraft({ ...editDraft, intro: e.target.value })} /></label>
              <label className="field field--wide"><span>个性签名（个人主页单独一段）</span>
                <input className="input" value={editDraft.signature} placeholder="他自己的一句话"
                       onChange={(e) => setEditDraft({ ...editDraft, signature: e.target.value })} /></label>
              <label className="field field--wide"><span>个人主页背景（mp4 / 图片；留空用默认背景）</span>
                <div className="toolbar" style={{ margin: 0 }}>
                  <button type="button" className="btn sm"
                          onClick={() => void pickBg(drawerPlayer.id)}>选择视频 / 图片…</button>
                  {drawerPlayer.bgMedia
                    ? <>
                        <span className="hint" style={{ margin: 0 }}>
                          {drawerPlayer.bgMedia.split(/[\\/]/).pop()}
                        </span>
                        <button type="button" className="btn sm ghost"
                                onClick={() => void clearBg(drawerPlayer.id)}>移除</button>
                      </>
                    : <span className="hint" style={{ margin: 0 }}>未设置（用默认背景）</span>}
                </div>
              </label>
              <div className="drawer__save">
                <button className={`btn primary${okBtn === 'save' ? ' is-ok' : ''}`}
                        onClick={() => void saveEdit(drawerPlayer.id)}>
                  {okBtn === 'save' ? '✓ 已保存' : '保存'}
                </button>
                <button className="btn ghost" onClick={() => startEdit(drawerPlayer)}>还原</button>
              </div>
            </div>

            <footer className="drawer__foot">
              <button className="btn" onClick={() => onOpenDetail(drawerPlayer.id)}>完整详情页</button>
              {view === 'left' ? (
                <button className="btn" onClick={() => void restorePlayer(drawerPlayer)}>恢复到在帮</button>
              ) : (
                <button className="btn" onClick={() => startEdit(drawerPlayer)}>重置表单</button>
              )}
              <span className="grow" />
              <button className="btn danger"
                      onClick={(e) => warnThen(e, () => (view === 'left' ? void handleRemoveLeft(drawerPlayer) : void handleRemove(drawerPlayer)))}>
                删除成员
              </button>
            </footer>
          </aside>
        </div>
      )}
      {(showAdd || addClosing) && (
        /* 新增成员改成**和个人编辑一样的抽屉**（用户口径：样式格式相同）——
           字段顺序、标签在上、两列网格、底部按钮都与编辑抽屉一致。 */
        <div className={'drawer-mask' + (addClosing ? ' drawer-mask--out' : '')} onClick={closeAdd}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <header className="drawer__head">
              <div className="drawer__title">
                <div className="drawer__id">新增成员</div>
                <div className="drawer__alias">只写 ID 与麦克风即可，其余可以之后再补</div>
              </div>
              <button className="btn ghost sm" onClick={closeAdd}>关闭</button>
            </header>
            <div className="drawer__form">
              <label className="field"><span>序</span>
                <input className="input" value={draft.joinedOrder} placeholder="空 = 排到最后"
                       onChange={(e) => setDraft({ ...draft, joinedOrder: e.target.value })} /></label>
              <label className="field"><span>ID *</span>
                <input className="input" value={draft.id} placeholder="角色 ID / 名字"
                       onChange={(e) => setDraft({ ...draft, id: e.target.value })} /></label>
              <label className="field field--wide"><span>历史用名（多个用 / 分隔）</span>
                <input className="input" value={draft.aliases}
                       title="改名前的旧名，多个用 / 或 、 分隔。旧战报/旧报名里写旧名也能对上这个人"
                       onChange={(e) => setDraft({ ...draft, aliases: e.target.value })} /></label>
              <label className="field"><span>状态</span>
                <Select className="select" value={draft.status}
                        onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
                  <option value="active">在帮</option>
                  <option value="inactive">暂离</option>
                  <option value="left">离帮</option>
                </Select></label>
              <label className="field"><span>麦克风</span>
                <Select className="select" placeholder value={draft.mic}
                        onChange={(e) => setDraft({ ...draft, mic: e.target.value as Player['mic'] })}>
                  <option value="">未填</option>
                  <option value="有">有</option><option value="无">无</option>
                </Select></label>
              <label className="field"><span>备注角色</span>
                <Select className="select" placeholder value={draft.noteRole}
                        onChange={(e) => setDraft({ ...draft, noteRole: e.target.value as Player['noteRole'] })}>
                  <option value="">—</option>
                  {['指挥', '统战', 'K龙', '替补指挥', '长期请假'].map((r) => <option key={r} value={r}>{r}</option>)}
                </Select></label>
              <label className="field"><span>橙武</span>
                <Select className="select" value={draft.orangeWeapon}
                        onChange={(e) => setDraft({ ...draft, orangeWeapon: e.target.value })}>
                  <option value="">无</option>
                  <option value="有">有</option>
                </Select></label>
              <label className="field field--wide"><span>备注</span>
                <input className="input" value={draft.remark} placeholder="技能 / 装备标签"
                       onChange={(e) => setDraft({ ...draft, remark: e.target.value })} /></label>
              <div className="drawer__save">
                <button className={`btn primary${okBtn === 'add' ? ' is-ok' : ''}`}
                        onClick={() => { void handleCreate(); }}>
                  {okBtn === 'add' ? '✓ 已添加' : '添加'}
                </button>
                <button className="btn ghost" onClick={closeAdd}>取消</button>
              </div>
            </div>
          </aside>
        </div>
      )}

    </>
  );
}
