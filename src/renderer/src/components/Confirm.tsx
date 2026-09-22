import { useEffect, useState } from 'react';

/**
 * 自绘确认框，替代 window.confirm。
 *
 * 为什么要替：原生 confirm 的样式完全不可控（系统画的），
 * 而且它会**阻塞渲染进程**（自检探针也被它卡住过）。
 * 用法：if (!(await confirmDialog('确定？'))) return;
 */

type Req = { msg: string; resolve: (v: boolean) => void };
let push: ((r: Req) => void) | null = null;

export function confirmDialog(msg: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!push) { resolve(window.confirm(msg)); return; }   // 组件没挂载时的兜底
    push({ msg, resolve });
  });
}

export default function ConfirmHost() {
  const [req, setReq] = useState<Req | null>(null);
  useEffect(() => {
    push = (r) => setReq(r);
    return () => { push = null; };
  }, []);
  if (!req) return null;
  const done = (v: boolean) => { req.resolve(v); setReq(null); };
  return (
    <div className="cfm" onClick={() => done(false)}>
      <div className="cfm__box" onClick={(e) => e.stopPropagation()}>
        <div className="cfm__msg">{req.msg}</div>
        <div className="cfm__foot">
          <button type="button" className="btn" onClick={() => done(false)}>取消</button>
          <button type="button" className="btn primary" onClick={() => done(true)}>确定</button>
        </div>
      </div>
    </div>
  );
}
