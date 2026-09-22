# ByteDance Seed · Seedance 2.0 — DESIGN.md

> **来源**：照 <https://seed.bytedance.com/zh/seedance2_0> 的视觉特征**手写**的
> 设计规范（官方规范不存在，此为近似描述）。**这份文件是本项目首页的唯一视觉依据**：
> 生成/修改首页 UI 时，所有颜色、字号、间距、圆角、动效都从这里取，不得另起炉灶。

---

## 一、Visual Theme & Atmosphere

**一句话**：深色电影感的「模型发布页」—— 近黑底、超大标题、大留白、克制光晕、药丸按钮。

- **剧场感**：整屏深色，内容像被聚光打亮；主视觉区（首屏）几乎不放信息密度高的东西，
  只有一句话大标题、一段说明、几个入口。
- **节奏**：每个章节 = 眉题（小、灰、宽字距）→ 大标题（很重、很紧）→ 说明（限宽、松行距）→ 图/卡片。
- **颜色极少**：界面几乎全是明度层级（近黑 → 深灰 → 浅灰 → 白），
  **彩色只允许来自内容本身**（职业图标、图片、视频卡），不许用彩色块铺大面积。
- **纵深靠光晕**：不用重阴影，靠 1px 描边 + 大半径柔和径向光制造抬升与聚焦。
- **中英混排**：中文为主，英文做眉题/技术词/副标题；中文舒展，英文紧。
- **信息密度低**：宁可留白，不填满。

---

## 二、Color Tokens（深色）

| token | 值 | 用途 |
|---|---|---|
| `--bg` | `#0B0B0D` | 页面底（近黑） |
| `--bg-elev` | `#131317` | 卡片 / 抬升面 |
| `--bg-elev-2` | `#1C1C22` | 卡内嵌套（托盘、徽章底） |
| `--bg-glass` | `rgba(19,19,23,0.72)` | 悬浮条/模态（带模糊） |
| `--line` | `#26262E` | 1px 描边 / 分隔 |
| `--line-strong` | `#3B3B46` | hover 时的描边 |
| `--text` | `#FFFFFF` | 标题与主文 |
| `--text-dim` | `#A8A8B4` | 次级说明 |
| `--text-faint` | `#6E6E7A` | 眉题 / 占位 / 弱文 |
| `--accent` | `#FFFFFF` | 主按钮底（白底黑字） |
| `--accent-ink` | `#0B0B0D` | 主按钮上的字 |
| `--glow-cool` | `#6E7BFF` | 光晕冷色（蓝紫） |
| `--glow-warm` | `#C084FC` | 光晕暖色（紫粉） |
| `--glow-cyan` | `#22D3EE` | 光晕点缀（青） |
| `--ok` / `--warn` / `--danger` | `#3FD68C` / `#F2C94C` / `#FF6B6B` | 语义色（低饱和，配深底） |

> **约束**：彩色（glow-cool/warm/cyan、职业图标色）只能做光晕、点缀或内容图标；
> 大面积仍必须是 `--bg` / `--bg-elev` 的明度层级。

---

## 三、Typography

**字栈**
- 中文：`PingFang SC, HarmonyOS Sans SC, Microsoft YaHei, sans-serif`
- 英文/数字：`Inter, SF Pro Display, Segoe UI, sans-serif`（在中文字栈之前）
- 等宽（技术标签）：`JetBrains Mono, SF Mono, monospace`

**层级**（字号/字重/行高/字距）

| 角色 | size | weight | line-height | letter-spacing |
|---|---|---|---|---|
| Display（首屏大标题） | `clamp(40px, 6vw, 72px)` | 700 | 1.05 | `-0.025em` |
| Display-en（英文副标） | `clamp(15px, 1.6vw, 22px)` | 400 | 1.4 | `0.02em` |
| H2（章节大标题） | `clamp(28px, 3.4vw, 44px)` | 650 | 1.18 | `-0.015em` |
| H3（卡片标题） | `20–24px` | 600 | 1.3 | `-0.005em` |
| Body | `15–16px` | 400 | 1.75 | `0` |
| Small | `13px` | 400 | 1.7 | `0` |
| Eyebrow（眉题） | `11px` | 500 | 1.2 | `0.08em` |
| Micro（徽章内） | `11px` | 500 | 1 | `0.01em` |

**排版规则**
- 标题字重一定要**重**、行高**紧**、字距**负**；正文相反（轻、松、0 字距）。
- 眉题用 `--text-faint`，可全大写英文或小字号中文，前面可加一条 12px 短横线。
- 说明文限宽 `640px`，不要满幅铺文字。

---

## 四、Layout & Spacing

- 内容最大宽 `1280px`，水平居中；首屏视觉可破格全宽。
- 章节纵向节奏：`padding-block: clamp(88px, 12vh, 160px)`。
- 栅格：12 列，列间距 `24px`；卡片阵列 2–3 列自适应（`minmax(280px, 1fr)`）。
- 基准间距单位 `4px`；常用 `8 / 12 / 16 / 24 / 32 / 48 / 64`。
- 大标题左对齐；正文限宽；CTA 行与标题左缘对齐。

---

## 五、Radius & Elevation

- 圆角：**药丸按钮 `999px`**；卡片 `18px`；内嵌托盘/徽章 `12px`；输入 `12px`。
- **不用重阴影**。抬升靠：1px `--line` 描边 + `--bg-elev` 底色 + 一层极柔径向光晕。
- hover 时描边升级到 `--line-strong`，或加 `box-shadow: 0 0 0 3px rgba(110,123,255,.18)` 的柔光环。

---

## 六、Components

**按钮（药丸）**
- 主按钮：`background: var(--accent)`（白），文字 `var(--accent-ink)`（近黑），`border-radius: 999px`，
  padding `10px 22px`，weight 600，hover 轻微 `translateY(-1px)` + 光晕。
- 次按钮：透明底 + 1px `--line-strong` 描边，文字 `--text`，hover 底色 `--bg-elev-2`。
- 尺寸小档：`padding 6px 14px; font-size 13px`。

**卡片**
- `background: var(--bg-elev); border: 1px solid var(--line); border-radius: 18px; padding: 24–32px`。
- 标题在上（H3）、说明在下（Small, --text-dim）。
- hover：描边 `--line-strong`，可选轻微光晕。

**眉题（Eyebrow）**
- `font: 11px/1.2 500; letter-spacing: .08em; color: var(--text-faint)`，
  可前置 `— ` 或 24px 短横线（1px, `--line-strong`）。

**图标徽章（职业图标托盘）**
- 圆形托盘 `44–52px`，`background: var(--bg-elev-2)`，`border: 1px solid var(--line)`；
  图标 `24–28px` **保持原色**（禁止重染），留 6–8px 内边距。

**数据大数**
- 数字 `32–40px / 700 / tabular-nums`；标签在上（Eyebrow 风格）；对比值用 `--text-dim`。

**输入**
- `background: var(--bg-elev); border: 1px solid var(--line); border-radius: 12px`；
  placeholder 用 `--text-faint`；focus 时描边 `--glow-cool` + 柔光环。

---

## 七、Motion

- 入场：`opacity 0 → 1`、`translateY(12px) → 0`，`420ms cubic-bezier(.2,.7,.2,1)`，同级元素交错 `60ms`。
- Hover：`150ms ease`。
- 首屏光晕可做 6–8s 的极缓慢「呼吸」（透明度/位移 ≤4%）。
- **一律 `@media (prefers-reduced-motion: reduce)` 关闭动画**。
- 不做弹跳、不做大位移、不做连续炫技动画。

---

## 八、Do / Don't

**Do**
- ✅ 大字重对比 + 大留白，让「一句话」成为视觉主角
- ✅ 明度层级造纵深：近黑底 → 深灰卡 → 浅灰描边 → 白字
- ✅ 光晕克制：只在首屏/章节头出现，半径大、边缘极柔
- ✅ 药丸按钮、圆角卡片、1px 描边
- ✅ 彩色只出现在职业图标、图片、视频卡里

**Don't**
- ❌ 不用彩色块铺大面积背景
- ❌ 不用重投影、粗边框、强描边
- ❌ 不做密集表格样式的展示区（那是工具，不是宣传页）
- ❌ 不在同一屏塞多个大标题
- ❌ 不用装饰性插图或emoji填充
