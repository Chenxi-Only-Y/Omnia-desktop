/**
 * 渲染层 API 包装：统一解包 IpcResult，把 { ok:false } 转成异常，
 * 这样调用方可以用普通的 try/catch，而不用每处判断 ok。
 */
import type {
  AppInfo, AssignInput, ClassInfo, CombatGroupRow, CombatStat, DashboardData, GroupInput,
  GuildMeta,
  ImportCommitResult, ImportPreview, IpcResult, JoinMode, Match, MatchInput, MatchSummary,
  OppImportMode, ParticipationInput,
  ParticipationRow, Player, PlayerDetail, PlayerInput, RuleSet, RuleSetInput, RuleSetValidation,
  SavedScore, ScoreRunSummary, SheetGrid, SheetList,
  SignupBoard, SignupImportPreview, SignupImportRow, SignupInput, SignupReview, SignupRow,
  SquadCatalog, SquadInput, SquadRow,
} from '@shared/types';

/** 把 catch 到的东西变成给用户看的文案。
 *  渲染层 60+ 处都在写 err instanceof ApiError ? err.message : String(err)，
 *  收成一个函数：以后改文案（比如加前缀、做错误码映射）只改这一处。 */
export function errText(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err);
}

export class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function unwrap<T>(p: Promise<IpcResult<T>>): Promise<T> {
  const res = await p;
  if (!res || typeof res !== 'object') throw new ApiError('IPC 返回为空（主进程可能未就绪）');
  if (!res.ok) throw new ApiError(res.error);
  return res.data;
}

const bridge = () => {
  if (!window.omnia) {
    throw new ApiError('预加载桥未注入（window.omnia 不存在）。请确认 preload 路径正确。');
  }
  return window.omnia;
};

export const api = {
  appInfo: (): Promise<AppInfo> => unwrap(bridge().app.info()),

  meta: {
    classes: (): Promise<ClassInfo[]> => unwrap(bridge().meta.classes()),
    settings: (): Promise<Record<string, string>> => unwrap(bridge().meta.settings()),
    setSetting: (key: string, value: string): Promise<true> => unwrap(bridge().meta.setSetting(key, value)),
    /* 战斗组 / 小队建制：**按场次独立**，全部以 matchId 为首参 */
    squads: (matchId: number): Promise<SquadCatalog> => unwrap(bridge().meta.squads(matchId)),
    createGroup: (matchId: number, input: GroupInput): Promise<CombatGroupRow> =>
      unwrap(bridge().meta.createGroup(matchId, input)),
    removeGroup: (matchId: number, groupName: string): Promise<{ removed: boolean }> =>
      unwrap(bridge().meta.removeGroup(matchId, groupName)),
    createSquad: (matchId: number, input: SquadInput): Promise<SquadRow> =>
      unwrap(bridge().meta.createSquad(matchId, input)),
    appendSquad: (matchId: number, groupName: string): Promise<SquadRow> =>
      unwrap(bridge().meta.appendSquad(matchId, groupName)),
    removeSquad: (matchId: number, squadName: string): Promise<true> =>
      unwrap(bridge().meta.removeSquad(matchId, squadName)),
    setSquadTactic: (matchId: number, squadName: string, tactic: string): Promise<SquadRow> =>
      unwrap(bridge().meta.setSquadTactic(matchId, squadName, tactic)),
    setSquadSize: (matchId: number, squadName: string, size: number): Promise<SquadRow> =>
      unwrap(bridge().meta.setSquadSize(matchId, squadName, size)),
    /**
     * 截取排表功能区，**完整**（含右半区与下半部分），存成 PNG。
     *
     * 核心思路：**一次截完，不做分块拼接**。
     * 分块拼接试过多轮，接缝处始终有错位 —— 滚动落位、DPI 缩放、布局重排
     * 都会引入亚像素误差，用户实测反馈"还是错位的"，所以放弃拼接。
     *
     * 现在改成：截图期间由主进程把应用外壳（侧栏/顶栏）临时收起来，让功能区
     * 独占窗口，并把窗口撑到屏幕最大，使完整内容全部进入可见区域，一次
     * capturePage 截完 —— 没有接缝，也就不可能错位；之后原样还原。
     * （早前"隐藏侧栏"失败是因为只隐藏 <aside> 而没塌掉 .app 的两列网格，
     *   留下 216px 空列把内容挤成 355px 宽，原因已在主进程里一并处理。）
     */
    /**
     * 截取排表功能区，**完整**（含右半区与下半部分），存成 PNG。
     *
     * 采用「固定三块」方案（用户给的思路，比自动分块可靠得多）：
     *   ① 左半区 —— 滑块拉到最左，截左半区
     *   ② 中缝   —— 滑块居中，只截中间那条图
     *   ③ 右半区 —— 滑块拉到最右，截右半区
     * 三块的切分点落在**中缝及其两侧的间隙**上，那里是平坦底色，
     * 所以拼缝不可见 —— 这正是自动分块拼合失败的痛点所在。
     *
     * 每块的裁切范围按实测的 DOM 位置算（半区宽、中缝宽、间隙），
     * 并且只取「当前滚动位置下确实可见」的那一段，避免被滚动钳制后取到旧位置。
     */
    captureBoard: async (): Promise<{ path: string | null; width: number; height: number }> => {
      const board = document.querySelector('.board') as HTMLElement | null;
      const hsc = document.querySelector('.board__scroll') as HTMLElement | null;
      const vsc = document.querySelector('.content') as HTMLElement | null;
      const grid = document.querySelector('.board__halves') as HTMLElement | null;
      const halves = document.querySelectorAll('.half');
      const divider = document.querySelector('.board__divider') as HTMLElement | null;
      if (!board || !hsc || !vsc || !grid || halves.length < 2 || !divider) {
        throw new Error('排表功能区还没渲染，无法截图');
      }
      const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const prev = { x: hsc.scrollLeft, y: vsc.scrollTop };
      // 截图期间隐藏滚动条，免得被截进图里
      const hideBar = document.createElement('style');
      hideBar.textContent = '.board__scroll::-webkit-scrollbar,.content::-webkit-scrollbar'
        + '{display:none!important}'
        // 收起顶部工具条、提示条、顶栏，并去掉内容区留白：
        // 看板因此上移约 150px，整列 6 行（778px）才进得了视口
        // —— 之前 originY=177、可视高仅 706，底部 72px 落在屏幕外被截断
        + '.content > .card:first-child{display:none!important}'
        + '.content > .msg{display:none!important}'
        + '.topbar{display:none!important}'
        + '.content{padding:0!important}';
      document.head.appendChild(hideBar);

      /* 截图期间**关掉平滑滚动**（临时）：`.content` 上有 scroll-behavior:smooth，
         赋 scrollTop=99 会变成动画，320ms 后只滚到 89.33 —— 分块位置就偏了，
         拼出来的图会出现白缝/错位。改成 instant 后每次滚动都立刻到位。
         （声明放在 try 外面，finally 里才能还原。） */
      const prevHBeh = hsc.style.scrollBehavior;
      const prevVBeh = vsc.style.scrollBehavior;

      try {
        hsc.style.scrollBehavior = 'auto';
        vsc.style.scrollBehavior = 'auto';
        // 先滚到左上，量出看板在窗口里的位置
        hsc.scrollLeft = 0;
        vsc.scrollTop = 0;
        await settle(350);
        /* 竖向：**再往下滑一点**（用户口径：「我希望再下滑点再截图」）——
           看板整高 862px，而 originY 在 116 上下，116+862 会超过窗口高度，
           于是底部落在屏幕外，裁出来的图最下面少一条（实测确实少一整行）。
           这里先量一次"看板底部超出窗口多少"，把 .content 往下滑这么多再重新量，
           保证 originY + fullH 落在窗口里；下滑量受最大滚动范围钳制。 */
        let bRect = board.getBoundingClientRect();
        const overBottom = Math.round(bRect.bottom - window.innerHeight);
        if (overBottom > 0) {
          const maxV = Math.max(0, vsc.scrollHeight - vsc.clientHeight);
          const wantTop = Math.min(vsc.scrollTop + overBottom + 4, maxV);
          if (wantTop > vsc.scrollTop) {
            vsc.scrollTop = wantTop;
            await settle(320);
            bRect = board.getBoundingClientRect();
          }
        }
        const gRect = grid.getBoundingClientRect();
        const rel = (el: Element) => Math.round(el.getBoundingClientRect().left - gRect.left);
        const divFrom = rel(divider);
        const divTo = divFrom + Math.round(divider.getBoundingClientRect().width);
        // 完整宽度取**右半区右边缘**：网格自身被父级约束，gRect.width 只是可视宽
        const fullW = Math.round(halves[1].getBoundingClientRect().right - gRect.left);
        /* ⚠️ 高度必须取**整个看板**（.board）而不是网格（.board__halves）：
           看板 = 未分配区 + 两个半区，实测 862px；网格只有 786px。
           以前取的是 min(网格 scrollHeight, 看板高) = 786 → 底下整整一行没截进去
           （用户反馈的"截取照片出现问题"就是这个）。 */
        const fullH = Math.round(bRect.height);
        // 裁剪用的固定几何：看板左边缘在窗口里的 x、以及可视宽高
        const originX = Math.round(bRect.left - hsc.scrollLeft);
        const originY = Math.round(bRect.top);
        const viewW = hsc.clientWidth;
        const viewH = Math.min(vsc.clientHeight, Math.max(0, window.innerHeight - originY));
        const maxScroll = Math.max(0, hsc.scrollWidth - viewW);
        /* 横向上按**视口宽度**平铺，而不是按"左半区 / 中缝 / 右半区"：
           按语义切时左半区宽 1405 > 视口 1395，最后那 10px 谁都不截 → 图里留白缝；
           按视口平铺则每块的起点正好是上一块的终点，拼起来严丝合缝。 */
        const blocks: { name: string; from: number; to: number }[] = [];
        for (let from = 0; from < fullW - 2; from += viewW) {
          blocks.push({ name: `块${blocks.length + 1}`, from, to: Math.min(from + viewW, fullW) });
        }

        const drawn: { url: string; sx: number; w: number; at: number }[] = [];
        const diag: string[] = [`看板=${fullW}x${fullH} 分块=${blocks.length}`
          + ` 可视=${viewW}x${viewH} maxScroll=${maxScroll}`
          + ` 窗口高=${window.innerHeight} 竖向已滑=${Math.round(vsc.scrollTop)}`
          + ` 底部余量=${Math.round(window.innerHeight - (originY + fullH))}`
          + ` 中缝=${divFrom}..${divTo}`];
        for (const b of blocks) {
          // 让这一块完整可见：滚动量取「块起点」，再夹到合法范围
          const want = Math.min(Math.max(b.from, 0), maxScroll);
          hsc.scrollLeft = want;
          /* ⚠️ 这里**不要**再把 vsc.scrollTop 归零：上面为了让整块看板进视口
             已经下滑过一段，归零会把底部那条又推出屏幕（就是"截出来少一条"的成因）。 */
          await settle(320);
          const real = hsc.scrollLeft;
          // 该滚动量下，块的可见区间（内容坐标）
          const visFrom = Math.max(b.from, real);
          const visTo = Math.min(b.to, real + viewW);
          if (visTo - visFrom <= 2) { diag.push(`${b.name}: 不可见，跳过`); continue; }
          const w = visTo - visFrom;
          // 对应的窗口坐标
          const x = originX + (visFrom - real);
          const h = fullH;
          diag.push(`${b.name}: 滚=${real} 取=${visFrom}..${visTo} → 窗口x=${x} ${w}x${h}`);
          await api.meta.setSetting('captureRect', JSON.stringify({
            x, y: originY, width: Math.round(w), height: Math.round(h),
          }));
          const res = await bridge().meta.captureRect();
          if (!res.ok) throw new Error(res.error || `${b.name} 截图失败`);
          const im0 = await new Promise<HTMLImageElement>((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error('分块图片解码失败'));
            el.src = res.data;
          });
          diag.push(`${b.name}: 分块图=${im0.naturalWidth}x${im0.naturalHeight}`
            + ` (期望 ${Math.round(w)}x${h} CSS ×dpr) originY=${originY} viewH=${viewH}`);
          drawn.push({ url: res.data, sx: 0, w: Math.round(w), at: visFrom });
        }
        console.log('[capture] ' + diag.join(' ｜ '));
        (window as unknown as { __captureDiag?: string }).__captureDiag = diag.join(' ｜ ');

        // 拼合：按各块在内容坐标里的位置画回原尺寸
        const dpr = window.devicePixelRatio || 1;
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(fullW * dpr);
        canvas.height = Math.round(fullH * dpr);
        const g = canvas.getContext('2d');
        if (!g) throw new Error('无法创建画布');
        g.fillStyle = '#E6E1E6';
        g.fillRect(0, 0, canvas.width, canvas.height);
        for (const d of drawn) {
          const im = await new Promise<HTMLImageElement>((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error('分块图片解码失败'));
            el.src = d.url;
          });
          g.drawImage(im, 0, 0, Math.round(d.w * dpr), Math.round(fullH * dpr),
            Math.round(d.at * dpr), 0, Math.round(d.w * dpr), Math.round(fullH * dpr));
        }

        await api.meta.setSetting('capturePng', canvas.toDataURL('image/png'));
        return await unwrap(bridge().meta.captureRegion());
      } finally {
        hideBar.remove();
        hsc.style.scrollBehavior = prevHBeh;
        vsc.style.scrollBehavior = prevVBeh;
        hsc.scrollLeft = prev.x;
        vsc.scrollTop = prev.y;
      }
    },

    xlsxSheets: (data: Uint8Array): Promise<SheetList> => unwrap(bridge().meta.xlsxSheets(data)),
    xlsxGrid: (data: Uint8Array, sheet: string | number, headerRow?: number): Promise<SheetGrid> =>
      unwrap(bridge().meta.xlsxGrid(data, sheet, headerRow)),
  },

  player: {
    list: (): Promise<Player[]> => unwrap(bridge().player.list()),
    create: (input: PlayerInput): Promise<Player> => unwrap(bridge().player.create(input)),
    update: (id: number, patch: Partial<PlayerInput>): Promise<Player> =>
      unwrap(bridge().player.update(id, patch)),
    remove: (id: number): Promise<true> => unwrap(bridge().player.remove(id)),
    import: (rows: PlayerInput[]) => unwrap(bridge().player.import(rows)),
    export: (): Promise<PlayerInput[]> => unwrap(bridge().player.export()),
    /** 拖拽换位后整批写回「序」 */
    reorder: (playerIds: number[]): Promise<true> => unwrap(bridge().player.reorder(playerIds)),
    listWallpapers: (dir?: string): Promise<import('@shared/types').WallpaperItem[]> => unwrap(bridge().player.listWallpapers(dir)),
    wallpaperTranscode: (): Promise<string> => unwrap(bridge().player.wallpaperTranscode()),
    detail: (playerId: number): Promise<PlayerDetail> => unwrap(bridge().player.detail(playerId)),
    /** 选 mp4 / 图片当个人主页背景（取消返回 null） */
    pickBg: (): Promise<string | null> => unwrap(bridge().player.pickBg()),
    /** 设置背景（文件拷进应用目录） */
    setBg: (id: number, srcPath: string): Promise<Player> => unwrap(bridge().player.setBg(id, srcPath)),
    /** 移除背景 */
    clearBg: (id: number): Promise<Player> => unwrap(bridge().player.clearBg(id)),
  },

  match: {
    list: (): Promise<MatchSummary[]> => unwrap(bridge().match.list()),
    get: (id: number): Promise<Match> => unwrap(bridge().match.get(id)),
    create: (input: MatchInput) => unwrap(bridge().match.create(input)),
    update: (id: number, patch: Partial<MatchInput>): Promise<Match> =>
      unwrap(bridge().match.update(id, patch)),
    remove: (id: number): Promise<true> => unwrap(bridge().match.remove(id)),
    participations: (matchId: number): Promise<ParticipationRow[]> =>
      unwrap(bridge().match.participations(matchId)),
    upsertParticipation: (input: ParticipationInput) =>
      unwrap(bridge().match.upsertParticipation(input)),
    assignBulk: (input: AssignInput) => unwrap(bridge().match.assignBulk(input)),
    unassign: (matchId: number, playerId: number): Promise<true> =>
      unwrap(bridge().match.unassign(matchId, playerId)),
    /** 沿用另一场的排表（不带战报/评分/对方数据） */
    copyLineup: (fromMatchId: number, toMatchId: number, overwrite = false) =>
      unwrap(bridge().match.copyLineup(fromMatchId, toMatchId, overwrite)),
    setSkillNote: (matchId: number, playerId: number, note: string): Promise<true> =>
      unwrap(bridge().match.setSkillNote(matchId, playerId, note)),
    removeParticipation: (id: number): Promise<true> =>
      unwrap(bridge().match.removeParticipation(id)),
    saveStat: (participationId: number, stat: Partial<CombatStat>): Promise<true> =>
      unwrap(bridge().match.saveStat(participationId, stat)),
    clearStats: (matchId: number, side: 'our' | 'opp' = 'our'): Promise<{ cleared: number }> =>
      unwrap(bridge().match.clearStats(matchId, side)),
    clearStatRow: (participationId: number): Promise<true> =>
      unwrap(bridge().match.clearStatRow(participationId)),
    importPreview: (text: string, mode: JoinMode = 'roster'): Promise<ImportPreview> =>
      unwrap(bridge().match.importPreview(text, mode)),
    importCommit: (matchId: number, preview: ImportPreview, opts?: { opp?: OppImportMode }): Promise<ImportCommitResult> =>
      unwrap(bridge().match.importCommit(matchId, preview, opts)),
    runScore: (matchId: number, ruleSetId?: number): Promise<ScoreRunSummary> =>
      unwrap(bridge().match.runScore(matchId, ruleSetId)),
    scores: (matchId: number, ruleSetId?: number): Promise<SavedScore[]> =>
      unwrap(bridge().match.scores(matchId, ruleSetId)),
  },

  dashboard: {
    data: (): Promise<DashboardData> => unwrap(bridge().dashboard.data()),
  },

  /** 帮会（一帮会一个库文件）。open 之后其它接口读写的都是新帮会的数据。 */
  guild: {
    list: (): Promise<GuildMeta[]> => unwrap(bridge().guild.list()),
    active: (): Promise<GuildMeta | null> => unwrap(bridge().guild.active()),
    create: (name: string, note?: string): Promise<GuildMeta> => unwrap(bridge().guild.create(name, note)),
    open: (id: string): Promise<GuildMeta> => unwrap(bridge().guild.open(id)),
    update: (id: string, patch: { name?: string; note?: string }): Promise<GuildMeta> =>
      unwrap(bridge().guild.update(id, patch)),
    remove: (id: string): Promise<true> => unwrap(bridge().guild.remove(id)),
    setCover: (id: string, srcPath: string): Promise<GuildMeta> => unwrap(bridge().guild.setCover(id, srcPath)),
    pickCover: (): Promise<string | null> => unwrap(bridge().guild.pickCover()),
  },

  signup: {
    board: (matchId: number): Promise<SignupBoard> => unwrap(bridge().signup.board(matchId)),
    set: (input: SignupInput): Promise<SignupRow> => unwrap(bridge().signup.set(input)),
    apply: (matchId: number, playerIds: number[]): Promise<{ applied: number }> =>
      unwrap(bridge().signup.apply(matchId, playerIds)),
    /** 解析报名表 xlsx（只预览，不入库） */
    parse: (matchId: number, data: Uint8Array): Promise<SignupImportPreview> =>
      unwrap(bridge().signup.parseSignup(matchId, data)),
    /** 解析群「接龙」文本（只预览，不入库；与 xlsx 共用同一套预览/入库流程） */
    parseText: (matchId: number, text: string): Promise<SignupImportPreview> =>
      unwrap(bridge().signup.parseSignupText(matchId, text)),
    importRows: (matchId: number, rows: SignupImportRow[]):
      Promise<{ imported: number; unmatched: string[] }> =>
      unwrap(bridge().signup.importSignups(matchId, rows)),
    review: (matchId: number): Promise<SignupReview> =>
      unwrap(bridge().signup.reviewSignups(matchId)),
    createMissing: (matchId: number, gameIds: string[]):
      Promise<{ created: number; signups: number }> =>
      unwrap(bridge().signup.createMissingPlayers(matchId, gameIds)),
  },

  rules: {
    list: (): Promise<RuleSet[]> => unwrap(bridge().rules.list()),
    active: (): Promise<RuleSet | null> => unwrap(bridge().rules.active()),
    defaults: (): Promise<RuleSetInput> => unwrap(bridge().rules.defaults()),
    create: (input: RuleSetInput): Promise<RuleSet> => unwrap(bridge().rules.create(input)),
    update: (id: number, input: RuleSetInput): Promise<RuleSet> => unwrap(bridge().rules.update(id, input)),
    duplicate: (id: number, name?: string): Promise<RuleSet> => unwrap(bridge().rules.duplicate(id, name)),
    setActive: (id: number): Promise<RuleSet> => unwrap(bridge().rules.setActive(id)),
    remove: (id: number): Promise<true> => unwrap(bridge().rules.remove(id)),
    validate: (input: RuleSetInput): Promise<RuleSetValidation> => unwrap(bridge().rules.validate(input)),
  },
};
