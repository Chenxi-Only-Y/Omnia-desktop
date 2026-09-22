import { useMemo } from 'react';
import type { RadarAxis } from '@shared/types';

interface Props {
  axes: RadarAxis[];
  size?: number;
  /** 个人多边形颜色 */
  color?: string;
}

/**
 * 六维雷达图（纯 SVG，无第三方依赖）。
 *
 * 归一化方式：以「团队人均」为 1.0 的基准圈，个人值 / 团队人均 = 半径比例。
 * 半径上限按 2.0 截断（即某人某项是团队人均两倍时顶到最外圈），
 * 这样不同量级的维度（击杀 vs 伤害）能画在同一张图上而不用各自归一化，
 * 也让"1.0 圈"成为可读的参照线。
 */
export default function RadarChart({ axes, size = 260, color = 'var(--fg)' }: Props) {
  const cx = size / 2;
  const cy = size / 2;
  const rMax = size / 2 - 42;
  const CAP = 2.0;
  const n = Math.max(1, axes.length);

  const points = useMemo(() => {
    return axes.map((a, i) => {
      const ang = (-Math.PI / 2) + (i * 2 * Math.PI) / n;
      const ratio = Math.max(0, Math.min(CAP, a.ratio));
      const r = (ratio / CAP) * rMax;
      return {
        ...a,
        ang,
        r,
        x: cx + Math.cos(ang) * r,
        y: cy + Math.sin(ang) * r,
        // 满刻度（2.0 倍团队人均）的坐标，用于画轴线
        ax: cx + Math.cos(ang) * rMax,
        ay: cy + Math.sin(ang) * rMax,
        // 基准圈（1.0 倍）
        bx: cx + Math.cos(ang) * (rMax / CAP),
        by: cy + Math.sin(ang) * (rMax / CAP),
      };
    });
  }, [axes, cx, cy, rMax, n]);

  const poly = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const basePoly = points.map((p) => `${p.bx.toFixed(1)},${p.by.toFixed(1)}`).join(' ');
  const rings = [0.5, 1, 1.5, 2];

  if (!axes.length) return <div className="hint">没有可对比的数据</div>;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="radar" role="img">
      {/* 同心圈（0.5 ~ 2.0 倍团队人均） */}
      {rings.map((k) => (
        <circle key={k} cx={cx} cy={cy} r={(k / CAP) * rMax}
                fill="none"
                stroke={k === 1 ? 'var(--line-strong)' : 'var(--line)'}
                strokeWidth={k === 1 ? 1.2 : 1}
                strokeDasharray={k === 1 ? undefined : '3 4'} />
      ))}
      {/* 轴线 + 维度标签 */}
      {points.map((p) => (
        <g key={p.key}>
          <line x1={cx} y1={cy} x2={p.ax} y2={p.ay} stroke="var(--line)" strokeWidth={1} />
          <text
            x={cx + Math.cos(p.ang) * (rMax + 20)}
            y={cy + Math.sin(p.ang) * (rMax + 20)}
            fill="var(--text-dim)" fontSize={11}
            textAnchor={Math.abs(Math.cos(p.ang)) < 0.3 ? 'middle' : Math.cos(p.ang) > 0 ? 'start' : 'end'}
            dominantBaseline="middle"
          >
            {p.label}
          </text>
        </g>
      ))}
      {/* 团队人均基准圈（多边形） */}
      <polygon points={basePoly} fill="none" stroke="var(--text-faint)" strokeWidth={1} strokeDasharray="4 3" />
      {/* 个人 */}
      <polygon points={poly} fill={`${color}33`} stroke={color} strokeWidth={1.8} />
      {points.map((p) => (
        <circle key={p.key} cx={p.x} cy={p.y} r={2.6} fill={color} />
      ))}
      {/* 中心点 */}
      <circle cx={cx} cy={cy} r={2} fill="var(--line-strong)" />
    </svg>
  );
}
