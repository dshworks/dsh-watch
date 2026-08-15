<table>
<tr>
<td width="40%" valign="top">

# dsh-watch

[English](README.md) | 中文

### 给数据流挂一个监听。它说话，agent 就醒 —— 哪怕正在空闲，哪怕现场没有人。

自带的 jobs 子系统只说任务**结束**了。`dsh-watch` 说有东西**开口**了：
给长跑命令或持续增长的文件挂一个监听器，新出现的行经过滤、合批、字节封顶后，
作为会话内通知送达。

然后把人撤掉。把监听写进 profile 配置、挂上 daemon，agent 就会开机自启、
空闲时零成本静默、连续数周被数据流唤醒。

[![ci](https://github.com/dshworks/dsh-watch/actions/workflows/ci.yml/badge.svg)](https://github.com/dshworks/dsh-watch/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@dshworks/dsh-watch?color=4D6BFE)](https://www.npmjs.com/package/@dshworks/dsh-watch)
[![powered by dsh](https://img.shields.io/badge/powered__by-dsh-4D6BFE?logo=deepseek)](https://github.com/deepseek-ai/deepseek-harness)
[![license: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

</td>
<td width="60%" valign="top">

<img src="https://raw.githubusercontent.com/dshworks/dsh-watch/main/docs/watch-dark.png" alt="终端里运行 dsh --profile watcher：daemon 启动、报告 Standing by、随后静默空闲不花一分钱，接着一次听到 53 个新发布的仓库，并记下留用的 11 个及各自归属的 dshworks 仓库" width="100%">

</td>
</tr>
</table>

## 安装

```sh
dsh plugin --profile web add @dshworks/dsh-watch
dsh --profile web
```

`dsh plugin` 会转发给 pnpm，所以 PATH 里要有 pnpm。除此之外不需要配置 ——
下一个会话里 `watch` 工具就可用了。

## 工具本体

```text
watch(source: "command", command: "npm run dev", pattern: "error|warn|Ready", label: "dev")
→ Watch armed (watch-1) on command: npm run dev.

# …agent 继续干自己的活。当 dev server 打出 "Ready in 130ms"，
# 一条通知把它唤醒：
[watch dev · watch-1] 1 line:
Ready in 130ms
```

也可以盯文件：

```text
watch(source: "file", path: "/var/log/app.log", pattern: "ERROR|FATAL")
```

每个监听都是**一等公民后台任务**（kind 为 `watch`），因此标准接口原样适用：
`job_list` 列出已布防的监听，`job_output` 取出某个监听积压的行，`job_kill` 撤防，
归属按会话隔离，结束时走普通的完成通知。这个插件只增加"听"这件事 ——
没有第二套生命周期，也没有第二个注册表。

| 行为 | 细节 |
|---|---|
| 数据源 | `command`（经 shell 能力启动一次，继承会话的沙箱策略与环境变量）· `file`（从当前末尾开始跟踪；已有内容一律不投递；被截断则从头重来；文件还不存在也可以先等着） |
| 合批 | 一个 tick 内听到的所有行共用一条通知 —— 爆发式输出只花一次唤醒，而不是每行一次 |
| 过滤 | 可选的 JavaScript 正则，只投递命中的行。**失败特征也要写进去 —— 没声音不等于没问题** |
| 唤醒预算 | 每个 owner 一个令牌桶：先允许 `maxConsecutiveWakes` 次连发，之后每 `wakeRefillMs` 回一个额度。用户消息被领取时直接加满 |
| 事件预算 | 每个监听在 `max_events` 条通知后自行撤防并以 `completed` 结束；填 `0` 表示一直听下去 |
| 字节上限 | 每条完整通知按 UTF-8 安全截断（含包装文本）；`job_output` 保留有上限的积压，丢行时带明确的裁剪标记 |
| 截断诚实 | 上游输出丢失（`lossy` 读）会作为标记行暴露出来，绝不吞掉 |
| 生命周期 | 进程退出时先冲刷尾部再结算：`completed`（退出码 0）、`failed`（非零 —— 监听死了是一个发现，不是一段沉默）、`killed`（信号或撤防）。插件卸载会拆掉所有监听 |
| 上限 | 每个 owner 的布防数量上限，超了就让这次调用**明确失败** |

## 无人值守运行

一个连续盯一个月生态的 agent，不是一场对话。有两件事必须改，而两件都已在包里。

**它不能变聋。** 唤醒预算的存在，是为了不让一个失控的数据源把空闲 agent 无限循环唤醒。
"数连续唤醒次数、等下一条人类消息回血"这条规则，对有人坐在旁边的会话是对的 ——
对没人的会话就是一扇单向门：额度用完之后，每条通知都被注入到一个再也不会被唤醒的
空闲 agent 里。所以预算改成了令牌桶：额度随时间回来（`wakeRefillMs`，默认 60 秒），
而在桶空时到达的通知，会在额度回来的那一刻拿到一次补课唤醒。想要严格的
`dsh-tool-jobs` 语义，把 `wakeRefillMs` 设为 `0`。

**得有人去布防，也得有人让进程活着。** `dsh --profile headless` 跑完一个任务到静默
就退出；`dsh --profile web` 常驻，但要等浏览器里的人。于是 `autoArm` 把监听声明进
profile 配置 —— 在 `agent/session-start` 时为根会话布防，并且走工具注册表，
因此它要过的守卫、审批策略、沙箱和 shell 环境，跟模型自己发起的调用完全一致 ——
而 `@dshworks/dsh-watch/daemon` 是一个约 90 行的宿主：创建一个 agent、注入一份常驻
简报、把进程撑住，并把每个活动区间的收尾文本按 ISO 时间戳写到 stdout 作为运维日志。

```yaml
# ~/.dsh/profiles/watcher/cordis.patch.yml
- id: dsh-watch
  config:
    wakeRefillMs: 300000
    autoArm:
      - source: command
        command: node recipes/ecosystem-watcher/feed.mjs --topic dsh-plugin
        pattern: '"kind":"new-repo"'
        label: ecosystem
        max_events: 0          # 会自己撤防的监听，算不上监听

- insert:
    - id: dsh-watch-daemon
      name: '@dshworks/dsh-watch/daemon'
      config:
        brief: >-
          You are the ecosystem watcher. A standing watch named "ecosystem"
          is armed on a feed of newly published repositories. For each one,
          decide whether there is an idea worth keeping, and append it to
          data/ideas.ndjson.
```

```sh
dsh plugin --profile watcher add @dshworks/dsh-watch
dsh --profile watcher | tee -a watcher.log
```

[`recipes/ecosystem-watcher/`](recipes/ecosystem-watcher/) 里是完整的一套，
包含一个按创建时间轮询 GitHub topic、对每个没见过的仓库输出一行 NDJSON 的 feed。

### 实测

2026-08-15 的一次真实运行，DeepSeek-V4-Pro，会话里没有人。feed 找到 53 个新发布的
dsh 仓库；watcher 被唤醒、读完、留下 11 个，并说明了另外 42 个为什么被放掉：

```text
2026-08-15T16:21:23Z up — session 36041f74
2026-08-15T16:25:11Z Batch of 53 repos processed. Appended 11 ideas to data/ideas.ndjson
```

```json
{"repo":"liustack/modlens","why":"Pasting an image and receiving structured JSON evidence
 (OCR, layout, semantics) gives text-only DSH models vision without a vision model.",
 "for":"awesome-dsh-plugins"}
```

这次运行还顺带换来一个 bug 修复：注入给**忙碌** owner 的通知会在它的下一步被领取，
所以把它们算作"欠一次补课唤醒"，就会多出一次唤醒，而那次唤醒的全部内容是
"你有排队的通知" —— 说的却是已经回答过的通知。改成在 `agent/inbox/claimed` 时清零，
并补了一个回归测试守住。

## 配置

每一项边界都是经过校验的 `Config` 字段，不是写死的常量。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `pollIntervalMs` | `300` | 轮询节奏，同时也是合批窗口 |
| `maxNoticeBytes` | `4096` | 单条完整通知（含头部）的 UTF-8 字节上限 |
| `maxConsecutiveWakes` | `3` | 每个 owner 的唤醒额度桶容量 |
| `wakeRefillMs` | `60000` | 回一个额度所需的毫秒数；`0` 表示不按时间回血 |
| `defaultMaxEvents` | `50` | 每个监听的通知预算；`0` 表示不限 |
| `maxListenersPerOwner` | `8` | 每个 agent 的布防数量上限 |
| `backlogBytes` | `65536` | 单个监听 `job_output` 积压的保留字节预算 |
| `autoArm` | `[]` | 启动时为根会话布防的常驻监听 |

daemon 自己的配置是 `brief`（必填）、`flushIntervalMs`（`300000`）和 `journal`（`true`）。

## Model Experience

### 系统提示词

一段（order 107，排在后台任务指引之后）：

```markdown
You can arm a watch on a stream with the watch tool: it listens in the background and wakes you when new matching lines arrive, so never busy-poll a source you already listen to. Listeners are background jobs — job_list shows them, job_output reads a listener's heard-line backlog, job_kill disarms one.
```

配置了 `autoArm` 时，会追加第二段（order 108）列出常驻监听的名字，
免得模型把已经有的东西再布防一遍。

### 工具

只有一个工具 `watch`（source、command/path、workdir、pattern、max_events、label）。
撤防、列表、读取都复用自带的 `job_kill` / `job_list` / `job_output`。

### Token 影响

安静的数据源不花 token —— 轮询发生在宿主侧。每条通知是一条有字节上限的消息
（≤ `maxNoticeBytes`）；空闲唤醒还要额外付它开启的那次模型请求，
这正是唤醒需要预算的原因。

## 依赖要求

- jobs 子系统：`@deepseek-ai/dsh-jobs`、`dsh-jobs-local`、`dsh-tool-jobs` ——
  都在 `dsh-base` 里，因此 web 与 headless 标准 profile 都自带。
  没有挂上 job 控制器时，布防会**明确失败**。
- `source: command` 还需要 shell 能力（`@deepseek-ai/dsh-shell` 加一个 provider）。
  文件源不需要。
- daemon 另外需要 `agents`、`sessions`、`agentDefaultModel` —— 同样在 `dsh-base`。

## 开发

```sh
pnpm install && pnpm test    # 83 个测试
```

`lib/` 里是纯 ESM JavaScript —— 安装时不构建任何东西，所以用 git 装不会碰到
`allowBuilds`。（**开发**安装会：vitest 会拉 esbuild，在 `pnpm-workspace.yaml` 里放行
—— pnpm ≥ 11 从那里读构建设置，`package.json` 里的 `pnpm` 字段会被静默忽略。）

除了测试套件，完整生命周期都在 `0.1.0-rc.6` + DeepSeek-V4-Pro 的真实会话里验证过：
布防 → 不匹配的行保持沉默 → 空闲时命中即唤醒 → 用自带 `job_kill` 撤防 →
撤防后彻底安静（2026-08-14）；以及启动 → 常驻简报 → 空闲 → 被无人值守的 feed
唤醒两次，从写入到回复约 1.6 秒（2026-08-15）。

## 与邻居的关系

- **自带的 `dsh-tool-jobs`** 在任务**完成**时通知；dsh-watch 在**运行期间有输出**时通知。
  同一套唤醒机制，互补的两个时刻。
- **[yoke233/dsh-tool-monitor](https://github.com/yoke233/dsh-tool-monitor)**
  通过分流输出来订阅**已经在跑**的 bash/pwsh 任务。想盯一个你已经启动的任务用它；
  想布一个带合批和预算的专门监听（或盯文件）用 dsh-watch。
- **[AbnerAI/dsh-monitor](https://github.com/AbnerAI/dsh-monitor)**
  反复重跑一个命令、或轮询 NDJSON 收件箱，逐行唤醒 agent。dsh-watch 的不同在于：
  命令只启动一次并按流处理、按 tick 合批、给唤醒和事件都上预算、每条通知都有字节上限、
  活在 jobs 子系统内部，以及自带一个无人值守宿主。

## 已知限制与未做的事

- 是轮询，不是 `inotify`/`kqueue`：低于 `pollIntervalMs` 的延迟不在范围内，
  tick 本身就是设计中的合批窗口。
- 每个监听只有一个正则；多种特征用或来覆盖（`error|Traceback|FAILED`）。
- 命令源的 `stderr` 混在 shell provider 的标记段落里，不是一条单独可过滤的通道。
- 重启后不会自动恢复：监听与它的会话同生共死。重启后的 daemon 会开一个新会话并按
  `autoArm` 重新布防，而不是接着上一个会话。
- 补课扫描挂在监听的 tick 上，所以一个 owner 如果所有监听都被撤防了，
  排队的通知会一直留到有别的东西唤醒它为止。

## 许可

MIT。与 DeepSeek 无隶属关系。已登记在
[awesome-dsh-plugins](https://github.com/dshworks/awesome-dsh-plugins)。
