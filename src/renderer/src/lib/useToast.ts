import { useEffect } from 'react';

/**
 * 浮动提示的自动消失。
 *
 * 用户口径：提示改成右下角浮出、两秒自动消失，不再占版面把内容顶下去；
 * 但**报错要留够时间看清**，所以只有成功类（notice）自动清掉，错误不自动清。
 *
 * 注意：清空是走 setState(null)，所以同一条消息可以再次触发 ——
 * 否则第二次做同样的操作会因为「state 没变」而毫无反应（纯 CSS 定时淡出就会这样）。
 */
export function useToastAutoClear(
  notice: string | null,
  setNotice: (v: string | null) => void,
  ms = 2500,
): void {
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), ms);
    return () => clearTimeout(t);
  }, [notice, setNotice, ms]);
}
