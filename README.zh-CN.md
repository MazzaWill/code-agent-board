# code-agent-board

**两个来自不同厂商的 AI CLI 读你未提交的改动，多轮互相挑刺辩论，直到双方都没有阻塞
意见才散会。**

一个 [Claude Code](https://claude.com/claude-code) skill。单个模型自审会带着和写代码时
一样的盲区，所以这里让两个**不同厂商**的模型各自独立评审、然后辩论，你当主持人。

> 英文版 `README.md` 是准据版本，本译本可能滞后。

## 你会得到什么

每轮一张表，打到 stdout：

```
[code review] Round 1 — 1 approve / 1 request_changes / 0 failed
Outcome: changes_requested (blocking objections raised)
────────────────────────────────────────────────────────────
codex   request_changes  webhook does not downgrade on expiry   (2 blocking, 1 non-blocking)
grok    approve          nothing blocking                       (0 blocking, 3 non-blocking)

BLOCKING:
[codex] src/payment/webhook.ts:88
  Issue: throws when the subscription has expired, without falling back to free
  Why it matters: the caller only catches StripeError, so a TypeError escapes as a 500
  Suggested fix: return a free-tier permission object on the expiry branch

Transcripts: .claude/board/round-1/codex.md, .claude/board/round-1/grok.md
Cost reported by grok: $0.0133 — codex does not report cost
```

你逐条处理 blocking——采纳或**带着理由**拒绝——然后开下一轮。完整原文落盘，进 context
的只有这张表。（想要中文评审意见就加 `--lang zh-CN`。）

## 为什么是两个厂商，而不是两个 prompt

模型评审自己的产出时，带着的是写这段代码时同一套盲区。同一个模型换个 prompt 跑两遍，
多半只是把同样的发现换个说法讲一遍。

不同厂商的两个模型，分歧是**有信息量的**：两家都标同一行，那基本是真的；一家标了另一家
漏了，那正是单模型评审会漏掉的那类。

分歧本身就是产物。这个仓库里的一切，都是为了把分歧变成决定而不是噪音。

## 它真的有用吗

实现完成后，board 评审了自己的改动。三轮找出 **11 个真缺陷**——9 个由评审员提出，2 个来自
手工冒烟测试——每一条都经人工独立核实后才修。其中两条分量很重：

| # | 缺陷 | 性质 |
|---|---|---|
| 5 | brief 漏掉未跟踪的新文件，评审员实际在评一份残缺的 diff | **评审失效** |
| 7 | 未跟踪的 symlink 被跟随，仓库外的文件内容被发往外部 CLI | **安全** |

第 5 条最值得看。那次是评审员**拒绝下判断**，因为它看不到被 import 的模块。如果它没那么
谨慎，就会基于残缺 diff 给出 approve，而我们会以为审过了。

抽离开源时又查出 4 个，包括一个「探针探的模型和真实轮次不是同一个」的 doctor，却一直报
「全部就绪」。

**然后 board 审了这次抽离本身——四轮，每一轮审的都是上一轮的修复。又找出 14 个，而且每一
轮都在上一轮的修复里发现了真缺陷。** 全部加起来 29 个，每条都经人工核实后才采纳。

其中一条在报告它的那一轮里自证了：有位评审员只跑了 1 个 turn，返回了一份结构合法但内容
为空的裁决——

```json
{"verdict":"request_changes","blocking":[],"one_line_summary":"placeholder"}
```

——解析完全通过，而 blocking 为空又让它被算成一张 **approve**。一个没干活的评审员投了赞成
票。而另一位评审员在同一轮里，正好从代码里读出了这一类 bug。

修法是把本来只在一个方向上正确的规则推广开：矛盾必须**朝保守方向**解决。「声称 approve
却列了 blocking」解析为 request_changes；「声称 request_changes 却什么都没列」现在是
parse_error，而不是通过。

第 4 轮查出评审员 id——它会变成产物文件名——从未被校验：`../../../package` 会解析到产物
目录之外，而 codex 正是用 `-o` 往那里写裁决，它会覆盖被审仓库的 `package.json`。

两位评审员最后呈现出单个模型给不了的互补性：一位每轮都能找出真缺陷，包括自己上一轮修复
里的；另一位在最后一轮准确判断出剩下哪些只是漂移而非 bug——正是后者让这个过程能停在一个
站得住脚的地方，而不是无限跑下去。

完整清单和每条修复的推理在 [DESIGN.zh-CN.md](DESIGN.zh-CN.md) §13。

### 审方案比审代码更划算

同一份有缺陷的方案，两种 prompt 实测对比：

| | 代码模式 | 方案模式 |
|---|---|---|
| codex blocking | 2 条 | **3 条** |
| grok blocking | 2 条 | 2 条 |
| 多出的发现 | — | 「auth 模块只返回硬编码的免费档，方案没有订阅状态的事实来源」 |
| 成本 | $0.0148 | $0.0390 |

多出的那条不是 bug，是**方案缺了一块**。代码评审的判据（bug / 安全 / 数据损坏）结构上
就够不到这类问题。方案还没动手就被指出第一步会失效，省下的是整段返工。

## 安装

| 前置 | 说明 |
|---|---|
| Node ≥ 20 | 用 `node --test`，零第三方依赖 |
| git | brief 是用 git 拼的 |
| [Claude Code](https://claude.com/claude-code) | 这是给它用的 skill |
| [codex CLI](https://developers.openai.com/codex/cli) | 评审员 1——装好并登录 |
| [grok CLI](https://grok.com) | 评审员 2——装好并登录 |

```bash
git clone https://github.com/MazzaWill/code-agent-board.git
cd code-agent-board
sh install.sh          # 软链到 ~/.claude/skills/board
npm run doctor         # 两位评审员都必须报 ready
```

> **skill 目录名必须是 `board`**，尽管仓库叫 code-agent-board。`/board` 命令和 skill
> frontmatter 的 `name` 都依赖这个名字。`install.sh` 会处理好；手工软链的话记得链成
> `board`。链错了 doctor 会告警。

然后**重启 Claude Code 会话**——已经开着的会话不会加载新装的 skill。

两个 CLI 都必须在 `PATH` 里。grok 默认装到 `~/.grok/bin`，不是每个 shell 都会自动带上；
如果你确认装了却被 `npm run doctor` 报成 "not installed"，那是 `PATH` 的问题，不是二进制
不在。

预算大约十分钟，大部分花在两个 CLI 的登录上。

## 用法

```
/board
```

或者直接跟 Claude 说「开会」「找同事审一下」「交叉评审」「审一下这个方案」。

常规改动在 `xhigh` 档一轮 **5–8 分钟**，期间没有任何输出，直到两家都跑完。大 diff 会显著
更久——实测本仓库自己那次 3468 行的抽离，codex 用了 **13分49秒**，距默认 900 秒超时只差
71 秒。超过约 2000 行 board 会先问你；如果你经常审这么大的改动，把配置里的 `timeoutMs`
调高。

成本按 grok 上报大约**每轮 $0.01–0.04**；codex 完全不上报成本，所以真实数字更高。

复杂改动和有分量的方案才值得。改错别字不划算。

## 两种模式

| 模式 | 审什么 | 参数 |
|---|---|---|
| `code`（默认） | 未提交的代码改动 | `--mode code` 或省略 |
| `plan` | 技术方案 / 设计文档 | `--mode plan` |

`plan` 模式要求方案**先写成文件**——只存在于对话里的方案不落盘，board 读不到。

拼错 `--mode` 会直接报错退出，绝不回落。因为回落的失效方式是静默的：拿代码 prompt 去审
方案，评审员会去找「这份 markdown 有什么 bug」，找不到，approve——而你以为方案审过了。

## 一场会怎么收敛

意见分成 `blocking` 和 `non_blocking`，**只有 `blocking` 算反对票**。这个分级就是收敛
机制本身：不分级的话，评审员为了显得有用会一直挑命名、格式，三轮永远凑不齐全票。

| 结论 | 含义 |
|---|---|
| `approved` | 全票通过，散会 |
| `changes_requested` | 处理 blocking，开下一轮 |
| `inconclusive` | 有评审员失败——本轮不作数，也不消耗轮次配额 |
| `all_failed` | 全部失败，停止并报告 |

**你可以带着理由拒绝某条 blocking，而这个权利是收敛的必要条件。** 若强制接受每一条，
两个评审员可以用互相矛盾的要求把你拉锯到死（一个说该抽成函数，另一个说内联更清晰），
你就会在两个方案之间反复横跳。你的理由会进下一轮的 brief，评审员据此判断问题有没有被
真正解决，而不是把同一条再提一遍。

三轮谈不拢就升级：board 会把双方完整的理由链写下来，决定权交还给你。

## 它绝不会静默通过

`unavailable` / `timeout` / `parse_error` 一律不计 approve 票。一位评审员挂了，哪怕另一位
approve，整轮也是 `inconclusive`——两人局少一票就等于没有交叉验证，而那正是全部意义所在。

这是这类工具最容易悄悄写错的地方，所以它是被测试直接断言的，而不只是写在文档里。

## 评审员会幻觉——采纳前先核实

实测：某次评审员引用了 `user_models` 表、`storage_path` 字段、`/api/user` 路由。那个仓库
总共 4 个文件，这些一个都不存在。

推理方向是对的，细节是脑补的。两份 prompt 现在都要求「引用的标识符必须是你真实读到的」，
加上之后那一轮的引用**全部经得起核实**。**但不要假定它 100% 遵守**——采纳任何一条
blocking 之前，先自己去仓库里核实它引用的文件、函数、字段真实存在。

### 而且有时候评审员根本没在评审

board 审自己这个仓库的三轮里，有一位评审员只有一轮做了真评审，另外两轮返回的是它并没有
想过的答案。两次都不算「失败」：没超时、没报错、没拒绝。

- 第 1 轮：`{"verdict":"request_changes","blocking":[],"one_line_summary":"placeholder"}`
  ——schema 合法，而 blocking 为空又让它被算成一张 **approve**。现已被裁决校验拦下。
- 第 3 轮：把 `"需要先读完整上下文再判断"` 当成一条 blocking 交上来，`file` 和
  `why_it_matters` 一应俱全。**结构上和一条真发现无法区分**，任何 schema 校验都够不到。

破绽在成本和耗时：**$0.0054 和 $0.0138，对比它真干活那轮的 $0.2047**——差 15 到 40 倍。
这两个数字都不出现在裁决里，所以 board 现在把耗时写进每份原文的头部。

这就是上面那条规则的具体理由：采纳前由人核实。这也是为什么失败的评审员永远不算 approve
票——但要注意，**退化**的评审员不是失败的评审员，区分两者只能靠你自己的判断。

## 什么会离开你的机器

你的 diff，加上未跟踪且未被 gitignore 的文件的完整内容，会发给 OpenAI 和 xAI。

board 不会把这些放进 brief：被 gitignore 的文件、symlink 指向的目标（绝不跟随）、二进制
文件、以及文件名看起来像密钥的（`.env*`、各种私钥与 keystore 扩展名、ssh 密钥文件名、含
`credentials` 的文件——确切的模式在 [`scripts/brief.mjs`](scripts/brief.mjs) 里，
[SECURITY.md](SECURITY.md) 有说明）。跳过的文件会被明确列为「已跳过」而不是静默丢掉，
好让评审员知道那里有东西。

**但「不在 brief 里」不等于「够不着」。** 评审员是 agent，以被审仓库为工作目录运行，而
prompt 还鼓励它们读文件来建立上下文。board 拒绝附上的文件，评审员完全可以自己去打开。
只读沙箱拦的是写入，它不是保密边界。如果仓库里有你不能暴露给这两家厂商的凭证，就别在它
上面跑 board——详见 [SECURITY.md](SECURITY.md)。

两位评审员都跑在各自 CLI 的硬只读沙箱里，不接触任何凭证。它们的输出被当作数据，绝不当
作指令执行。

## 配置

全在 [`config/reviewers.json`](config/reviewers.json)：

- **模型**——`gpt-5.6-sol` 和 `grok-4.6` 是钉死的。账号用不了就改这里；真出这个问题时
  doctor 会点名告诉你。
- **推理档位**——`xhigh`。调低的话记得一起调 `timeoutMs`（文件里的注释解释了为什么）。
- **加第三位评审员**——加一条含 `args` 和 `probe` 块的记录。名单会在 spawn 任何东西之前
  校验，所以配错了不花钱：
  - id 必须互不相同（大小写不敏感比较）且能当文件名用——产物是按 id 命名的，
    `../../../package` 会解析到产物目录之外
  - 整份名单至少要跨越两个**厂商**。所有条目都指向同一家的名单，就是同一个模型审了两遍，
    不是交叉验证。（已有厂商再加第三条是允许的——校验看的是整份名单。）vendor 默认取 bin
    的值，所以两条记录共用同一个二进制但指向不同厂商时，要显式写 `vendor` 字段。
  - 如果那个 CLI 的输出形状和现有两种（裸 JSON、或带 `structuredOutput` 的信封）都不同，
    还要在 `scripts/verdict.mjs` 里加一个解析器

`BOARD_HOME` 告诉 skill 协议 board 装在哪，用于 SKILL.md 的探测找不到的位置。它**不会**
改变脚本读哪份配置——每个脚本都用 `import.meta.url` 解析自己的目录。`--lang zh-CN` 让评审
意见用中文返回。

## 产物

一轮产生的所有东西都在 `<你的仓库>/.claude/board/round-N/`——brief、prompt、每位评审员的
原始输出、解析后的裁决、汇总表。

board 会把 `.claude/board/` 加进 `.git/info/exclude`，只在本地生效。**绝不动你项目自己的
`.gitignore`。**

## 平台支持

macOS 和 Linux 是一等公民，有 CI 覆盖（Node 20/22/24）。

Windows 暂不支持：doctor 的 PATH 查找已经改成跨平台的，但 SKILL.md 的临时文件处理和三个
测试仍假定 POSIX 行为（symlink、文件模式）。请用 WSL。

## 开发

```bash
npm test        # 116 个测试，不需要 npm install
npm run doctor
```

零第三方依赖是硬规矩——所以 `npm test` 在全新 clone 上不装任何东西就能跑。解析、计票、
格式化都写成纯函数，正是为了不调用 CLI 就能测；整套测试不花一分钱，也不需要 API key。

设计依据：[DESIGN.zh-CN.md](DESIGN.zh-CN.md) · 安全：[SECURITY.md](SECURITY.md) ·
贡献：[CONTRIBUTING.md](CONTRIBUTING.md) ·
行为准则：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## 致谢

灵感来自刘小排的文章《一个篱笆三个桩 一个AI五个帮》。原文只给了想法——这里的协议、配置、
收敛规则和每一个设计决定，都是从零设计的。

## License

MIT
