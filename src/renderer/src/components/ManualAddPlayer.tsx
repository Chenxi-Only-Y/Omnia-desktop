import { useState } from 'react';
import type { ClassInfo, Player } from '@shared/types';
import { api, errText } from '../api';
import Select from './Select';

/**
 * 「手动加人」——**报名页与排表选人面板共用同一份**（用户口径：「和报名那个同步」）。
 *
 * 为什么要有它：临时来的人往往既没填报名表、也可能还没进主档，所以这里一次把两件事做完：
 *   ① 主档里没有 → 先建档（只写 ID、名字与麦克风）；
 *   ② 写本场报名（参加 / 请假 + 主职 / 副职 + 麦克风）。
 * 职业仍然**不进主档**（全项目口径：职业只从报名表来）。
 *
 * 主档里已有这个人时（ID / 名字 / **历史用名** 任一命中）不再建档，直接用那条记录，
 * 于是改名过的人也能对上。
 *
 * 调用方通过 onAdded 拿到 playerId，决定"接下来干什么"：
 *   · 报名页：什么都不用做（报名已写好）；
 *   · 排表选人面板：接着把他放进被点的那个格子。
 */
export default function ManualAddPlayer({
  matchId, classes, onAdded, submitLabel = '加入本场', autoFocus = false,
}: {
  matchId: number;
  classes: ClassInfo[];
  onAdded?: (playerId: number, info: {
    mainClass: string; subClass: string; created: boolean; gameId: string;
    status: 'JOIN' | 'LEAVE';
  }) => void;
  submitLabel?: string;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState<{
    id: string; status: 'JOIN' | 'LEAVE'; mainClass: string; subClass: string; mic: Player['mic'];
  }>({ id: '', status: 'JOIN', mainClass: '', subClass: '', mic: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const id = draft.id.trim();
    if (!id) { setErr('ID 不能为空'); return; }
    setBusy(true);
    try {
      const key = id.toLowerCase();
      const hit = (await api.player.list()).find((p) => p.gameId.toLowerCase() === key
        || p.name.toLowerCase() === key
        || (p.aliases ?? []).some((a) => a.toLowerCase() === key));
      let playerId = hit?.id;
      let created = false;
      if (playerId === undefined) {
        const made = await api.player.create({ gameId: id, name: id, mic: draft.mic });
        playerId = made.id;
        created = true;
      }
      const leave = draft.status === 'LEAVE';
      await api.signup.set({
        matchId,
        playerId,
        status: draft.status,
        mainClass: leave ? '' : draft.mainClass,
        subClass: leave ? '' : draft.subClass,
        mic: draft.mic,
      });
      setErr(null);
      setDraft({ id: '', status: 'JOIN', mainClass: '', subClass: '', mic: '' });
      onAdded?.(playerId, {
        mainClass: leave ? '' : draft.mainClass,
        subClass: leave ? '' : draft.subClass,
        created,
        gameId: hit?.gameId ?? id,
        status: draft.status,
      });
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const leave = draft.status === 'LEAVE';
  return (
    <div className="manualadd">
      {err && <div className="msg error">{err}</div>}
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <input className="input" placeholder="ID / 名字 *" style={{ width: 180 }}
               autoFocus={autoFocus}
               value={draft.id}
               onChange={(e) => setDraft({ ...draft, id: e.target.value })}
               onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
        <Select className="select" value={draft.status}
                onChange={(e) => setDraft({ ...draft, status: e.target.value as 'JOIN' | 'LEAVE' })}>
          <option value="JOIN">参加</option>
          <option value="LEAVE">请假</option>
        </Select>
        <Select className="select" placeholder value={draft.mic}
                onChange={(e) => setDraft({ ...draft, mic: e.target.value as Player['mic'] })}>
          <option value="">麦</option>
          <option value="有">有</option><option value="无">无</option>
        </Select>
        <Select className="select" value={draft.mainClass} disabled={leave}
                onChange={(e) => setDraft({ ...draft, mainClass: e.target.value })}>
          <option value="">主职业</option>
          {classes.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
        </Select>
        <Select className="select" value={draft.subClass} disabled={leave}
                onChange={(e) => setDraft({ ...draft, subClass: e.target.value })}>
          <option value="">副职</option>
          {classes.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
        </Select>
        <button className="btn primary" disabled={busy} onClick={() => void submit()}>
          {busy ? '处理中…' : submitLabel}
        </button>
      </div>
      <div className="hint" style={{ marginTop: 6 }}>
        主档里没有这个人会自动建档（只写 ID 与麦克风）；填「历史用名」里的旧名也能对上人。
      </div>
    </div>
  );
}
