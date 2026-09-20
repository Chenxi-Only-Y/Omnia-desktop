/**
 * 渲染层 API 包装：统一解包 IpcResult，把 { ok:false } 转成异常，
 * 这样调用方可以用普通的 try/catch，而不用每处判断 ok。
 */
import type {
  AppInfo, AssignInput, ClassInfo, CombatGroupRow, CombatStat, DashboardData, GroupInput,
  ImportPreview, IpcResult, JoinMode, Match, MatchInput, MatchSummary, ParticipationInput,
  ParticipationRow, Player, PlayerDetail, PlayerInput, RuleSet, RuleSetInput, RuleSetValidation,
  SavedScore, ScoreRunSummary, Season, SeasonInput, SeasonSummary, SheetGrid, SheetList,
  SignupBoard, SignupInput, SignupRow, SquadCatalog, SquadInput, SquadRow,
} from '@shared/types';

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
    /** 战斗组 / 小队建制（数据驱动，可新增） */
    squads: (): Promise<SquadCatalog> => unwrap(bridge().meta.squads()),
    createGroup: (input: GroupInput): Promise<CombatGroupRow> => unwrap(bridge().meta.createGroup(input)),
    removeGroup: (id: number): Promise<true> => unwrap(bridge().meta.removeGroup(id)),
    createSquad: (input: SquadInput): Promise<SquadRow> => unwrap(bridge().meta.createSquad(input)),
    appendSquad: (groupId: number): Promise<SquadRow> => unwrap(bridge().meta.appendSquad(groupId)),
    removeSquad: (id: number): Promise<true> => unwrap(bridge().meta.removeSquad(id)),
    setSquadTactic: (id: number, tactic: string): Promise<SquadRow> =>
      unwrap(bridge().meta.setSquadTactic(id, tactic)),
    /**
     * 截取排表功能区，**完整**（含右半区与下半部分），存成 PNG。
     *
     * 为什么必须分块拼：capturePage 只截**可见**区域，而功能区的完整尺寸
     * （约 2614×1704）比屏幕还大，右半区在横向滚动区、下方各队在竖向滚动区。
     *
     * 关键（前两次拼错就错在这）：几何量**只量一次** —— 先把窗口撑到屏幕最大，
     * 此时记下看板在窗口里的位置、以及内容区的可视尺寸；之后每块的裁剪矩形
     * 固定不变，位置只用 scrollLeft / 行索引推算，**不再**用滚动后的
     * getBoundingClientRect() 现算（看板自身在横向滚动，rect 会跑）。
     */
    captureBoard: async (): Promise<{ path: string | null; width: number; height: number }> => {
      const vsc = document.querySelector('.content') as HTMLElement | null;        // 竖向滚它
      const hsc = document.querySelector('.board__scroll') as HTMLElement | null;  // 横向滚它
      const grid = document.querySelector('.board__halves') as HTMLElement | null;
      if (!vsc || !hsc || !grid) throw new Error('排表功能区还没渲染，无法截图');

      const prev = { x: hsc.scrollLeft, y: vsc.scrollTop };
      const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
      // 截图期间隐藏滚动条：否则会被截进图里（图里出现混入的滚动条）
      const hideBar = document.createElement('style');
      hideBar.textContent = '.board__scroll::-webkit-scrollbar,.content::-webkit-scrollbar'
        + '{display:none!important}';
      document.head.appendChild(hideBar);
      let maxed = false;
      try {
        // 1) 窗口撑到屏幕最大，拿尽可能大的可视区域
        const mw = await bridge().meta.captureMaxWin();
        maxed = mw.ok;
        // 等布局彻底落定再量几何：之前只等 400ms，窗口重排没完成就开始量，
        // 量到的尺寸与之后截图时刻的布局不一致 → 拼出来列宽不同（踩过）
        await settle(1200);
        hsc.scrollLeft = 0;
        vsc.scrollTop = 0;
        await settle(500);

        // 2) 几何量一次（之后固定不变）
        //    横向滚动属于 .board__scroll，竖向属于 .content —— 早前一直量错容器，
        //    导致 scrollTo 被钳制在 0、拼出重复图（踩过）
        const gp = grid.getBoundingClientRect();
        const originX = Math.max(0, Math.round(gp.left));   // 看板在窗口内的固定位置
        const originY = Math.max(0, Math.round(gp.top));
        // 完整尺寸以**网格自身**为准：.board__scroll 的 scrollWidth 含
        // min-width:min-content 撑出的额外空间，会比内容宽（实测 3197 vs 2636）
        const fullW = Math.round(grid.scrollWidth);
        const fullH = Math.round(grid.scrollHeight);
        const tileVW = hsc.clientWidth;
        const tileVH = vsc.clientHeight;
        if (tileVW <= 10 || tileVH <= 10) {
          throw new Error(`可见区域太小（${tileVW}x${tileVH}），无法分块截图`);
        }
        const diag: string[] = [`origin=${originX},${originY} 完整=${fullW}x${fullH}`
          + ` 可视=${tileVW}x${tileVH}`];

        // 先收集每块的截图与实际滚动位置，再按「只取独有区域」的方式合并，
        // 让最后一块吸收重叠部分（滚动会被钳制，块之间必然有重叠）
        type Shot = { url: string; realX: number; realY: number };
        const shots: Shot[] = [];
        const ys: number[] = [];
        for (let ay = 0; ay < fullH; ay += tileVH) ys.push(ay);
        const xs: number[] = [];
        for (let ax = 0; ax < fullW; ax += tileVW) xs.push(ax);

        for (const ay of ys) {
          for (const ax of xs) {
            // 滚动位置取整：带小数的 scrollLeft 会让每块有几像素漂移，拼出来逐行错位（踩过）
            hsc.scrollLeft = Math.round(ax);
            vsc.scrollTop = Math.round(ay);
            await settle(280);
            const realX = hsc.scrollLeft;
            const realY = vsc.scrollTop;
            diag.push(`req ${ax},${ay} → 实 ${Math.round(realX)},${Math.round(realY)}`
              + ` (max ${Math.round(hsc.scrollWidth - hsc.clientWidth)})`);
            await api.meta.setSetting('captureRect', JSON.stringify({
              x: originX, y: originY, width: tileVW, height: tileVH,
            }));
            const res = await bridge().meta.captureRect();
            if (!res.ok) throw new Error(res.error || '分块截图失败');
            shots.push({ url: res.data, realX, realY });
          }
        }
        // 诊断色块与落点日志挪到 tiles/dpr 声明之后（见下方）

        // 按实际滚动位置合并：每块占据 [real, 下一次的 real) 这段
        type Tile = { url: string; ax: number; ay: number; w: number; h: number; sx: number; sy: number };
        const tiles: Tile[] = [];
        for (const s of shots) {
          const nextX = xs.find((v) => v > s.realX + 0.5);
          const nextY = ys.find((v) => v > s.realY + 0.5);
          const ax = Math.round(s.realX);
          const ay = Math.round(s.realY);
          let w = (nextX === undefined ? fullW : Math.round(nextX)) - ax;
          let h = (nextY === undefined ? fullH : Math.round(nextY)) - ay;
          if (s.realX + 0.5 >= fullW || s.realY + 0.5 >= fullH) continue;
          // 源偏移：重叠宽度取右侧/下侧，即从本块右/下边缘反推
          const sx = Math.max(0, tileVW - w);
          const sy = Math.max(0, tileVH - h);
          if (w <= 0 || h <= 0) continue;
          tiles.push({ url: s.url, ax, ay, w, h, sx, sy });
        }

        // 3) 按绝对坐标拼回原尺寸
        const dpr = window.devicePixelRatio || 1;
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(fullW * dpr);
        canvas.height = Math.round(fullH * dpr);
        const g = canvas.getContext('2d');
        if (!g) throw new Error('无法创建画布');
        g.fillStyle = '#E6E1E6';
        g.fillRect(0, 0, canvas.width, canvas.height);
        for (const t of tiles) {
          const im = await new Promise<HTMLImageElement>((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error('分块图片解码失败'));
            el.src = t.url;
          });
          // 分块图是 dpr 倍的物理像素：源区域按 (sx,sy,w,h) 取，落到画布 (ax,ay)
          const d = dpr;
          g.drawImage(im,
            Math.round(t.sx * d), Math.round(t.sy * d),
            Math.round(t.w * d), Math.round(t.h * d),
            Math.round(t.ax * d), Math.round(t.ay * d),
            Math.round(t.w * d), Math.round(t.h * d));
        }
        // 落点诊断：把每块的目标位置写进日志（拼错时一眼能看出落点偏移）
        diag.push('落点=' + JSON.stringify(
          tiles.map((t) => `${t.ax},${t.ay} ${t.w}x${t.h} src${t.sx},${t.sy}`),
        ));
        console.log('[capture] ' + diag.join(' ｜ '));
        (window as unknown as { __captureDiag?: string }).__captureDiag = diag.join(' ｜ ');

        await api.meta.setSetting('capturePng', canvas.toDataURL('image/png'));
        return await unwrap(bridge().meta.captureRegion());
      } finally {
        hideBar.remove();
        if (maxed) await bridge().meta.captureRestoreWin();
        hsc.scrollLeft = prev.x;   // 横向在 board__scroll、竖向在 content
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
    detail: (playerId: number): Promise<PlayerDetail> => unwrap(bridge().player.detail(playerId)),
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
    setSkillNote: (matchId: number, playerId: number, note: string): Promise<true> =>
      unwrap(bridge().match.setSkillNote(matchId, playerId, note)),
    removeParticipation: (id: number): Promise<true> =>
      unwrap(bridge().match.removeParticipation(id)),
    saveStat: (participationId: number, stat: Partial<CombatStat>): Promise<true> =>
      unwrap(bridge().match.saveStat(participationId, stat)),
    importPreview: (text: string, mode: JoinMode = 'roster'): Promise<ImportPreview> =>
      unwrap(bridge().match.importPreview(text, mode)),
    importCommit: (matchId: number, preview: ImportPreview) =>
      unwrap(bridge().match.importCommit(matchId, preview)),
    runScore: (matchId: number, ruleSetId?: number): Promise<ScoreRunSummary> =>
      unwrap(bridge().match.runScore(matchId, ruleSetId)),
    scores: (matchId: number, ruleSetId?: number): Promise<SavedScore[]> =>
      unwrap(bridge().match.scores(matchId, ruleSetId)),
  },

  dashboard: {
    data: (): Promise<DashboardData> => unwrap(bridge().dashboard.data()),
  },

  signup: {
    board: (matchId: number): Promise<SignupBoard> => unwrap(bridge().signup.board(matchId)),
    set: (input: SignupInput): Promise<SignupRow> => unwrap(bridge().signup.set(input)),
    apply: (matchId: number, playerIds: number[]): Promise<{ applied: number }> =>
      unwrap(bridge().signup.apply(matchId, playerIds)),
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

  season: {
    list: (): Promise<SeasonSummary[]> => unwrap(bridge().season.list()),
    active: (): Promise<Season> => unwrap(bridge().season.active()),
    create: (input: SeasonInput): Promise<Season> => unwrap(bridge().season.create(input)),
    update: (id: number, patch: Partial<SeasonInput>): Promise<Season> => unwrap(bridge().season.update(id, patch)),
    setActive: (id: number): Promise<Season> => unwrap(bridge().season.setActive(id)),
    remove: (id: number): Promise<true> => unwrap(bridge().season.remove(id)),
    assignMatches: (seasonId: number, matchIds: number[]): Promise<{ moved: number }> =>
      unwrap(bridge().season.assignMatches(seasonId, matchIds)),
  },
};
