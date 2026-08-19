# board — 多模型交叉评审「开会」机制 设计文档

> 英文版 `DESIGN.md` 是准据版本，本译本可能滞后。

状态：已实施。本文档记录的是实现背后的取舍与踩过的坑。

## 1. 要解决什么

复杂编码任务写完后，单靠一个模型自审容易漏。把改动同时交给**不同厂商**的一线模型互相挑刺，
反复几轮直到都没有阻塞意见，把返工概率压下去。

灵感来自公众号《一个篱笆三个桩 一个AI五个帮》(刘小排)。原文只给了想法，没有任何实现——
配置、命令、收敛规则全部是本文档从零设计的。

### 目标

- 手动触发一次「会议」，把当前未提交改动交给 codex 和 grok 评审
- 多轮辩论：评审员看得到上一轮的争议和我的回应
- 收敛判定明确：全票 approve 才散会；3 轮谈不拢升级给用户拍板
- 跨机器可移植：独立仓库，clone 后软链进 skills 目录即可

### 非目标（明确不做）

- **不做自动触发**。用户明确选择手动。加自动触发的路已铺好（见 §11），但这版不做。
- **不让评审员改代码**。它们只读，改动一律由主会话执行。
- **不追求评审员数量**。当前 2 个（codex + grok）。两家不同厂商就够产生分歧信号了。

## 2. 触发方式

用户在主会话敲 `/board`。没有任何自动触发，不挂 hook。

## 3. 架构

```
用户 /board
   ↓
SKILL.md（主持人协议，Claude 读并执行）
   ↓ 只写两个仓库外临时文件：intent（改动意图）、contested（上轮争议及处理）
   ↓
scripts/board-round.mjs（会议秘书）
   ↓ ① ensureIgnored —— 先于任何写入
   ↓ ② buildBrief —— git diff + 未跟踪文件完整内容 + intent + contested
   ├─ 并发 spawn ─→ codex exec  (只读沙箱, --output-schema)
   └─ 并发 spawn ─→ grok        (只读沙箱, --prompt-file, --json-schema)
   ↓ 收两份裁决 JSON + 两份完整原文
   ↓ 计票，打一张汇总表到 stdout
   ↓
Claude 读汇总表 → 改代码 / 带理由拒绝 → 下一轮 或 散会
```

**分工原则**：脚本干"把人叫齐、收纪要、数票"这种确定性脏活；判断"哪条意见有理"始终在
Claude 手里，脚本无权替用户决定改不改。

**主持人不碰仓库。** brief 生成、git 忽略全部由脚本执行，主持人只提供 intent 和
contested 两份仓库外的文本。理由见 §13 —— 凡是"靠 agent 记得做"的步骤最终都会漏，
2026-08-17 连续踩了三次。

## 4. 评审员

`config/reviewers.json`，加人只改这个文件，不动流程代码。

| id | 命令 | 只读保障 | 结构化输出 | prompt 传递 |
|---|---|---|---|---|
| `codex` | `codex exec -m gpt-5.6-sol --ephemeral -s read-only -C <repo> -c model_reasoning_effort=xhigh --output-schema <schema> -o <out.json>` | 硬沙箱 `-s read-only` | `--output-schema` 硬约束 | stdin |
| `grok` | `grok --prompt-file <f> --cwd <repo> --sandbox read-only -m grok-4.6 --reasoning-effort xhigh --output-format json --json-schema <inline>` | 硬沙箱 `--sandbox read-only` | `--json-schema` 硬约束 | `--prompt-file` |

`grok` 的 `-p/--single` 与 `--prompt-file` **互斥**，同时给会报
`a value is required for '--single' but none was supplied`。用文件就不能带 `-p`。

codex 默认带 `--ephemeral`，会话不写进 `~/.codex/sessions/`——一轮评审否则会留下约 1 MB
的 rollout 文件，而且 `codex exec resume --last` 会指向评审会话而不是你自己上一次的工作
会话。**如果你用工具统计 codex 用量**（这类工具都是靠扫那些 rollout 文件算的），就要去掉
这个参数，否则 ephemeral 会话在它们眼里完全不存在，这部分消耗永远不会被记进去。

两家都会自动读取仓库里的 `CLAUDE.md` / `AGENTS.md` 作为项目上下文（实测确认会加载），
评审员因此免费拿到项目规约，不用在 prompt 里重复。

### 两家输出形状（2026-08-17 真实调用实测，非文档推断）

**形状不同，解析必须分开写：**

- **codex**：`-o <file>` 写出的是**裸的 schema 对象**，没有信封。
  ```json
  {"verdict":"approve","blocking":[],"non_blocking":[],"one_line_summary":"probe ok"}
  ```
- **grok**：stdout 是**信封**，裁决在 `.structuredOutput`，另有 `.text`（同一份 JSON 的字符串形式）
  和 `.total_cost_usd`（本次调用花费，可直接在汇总表里报成本）。
  ```json
  {"text":"{...}", "stopReason":"end_turn", "total_cost_usd":0.0133,
   "structuredOutput":{"verdict":"approve","blocking":[],...}}
  ```

### schema 必须写成 OpenAI strict 格式

codex 的 `--output-schema` 走 OpenAI strict 校验，宽松 schema 直接 HTTP 400：

> `Invalid schema for response_format 'codex_output_schema': In context=(), 'additionalProperties' is required to be supplied and to be false.`

因此 `verdict.schema.json` 必须满足：

1. **每一层对象**都显式写 `additionalProperties: false`
2. 每层的 `required` 列出**该层全部属性**（strict 模式不允许缺省可选字段）
3. 可选字段用可空联合类型表达，如 `"line": {"type": ["integer","null"]}`

grok 实测也接受这份严格 schema（含 `["integer","null"]` 联合类型），所以**两家共用一份**。

## 5. 裁决协议

权威定义在 `config/verdict.schema.json`（strict 格式，见上节）。字段语义：

| 字段 | 含义 |
|---|---|
| `verdict` | `approve` / `request_changes` |
| `blocking[]` | `file` `line` `issue` `why_it_matters` `suggested_fix` |
| `non_blocking[]` | `file` `issue` |
| `one_line_summary` | 一句话结论 |

> 这里只列语义，不复制 JSON——文档里再抄一份 schema 只会制造第二处需要维护的
> 真相源，且必然漂移。以 `config/verdict.schema.json` 为准。

**只有 `blocking` 非空才算反对票。** 这条是收敛的命门：不分级的话，评审员为了显得有用会一直挑
命名、格式之类的毛病，三轮永远凑不齐全票。`non_blocking` 给它们一个发泄的地方又不拦路。

`verdict` 字段与 `blocking` 长度冲突时（比如说 approve 却给了 blocking 条目），
**以 `blocking` 长度为准**，并在汇总表里标注该评审员自相矛盾。模型偶尔会填错枚举，
但不会凭空编出具体的 blocking 条目。

## 6. 主循环（收敛状态机）

写死在 `SKILL.md` 里，Claude 照此执行：

```
round = 1
loop:
  1. 往仓库外临时文件写两样（不碰仓库）：
     - intent    本次改动意图
     - contested 第 2 轮起必填：每条 blocking + 我改了什么 / 未采纳及理由
  2. node scripts/board-round.mjs --round N --intent <f> [--contested <f>]
     （脚本自己 ensureIgnored → 拼 brief → 并发开会）
  3. 读 stdout 汇总表
  4. 全员 approve → 写 verdict.md「通过」，散会汇报，退出
  5. 否则逐条处理 blocking：
       认同  → 改代码，下轮 brief 记「已按 X 修改」
       不认同 → 不改，下轮 brief 记「未采纳，理由 Y」（**必须给理由**）
  6. round++；round > 3 → 升级：停下，写 verdict.md，把分歧摆给用户
```

**第 5 步允许带理由拒绝，是收敛的必要条件。** 若强制接受每一条 blocking，两个评审员可以互相
矛盾地把主会话拉锯到死（codex 说"该抽成函数"，grok 说"内联更清晰"），照单全收就会在两个方案
之间反复横跳，永远不通过。允许拒绝 + 下一轮评审员看得到理由，辩论才可能终止。

### 3 轮未达成一致时的输出

`verdict.md` 必须包含：每条未决争议的**双方完整理由链**（谁在第几轮说了什么、我的回应、对方的
反驳）、另一位评审员对该条的态度、以及**我的判断和建议**。判断要给，但决定权交还用户。

## 7. 磁盘布局

### 仓库内（跟着 git 走）

```
code-agent-board/
├─ SKILL.md                    主持人协议 → /board
├─ DESIGN.md                   本文档（另有 DESIGN.zh-CN.md）
├─ README.md
├─ scripts/
│  ├─ board-round.mjs          会议秘书：编排、并发调用、写盘
│  ├─ brief.mjs                拼 brief（含未跟踪文件，跳 symlink）
│  ├─ git-artifacts.mjs        产物的 git 忽略
│  ├─ verdict.mjs              解析两家输出
│  ├─ tally.mjs                计票与轮次状态机
│  ├─ summary.mjs              汇总表格式化
│  ├─ modes.mjs                code / plan 两种评审模式
│  ├─ reviewer-config.mjs     评审员名单校验，doctor 与 board-round 共用
│  └─ board-doctor.mjs         环境自检
├─ prompts/
│  ├─ code-reviewer.md         审代码（默认，英文）
│  ├─ plan-reviewer.md         审方案（--mode plan，英文）
│  └─ *.zh-CN.md               中文版，--lang zh-CN 时使用
├─ config/
│  ├─ reviewers.json
│  └─ verdict.schema.json
└─ test/                       116 个测试，`npm test` 一把跑完
   ├─ brief.test.mjs           用真 git 仓库（含 symlink、大文件、重命名、密钥文件）
   ├─ git-artifacts.test.mjs   用真 git 仓库 + 真 worktree
   ├─ modes.test.mjs           (模式 × 语言) 矩阵，断言每份 prompt 都带 {{BRIEF}} 和两条约束
   ├─ doctor.test.mjs          探针派生与模型一致性，含「不可验证必须失败」
   ├─ reviewer-config.test.mjs 条目数、id 唯一性、至少两个厂商
   ├─ args.test.mjs            严格参数解析；参数名拼错必须大声失败
   ├─ verdict.test.mjs
   ├─ tally.test.mjs
   └─ summary.test.mjs
```

用 `.mjs` 而非 bash：解析/计票/格式化是纯函数，能直接用 `node --test` 跑。
bash 写的话这部分就没法测。零第三方依赖是硬规矩——`npm test` 不需要先 `npm install`。

### 被评审仓库内（本地产物，不进 git）

```
<repo>/.claude/board/
├─ round-1/
│  ├─ brief.md
│  ├─ prompt.txt
│  ├─ codex.json  codex.md
│  ├─ grok.md
│  ├─ summary.md
│  └─ results.json
├─ round-2/  round-3/
└─ verdict.md
```

`.claude` 若未被 gitignore，脚本往 `.git/info/exclude` 追加一条（本地生效，
不弄脏项目自己的 `.gitignore`）。

## 8. 汇总表格式

`board-round.mjs` 打到 stdout：

```
Round 1 — 1 approve / 1 request_changes / 0 unavailable
────────────────────────────────────────────────────────
codex  request_changes  webhook 未处理订阅过期降级      (2 blocking, 1 non-blocking)
grok   approve          无阻塞问题                      (0 blocking, 3 non-blocking)

BLOCKING:
[codex] src/payment/webhook.ts:88
  订阅过期后直接 throw，未回落 free 权限
  为什么要紧：上层 catch 只覆盖 StripeError，这里抛 TypeError 会漏成 500
  建议：过期分支返回 free 权限对象

Transcripts: .claude/board/round-1/codex.md, .claude/board/round-1/grok.md
Cost reported by grok: $0.0133 — codex does not report cost
```

原文路径由实际评审员列表派生，不是写死的两个名字；成本行注明是谁报的，因为
codex 不上报成本，把 grok 一家的数字当成整轮成本就是在静默少报。

Claude 只读这张表（几百 token），觉得哪条可疑再去翻完整原文。相比"两份全文进 context"
省下大部分开销，三轮下来差距很大。

## 9. 错误处理

| 故障 | 处理 |
|---|---|
| CLI 未安装 / 未登录 | `board-doctor.mjs` 提前查；会中失败记 `unavailable` |
| 超时（默认 900s） | 杀进程，记 `timeout`。900s 是按 xhigh 定的；改 `reasoning-effort` 要一起调 |
| 输出非合法 JSON | 记 `parse_error`，原文原样交给 Claude，不猜 |
| `verdict` 与 `blocking` 自相矛盾 | 以 `blocking` 为准，汇总表标注 |
| diff > 2000 行 | 先警告并要用户确认再开会 |
| 无未提交改动 / 不在 git 仓库 | 直接退出并说明原因 |

### 大 diff 下的实测运行特性

用 board 审本仓库自己那次 3468 行的抽离（brief 233 KB），实测数字在你要审大改动前值得先知道：

| | 实测 |
|---|---|
| codex 从启动到出裁决 | **13 分 49 秒** |
| grok 同一份 brief | **12 秒**——而且返回的是占位裁决，根本没干活 |
| 距 `timeoutMs`（900 秒）的余量 | **71 秒** |

三条推论：

1. **「5-8 分钟」适用于常规改动，不适用于这个规模。** 几百行的 diff 在那个窗口内能跑完，
   几千行不行。
2. **`timeoutMs` 才是 diff 规模的真实上限。** 3468 行时 codex 离 900 秒（15 分钟）上限
   只差 71 秒。真被 SIGKILL 的话，那一轮就是花了 15 分钟什么也没得到——而且另一位当时返回
   的是空裁决（现已判为 `parse_error`），最终结论会是 `all_failed` 而不是 `inconclusive`。
   这正是 SKILL.md 要求超过约 2000 行先问用户的原因；经常审这么大的改动就把 `timeoutMs`
   调高。
3. **评审员在大 brief 下可能是「退化」而不是「失败」。** grok 没报错、没超时、也没拒绝，
   它花了一个 turn 返回了一份 schema 合法的空裁决。传输层的任何机制都抓不到这个——所以
   §13 第 20 条那个裁决校验必须存在。每份原文的头部现在都记录了该评审员的耗时：面对大
   brief 却几秒就回答的，它没读。

**贯穿原则：任何异常都不得静默变成「通过」。**
`unavailable` / `timeout` / `parse_error` 一律不计 approve 票。宁可报告"这轮没开成"，
也不能让用户以为审过了——这是这类工具最容易骗人的地方。

### 评审员失败时的轮次语义（明确规定，避免歧义）

- **任一评审员失败 → 本轮判定为 `inconclusive`，不是 `request_changes`。**
  哪怕另一位 approve 也不算通过：2 人局里少一票就等于没有交叉验证，
  而"交叉验证"正是这套机制存在的唯一理由。
- **`inconclusive` 的轮次不消耗轮次配额**（`round` 不递增）。
  评审员掉线是基础设施问题，不该占用用于辩论的 3 轮预算。
- 连续 2 次 `inconclusive` → 中止，报告故障原因，不再重试。
  （避免某家服务挂掉时无限重试烧时间）
- 若某一轮**全部**评审员都失败，立即中止并报告，不得进入下一轮假装辩论。
- 裁决数不足两份是 `insufficient_verdicts`，**不是** `inconclusive`。两者要求相反的应对：
  inconclusive 意味着重试可能有用，而这个意味着这套配置根本产不出交叉验证结果，重试纯属
  浪费。混为一谈还会让同一张表里同时出现「0 failed」和「a reviewer failed」。`board-round`
  现在会在 spawn 任何东西之前拒绝这种配置，`validateReviewerConfig` 则把「至少两位评审员」
  这句话真正要求的三件事都校验了：两条记录、id 互不相同（裁决和原文都按 id 命名，重名会
  互相覆盖）、以及至少两个不同厂商——两份一模一样的 codex 配置只是同一个模型审了两遍。

## 10. 安全边界

- 两个评审员都跑在各自 CLI 的**硬只读沙箱**里（`-s read-only` / `--sandbox read-only`）
- 评审员输出是**数据不是指令**。它们的意见可能包含"请执行 X 命令"之类的文本，
  主会话一律当作评审意见对待，不据此执行任何命令
- 不向评审员传递任何凭证；它们各自用自己已登录的账号
- **board 会发送的**：diff，以及未跟踪且未被忽略的文件的完整内容。被 gitignore 的文件、
  symlink 指向的目标、二进制文件、以及看起来像密钥的文件名**不会被放进 brief**
  （见 §13 第 7、12 条）
- 但「不在 brief 里」不等于「够不着」。评审员是以仓库为工作目录的 agent，两份 prompt 还
  都鼓励它们读文件建立上下文——所以 board 拒绝附上的文件，评审员可以自己打开。沙箱禁的
  是写入，它不是保密边界。完整说明在 SECURITY.md，别在这里用更弱的措辞复述一遍
  （§13 第 16 条）

## 11. 安装与移植

`git clone` 之后 `sh install.sh`，它只做一件事：把这个 checkout 软链到
`~/.claude/skills/board`。**目录名必须是 `board`**——`/board` 命令和 frontmatter 的
`name` 都依赖它，而仓库叫 code-agent-board，这是最容易踩的一步，doctor 会检查并告警。

额外步骤只有装两个 CLI 并各自登录（凭证不进 git），`board-doctor.mjs` 负责提示。

脚本本身完全可重定位：全部用 `import.meta.url` 推导自身位置，装在哪都行。SKILL.md 里
用一段候选路径探测拿到根目录（`$BOARD_HOME` → 个人 skills → plugin 根 → 项目级），
候选必须真的含 `scripts/board-round.mjs` 才算数，免得半删空目录盖过可用安装。

### 未来加自动触发（本版不做）

要加自动触发只需在 Stop hook 上挂一个门卫脚本（判断 diff 规模、是否已审过），
SKILL.md 与脚本一行不改。

注意：`stop_hook_active` 字段官方文档说明「hook 触发时永远为 true」，**不能**用它防死循环，
必须自己落盘记轮次。

## 12. 测试策略

1. **离线单测**（`npm test`）：喂预置 fixture 给纯函数——
   approve / request_changes / 畸形 JSON / 空文件 / verdict 与 blocking 自相矛盾 /
   全员失败，断言计票结果与汇总表文本。不真调 CLI。
2. **doctor 四态**：都正常 / CLI 缺失 / 未登录 / 钉死的模型账号无权限。
3. **真实端到端**：scratch 仓库里埋一个真 bug（漏 null 检查、并发写同一缓存），
   跑完整 `/board`，看两家能否揪出来。

第 3 项是唯一能回答"这套东西到底有没有用"的验证。实现完立刻跑一次并把结果如实汇报——
若 codex 和 grok 连埋好的 bug 都找不出，这套机制就是在浪费时间和额度，早知道比晚知道好。

## 13. board 自评审发现的缺陷（2026-08-17）

实现完成后用 board 评审自己的改动，三轮共发现 **11 个真缺陷**：9 个由 codex 或 grok 提出，
另外 2 个（第 1、2 条）来自手工冒烟测试。全部经人工独立验证后修复。记在这里是因为
它们指向同一个教训。

| # | 缺陷 | 提出者 | 性质 |
|---|---|---|---|
| 1 | `String.replace` 替换串里 `$&` / `` $` `` 被当特殊模式，diff 被静默篡改 | 冒烟测试 | 数据损坏 |
| 2 | grok 的 `-p` 与 `--prompt-file` 互斥，同时给直接报错 | 冒烟测试 | 配置错误 |
| 3 | linked worktree 下 `--git-dir` 定位 `info/exclude` 写错位置且不报错 | codex | 静默失效 |
| 4 | 无条件 append 会让 exclude 堆重复规则 | grok | 累积垃圾 |
| 5 | brief 漏掉未跟踪的新文件（`git diff HEAD` 不显示） | grok | **评审失效** |
| 6 | 忽略规则写得比 brief 晚，中间有暴露窗口 | codex | 时序 |
| 7 | 未跟踪 symlink 被跟随，仓库外文件内容进 brief 并发往外部 CLI | codex | **安全** |
| 8 | 64 KiB 截断发生在整份读进内存之后，大文件仍会撑爆进程 | codex | 资源 |
| 9 | `countChangedLines === 0` 误判纯重命名/模式变化为"无改动" | codex | 逻辑 |
| 10 | intent/contested 缺失静默转空串，第 2 轮起辩论上下文丢失 | codex | 协议破坏 |
| 11 | SKILL.md 里 `import('~/...')` 不做 `~` 展开，命令跑不通 | codex | 文档错误 |

### 教训

**第 5、6、10 条根因相同：把安全或正确性步骤写进 SKILL.md 让 agent 执行。**
写了"未跟踪的新文件另附完整内容"，agent 没执行；写了"往 .git/info/exclude 加一行"，
agent 没执行。这类步骤必须挪进代码强制执行——所以才有了 `brief.mjs` 和
`git-artifacts.mjs` 两个模块。

**第 7 条说明只读沙箱保护不了这个方向。** 评审员的沙箱限制的是评审员，而泄露发生在
主进程拼 prompt 的时候。凡是要发给外部 CLI 的内容，都得在拼装侧做边界检查。

**第 5 条最值得注意：它让整场评审失效而不报错。** grok 因为看不到被 import 的模块
而拒绝下判断——如果它没那么谨慎，就会基于残缺的 diff 给出一个"通过"，而我们会以为
审过了。这正是 §9「任何异常都不得静默变成通过」想防的情况，但当时那条规则没覆盖
"输入本身不完整"这个入口。

### 抽离开源时发现的后续缺陷

准备开源时又查出 4 个，同宗同源，均已在此仓库修复：

| # | 缺陷 | 性质 |
|---|---|---|
| 12 | 未跟踪且不在 `.gitignore` 里的 `.env`，完整内容会进 brief 并发往两家厂商 | **安全** |
| 13 | doctor 的探针自己手写了一份 CLI 调用参数，于是探的是 CLI **默认模型**而非配置里钉死的那个——账号没有该模型权限的用户会拿到绿色的「全部就绪」，然后在第一次开会时失败 | **静默失效** |
| 14 | doctor 遇到不认识的评审员 id 只打印警告、不计入失败，最后照样输出「全部就绪」并 exit 0 | **静默通过** |
| 15 | 汇总表写死 `{codex,grok}.md`；成本行只累加会报成本的评审员，却称之为整轮成本 | 诚实性 |

第 13 条是第 3 条换了身衣服：又一处手工维护的第二真相源，按构造必然漂移。修法不是去
校正那份副本，而是删掉它——探针现在从 `config/reviewers.json` 派生参数，并且无法证明
自己探的是真实轮次会用的模型时直接拒绝运行。

第 14 条则是直接违反本项目自己的铁律，而且就发生在那个专门用来抓这种事的工具里面。

### 然后 board 审了这次抽离本身

发布前把 board 指向抽离的 diff（3468 行），它提了 7 条 blocking。**6 条属实**，均已在本仓库
修复；1 条是 dogfood 环境造成的误判（临时基线提交里确实是私有版内容，评审员把它当成了
「要发布的历史」）。

| # | 缺陷 | 性质 |
|---|---|---|
| 16 | 密钥文件名过滤只挡住内容进 brief，但评审员是以仓库为 cwd 的 agent、prompt 还鼓励它读文件——「不进 brief」被写成了「不会发送」，承诺过强 | **文档 / 安全** |
| 17 | SENSITIVE 正则没匹配 `.envrc`、`secrets.env`、`secrets.txt`，而 SECURITY.md 承诺的是 `.env*` | **安全** |
| 18 | `board-doctor.mjs` 比较 `process.argv[1]` 与 `import.meta.url` 时不解析 symlink，于是经由 `install.sh` 造的 `~/.claude/skills/board` 软链调用时，什么都不检查就 exit 0 | **静默成功** |
| 19 | 参数解析忽略未知参数，`--mdoe plan` 会静默用代码 prompt 审方案；畸形的 `--round` 还能绕过 contested 强制要求 | **静默回落** |
| 20 | 结构合法但内容为空的裁决会变成一张 approve 票 | **静默通过** |
| 21 | SKILL.md 一边告诫 agent 别依赖 shell 变量跨命令存活，一边自己用 `$TMP` 跨命令且文件名固定 | 协议 |

**第 20 条在报告它的那一轮里自证了。** 有一位评审员只跑了 1 个 turn，返回
`{"verdict":"request_changes","blocking":[],"one_line_summary":"placeholder"}`。这份输出
schema 合法所以解析通过，而 blocking 为空又让 `normalizeVerdict` 把它归为 **approve**——
一个没干活的评审员投了赞成票。要是另一位也 approve，这轮就会被报成全票通过。

修法是把本来只在一个方向上正确的规则推广开：矛盾必须**朝保守方向**解决。「声称 approve
却列了 blocking」解析为 request_changes（和原来一样），而「声称 request_changes 却什么都
没列」现在是 `parse_error`——无法据以行动，就不能算赞成。

第 18 条最扎心：一个专门用来杜绝静默成功的项目，自己的诊断工具静默成功了。它是这次抽离
引入的（那个直接调用判断是为了让测试能 import 纯函数），而且会命中**每一个用
`install.sh` 安装的用户**。

### 第 2、3 轮：审这些修复本身

每一轮审的都是上一轮的修复。两轮都在修复里找出了真缺陷。

**第 2 轮**（2 条 blocking）。单份裁决会被算成通过——配置一位评审员，每轮都读作
`approved`，把一个模型的意见当成两家厂商达成了一致。这个场景里没有任何人失败，所以既有的
失败路径全都抓不到它。另外安装名检查第二次修错：改用调用路径判断，只在从软链启动时才有
效，而 README 教的 `npm run doctor` 和 install.sh 自己打印的命令都走物理 checkout。

更难堪的是，**为第一次修复写的测试把「零评审员」定义成了成功**，等于把它本该防住的缺陷
固化了进去。

**第 3 轮**（3 条 blocking），三条全是真的：

| 缺陷 | 为什么要紧 |
|---|---|
| 名单检查只数了条目个数 | 两份一模一样的 codex 配置能通过——同一个模型审两遍，却被报成跨厂商一致。id 重名还会互相覆盖裁决与原文，因为两者都按 id 命名 |
| `insufficient_verdicts` 被当成 `inconclusive` 上报 | 两者要求的应对相反。摘要里「0 failed」和「a reviewer failed」并排出现，而协议的重试规则会对一套永远不可能成立的配置重跑一次昂贵评审 |
| doctor 的安装探测与 SKILL.md 不一致 | 少了 git 顶层候选，末尾还有 `basename(root) === 'board'` 这个无条件回退，任何叫 board 的目录都算已安装，不管 agent 能不能找到它 |

安装检查一共改了**三次**。前两次都在回答一个略微错误的问题，只有第三次问对了——「这个
checkout 能否作为名为 board 的 skill 被找到？」——办法是解析安装目标，而不是打量入口路径。

**第 4 轮**（1 approve，3 条 blocking）。三条全是真的，而且全都是「第 3 轮加的那个校验器
自己不校验输入」：

| 缺陷 | 为什么要紧 |
|---|---|
| `advanceState` 不认识新加的 `insufficient_verdicts` | 它落进了 `changes_requested` 分支返回 `next_round`——把「这套名单永远不可能成立，停下来改配置」变成了重试循环 |
| vendor 值比较前不做规范化 | `openai` 和 `OpenAI` 被算成两个厂商，两份一模一样的评审员就能通过跨厂商检查，两张 approve 会被报成一致 |
| id 只查完全重复，却被直接当文件名用 | `../../../package` 会解析到产物目录之外，而 codex 正是用 `-o` 往那里写裁决——它会覆盖被审仓库的 `package.json`。仅大小写不同的 id 在 macOS 上也是同一个文件 |

dogfood 到这里停止。不是因为评审员挖不动了——它们还挖得动——而是因为发现的性质变了：
第 1-3 轮找的是代码**做了什么**的缺陷，第 4 轮找的是它**接受什么输入**的缺陷。两类都值得
修，也都修了；但后一类没有自然终点，而另一位评审员此时已经 approve 这一轮，并把剩下的判
为「规格/文档/测试的漂移，不是用户会撞到的 bug」。再跑下去就是仪式而不是判断了。

### 四轮下来，两位评审员各自的表现

值得记录，因为这是 §9 和 §13 那些规则最有力的论据：

| 轮次 | codex | grok |
|---|---|---|
| 1（233 KB brief） | 13分49秒，7 条 blocking，6 条属实 | **12 秒，$0.0138——返回占位裁决** |
| 2（20 KB brief） | 8分46秒，2 条 blocking，全属实 | 约 10 分钟，$0.2047，approve + 4 条 nit，其中一条 codex 没看到 |
| 3（27 KB brief） | 3 条 blocking，全属实 | **$0.0054——把「需要先读完整上下文再判断」当成一条 blocking 交了上来** |
| 4（31 KB brief） | 3 条 blocking，全属实 | $0.2162，approve + 3 条 nit——准确判断出剩下哪些是漂移而非 bug |

两条推论。

**一位评审员三轮里退化了两轮，而且一次都没「失败」过。** 没有超时、没有报错、没有拒绝，
只是给出了一个并没有想过的答案。第 1 轮那次被 #20 加的裁决校验接住了，第 3 轮这次没有：
「我需要先多读一点」带着 file、issue、why_it_matters 一起来，结构上和一条真发现无法区分。
schema 校验够不到这一层——而这正是 SKILL.md 那条铁律（采纳任何 blocking 前先自己核实）
存在的原因。

**成本数字是破绽。** $0.0054 和 $0.0138，对比它真干活那轮的 $0.2047——差 15 到 40 倍。
加上现在每份原文头部记录的耗时，这是判断「评审员没读 brief」最便宜的信号。这两个数字都
不出现在裁决本身里。

**另一位评审员四轮都找出了真缺陷**，包括每一轮修复里的。四轮共 14 条，每条都经人工核实
后才采纳。

跨厂商评审在这里始终没有收敛到全票通过。但它一次都没有产生过虚假通过——而且两位评审员
是互补的，这是单个模型做不到的：一位不停找出真缺陷，另一位在最后一轮准确判断出剩下哪些
只是漂移。正是后者这个判断，让这个过程能停在一个站得住脚的地方，而不是无限跑下去。

## 14. 方案评审模式

`--mode plan` 用 `prompts/plan-reviewer.md` 替换代码评审 prompt。前提：方案必须先写成
文件（plan mode 本身不落盘）。

### 为什么值得单独一套 prompt

同一份有缺陷的方案，两种 prompt 实测对比：

| | 代码模式 | 方案模式 |
|---|---|---|
| codex blocking | 2 条 | **3 条** |
| grok blocking | 2 条 | 2 条 |
| 新增发现 | — | 「`auth.ts` 只返回硬编码 `plan:'free'`，方案没有订阅状态的事实来源」 |
| 引用真实性 | grok 编造了 `user_models`、`storage_path`、`/api/user`、`/generate` | 全部真实 |
| 成本 | $0.0148 | $0.0390 |

方案模式多挖出的那条是典型的方案级问题——不是 bug，是**方案缺了一块**：判断订阅状态的
数据从哪来没定义。代码模式的判据（bug/安全/数据损坏）覆盖不到这类缺失。

### 「引用必须真实」的约束有效

代码模式那次 grok 引用了 4 个仓库里根本不存在的标识符（那个 scratch 仓库总共 4 个文件）。
推理方向对，细节是脑补的。两份 prompt 都加上「引用时文件名、函数名、表名、字段名必须是
真实读到的，无法确认就明说未确认」之后，方案模式那轮的引用**全部经得起核实**。

但**不能指望 100% 遵守**——SKILL.md 里保留了「采纳任何 blocking 前先自己核实」的铁律。

### 模式拼错必须报错

`resolveMode` 对未知模式返回 `ok:false` 并让脚本 exit 2，**绝不回落到默认**。
用代码 prompt 审方案的失效方式是静默的：评审员会往「这份 markdown 有什么 bug」使劲，
然后很可能 approve——因为 markdown 确实没有 bug，而用户会以为方案审过了。
