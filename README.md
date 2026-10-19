# 漫卷 SlowScroll

> 「漫」取慢速全档调节，「卷」取网页徐徐展开、到底回顶循环之意。

慢速自动滚动浏览器扩展。支持 50–4000 px/s 全档调速、暂停恢复、到底自动回顶循环与区间循环，兼容 SPA、页面内部滚动容器、影子 DOM 与 iframe 正文页。

**技术栈**：Manifest V3 + 原生 JavaScript，**零运行时依赖、零构建**——`npm run build` 是自研的保守压缩器（去注释与空白折叠，不做标识符混淆），源码约 250 KB，全部逻辑可逐行对照阅读。

| | |
|---|---|
| **浏览器** | Chrome / Edge 及其他 Chromium 内核（Firefox、Safari 未适配） |
| **权限** | 仅 `activeTab`、`scripting`、`storage`，无 `<all_urls>` 主机权限 |
| **依赖** | 运行时 0 个，测试 0 个（自建迷你 DOM），开发 0 个 |
| **发布** | `npm run build` 产出商店 zip（约 54 KB），七环节 CI 校验 |

---

## 目录

- [主要功能](#主要功能)
- [操作方式](#操作方式)
- [设置选项](#设置选项)
- [技术特性](#技术特性)
- [设计系统](#设计系统)
- [浏览器兼容性](#浏览器兼容性)
- [开发与测试](#开发与测试)
- [开发约定](#开发约定)
- [已知技术债](#已知技术债)
- [安装与使用](#安装与使用)
- [常见问题](#常见问题)
- [版本历史](#版本历史)

---

## 主要功能

| 功能 | 说明 |
|------|------|
| 自动滚动 | 智能识别页面滚动容器，兼容 SPA 与内部滚动区域 |
| iframe 正文 | 正文在 iframe 内的文章站 / 在线文档同样可驱动，控制条仍只有一条 |
| 影子 DOM | 穿透开放 shadow root 定位滚动容器（封闭 root 受浏览器限制不可穿透） |
| 速度调节 | 50–4000 px/s 连续调节，悬浮条 / 弹窗 / 快捷键三处同步 |
| 速度记忆 | 调过的速度按会话记住，切页面不再回到默认 600 |
| 滚动进度 | 弹窗实时显示已滚动百分比与剩余像素 |
| 启停控制 | 播放、停止、暂停、恢复四态可辨，按钮文本与配色随状态变化 |
| 快速回顶 | 停止滚动并平滑返回页面顶部 |
| 到底循环 | 触底后自动回到顶部继续向下；识别无限滚动页面并自动跳过回顶 |
| 区间循环 | 在指定段落范围内反复滚动，适合背单词、看乐谱、精读某一段 |
| 手势接管策略 | 手动滚动时可选择暂停 / 临时减速 / 完全忽略 |
| 触底自动翻页 | 滚到底自动点「下一章 / 下一页」，默认关闭，带站点白名单与 1.5s 取消窗口 |
| 倒计时到点自动停 | 设定分钟数后自动停止，适合「睡前读 20 分钟」；0 表示不限时 |
| 失败原因明示 | 页面滚不动时说明原因（无可滚动内容 / 疑似虚拟列表），而不是让用户干等 |
| 状态提示 | 触底、回顶中、区间停留、无限滚动加载中等场景给出实时提示条 |
| 自动隐藏 | 开始滚动后控制条淡出，把页面完整让给阅读；热区或 `Esc` 唤回 |

---

## 操作方式

三个操作入口（页面悬浮条、工具栏弹窗、快捷键）共享同一份引擎状态，任意入口的操作会实时反映到其余两处。

### 页面悬浮控制条

页面右下角的深色玻璃控制条：

| 按钮 | 功能 | 说明 |
|------|------|------|
| 播放 / 停止 | 启动或停止自动滚动 | 图标在播放/停止间切换 |
| − | 减速 | 按设置页「速度步进」递减 |
| + | 加速 | 按设置页「速度步进」递增 |
| 循环 | 切换回顶循环 | 开启后按钮转为绿色高亮 |
| 区间 | 标记区间起止 | 单键推进：设起点 → 设终点 → 清除，按钮文案随进度变化 |
| ↑ | 回到页面顶部 | 停止滚动并平滑回顶 |

控制条上方的提示条会显示触底、回顶中、区间停留中等状态文案，可在设置页关闭。

**区间循环**

在需要反复阅读的段落上来回滚动，而不是每次滚到页面底部。两种标记方式：

1. 把页面滚到想循环的**开头**，点击「区间」（此时显示「区间」）
2. 滚到这段的**结尾**，再次点击「区间」（显示「设终点」）
3. 两个锚点都就位后按钮变为高亮，显示「区间循环中」，滚动会在该范围内往返

要点：

- **终点停留**：滚到区间下沿后原地停留（默认 3 秒）再回弹。没有停留的话内容会「顶到头立刻弹回」，视觉上是高频抖动，同时用户也读不完那一段
- **区间不能太短**：两个锚点间距小于 200px 时会被拒绝并清空——这么短的区间来回弹跳只会晃眼
- **锚点是页面级的**：`scrollTop` 在不同页面之间没有可比性，所以锚点不写入全局配置，切页面即失效，这是刻意的
- **与到底循环互斥**：区间生效时整页触底逻辑让位，反之亦然
- 停留时长可在弹窗里现场调整，也可设默认值

**手动滚动时的接管策略**

你主动滚滚轮时，扩展的响应方式可配置（弹窗或设置页均可切换）：

| 策略 | 行为 | 适用 |
|------|------|------|
| 暂停 | 一有滚轮就停止自动滚动 | 想随时完全接管控制权 |
| 减速 | 临时降到一半速度，停下后约 1.8 秒自动恢复 | **长文阅读推荐**：能一边跟读一边保持自动滚动 |
| 忽略 | 完全不响应，始终自动滚动 | 只想单向自动滚动 |

「减速」档在弹窗里会明确标注「手势降速中，当前实际 300 px/s」，避免出现「明明设了 600 却只有 300」的困惑——你的设定值不会被降速改写。

**滚动时自动隐藏**

自动滚动开始后，控制条会在 1.2 秒后自动淡出，把右下角完整让给阅读内容。唤回方式：

| 唤回方式 | 说明 |
|---------|------|
| 鼠标移入右下角 | 视口右下角 96×96 的矩形热区，鼠标移入即展开 |
| `Esc` | 键盘用户唤回，不阻止页面自身的 Esc 行为 |

行为细则：

- **有延迟**：滚动开始后 1.2 秒才收起，留出时间看清「播放 → 停止」的状态切换
- **指针在场不收起**：鼠标停在控制条上或仍在右下角热区内时，2.5 秒后也不会收起——否则会出现「鼠标压着它，它却消失了」
- **停止后不弹回**：停止滚动代表用户已接管，此时弹回等于打断阅读，需要时用热区 / `Esc` 唤回
- **只收起控制条**：触底、回顶中等状态提示条始终可见，不会因为隐藏而丢失反馈
- **键盘可达**：收起态用 `visibility: hidden` 退出可聚焦范围，同时 `Tab` 进入时自动展开
- 可在设置页关闭「滚动时自动隐藏控制条」，关闭后行为与旧版一致

### 工具栏弹窗

点击扩展图标打开，320px 宽，含三态徽章（已停止 / 运行中 / 已暂停）：

| 控件 | 功能 |
|------|------|
| 开始 / 停止滚动 | 切换滚动状态，主按钮 |
| 暂停 / 继续 | 暂停或恢复；未运行时该按钮禁用 |
| 速度滑块 | 精确调节滚动速度 50–4000 px/s，拖动时本地即时反馈 |
| 到底回顶循环 | 开关循环模式，与设置页默认值联动 |
| 已循环 N 次 | 循环开启且已循环时出现 |
| 设置 | 打开设置页 |


### 快捷键

| 快捷键 | 功能 | 说明 |
|--------|------|------|
| `Alt+S` | 启动 / 停止自动滚动 | 默认已绑定 |
| `Alt+P` | 暂停 / 恢复自动滚动 | 默认已绑定 |
| `Alt+↑` | 加速滚动 | 步长同设置页「速度步进」 |
| `Alt+↓` | 减速滚动 | 步长同设置页「速度步进」 |
| 无默认键 | 切换回顶循环 | 需在 `chrome://extensions/shortcuts` 手动绑定 |

> MV3 限制最多 4 个带 `suggested_key` ，因此「切换回顶循环」不占用默认键位。

---

## 设置选项

打开方式：弹窗底部「设置」/ 扩展管理页「选项」。

| 配置项 | 存储键 | 默认值 | 范围 | 说明 |
|--------|--------|--------|------|------|
| 默认速度 | `defaultSpeed` | 600 | 50–4000 px/s | 未调过速度时的初始速度 |
| 速度步进 | `step` | 50 | 10–500 | 悬浮条与快捷键每次加减的数值 |
| 到底回顶循环 | `loopEnabled` | false | 开关 | 是否默认开启循环 |
| 手动滚动接管策略 | `gesturePolicy` | `pause` | pause / slowdown / ignore | 手动滚动时如何让出控制权，改动即时生效 |
| 区间终点停留 | `rangeDwellMs` | 3000 | 0–60000 ms | 区间模式下滚到下沿后的停留时长 |
| 页面悬浮控制条 | `overlayEnabled` | true | 开关 | 关闭后不再显示悬浮条，改动即时生效 |
| 滚动时自动隐藏控制条 | `autoHideOverlay` | true | 开关 | 开始滚动后控制条淡出，热区 / `Esc` 唤回，改动即时生效 |
| 触底自动翻页 | `autoNextPage` | **false** | 开关 | 滚到底自动点「下一章」，**默认关闭**，见下方风险说明 |
| 翻页站点白名单 | `autoNextSites` | `[]` | 域名数组 | 留空 = 不限站点；填入后仅这些域名生效（子域名同样生效） |
| 倒计时到点自动停 | `stopAfterMinutes` | 0 | 0–480 分钟 | 0 表示不限时；从按下开始滚动起算 |

设置页还提供：滑块↔数值双向同步、恢复默认、`Cmd/Ctrl+S` 保存。

> 所有配置存于 `chrome.storage.sync`，content / popup / options 三端共用同一套键名。

**关于「默认速度」与会话速度**

调速记在 `sessionSpeed` 键上，与设置页的 `defaultSpeed` 分开：

| 场景 | 取值优先级 |
|------|-----------|
| 打开页面 | `sessionSpeed`（上次调到的速度）→ `defaultSpeed` → 600 |
| 设置页改默认速度 | 只影响尚未开始的会话，不打断正在进行的滚动 |

分开存放的原因是：拖滑块是临时微调，而设置页的默认值是全局偏好。若调速直接写 `defaultSpeed`，用 300 px/s 看一遍文章就会把全局默认永久改掉。

落盘做了防抖（800ms），停止滚动时强制冲刷。滑块拖动每秒可产生数十次变更，逐次直写会撞上 Chrome `storage.sync` 每分钟 120 次的写入配额上限而静默失败。

**⚠️ 关于「触底自动翻页」的风险控制**

这是扩展里唯一会**替你在第三方页面上点击元素**的功能，误判的代价不可逆（可能跳到广告页、付费墙甚至站内 destructive 操作）。因此它默认关闭，并设有五道闸门：

| 闸门 | 行为 |
|------|------|
| 默认关闭 | 须在设置页或弹窗显式开启，升级不会自动生效 |
| 站点白名单 | 可限定只在信任域名生效；后缀匹配带点边界，`evil-example.com` 不会被 `example.com` 放行 |
| 锚点白名单 | 只认 `rel="next"` 语义标记，或**规范化后完全相等**的文案（`下一章` / `下一页` / `next chapter`…）。「下一章预告」这类包含关系不会被误点 |
| 危险链接拒绝 | `javascript:` 伪协议、纯锚点、零尺寸隐藏元素一律不碰 |
| 武装 → 等待 → 点击 | 找到候选后先在悬浮条明示「即将翻到下一章」，留出 1.5s 取消窗口；期间任何滚轮 / 触摸 / 方向键都会撤销 |

另外：与回顶循环互斥（开循环即撤销已武装的候选）；点击前先停机，避免把 `scroll-behavior` 补丁带进新页面；单页翻页上限 200 次，冷却 3s，防止站点死链时无限跳转。

翻页计数按「页面会话」计，新页面由新文档重新初始化，自然归零。

**关于「倒计时到点自动停」**

纯 `setTimeout` + 一个绝对到期时刻（`stopDeadlineAt`），与区间停留的 `dwellTimer` 同构，不新增状态机。用绝对时刻而非递减计数器，是因为 `setTimeout` 在后台标签页会被浏览器限流甚至丢弃，递减计数会永久停在半路。

到期判据用 `stopDeadlineAt` 而非 `stopAfterMinutes`：后者是用户配置，到点后必须保留以便下次启动沿用；若拿它当判据，取消定时器后会每秒无限续期。

---

## 技术特性

### 架构

```
  popup / options / 悬浮条 / 快捷键
                  │
                  ▼
    background.js ──── 命令路由 · 按 frameId 的状态表 · 广播合并 · 按需注入
                  │
    ┌─────────────┼─────────────┐
    ▼             ▼             ▼
  顶层 frame    iframe frame   微小 frame
  scrollEngine  scrollEngine   （跳过，面积 < 40000px²）
  overlay ✗     overlay ✓      挡掉广告位与追踪像素
```

- **单一状态源**：`scrollEngine` 持有全部状态，UI 通过 snapshot 单向渲染，禁止在事件回调里散落 DOM 修改
- **状态上报分两类**：控制类变更（启停 / 调速 / 切策略 / 锚点）走 `publishState()` 即时上报；纯滚动帧走 `publishProgress()` 按 500 ms 节流。不区分会让状态推送退化为帧率级别（60 次/秒打向 background 与所有扩展页）
- **按需注入**：先发 `QUERY_STATE` 探测 content 是否就绪，未就绪才 `executeScript`，配合 `INJECTED_TABS` 集合避免重复注入
- **状态缓存**：`STATE_CACHE` 按 `frameId` 存（多 frame 直接覆盖会互相冲掉），随标签页关闭 / 导航 / URL 变更自动清理，`QUERY_STATE` 优先走缓存
- **状态广播**：content 上报 `STATE_UPDATE` 时 background 转发 `STATE_BROADCAST` 给 popup，弹窗打开期间的状态改动实时可见
- **常量单一来源**：速率、区间、时长统一取自 `shared/constants.js`（43 项），四端共用

### 关键约束

这几条是踩过坑之后定下的硬约束，展开说明见 [开发约定](#开发约定)：

| 约束 | 原因 |
|------|------|
| `shared/constants.js` 在 `manifest.content_scripts` 与 background 注入列表中都排第一 | 引擎启动即读取，缺失会直接抛错中止 |
| content 端禁止顶层 `const` / `let` | Service Worker 回收后会二次注入同一文件，顶层词法声明直接抛 `already been declared`，**整个文件不执行** |
| content 两端先过非 HTML 文档守卫 | `matches` 为 `<all_urls>`，会命中 SVG / 图片查看器，注入即崩 |
| content 脚本不写内联样式 | 非 HTML 文档中元素没有 `style` 属性，且与「禁止内联样式」的设计约定冲突 |
| 悬浮条只挂顶层 frame | 否则 iframe 页面上会出现多条控制条；判定须早于任何 DOM 操作 |
| 控制消息按 `frameId` 定向 | iframe 正文页上顶层引擎存在却不响应，命令发给顶层会被吃掉（表现为点了没反应） |
| 远程调用两端白名单 | `this[message.method](...)` 等于敞开引擎控制面 |
| 所有 `sendMessage` 带超时并读 `lastError` | 页面导航 / SW 回收时可能长时间不返回，popup 会卡在旧状态 |

### 文件结构

```
漫卷 SlowScroll/
├── manifest.json              # 扩展清单（icons / commands / 权限 / all_frames）
├── background/
│   └── background.js          # 命令路由、按 frameId 的状态表、状态广播、按需注入
├── content/
│   ├── overlay.js             # 悬浮条逻辑 + 自动隐藏状态机 + 开关响应
│   ├── overlay.css            # 悬浮条样式（自包含，不依赖 shared/）
│   └── scrollEngine.js        # 滚动引擎：容器探测 / 驱动 / 触底 / 循环 / idle
├── popup/                     # 工具栏弹窗（html / css / js）
├── options/                   # 设置页（html / css / js）
├── shared/                    # 设计令牌、组件与全局常量
│   ├── tokens.css             # 设计令牌 + Reset + 极光背景
│   ├── components.css         # 玻璃卡片 / 按钮 / 开关 / 滑块等组件
│   └── constants.js           # 速率 / 区间 / 时长 / 热区尺寸的唯一真源（55 项）
├── assets/icons/              # PNG 图标 16/32/48/128 + SVG 源
├── preview/design-system.html # 设计系统预览页（带浅色/深色切换）
├── temp_tests/                # 开发自测、构建脚本与浏览器夹具（不随扩展分发）
│   ├── engine.test.js         # 引擎逻辑自测（185 项）
│   ├── manifest.test.js       # 清单与实现一致性自测（156 项）
│   ├── contrast.test.js       # 对比度实测（36 项）
│   ├── ui.test.js             # popup/options/overlay 交互自测（168 项）
│   ├── dom.js                 # 迷你 DOM：驱动交互层的 HTML 解析、事件与 chrome 桩
│   ├── run_browser_check.js   # 浏览器验证驱动（六组，CI 下强制）
│   ├── browser_check.html     # 引擎浏览器行为夹具（13 项）
│   ├── overlay_check.html     # 悬浮条自动隐藏浏览器夹具（19 项）
│   ├── long_page.html         # 长页面手工验证夹具
│   ├── build.js               # 发布构建：版本注入 + 压缩 + 自检 + 行为验证
│   ├── ci.js                  # CI 入口：七环节串行校验
│   ├── pack.js                # 原始文件打包（不压缩，验证「能装上」）
│   ├── filelist.js            # 运行时文件清单（pack 与 build 共用）
│   ├── zip.js                 # 最小 ZIP 写入器（deflate，零依赖）
│   ├── lint.js                # 语法检查
│   └── gen_icons.py           # SVG → PNG 图标生成
└── README.md
```

`temp_tests/` 共 16 个文件、约 292 KB，全部不进入商店包——`build.js` 只打包 `filelist.js` 清单里的 19 个运行时文件。清单漏登记时构建会给出提示，杜绝「磁盘上有、包里没有」。

### 关键实现

#### 滚动容器探测

多数 SPA 与阅读类站点把滚动容器放在内部 `div` 上，此时 document 根节点不可滚动。引擎启动时扫描视口内所有元素，筛选条件为：

- 计算样式 `overflow-y` ∈ `auto | scroll | overlay`
- `scrollHeight - clientHeight > 16`（真实存在溢出）
- 与视口有实际相交面积（排除隐藏容器）

取可见面积最大者，无可用内部容器时回落到 document 根。滚动过程中每帧校验容器是否仍连接在文档中（廉价属性），真正的「是否仍可滚动」按 30 帧抽检一次——`getComputedStyle` 与 `scrollHeight` 读取都会强制样式重算与布局，每帧执行是持续开销的主要来源。SPA 路由切换导致容器失联时立即重选。

**影子 DOM 穿透**：现代站点（尤其是组件库驱动的）大量把滚动容器放在 shadow root 内，而 `document.querySelectorAll('body *')` 按规范不跨 shadow 边界。引擎的候选收集因此会迭代下钻开放的 shadow root，深度上限 `SHADOW_SCAN_MAX_DEPTH`（4 层）、数量上限 `SHADOW_SCAN_MAX_ROOTS`（24 个）与总元素上限 `CONTAINER_SCAN_MAX_ELEMENTS`（20000）——无上限时一个页面可能牵出整棵子树，遍历成本会超过它解决的问题。**封闭（closed）shadow root 不可穿透**，这是浏览器安全边界而非缺陷：`shadowRoot` 为 `null`，遍历自然跳过。

**扫描失败退避**：`selectScrollContainer` 恒返回非空（最差回落到 document 根），所以「扫描失败」的真实判据不是返回 `null`，而是**重扫后选出的容器依然不可滚动**——页面尚未渲染完成、全屏视频、纯展示型页面都会走到这里。此时若无退避，抽检每 30 帧就触发一次全量扫描，在几千个元素的页面上是持续的样式重算开销。引擎按连续失败次数指数拉长重扫间隔（`CONTAINER_SCAN_BACKOFF_BASE_MS` 1s 起，封顶 `CONTAINER_SCAN_BACKOFF_MAX_MS` 8s），并在选出真正可滚动的容器后立即清零——迟滞只惩罚「一直失败」这条路径。

#### 滚动稳定性

- **`scroll-behavior` 覆盖**：页面若设置 `scroll-behavior: smooth`，逐帧写 `scrollTop` 会被补间动画拖慢导致速度失真。滚动期间临时以 `!important` 强制为 `auto`，停止时完整还原原始内联值。
- **后台标签页保护**：标签页切后台后 `requestAnimationFrame` 停摆、时间基准冻结。回前台时单帧步进钳制在 50 ms 以内，避免页面被瞬间甩到底；同时监听 `visibilitychange` 主动重置时间基准。
- **无限滚动识别**：触底后观察 `scrollHeight` 是否继续增长，增长则判定为懒加载 / 无限滚动，不执行回顶。**离开底部即作废该判定**——否则一次误判会让回顶循环在该页面此后永久失效。

#### 触底后的 idle 低频探测

触底且本轮不会回顶时，继续跑 `requestAnimationFrame` 只会每帧重复「写无效 `scrollTop` + 读布局 + 被节流挡掉的通知」，在静止页面上是纯粹的持续开销。引擎此时切到 `idle` 阶段：

- 停止 rAF 主循环，改由 1 s 一次的定时器探测
- 探测到内容增长（懒加载追加）→ 恢复主循环
- 探测到用户用滚动条手动回滚 → 自动暂停，把控制权交还用户
- 循环开关在 idle 期间被打开 → 立即唤醒，不等满 1 s

#### 触底自动翻页

翻页的判定挂在 idle 探测上，而不是主循环：此时主循环已停，正好是「页面到底了」的稳定时刻，且 1 s 的低频天然限制了误判频率。

流程是「武装 → 等待 → 点击」三段。找到候选后不立即点击，而是先在悬浮条明示「即将翻到下一章，滚动可取消」，留出 `AUTO_NEXT_CONFIRM_MS`（1.5 s）的撤销窗口。这段时间里用户任何接管手势都会取消本次翻页。

几个刻意的取舍：

- **文案匹配用完全相等，不用包含**。正文里的「下一章预告」一旦被包含匹配命中，扩展就会点掉完全无关的链接。规范化只折叠空白与剥除装饰符号（`»`、`【】` 等）。
- **锚点只存 href 与文案，不存 DOM 节点**。`autoNextArmed` 会进每次 `snapshot()`，挂着整棵子树会让状态上报变成内存泄漏。
- **点击前先 `stopScrolling()`**。导航未必立即发生，页面若撑住几秒继续滚，会把 `scroll-behavior` 补丁带进新页面。
- **失败路径要收口**。站点若不响应点击，冷却 3s + 单页 200 次上限会把「点一次没反应」变成「不再尝试」，而不是无限重复点击同一个链接。

#### 容器失败原因明示

扫描失败在用户侧的表现是「点了没反应」，无从判断是页面没内容、是虚拟列表、还是扩展选错了容器。引擎在连续失败达 3 次后做一次诊断，把原因透出到悬浮条与弹窗。

诊断复用 `selectScrollContainer` 顺带记下的候选元素计数（`state.lastCandidateCount`），**自身不做任何遍历**。这一点是硬要求：退避机制的全部意义就是消除「扫不到东西的页面上反复全量扫描」的开销，如果在诊断环节又把全量遍历请回来，等于前功尽弃。测试对此有专门断言。

判据：文档根无溢出、且 DOM 规模达 400 节点以上 → 疑似虚拟列表（内容被窗口化，滚动条不出现）；否则 → 本页无可滚动内容。容器恢复后原因立即清空，避免解释一直挂在界面上。

#### 到底回顶循环

- 触底后等待 600 ms（`loopGraceMs`）观察内容是否继续增长，以给懒加载留出时间；增长则判定为无限滚动，跳过回顶
- 回顶动画采用 easeOutCubic，时长按距离与速度计算并夹在 350–1600 ms
- 到顶后 `loopCount++`、重置时间基准，继续向下滚动

#### 用户手势接管

引擎持续写 `scrollTop` 会与用户的手动滚动互相拉锯，表现为「滚着滚着被拽回去」。扩展监听 `wheel` / `touchstart` / `touchmove` / 滚动类按键，检测到明确的滚动意图时**不静默夺权**，而是按 `gesturePolicy` 交出控制权：

| 策略 | 实现 |
|------|------|
| `pause` | 直接 `pauseScrolling()` |
| `slowdown` | 置 `speedFactor = 0.5`，静默 `SLOWDOWN_RECOVER_MS`(1800ms) 后恢复 |
| `ignore` | 直接返回 |

两个实现细节：

- **临时降速与用户设定值分离**。`speedFactor` 只在手势期间生效，`state.speed` 不被改写，快照另出 `effectiveSpeed` 字段。否则用户设了 600 却滚出 300 会无从解释。
- **带 `Ctrl` / `Meta` / `Alt` 的组合键归扩展自身快捷键所有**，不参与接管；悬浮条自身的交互同样排除。

#### 区间循环

`stepReturnTop` 的插值逻辑对「回顶」和「回区间起点」是同一套，差别只在目标值：

```
回弹目标 = rangeActive() ? rangeStart : 0
el.scrollTop = returnFrom + (returnTarget - returnFrom) * eased
```

`rangeActive()` 要求两个锚点都设置且间距 ≥ `MIN_RANGE_SPAN`(200px)。状态机新增 `dwelling` 相位：滚到区间下沿 → 停留 `rangeDwellMs` → 回弹到起点 → `loopCount++`。区间生效时整页触底逻辑（含无限滚动判定）整体让位。

两个容易踩的点：

- **锚点捕获必须能独立于滚动启动**。用户的使用路径天然是「先手动滚到某一段，再标记锚点」，此时 `state.container` 仍为 `null`（容器只在 `startScrolling` 时选定）。故 `captureAnchor` 内做惰性兜底选取，否则锚点功能在真实使用路径上恒为失效。
- **停留期不能进 idle**。`enterIdle()` 在区间模式下直接返回——「到区间下沿」不是「到尽头」，误入 idle 会让滚动静默停住。

#### 滚动进度与上报节流

`snapshot()` 中的 `progress` / `remaining` 由 `scrollTop / (scrollHeight - clientHeight)` 得出，是已有读取的组合，不引入新的强制布局。但这两项**每帧都在变**，若无差别地随每次 `publishState` 上报，状态推送会从「控制类偶发」退化为**帧率级别**（约 60 次/秒）打向 background 与所有已打开的扩展页。

故拆成两个入口：

| 入口 | 行为 |
|------|------|
| `publishState()` | 即时，用于启停 / 调速 / 切策略 / 锚点等控制类变更 |
| `publishProgress()` | 按 `PROGRESS_PUBLISH_THROTTLE_MS`(500ms) 节流，用于纯滚动帧 |

`readProgress()` 在容器未选定时会惰性选一次容器：页面加载后立刻打开 popup 是常见路径，不能因为还没开始滚动就把进度显示成 0%。

#### 速度会话持久化

`setSpeed(v, options)` 与 `setLoop` 对齐，支持 `persist` 落盘到 `sessionSpeed` 键。两处防抖不可省：

- **滑块防抖 800ms**：拖动每秒产生数十次变更，逐次直写会撞上 `storage.sync` 每分钟 120 次的写入配额上限，**超限后静默失败且不报错**——用户只会看到「设了没生效」
- **停止时强制冲刷**：拖动后立刻点停止是常见操作，不应因为防抖窗口未到而丢掉这次调整

#### 非 HTML 文档守卫

`matches` 为 `<all_urls>`，除网页外还会命中 SVG、XML 与图片查看器。这类文档没有 `body`，且 `document.createElement('div')` 返回的是**普通 `Element` 而非 `HTMLElement`**——没有 `style` 属性。悬浮条一旦注入就会在设置图标样式时抛 `Cannot read properties of undefined (reading 'setProperty')`。

因此 content 两端在初始化前统一调用 `shared/constants.js` 的 `__SLOWSCROLL_IS_HTML_DOC__(document)`：

- 主判据为 `contentType ∈ { text/html, application/xhtml+xml }`
- `contentType` 缺失时兜底为「能否造出带 `style` 的元素」。**不能用 `documentElement.style` 判定**——`SVGSVGElement` 同样有 `style`，会把 SVG 误判为 HTML（此坑已实测踩过）
- 判定为非 HTML 文档时，引擎与悬浮条各自跳过初始化并在控制台留一行说明

这也是 content 端**不写内联样式**的技术原因：状态样式一律由 class 驱动，规则写在 `content/overlay.css`。

#### iframe 支持

大量文章站、在线文档把正文放在 `iframe` 里。`manifest` 开启 `all_frames: true` 后引擎会在每个 frame 各跑一份，扩展据此处理三件事：

- **小 frame 直接跳过**。广告位与追踪像素所在的 iframe 中初始化引擎，等于白付一次 `storage` 读、五个监听器和一次状态上报。引擎按视口面积判定，低于 `MIN_FRAME_AREA`（40000 px²，即约 200×200）即跳过；顶层文档面积等于整个视口，永远不受影响。
- **悬浮条只挂顶层**。每个 frame 各挂一条会让用户在 iframe 内部看到一堆互相割裂的控制条。判定用 `window.top !== window.self`——跨域 iframe 读取 `window.top` 的**属性**会抛安全错误，但比较引用本身始终安全。
- **控制消息按 `frameId` 定向**。iframe 正文页上顶层引擎存在却滚不动，命令若发给顶层会被「吃掉」，用户表现为点了没反应。background 按 `sender.frameId` 维护 `tabId → frameId → 状态` 的状态表，并选出「活动 frame」：优先正在滚动的那个，其次最近上报的（超过 `FRAME_STATE_TTL_MS` 未更新的非滚动 frame 视为已移除而剔除）。popup 与快捷键都据此定向；顶层悬浮条在本地滚不动时，会把命令经 background 转给活动 frame（`OVERLAY_COMMAND` → `RUN_ENGINE_METHOD`，两端都做方法白名单校验，消息内容不可信）。

状态广播按 `BROADCAST_DEBOUNCE_MS`（50 ms）合并：N 个 frame 同时初始化时逐条广播会放大成 N×N 次跨进程投递，合并后只广播活动 frame 的最终状态。

#### 消息超时

页面正在导航、Service Worker 刚被回收、或标签页正在关闭时，`chrome.tabs.sendMessage` 可能长时间不返回。没有超时的话 popup 会一直停在旧状态，用户表现为「点了没反应」。所有跨进程消息统一走 `withTimeout`：`MESSAGE_TIMEOUT_MS`（300 ms）用于探测与控制消息，`INJECT_TIMEOUT_MS`（2000 ms）用于 `executeScript`——注入要读文件并建隔离世界，本就比普通消息慢。popup 侧同样带超时。

`Promise.race` 只能保证「不等」，不能取消底层调用，迟到的响应会被丢弃——这正是期望行为，那时的状态早已过时。

> background 作为独立进程不在 `content_scripts` 的注入列表里，因此通过动态 `import()` 读取同一份 `shared/constants.js`，而不是复制一份数值。复制即意味着两处会漂移。

#### 悬浮条自动隐藏

自动隐藏由 `content/overlay.js` 内的状态机驱动，显隐只切换根节点的 `.is-hidden` class（content 端禁止内联样式）。相关时长与热区尺寸全部取自 `shared/constants.js`：`OVERLAY_HIDE_DELAY_MS` / `OVERLAY_REHIDE_IDLE_MS` / `OVERLAY_REVEAL_ZONE_SIZE`。

三个关键取舍：

- **热区用坐标判定而非实体元素**。放一个透明的 `div` 覆盖右下角会吞掉宿主页面右下角按钮的点击；监听 `mousemove` 判 `clientX/clientY` 零副作用，也不引入新的绘制层。
- **唤回判定用「进入」跳变而非持续命中**。若持续命中，指针停在热区内会不断重置收起计时，逻辑变得难以推理；跳变判定只在 `false → true` 的那一帧唤回一次。
- **收起前同时检查 `hovered` 与 `pointerInZone`**。只认 `mouseenter` 会出现这样的缺陷：用户在右下角唤回后，鼠标正压着控制条，2.5 秒后它却自行消失——看得见摸得着却点不到。此缺陷已由浏览器层用例 H13b 复现并锁定。

收起态同时设置 `opacity: 0`、`transform`、`visibility: hidden` 与 `pointer-events: none`。`visibility` 不可省：仅用 `opacity: 0` 时元素仍留在可聚焦序列中，键盘 `Tab` 会跳进看不见的控件。

---

## 设计系统

三层架构，`popup` 与 `options` 共用，`content/overlay.css` 为唯一例外（需自包含以注入任意第三方网页）。

| 层 | 文件 | 内容 |
|----|------|------|
| 基础层 | `shared/tokens.css` | 设计令牌 + Reset + `.ss-aurora` 极光背景 |
| 组件层 | `shared/components.css` | `glass-card` / `btn` / `switch` / `slider` / `field-input` / `setting-row` / `badge` / `toast` / `kbd` |
| 页面层 | `popup/`、`options/`、`content/` | 页面专属布局与样式 |

设计规范：

- **禁止内联样式**，所有界面一律复用 `shared/` 两层
- 玻璃拟态：`blur ≥ 16px`、填充 alpha 0.30–0.62、必须搭配 `inset 0 1px 0` 内高光
- 间距基于 4px 网格（4–48px 连续无缺口）；圆角 8 / 10 / 14 / 20 / 28
- 可交互元素五态齐全：`hover` / `active` / `focus-visible` / `disabled`
- 全部界面支持 `prefers-color-scheme` 与 `prefers-reduced-motion`
- 完整预览见 `preview/design-system.html`（打开即见色彩、字体、组件状态、弹窗、悬浮条，可切换浅色/深色）

**对比度口径（重要）**

玻璃是半透明层，文字的**最终**颜色 = 文字色透过「极光背景 + 玻璃填充」叠加后的结果，
比色卡标称值更低。因此所有承载文字的颜色均按**最差叠加背景**反推，而非按色卡挑选。
当前实测（正文 ≥ 4.5:1，非文本 ≥ 3:1）：

| 组合 | 实测 | 说明 |
|------|------|------|
| `--text-strong` on card 玻璃 | 13.77:1 | |
| `--text-body` on card 玻璃 | 7.61:1 | |
| `--text-muted` on section 玻璃 | 5.25:1 | 全局第三级文字色 |
| `--btn--primary` 白字 on 渐变 | 4.99 – 5.70:1 | |
| `.btn.is-active` 白字 | 5.48:1 | |
| 深色 `.btn--glass` hover 文字 | 9.77:1 | |
| 悬浮条 `.unit` / 焦点环 | 4.80 / 3.64:1 | |

> 改动任一文字色或玻璃 alpha 后**必须重跑对比度实测**，否则会打破上表结论。
> 另注意：`--color-warning` 是「警示底色」（需承载白字故偏深），
> 当前景文字用时两主题均不达标，暂停态另立了 `--color-paused` 令牌。

---

## 浏览器兼容性

本项目基于 Chromium 扩展平台开发，**Edge 可直接使用，无需修改任何代码或 manifest**。

| 浏览器 | 支持情况 | 说明 |
|--------|----------|------|
| Chrome | ✅ | 主要开发与测试环境 |
| Edge | ✅ | 同为 Chromium 内核，`chrome.*` 命名空间原生可用 |
| 其他 Chromium 浏览器 | 大概率可用 | Brave、Vivaldi、Opera 等同理 |
| Firefox | ❌ 未适配 | 需改用 `browser.*` 命名空间并处理 manifest 差异（`background.scripts` 等） |
| Safari | ❌ 未适配 | 需通过 Xcode 转换，MV3 支持有限 |

### 为什么 Edge 无需改动

Edge 与 Chrome 同为 Chromium 内核，三项关键点天然一致：

- **API 命名空间**：Edge 原生提供 `chrome.*` 全量 API，无需 `browser.*` polyfill
- **Manifest V3**：MV3 在 Edge 上为唯一标准，Service Worker、`chrome.scripting` 按需注入均正常
- **权限模型**：MV3 的 `permissions` / `host_permissions` 分离模型完全一致，本项目仅申请 `activeTab`、`scripting`、`storage`

本项目未使用任何 Chrome 专属 API（未调用 `chrome.declarativeNetRequest`、`chrome.identity` 等），因此在 Edge 上不存在缺失 API 的风险。

### Edge 使用说明

#### 安装

1. 地址栏打开 `edge://extensions/`
2. 开启左下角「开发人员模式」（Developer mode）
3. 点击「加载解压缩的扩展」（Load unpacked）
4. 选择本项目根目录（含 `manifest.json` 的那一层）

> Edge 对已加载的开发者模式扩展会显示一条常驻提示横幅，**无法永久关闭**，属浏览器设计，非故障。

#### 需要注意的 Edge 差异

| 项目 | Chrome | Edge |
|------|--------|------|
| 扩展管理页 | `chrome://extensions/` | `edge://extensions/` |
| 快捷键自定义 | `chrome://extensions/shortcuts` | `edge://extensions/shortcuts` |
| 受限内部页 | `chrome://` 等 | `edge://`、`extension://` 等，扩展同样无法注入 |
| 无痕窗口 | 默认不运行扩展 | 默认不运行，需在扩展「详细信息」中手动开启「允许 InPrivate」 |
| 从 Chrome 商店安装 | —— | 需先开启「允许来自其他应用商店的扩展」 |

> 本地「加载解压缩」**不需要**开启「允许来自其他应用商店的扩展」，该开关仅在从 Chrome 应用商店安装时生效。

#### Edge 性能机制对滚动的影响

Edge 默认开启**睡眠标签页**与**效率模式**，会在标签页不活跃一段时间后冻结其脚本定时器——这会直接暂停本项目的滚动引擎（`requestAnimationFrame` 停摆）。

项目内已针对该场景做了防护：`maxFrameDt` 将单帧步进钳制在 50 ms 以内，并监听 `visibilitychange` 重置时间基准，因此**从后台切回前台时页面不会被瞬间甩到底部**。

但若希望长时间无人值守地连续滚动，建议在 Edge 中关闭相关设置：

```
edge://settings/system
  → 关闭「自动将标签页置于睡眠状态」
  → 关闭「效率模式」（插电与电池两种均关闭）
```

或在 `edge://flags` 中将 `Enable tab freezing`、`Enable tab discarding` 设为 `Disabled`。也可在扩展「详细信息」中把目标站点加入「始终保持这些网站处于活动状态」白名单。

---

## 开发与测试

```bash
# 全部自测（引擎 + 清单 + 对比度 + 界面交互）
npm test

# 语法检查
npm run lint

# 引擎行为自测：容器探测 / dt 钳制 / visibilitychange / 步进委派
#                 / scroll-behavior 覆写还原 / 死字段清理 / scrollToTop
#                 / idle 低频探测 / 无限滚动判定复位 / 手势接管
#                 / 容器校验节流 / 常量一致性 / 非 HTML 文档守卫
#                 / 滚动进度与上报节流 / 速度会话持久化
#                 / 手势策略三档 / 区间循环与停留
#                 / 影子 DOM 穿透 / 容器扫描失败退避
#                 / 触底自动翻页（白名单锚点策略 + 取消窗口 + 互斥）
#                 / 倒计时到点自动停 / 容器失败原因诊断
npm run test:engine      # 185 项断言

# 清单一致性自测：注入顺序 / 页面引用 / 常量定义 / 存储键名 / MV3 约束
#                 / 非 HTML 文档守卫 / 重复注入幂等 / 悬浮条自动隐藏契约
#                 / 新增配置键名与控件存在性 / 进度节流契约 / 区间循环契约
#                 / 多 frame（iframe）契约 / 消息超时契约
#                 / 自动翻页与倒计时契约（默认关闭 / 白名单 / 危险协议）
npm run test:manifest    # 156 项断言

# 对比度实测：三个界面 × 双主题 × 悬浮条的文字/非文本对比度
npm run test:contrast    # 36 项断言

# 界面交互自测：popup / options / overlay 的点击、拖动、保存
#                 / 状态映射 / 旧键迁移 / 数值钳制 / 常量缺失降级
#                 / 容器失败原因渲染 / 自动翻页开关与白名单 / 倒计时
npm run test:ui         # 168 项断言

# 浏览器真实行为验证（需已安装 playwright，会自动找 Chrome / Edge）
# 分六组：HTML 页 13 项 + 悬浮条自动隐藏 19 项 + 非 HTML 文档（SVG）5 项
#       + 重复注入幂等 3 项 + 区间循环与进度节流 12 项
#       + 影子 DOM 与 iframe 8 项
npm run test:browser        # 60 项断言，缺依赖时跳过并显著标注

# 强制执行浏览器层：缺依赖直接失败。CI 环境自动切到此模式，
# 也可手动指定 SLOWSCROLL_REQUIRE_BROWSER=1
npm run test:browser:strict

# 从 SVG 源重新生成 PNG 图标（16/32/48/128，4x 超采样）
npm run icons

# 原始文件打包（不压缩），用于确认「能装上」
npm run pack

# 发布构建：版本注入 + 压缩 + 产物自检 + 全套行为验证，输出 dist/manjuan-scroll-<版本>.zip
npm run build

# 只做压缩与自检，不产出 zip（改完代码先跑这个）
npm run build:check

# 一条命令跑完全部校验，浏览器层强制执行。发布前必跑。
npm run ci
```

自测分五层，互为补充：

| 命令 | 覆盖 | 断言数 |
|------|------|--------|
| `npm run test:engine` | 容器探测与影子 DOM 穿透、扫描失败退避、dt 钳制、步进委派、scroll-behavior 还原、idle 探测、手势接管、区间循环、触底自动翻页、倒计时到点自动停、容器失败诊断等引擎逻辑 | 185 |
| `npm run test:manifest` | 注入顺序、页面引用、常量定义、存储键名、MV3 约束、重复注入幂等、悬浮条自动隐藏契约、多 frame 与消息超时契约、自动翻页与倒计时契约 | 156 |
| `npm run test:contrast` | 三个界面 × 双主题 × 悬浮条的文字/非文本对比度 | 36 |
| `npm run test:ui` | popup / options / overlay 的按钮点击、滑块节流与松手提交、保存与恢复默认、旧键迁移、数值钳制、失败原因渲染、降级态 | 168 |
| `npm run test:browser` | 真实 Chromium 下的容器探测、节流效果、idle 行为、样式还原、悬浮条显隐时序与热区坐标、区间循环、影子 DOM 与 iframe 行为 | 60 |

合计 **605 项**（Node 层 545 + 浏览器层 60）。`npm run ci` 会把五层各跑一遍，并在构建时**再对着压缩产物跑一遍**，确认压缩没有改变任何一项的行为。

### 构建与发布

`npm run build` 是唯一的发布入口，做五件事：

1. **版本注入**：以 `package.json` 的 `version` 为准写入 `manifest.json`（产物内的副本，源文件不被改写）。版本号格式在注入前校验，1–4 段数字，放行 Chrome Web Store 的限制。
2. **压缩**：去注释、去缩进、折叠安全的行内空白。**不做标识符混淆**——content 脚本跑在第三方页面里，混淆后一旦线上出问题，用户侧只有一行乱码，既无法自证也无法上报堆栈；本项目源码约 250 KB，压缩收益以字节计，不值得用可维护性去换。
3. **静态自检**：JS 语法解析、manifest 与打包清单交叉校验、字符串字面量与 DOM id 与 storage 键名逐字比对、CSS 自定义属性与 `@media` / `@keyframes` / 选择器不丢失、HTML 标签序列与文本内容不丢失。压缩器与校验器**共用同一个 tokenizer**——若校验另写一套正则，两者会一起错向同一个方向，「自检通过」就成了摆设。
4. **行为等价验证**：把压缩产物铺到临时目录，让引擎 / 清单 / 交互 / 浏览器四层测试**对着压缩后的文件**再跑一遍。这是唯一能证明「压缩没有改变行为」的方式：到此为止能证明的只是「仍能解析、字面量没变」，而压缩器完全可能在语法合法的前提下改变求值顺序或作用域。
5. **产出**：内容排序固定、时间戳固定，因此同样的输入产出字节一致的 zip，便于用 sha256 判断产物是否变化。

**基线对比是关键设计**：同一套断言会**先在源码上跑一遍**作为基线，只把「产物上出现、源码上没有」的失败归因于压缩。否则源码自身的缺陷会被算到压缩头上——那会让人去查一个根本不存在的压缩 bug，而真正该修的源码问题反而被淹没。浏览器层同样遵循这套规则。

这套验证并非摆设：它在本项目里先后抓出过压缩器把 CSS 注释吞进选择器匹配导致的假阳性、`invoke('toggleStartStop')` 省略参数后 `...args` 展开 `undefined` 抛错、以及静态检查靠缩进定位函数体在压缩后失效等问题。

### 交互测试的运行环境

`npm run test:ui` 由 `temp_tests/dom.js` 驱动，它是一个约 400 行的迷你 DOM：HTML 解析、`innerHTML` 解析、选择器（tag / `#id` / `.class` / `[attr]` / 后代组合 / 逗号分组）、事件捕获冒泡、`classList` / `style` 自定义属性 / `dataset`，以及行为级的 `chrome.storage.sync` 与 `runtime` 桩。

不用现成 DOM 库是刻意的：项目坚持零运行时依赖、零构建，为了跑测试引入 jsdom 会让这条约束名存实亡。代价是布局与样式计算不在覆盖范围内——显隐过渡、热区坐标这类需要真实渲染的判断仍归浏览器层，两层分工明确。

代价的另一半是**桩不完整会伪装成产品 bug**：`getComputedStyle` / `CustomEvent` / `getBoundingClientRect` 这些在真实页面里是裸全局，只挂到 `window.*` 上时 content 脚本直接 `ReferenceError`，报错信息与「代码写错了」一模一样。补桩时须逐个对照真实页面用到的裸全局。

### 静态检查的边界

清单自测用静态检查捕获「顺序 / 拼写 / 契约」类问题——这类问题在浏览器里表现为静默失效，最适合用静态检查兜住。悬浮条自动隐藏一组即属此列：显隐是否走 class、时长是否取自常量、Esc 是否误用 `preventDefault`、热区是否偷偷插了 DOM，全部静态可判。

两条自限：写断言前**必须先剥离注释**（否则注释里提到 `preventDefault` 会误判）；**不得依赖源码排版**（如靠缩进定位函数体），压缩会重排空白，按排版截取在产物上必然假失败。少量确实依赖排版的断言走 `assertSourceShape`，在产物验证时**显式跳过并标注**，而不是伪装成通过。

### 浏览器层为何不可省略

Node 桩测不出「标准模式下 `documentElement` 的 `overflow` 计算值是 `visible`」这类真实浏览器才有差异的行为。该层曾抓出三件事：

- **一个纯性能 bug**：若按普通元素判定根元素的可滚动性，容器抽检会每次失败并回落到全量扫描 `body *`，实测 60 帧触发 390 次样式重算，修复后为 0 次
- **一个交互缺陷**：收起判定只看 `mouseenter`，导致用户在右下角唤回后，控制条于手底下自行消失（H13b 锁定）
- **一个崩溃点**：SVG 文档中 `createElement` 产出的是没有 `style` 的普通元素，注入即抛 TypeError

影子 DOM 一组还暴露了一个**看似产品缺陷、实为夹具设计问题**的坑：测试页同时放了 shadow 容器和两个 iframe，iframe 撑高视口后 document 根的可见面积超过 shadow 容器，引擎按既有「面积优先」规则合理地选了 body。同理，该组最初报 `chrome is not defined`，看起来像穿透失败，实则是引擎初始化末尾就调 `chrome.storage.sync.get`，桩没注入。教训是——**断言失败时先确认被测页面本身是否制造了歧义，别急着改产品代码**；因此现在每个浏览器组都有「前置就绪」断言，避免基础设施问题伪装成产品缺陷。

### CI

`npm run ci` 顺序执行七个环节，任一失败即中止：语法检查 → 引擎 → 清单 → 对比度 → 界面交互 → 浏览器真实行为（**强制**）→ 构建与产物自检。

浏览器层在 `npm test` 中缺依赖会跳过（本地装 playwright 要下载约 150 MB 浏览器，强制会让只想跑引擎自测的人被迫先装一整套环境），但这绝不意味着「静默绿灯」：

- 检测到 CI 环境（`CI` / `GITHUB_ACTIONS` / `GITLAB_CI` 等任一变量）时**自动切为强制模式**，不给跳过留口子
- 跳过时输出以 `○` 显著标注，并说明本次结果不含浏览器层覆盖
- 强制模式下缺依赖直接退出码 1，并给出可执行的修复命令

**浏览器来源优先用 playwright 自带的 chromium**，其次才是本机 Chrome / Edge（`SLOWSCROLL_USE_SYSTEM_BROWSER=1` 可强制走本机）。这不是偏好问题：CI 上通常没有 Chrome，若只认本机浏览器，装完 `npx playwright install chromium` 仍会被判为「未找到浏览器」而失败——那正是这条技术债的真正根因。自带的 chromium 版本与库严格匹配，也不会因系统浏览器版本差异出现诡异问题。

**playwright 必须装在项目本地，不能装全局。** `run_browser_check.js` 走的是 `require('playwright')`，Node 的模块解析不会去全局 `node_modules` 里找；`npm install -g playwright` 装完，`require` 依然抛「未安装 playwright」，CI 直接失败在第一层。本项目 `package.json` 刻意保持零依赖（不写 `dependencies` / `devDependencies`），故流水线用 `npm i --no-save playwright` 就地安装：装进本仓库 `node_modules`，解析链能命中，同时不污染依赖声明。

流水线配置见 [.github/workflows/ci.yml](.github/workflows/ci.yml)，push 到 `master` / `main`、提交 PR 或手动触发时自动运行 `npm run ci`。

手工验证时可用 `temp_tests/long_page.html` 作为长页面夹具，观察触底提示、回顶动画与循环计数。

---

## 开发约定

这些是踩过坑之后定下的硬约束，改动前请先读：

1. **存储键名三端一致**。`chrome.storage.sync` 的键必须与 content / popup / options 三端拼写一致。历史上曾出现 options 写 `speedStep`、engine 读 `step`，导致「速度步进」设置永久失效。新增配置项前，先确认所有读取端拼写，并确认设置页 HTML 里存在对应控件——只在 JS 里读一个不存在的 id 同样会静默失效。
2. **数值只写在 `shared/constants.js`**。速率、区间、时长、热区尺寸一律先进常量文件，content / popup / options 通过 `globalThis.__SLOWSCROLL_CONSTANTS__` 读取，禁止在各处重复硬编码。引擎在常量缺失时直接抛错中止，popup / options 进入降级态并明示错误——**绝不用第二套数值静默运行**。修改常量时注意 `manifest.json` 的 `content_scripts` 与 background 的注入列表都必须把 `shared/constants.js` 排在最前。
3. **MV3 最多 4 个带 `suggested_key` 的命令**。超出会导致 manifest 加载失败。需要更多命令时不带 `suggested_key`，交由用户在扩展管理页手动绑定。
4. **MV3 图标必须为 PNG**，SVG 不能直接使用。改图标后跑 `temp_tests/gen_icons.py` 重新生成。
5. **单一渲染入口**。popup 的所有 UI 更新都从 `render(state)` 走，禁止在事件回调里散落 DOM 修改。
6. **改引擎必须跑自测**。`npm test`（引擎 185 + 清单 156 + 对比度 36 + 界面交互 168 = 545 项）全绿才算完成；改动涉及真实 DOM 行为时另跑 `npm run test:browser`（HTML 页 13 + 悬浮条 19 + 非 HTML 文档 5 + 重复注入 3 + 区间循环与进度节流 12 + 影子 DOM 与 iframe 8 = 60 项）。改动 content / popup / background 任一文件后，`npm run build:check` 会把压缩产物铺开重跑全部四层，确认「压缩没有改变行为」。发布前跑 `npm run ci`（浏览器层强制）。
7. **新增高频状态字段必须节流上报**。`snapshot()` 里每帧都在变的量（滚动进度）不能无差别地随每次 `publishState` 上报，否则状态推送会退化为帧率级别。控制类变更走 `publishState()` 即时上报，纯滚动帧走 `publishProgress()` 按 `PROGRESS_PUBLISH_THROTTLE_MS` 节流。
8. **写 `chrome.storage.sync` 必须防抖**。配额为每分钟 120 次写入，**超限后静默失败且不报错**。任何来自滑块或连续操作的高频事件都要先防抖聚合，并在关键时机（停止 / 卸载）强制冲刷，避免丢最后一次调整。
9. **所有 `sendMessage` 必须读 `chrome.runtime.lastError`**，否则控制台会抛未检查错误红字。跨进程消息还要**带超时**：页面导航中或 Service Worker 刚被回收时 `chrome.tabs.sendMessage` 可能长时间不返回，没有超时 popup 会一直停在旧状态。统一走 `withTimeout`。
10. **content 端禁止顶层 `const` / `let`**。content 脚本会被反复注入（Service Worker 回收后 `ensureContentInjected` 会再次 `executeScript` 同一组文件）。顶层词法声明在二次注入时抛 `Identifier 'X' has already been declared`，**整个文件不执行**。要用 `var`，或把整文件包进 IIFE。
11. **远程调用必须白名单**。background 与引擎之间会转发方法名，消息内容不可信。`this[message.method](...)` 等于把控制面敞开，两端都要用 `Set` 显式列出允许的方法，且不得用 `eval` / `new Function`。
12. **注释中文、命名英文**，与现有代码风格保持一致。
13. **对比度必须实测，不能目测**。玻璃叠加会让所有颜色实际对比度低于色卡标称值。
    改动文字色、品牌色或玻璃 alpha 后跑 `node temp_tests/contrast.test.js`（36 项），
    通过后再更新 README 的对比度表。目测「看着挺清楚」曾导致 `--text-muted`
    在三种真实背景上全部不达标。
14. **半透明描边用 rgba 硬值，不用 `color-mix`**。低版本 Chromium 会整条丢弃
    `color-mix` 声明，导致降级后样式缺失。
15. **`content/overlay.css` 由 manifest 注入，`overlay.js` 不得无条件补 link**。
    否则关闭悬浮条开关时只能删掉自己插的那份，样式残留，开关形同虚设。
    需要探测时读 `:root` 上的 `--ss-overlay-probe`。
16. **命名统一用 `slowScroll` / `ss-` 前缀**。DOM id 与样式表写 `slowScroll-*`（如 `#slowScroll-overlay`、`#ss-play`），JS 全局对象写 `window.__slowScrollEngine` / `__slowScrollOverlay`，标记属性与自定义事件写小写连字符形式（`data-slowscroll-scroll`、`slowscroll:state`）。新增标识符一律遵循此规则。
17. **日志与异常文案一律带 `[SlowScroll]` 前缀**。content / background / popup / options / shared 五个目录下的 `console.*` 调用与 `throw new Error` 文案都必须以 `[SlowScroll]` 开头，便于在混有第三方网页日志的控制台里筛选。`temp_tests/` 下的 Node 脚本输出到终端而非扩展控制台，不加前缀。
18. **保持 Chromium 通用性**。代码只用 `chrome.*` 命名空间，**不要引入 Chrome 专属 API**（如 `chrome.declarativeNetRequest`、`chrome.identity`），否则会破坏 Edge 等 Chromium 浏览器的兼容性。若某功能必须用 Chrome 专属 API，需同步评估降级路径。
19. **content 两端必须先过非 HTML 文档守卫**。`matches` 是 `<all_urls>`，会命中 SVG / XML / 图片查看器：这些文档没有 `body`，且 `document.createElement` 返回的是**没有 `style` 属性的普通 `Element`**（不是 `HTMLElement`）。判定统一走 `shared/constants.js` 的 `__SLOWSCROLL_IS_HTML_DOC__`，两端共用同一真源，禁止各自硬编码 `contentType`。
    由此推出一条硬约束：**content 脚本不得写内联样式**（`el.style.setProperty(...)`）。历史上正是 `?.style.setProperty` 在 SVG 上抛 `Cannot read properties of undefined`，且与「禁止内联样式」的设计约定冲突。状态样式一律走 class + `overlay.css`。
20. **收起态必须同时设 `visibility: hidden` 与 `pointer-events: none`**。只写 `opacity: 0` 时元素仍留在可聚焦序列中，键盘 `Tab` 会跳进看不见的控件；只写 `pointer-events: none` 时屏幕阅读器仍会朗读已收起的内容。
21. **注入页面的热区一律用坐标判定，禁止插入实体元素**。一个透明的 `div` 会吞掉宿主页面右下角按钮的点击；`mousemove` 判 `clientX/clientY` 零副作用。
22. **新增运行时文件必须同步 `temp_tests/filelist.js`**。打包清单与构建共用这一份；漏登记会导致「磁盘上有、包里没有」，且 `npm run build` 会给出未登记文件的提示。
23. **改压缩器必须同时改自检，且共用同一个 tokenizer**。校验若另写一套正则去数字符串，会与压缩器一起错向同一个方向，「自检通过」就成了摆设。判断函数体是否完整一律用大括号配平（`extractFunction`），不要靠缩进定位——缩进是排版，压缩后必然改变。
24. **测试失败时先确认是「谁的失败」**。`npm run build` 会先在源码上取基线，只把产物独有的失败归因于压缩。断言失败时应先确认被测页面是否制造了歧义，而不是立刻改产品代码。
25. **浏览器验证优先用 playwright 自带的 chromium**。只认本机 Chrome / Edge 会让 CI 即使装了 playwright 也无法运行——CI 上没有 Chrome，那才是这条约束的真正根因。可用 `SLOWSCROLL_USE_SYSTEM_BROWSER=1` 强制走本机浏览器（用于排查浏览器差异）。
26. **CI 环境不做「友好跳过」**。`CI` / `GITHUB_ACTIONS` 等任一变量存在即切强制模式；本地可以跳，但必须以 `○` 标注。**「缺依赖静默跳过」是流水线里最危险的绿灯**，看起来全过，实际有一整层根本没跑。
27. **playwright 必须装项目本地，不能装全局**。`run_browser_check.js` 用 `require('playwright')`，Node 模块解析不搜全局 `node_modules`；`npm install -g playwright` 装完仍然抛「未安装 playwright」，流水线第一层就挂。本项目 `package.json` 守零依赖，故用 `npm i --no-save playwright`。

---

## 已知技术债

- **悬浮条的真实鼠标交互仍靠人工复核**。浏览器层用合成事件模拟 `mouseenter` / `mousemove`，无法复现真实指针轨迹下的 hover 抖动、快速移入移出、以及与宿主页面元素的命中竞争。

---

## 安装与使用

本项目支持 Chrome 与 Edge（及其他 Chromium 内核浏览器），**Edge 无需任何额外配置**，详见[浏览器兼容性](#浏览器兼容性)。

### 开发者模式安装

**Chrome**

1. 打开 `chrome://extensions/`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本项目根目录（含 `manifest.json` 的那一层）

**Edge**

1. 打开 `edge://extensions/`
2. 开启左下角「开发人员模式」
3. 点击「加载解压缩的扩展」
4. 选择本项目根目录（含 `manifest.json` 的那一层）

> 重命名或移动项目目录后，浏览器不会自动跟随新路径，必须删除旧条目后重新加载。

### 使用方法

1. 安装后打开任意网页
2. 页面右下角出现悬浮控制条，点击「播放」开始自动滚动
3. 用 `+` / `−` 调节速度，或点击扩展图标用滑块精确调节
4. 点击弹窗底部「设置」可调整默认速度、步进、循环与悬浮条开关

> **注意**：浏览 `chrome://` 、扩展商店等内置页面时扩展无法注入，属浏览器限制。
> 打开 SVG / XML / 图片等**非 HTML 文档**时扩展也会主动跳过——这类文档没有可滚动正文，
> 强行注入会因缺少 `body` 与元素 `style` 而报错。

---

## 常见问题

**控制台报 `Cannot read properties of undefined (reading 'setProperty')`**
旧版本在 SVG / XML 等非 HTML 文档上注入悬浮条导致崩溃（该文档中 `createElement`
产出的是没有 `style` 的普通元素）。当前版本已加非 HTML 文档守卫，
若仍出现请确认扩展已更新到最新代码并刷新页面。

**悬浮条不显示**
确认设置页未关闭「页面悬浮控制条」；检查扩展是否已启用；尝试刷新页面。

**滚动时悬浮条不见了**
这是预期行为：开始滚动 1.2 秒后控制条会自动淡出，把右下角让给阅读内容。把鼠标移到视口右下角，或按 `Esc` 即可唤回。不想要这个行为可在设置页关闭「滚动时自动隐藏控制条」。

**控制条刚出现又自己消失了**
若鼠标正压在控制条上却仍被收起，属缺陷。当前实现已同时检查「悬停在控制条上」与「指针仍在右下角热区内」两个信号，并有用例 H13b 锁定；若你在别的场景复现，请附上复现步骤。

**滚动没反应**
部分虚拟列表页面会拦截滚动。若页面自身可滚动，扩展会自动识别内部容器。

**滚动速度偏慢**
页面若设置了 `scroll-behavior: smooth` 会影响定位，扩展已在滚动期间自动覆盖并还原该样式。若仍异常，多为页面自身的滚动劫持逻辑。

**快捷键不生效**
确认快捷键未与其他软件冲突。可在 `chrome://extensions/shortcuts`（Edge 为 `edge://extensions/shortcuts`）查看与自定义。

**切回前台后页面瞬间跳到底部（Edge 尤甚）**
Edge 的睡眠标签页与效率模式会冻结后台标签页的脚本定时器。项目内已做 dt 钳制防护，若仍发生长时无人值守的连续滚动场景，请按[浏览器兼容性](#浏览器兼容性)中的说明关闭相关设置。

**Edge 中扩展不生效**
依次检查：① 「开发人员模式」是否已开启；② 扩展卡片开关是否为开启；③ 加载后是否已刷新目标网页；④ 「详细信息 → 网站访问权限」是否允许当前站点。Edge 默认不在 InPrivate 窗口运行扩展，需另行手动开启。

**调速步进不生效**
旧版本设置页与引擎键名不一致（`speedStep` / `step`），现已修复并含旧数据自动迁移。若浏览器仍缓存旧存储，卸载重装扩展即可。

**循环不回顶**
若页面为无限滚动（触底后内容持续增长），扩展会判定为懒加载并主动跳过回顶，属预期行为。

**正文在 iframe 里，悬浮条点了没反应**
先把鼠标移到正文所在页面并让 iframe 内元素获得焦点（`all_frames` 模式下引擎在每个 frame 各跑一份，
控制消息会自动路由到活动 frame）。若仍无反应，多为 iframe 本身被跨域限制无法读取内容——
扩展能驱动跨域 iframe，但需目标文档确实可滚动。

**设置改了不起作用**
`chrome.storage.sync` 有每分钟 120 次的写入配额，**超限后静默失败且不报错**。
极端情况下（如用脚本连续改存储）可能触发配额，此时重开设置页或卸载重装即可恢复。

**为什么调过的速度切页面后又变回默认**
调速记在会话键 `sessionSpeed` 上，与设置页的全局默认 `defaultSpeed` 分开——
拖滑块属临时微调，不该把全局偏好改掉。若想让某速度成为所有页面的默认，去设置页改「默认速度」。

**控制条下方出现「已到达底部」提示但没有回顶**
触底后引擎会先观察 600 ms 看内容是否继续增长（给懒加载留时间）。确认是无限滚动页面时会跳过回顶。
若确属普通页面却误判，离开页面底部再回来即可让判定作废。

---

## 版本历史

### v1.5.1

以下内容自 v1.1.0 之后累积开发

**新功能**

- **iframe 正文页支持**：manifest `all_frames` 改为 `true`，正文位于 iframe 内的文章站 / 在线文档同样可驱动。配套三项防护，否则会变成「iframe 正文页滚不动 / 悬浮条一堆 / 弹窗显示错乱」：微小 frame（视口面积 < 40000px²，典型是广告位与追踪像素）跳过初始化；悬浮条只挂顶层（`window.top !== window.self` 守卫，必须早于任何 DOM 操作，跨域下比较引用始终安全）；控制消息按 `frameId` 定向，状态表改为 `tabId → frameId → 状态`
- **影子 DOM 穿透**：容器候选收集迭代下钻开放 shadow root（`querySelectorAll('body *')` 按规范不跨 shadow 边界）。首轮用 `body *`，进入 shadow root 后用 `*`（shadow tree 没有 body/head 之分）。深度 4 / root 数 24 / 总元素 20000 三重上限；closed root 的 `shadowRoot` 为 null，自然跳过
- **触底自动翻页（下一章 / 下一页）**：判定为普通页面（非无限滚动）且触底后，按白名单锚点策略查找后续链接并点击。**默认关闭**——自动点击第三方页面的元素是不可逆操作，扩展无权替用户决定「读完这一章该去哪」。设五道闸门：站点白名单（后缀匹配带点边界）、锚点白名单（`rel="next"` 语义标记，或规范化后**完全相等**的文案，包含匹配会点中「下一章预告」这类无关链接）、危险链接拒绝（`javascript:` / 纯锚点 / 零尺寸隐藏元素）、武装→等待→点击三段式（1.5s 取消窗口，任何接管手势即撤销，把不可逆跳转变成可反悔的一步）、失败路径收口（3s 冷却 + 单页 200 次上限，防死链）。与回顶循环互斥
- **倒计时到点自动停**：设定分钟数后到点自动停止并还原页面，适合「睡前读 20 分钟」。纯 `setTimeout` + 绝对到期时刻，与区间停留计时器同构，无新增状态机
- **容器失败原因明示**：连续扫描失败达 3 次后诊断原因，把「点了没反应」变成「本页无可滚动内容 / 页面疑似虚拟列表」。诊断复用上次扫描的候选计数，自身不做遍历——否则等于把退避机制消除的开销又请回来
- **设置页新增「自动化」分区**（自动翻页开关 + 站点白名单 + 倒计时分钟数），弹窗新增对应折叠区与实时剩余时间；白名单区仅在开关打开时显形

**工程基建**

- 新增发布构建 `npm run build`：版本注入 + 压缩 + 产物静态自检 + 四层行为等价验证，产出可复现的 zip（条目排序固定、时间戳固定）。**不做标识符混淆**——content 脚本跑在第三方页面里，混淆后一旦线上出问题，用户侧只有一行乱码，既无法自证也无法上报堆栈
- 新增界面交互自测 `npm run test:ui`（168 项）与配套的迷你 DOM `temp_tests/dom.js`（约 400 行，零依赖），覆盖 popup / options / overlay 的点击、拖动、保存、旧键迁移、数值钳制、失败原因渲染与降级态。**刻意不用 jsdom**——项目坚持零依赖
- 浏览器验证新增强制模式：CI 环境自动生效，缺依赖时退出码 1 并给出可执行修复命令，不再静默跳过
- 新增 `npm run ci` 一键全量校验（7 个环节串行）与 `temp_tests/lint.js`、`filelist.js`、`zip.js` 三个共享模块
- 打包清单与 ZIP 写入器抽为共享模块，`pack.js` 与 `build.js` 不再各写一份

**正确性修复**

- 修复在非 HTML 文档（SVG / XML / 图片查看器）上注入即崩溃：`matches` 为 `<all_urls>` 会命中此类文档，其 `document.createElement` 产出的是没有 `style` 属性的普通 `Element`，悬浮条在设置图标样式时抛 `Cannot read properties of undefined (reading 'setProperty')`。新增 `__SLOWSCROLL_IS_HTML_DOC__` 判定函数，content 两端共用同一真源
- 消除 content 端的内联样式：播放 / 停止图标的显隐改由 `overlay.css` 的 `.running` class 规则驱动，既根除崩溃点，也与「禁止内联样式」的设计约定对齐
- 修复触底后 rAF 永久空转：新增 `idle` 阶段，改用 1 s 低频探测，静止页面上不再 60fps 强制重排、不再周期性唤醒 Service Worker
- 修复 `suspectedInfinite` 永不复位：离开底部即作废无限滚动判定，此前一次误判会让回顶循环在该页面此后永久失效
- 修复 popup 状态不实时：background 广播 `STATE_BROADCAST`，弹窗打开期间用快捷键或悬浮条操作可实时看到
- 修复 `STATE_CACHE` 跨页残留：除 `status === 'loading'` 外，同时监听 `changeInfo.url`，覆盖 SPA `pushState` 路由切换
- 修复引擎 `TOGGLE_LOOP` 分支的死变量 `enabled`
- 修复区间锚点捕获在真实使用路径下恒为失效：`state.container` 只在 `startScrolling` 时选定，而用户路径恰恰是「先手动滚到某段再标记」，此刻容器为 null。`captureAnchor` / `readProgress` 补了惰性选容器的兜底
- 修复 popup 操作竞态：改「乐观更新 + 以广播为准」，去掉每次操作后的状态往返；广播带单调递增 `seq` + `tabId`，popup 丢弃过期更新。顺带修掉「暂停中点主按钮后界面卡在『已暂停』而引擎其实已停」
- 修复消息无超时：页面导航中或 Service Worker 刚被回收时 `chrome.tabs.sendMessage` 可能长时间不返回，没有超时 popup 会一直转圈。统一走 `withTimeout`

**性能与体验**

- 新增悬浮条自动隐藏：开始滚动后延迟 1.2 s 淡出，把右下角完整让给阅读内容；鼠标移入右下角 96×96 热区或按 `Esc` 唤回，唤回后指针在场不二次收起，停止滚动不主动弹回。底部状态提示条始终可见
- 新增设置项「滚动时自动隐藏控制条」（`autoHideOverlay`，默认开启），关闭后行为与旧版一致，改动即时生效
- 容器扫描失败指数退避：`selectScrollContainer` 恒返回非空（最差回落 document 根），所以「扫描失败」的真实判据不是返回 `null`，而是**重扫后选出的容器依然不可滚动**。间隔 1s 起按失败次数翻倍、封顶 8s，选出可滚动容器即清零
- 容器有效性校验节流：每帧只做廉价的 `isConnected` 判断，真正的 `getComputedStyle` 按 30 帧抽检
- 修复文档根元素的可滚动性判定：标准模式下 `documentElement` 的 `overflow` 计算值是 `visible`，若按普通元素判定，容器抽检每次都失败并回落到全量扫描 `body *`——浏览器实测 60 帧触发 390 次样式重算，修复后为 0 次
- 新增用户手势接管：`wheel` / `touchstart` / `touchmove` / 滚动类按键触发自动暂停，组合键与悬浮条自身交互除外
- idle 期间支持识别滚动条手动回滚并自动暂停
- 界面信息层级重排：popup 把「状态文字」与「滚动进度」合成一块主视图（打开弹窗的第一诉求是「现在滚到哪了」，拆开要扫两眼才能拼出全貌），低频功能收进折叠区；options 速度项独立成卡片、保存栏吸底。实测 popup 内容高度 586px，在 Chrome 600px 上限内

**工程化**

- 新增 `shared/constants.js` 作为速率、区间、时长的唯一真源（现 55 项）；引擎缺常量直接抛错中止，popup / options 进入降级态明示错误，**绝不用第二套数值静默运行**
- manifest `content_scripts` 与 background 注入列表均把 `shared/constants.js` 排在最前
- 新增 `temp_tests/manifest.test.js` 清单一致性自测（156 项），静态捕获注入顺序、键名拼写、MV3 约束、悬浮条显隐契约、新增配置键名与控件存在性、进度节流契约、区间循环契约、多 frame 与消息超时契约类问题
- 新增浏览器真实行为验证层（`browser_check.html` / `overlay_check.html` + `run_browser_check.js`，60 项分六组），用真实 Chromium 补上 Node 桩测不出的差异
- 浏览器层先后抓出四个真实缺陷：收起判定只看 `mouseenter` 导致控制条在手底下自行消失（H13b 锁定）；区间循环时序与进度节流（Node 桩的 `Date.now()` 是可控时钟，与真实计时器不等价）；锚点捕获依赖滚动已启动；重复注入时顶层 `const` 抛 `already been declared` 导致整文件不执行（只有插真实 `<script>` 节点才复现，`page.evaluate` 每次独立作用域，会得出「没问题」的错误结论）
- 新增滚动进度（`progress` / `remaining`）：读数由 `scrollTop / (scrollHeight - clientHeight)` 得出，不引入新的强制布局；上报按 500ms 节流，控制类变更仍即时
- 新增速度会话持久化：调速落到 `sessionSpeed` 键，与设置页 `defaultSpeed` 分离（拖滑块属临时微调，不应改写全局默认），落盘防抖 800ms、停止时冲刷
- 新增手势接管策略三档（`pause` / `slowdown` / `ignore`）：临时降速用 `speedFactor` 与用户设定值分离，快照另出 `effectiveSpeed`，避免「设了 600 却滚出 300」的困惑
- 新增区间循环：`stepReturnTop` 复用同一套插值、仅换目标值，新增 `dwelling` 停留相位
- 新增 `temp_tests/pack.js` 打包脚本（手写最小 ZIP 结构，不依赖系统 zip / tar，规避 Windows 盘符转义问题）与 `package.json`、`.gitignore`，初始化 git 仓库
- 自测从 22 项扩充到 **605 项**（引擎 185 + 清单 156 + 对比度 36 + 界面交互 168 = 545，另有浏览器层 60）
- 浏览器验证的浏览器来源改为**优先用 playwright 自带的 chromium**，其次才是本机 Chrome / Edge。这不是偏好问题：CI 上通常没有 Chrome，若只认本机浏览器，装完 `npx playwright install chromium` 仍会被判为「未找到浏览器」而失败
- README 全面重写：新增目录锚点、架构流程图、技术栈概览表、关键约束表、设计系统说明、浏览器兼容性（含 Edge 睡眠标签页对滚动的影响）、开发约定 26 条与已知技术债，修正文件树、数值与编号

### v1.1.0

**配置层**

- 修复速度步进设置失效（`speedStep` / `step` 键名不一致），含旧数据自动迁移
- 快捷键调速改为遵循设置页步进，不再固定 ±50

**引擎层**

- 实现滚动容器探测，SPA 与内部滚动容器场景可用
- 滚动期间自动覆盖并还原 `scroll-behavior`，修复速度失真
- 后台标签页防瞬移（dt 钳制 + `visibilitychange`），4000 px/s 下回前台位移从 120000 px 降为 200 px
- `scrollToTop()` 统一走容器 `scrollTo`，消除语义冲突

**消息链路**

- content 注入改为按需探测，避免高频操作触发重复注入
- 状态缓存随标签页关闭 / 导航自动清理
- 补齐 `lastError` 处理，消除控制台未检查错误

**UI 与打包**

- 「页面悬浮控制条」开关接入实际逻辑，支持运行时生效
- popup 单一 `render(state)` 渲染入口 + 滑块节流提交
- 悬浮条图标切换改为显式 class，不再依赖 DOM 顺序
- 补齐 manifest 图标（16/32/48/128 PNG）

**清理**

- 移除只写不读的状态字段
- README 全面重写

### v1.0.0

- 基础自动滚动功能、悬浮控制面板、速度调节

---

## 许可证

本项目采用 MIT 许可证，详见 [LICENSE](LICENSE)。