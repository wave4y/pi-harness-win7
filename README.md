# Pi Win7 Web

以真正的 **Pi Agent Core 0.51.6** 为任务循环，面向 **Windows 7 SP1 + Chrome 102** 的本地 Web 编程助手。浏览器负责交互，本地服务负责文件工具和模型请求。运行过程中不依赖 PowerShell、CMD、Bash、Bun 或完整 TTY。

这是独立的兼容适配版本，不是最新 Pi CLI 的原样移植。Win7 和 Chrome 102 是目标环境；实际验证范围见下文，不能将 Node 12 测试等同于 Win7 实机认证。

源码：[wave4y/pi-harness-win7](https://github.com/wave4y/pi-harness-win7)。便携包：[GitHub Releases](https://github.com/wave4y/pi-harness-win7/releases)。

## 使用便携包

升级到 0.7.0 时，先关闭旧版本的 Node 窗口，再运行新版启动器。新版固定使用 `%LOCALAPPDATA%\PiWin7Web`（无此变量时使用 `%APPDATA%\PiWin7Web`），以后换解压目录不会换数据目录。同一数据目录只能运行一个新版服务。

1. 解压 `release/pi-win7-web-0.7.0-x64.zip` 到可写的短路径，例如 `D:\PiWeb`。
2. 双击 `launch.vbs`。启动器直接运行随包提供的 `runtime/node.exe`，不启动 CMD 或 PowerShell。
3. 在 Chrome 102 打开 `http://127.0.0.1:3080`。启动器会尝试使用系统默认浏览器；默认浏览器不是 Chrome 时手动打开此地址。
4. 点击工作目录入口或设置中的“浏览”，在文件夹选择器里选择磁盘和目录，再确认。模型设置中填写模型 ID、OpenAI Chat Completions 兼容 API 地址和 API Key。
5. 发送任务，例如“查看这个目录，解释项目结构”或“创建一个中文说明文件”。

API 地址应是基础路径，例如 `https://api.deepseek.com/v1`，程序会追加 `/chat/completions`。本地、内网和远程兼容服务均支持 HTTP 或 HTTPS，例如 `http://192.168.1.20:8000/v1`。目前仅接入 Chat Completions 兼容接口，不包含 Anthropic 原生接口、Responses API、OAuth 登录、图片或推理模型专用参数。

API Key 在设置中保存一次后，重启和升级都能继续使用。Key 按完整 API 基础地址分别绑定，保存在本机数据目录的 `credentials.json`（本机明文文件，未加密）；不会放进网页返回值、普通配置或会话导出。更换地址不会把旧 Key 发给新地址，切回原地址可继续使用对应 Key。“清除 Key”同时清除其备份。`PI_API_KEY` 环境变量仅在本次进程提供凭据，不自动写入文件。

0.4.0 首次启动会检查程序旁的 `.state`，以及同一级 `pi-win7-web*` 旧包的 `.state`。其他位置的旧包可在“设置 → 本机数据”选择旧程序目录或 `.state` 后导入；原文件保留，现有设置不覆盖，有冲突的历史另存为会话。旧版从未保存的 Key 无法恢复，需要在新版首次填写一次。若旧目录已删除且无备份，对话也无法凭空恢复。

历史列表显示全部工作目录和模型的会话，可搜索和打开。每条消息、工具结果、排队指令及摘要检查点随进度落盘，生成中文字约每秒暂存；设置和会话有原子写入与上一份有效备份。异常中断后显示未完成回答，工具执行结果不明时标明不确定性，不自动重做。刷新/关闭网页会取消当次运行，已保存内容保留。新会话只清空活动模型上下文，原记录仍在历史列表。新安装的默认工作目录位于数据目录的 `workspace`，示例会首次复制进去；已有项目路径继续沿用，原路径不存在时可以查看历史，重新选择目录后会携带原记录继续，并保留旧会话。

停止服务：在启动器打开的 Node 控制台按 Ctrl+C。该窗口是 Node 的输出窗口，不是 Shell。端口被占用时会显示错误，请先关闭旧实例。组织策略禁止 VBScript 时，可创建指向 `runtime\node.exe` 的 Windows 快捷方式，将 `dist\server.cjs` 的完整路径作为参数、工作目录设为项目目录；同样不需要 CMD/PowerShell。

## 已实现

- 按 DeepSeek Harness 原版界面样式适配的中文 Web 工作台：对话、流式响应、工具记录、停止任务、设置、新会话与历史会话切换。
- 文件夹选择器：磁盘入口、上级目录、逐级浏览、确认选择；取消浏览不会修改工作目录。
- 文件目录浏览、UTF-8 文本查看和编辑、改动对比、保存前检查外部修改。
- Pi 自动循环：接收任务 → 调用模型 → 验证工具参数 → 执行工具 → 回传结果 → 继续回答。
- 文件工具：列目录、读取指定行、内容搜索、创建目录、写文件、精确替换。
- 程序工具：直接运行允许的可执行文件；run_python 使用内置 Python 与数据/文档依赖，展示标准输出/错误、退出码，支持超时和取消。
- DSH 权限选择：仅可查看、工作区内修改、完全权限；后台审批与取消。
- MCP：Streamable HTTP / stdio 连接、工具发现、工具调用和逐次审批。
- Skills：发现 SKILL.md、按需加载指令与支持文件、启用开关和附加目录。
- 单一上下文长度设置、自动预算、估算用量、Pi 自动/手动摘要压缩与超限重试。
- 项目 AGENTS.md/CLAUDE.md、SYSTEM.md/APPEND_SYSTEM.md、图形化提示词模板选择。
- 会话命名、分支、Pi v3 JSONL/HTML 导出、运行中插入指令与排队跟进。
- 会话恢复、每任务最多 20 轮模型调用、网络超时和不完整 SSE 响应检测。
- 只监听 `127.0.0.1`，请求令牌、Host/Origin 检查、CSP、路径越界和符号链接检查。

网页文件编辑器范围是选定工作目录；Agent 的文件范围由权限模式控制。当前只处理 UTF-8 文本，拒绝二进制、UTF-16 和 GBK 文件，避免静默损坏原文；单文件上限 1 MiB。搜索、日志和网络响应都有大小限制。目录浏览最多 1000 项，搜索结果会注明是否截断。

## 便携 Python（0.7.0 预发布）

x64 包内置 CPython 3.8.10，附带 20 个锁定版本的依赖：requests、pandas、NumPy、python-docx、python-pptx、openpyxl、XlsxWriter、Pillow、lxml 及其依赖。无需安装系统 Python、pip、Office 或配置 PATH。**这是供 Win7 SP1 实测的验收包，尚未通过 Win7 实机认证。** Python 3.8 和随带 OpenSSL 已停止维护；原生包的加载仍取决于目标电脑的系统更新和 C Runtime。

1. 打开“设置 → Python”，点击“检查运行环境”。只有实际启动解释器、检查隔离配置并成功导入全部依赖后才显示“自检通过”；可展开查看版本、TLS 和逐项错误。
2. 点击“试用文档与图片工具”，示例任务会放入输入框，发送后由 Agent 读取内置 portable-python Skill 并运行离线自检。也可直接提出“把这个 CSV 整理成 Excel，并生成 Word 报告”。
3. 在“仅可查看”和“工作区内修改”模式下，每次 run_python 都需批准，卡片显示解释器、脚本、参数和工作目录；完全权限模式直接执行。文档示例在当前目录下新建唯一输出文件夹，生成并重新打开 CSV、XLSX、DOCX、PPTX、PNG/JPEG，不覆盖原文件。

内置 Skill 随程序保存在 builtin-skills/portable-python，在所有工作目录中可发现，不需要手工添加。它按需加载数据、Word、PPT、图片和网络示例；同名内置 Skill 优先于项目 Skill。关闭 Skills 会停止注入目录和 read_skill，但不会禁用独立的 run_python 工具。

run_python 接受已保存的脚本路径、逐项参数、工作目录和 100–120000 ms 超时；固定使用随包解释器的隔离、UTF-8、无缓冲和禁止字节码缓存模式，不接受任意解释器、环境覆盖或 Shell 命令。标准输出与错误合计上限 64 KiB，支持取消；子进程不继承 API_KEY/TOKEN/PASSWORD 等常见凭据变量及 Python 注入环境。脚本仍有当前 Windows 用户的文件与网络权限，取消只处理直接子进程。

环境自检通过仅说明依赖可加载；文档往返验证检查文件结构，不代表 Office 渲染、中文字体或分页验收。Word/PPT 不包含 Office COM、PDF 渲染或 Office 安装。遇到 DLL、证书或原生模块错误，请复制“自检详情”及目标系统信息；不要用关闭证书验证作为修复。清单、许可证、逐文件 SHA256 和 DLL 导入报告位于 runtime/python38-x64。

详细基线与 Win7 验收项目见 [便携 Python 设计](docs/PYTHON-PORTABLE-PLAN.md)，实际技能见 [portable-python](builtin-skills/portable-python/SKILL.md)。

## 会话统计

输入框左下角沿用 DSH 的两组统计入口：轮数 / 步骤 / 输出速度，以及累计 Token / 缓存命中率。点击分别查看模型用时、工具调用用时、首 token 平均延迟、输出速度，以及输入、缓存和输出 Token 明细。工具用时不含等待人工审批的时间。

统计来自完整保存的会话历史，与当前上下文占用分开；自动压缩、刷新和重启不会清零，新会话重新累计，分支按保留的历史计算。摘要请求的用量在详情中另列。模型服务未返回用量或缓存明细、旧记录缺少计时数据时，显示未上报或部分数据，不把估算或占位零当作真实测量；速度仅使用已有输出 Token 和计时的数据。

## 按文件夹分组的对话

左侧历史会按完整工作目录自动分组，同一个目录下不同模型的对话放在同一组。同名但路径不同的文件夹分别显示；悬停可以看到完整路径。目录组可折叠，组与组内会话按最近活动排序，折叠选择保存在当前浏览器。搜索支持会话名称、工作目录和模型，命中的目录会展开；清除搜索后恢复原折叠选择。点击会话恢复其工作目录和模型，不需要先手工切换项目。

## 权限模式

在输入框旁选择权限，设置保存在当前会话中。新会话沿用当前选择；第一次打开一个工作目录/模型组合时默认“工作区内修改”。

| 模式 | 工作区内读取 | 工作区内修改 | 区外文件、程序、MCP 工具 |
| --- | --- | --- | --- |
| 仅可查看 | 直接执行 | 每次确认 | 每次确认 |
| 工作区内修改 | 直接执行 | 直接执行 | 每次确认 |
| 完全权限 | 直接执行 | 直接执行 | 直接执行 |

审批卡显示本次工具、参数和原因，选择“允许本次”或“拒绝”。停止任务、断开聊天连接会取消尚未处理的审批。完全权限使用 DSH 的勾选确认交互；它允许 Agent 访问工作目录以外的本机文件，并直接运行非 Shell 程序与已配置的 MCP 工具，不提升 Windows 用户权限。设备路径、UNC、NTFS ADS、写入符号链接和文件大小限制仍保留。

这些是应用的工具边界与审批策略，**不是 Windows 操作系统沙箱**。程序和 MCP 进程具有当前用户权限；第三方程序可能自行启动子程序。取消只尝试终止直接子进程，不保证清理后代进程。内置程序工具始终使用 shell:false，不解释管道或重定向，不运行 .bat/.cmd，也不提供 PowerShell、CMD、Bash。DSH 的实验性 Auto review 未接入，本版提供上述三种实际生效的模式。

## 测试 MCP

打开“设置 → MCP”，点击“填写示例”，保存后点击“连接测试”。示例会自动使用当前包中 node.exe 和 examples/mcp-demo-server.cjs 的绝对路径，不需要安装 npm 包。连接后应看到 echo、add 两个工具。

随后发送：“使用 MCP demo 的 add 计算 17 + 25，并用 echo 返回中文测试成功。”在工作区内修改模式下批准工具调用，完全权限模式会直接执行。连接测试只握手和发现工具，真正工具调用通过聊天完成。

也可粘贴标准的 MCP JSON 配置：

```json
{
  "mcpServers": {
    "demo": {
      "command": "D:\\PiWeb\\runtime\\node.exe",
      "args": ["D:\\PiWeb\\examples\\mcp-demo-server.cjs"]
    },
    "remote": {
      "url": "https://your-server.example/mcp",
      "headers": {"Authorization": "Bearer your-token"},
      "enabled": false
    }
  }
}
```

stdio 要求绝对可执行文件路径。不能直接填 npx、.cmd 或 Shell；若已有 Node MCP 服务，填兼容 Win7 的 node.exe，并在 args 中填服务入口脚本。第三方 MCP 服务本身仍须兼容 Win7/其运行时，客户端适配不会让现代 Node 依赖自动兼容。HTTP 支持协议版本 2025-03-26 的 Streamable HTTP POST（JSON/SSE 响应、会话 ID、分页工具发现）；stdio 额外支持 2024-11-05。不含旧版 HTTP+SSE、OAuth、sampling、elicitation 或独立 resources/prompts 界面。工具输出支持文本，图片/音频会明确省略。

保存并启用的 MCP 服务会在任务开始时连接、任务结束时关闭。外部服务的 readOnlyHint 不作为免审批依据。MCP env/headers 保存在本机数据目录的 extensions.json，设置页显示掩码；原样保存掩码保留旧值，改变目标地址/命令后需重新填写密钥。该文件包含敏感配置时请勿分享。

## 测试 Skills

便携包的默认 workspace 已带示例技能 win7-smoke-test。打开“设置 → Skills”可查看发现列表，再发送：“使用 win7-smoke-test 技能，按它的说明返回测试标记。”正常结果包含 PI-WIN7-SKILL-READY；工具记录应出现 read_skill。

自动发现当前工作目录的 .agents/skills 和 .pi/skills 中的 SKILL.md；切换到其他项目后，可把 examples/skills 的绝对路径加到“附加目录”。支持 name、description 的常用 YAML frontmatter 写法和按相对路径读取支持文件。Skills 开关关闭后不会注入技能目录，也不会提供 read_skill。启用时仅把名称和描述加入提示词，完整文件由模型需要时加载，不会在发现时执行脚本，也不会改变工具权限。

## 上下文窗口

“设置 → 模型与上下文”只需填写**上下文长度**，默认 64000，单位 tokens。最大输出、压缩预留、近期保留量和安全余量全部自动计算，只读显示；旧版手工填写的这些预算会重新派生，自动压缩开关继续保留。

例如填写 `100000`：最大输出 4096，安全余量 2000，实际输入预算 93904；压缩预留 25088，估算使用量接近 74912 时开始压缩；近期保留目标 31232，摘要最大输出 3200。近期保留量会根据工具组边界和实际空间调整。输出预算实际传给 API 的 `max_tokens`，此设置不会扩展模型本身能力，服务还须支持相应输出长度。

用量包含系统提示、工具定义、消息和工具结果，采用保守字符估算，并非服务商分词器的精确计数。自动压缩默认开启，用 Pi 原版摘要提示生成检查点，保留近期消息、最新用户要求和完整工具调用/结果；支持分块摘要、增量摘要及重启恢复，本地完整历史不删除。摘要失败或取消不会覆盖旧检查点；禁止静默丢弃旧历史来绕过超限。关闭自动压缩后，超限会报错，仍可点击“立即压缩”。服务商报告超窗时，自动压缩开启则强制摘要后重试一次。当前单个用户输入上限50000字符，每次任务最多20轮模型调用，多次对话可持续累积；单个会话状态文件上限64 MiB，达到写入上限会明确停止并报错。

长对话验证采用真实 Pi 循环和离线模拟模型，检查请求预算、完整工具组、反复压缩及重启后续聊；它验证程序流程，不代表真实模型在任何长对话中都能无损保留语义。真实服务的摘要质量、准确 token 数和模型上限仍需接入后验证。

## DSH 提示词与项目资源

“设置 → 提示词与资源”提供 DSH 标准与精简 Agent 提示词预设，可查看实际模板及来源。它们来自 DSH 固定提交的 Web 预设及工具说明，并按当前工具名称适配。PTC/Cordis 需要尚未迁入的执行器/动态插件，不会以空壳模式启用。这些是 Agent 系统预设，不是虚构的 DSH 写作模板列表。

项目指令遵循 Pi 的加载规则：每层 AGENTS.md 优先于 CLAUDE.md；可读取祖先目录，也可在资源设置关闭。全局 Pi 目录由用户明确填写，不默认扫描用户目录。.pi/SYSTEM.md 替换基础 persona，.pi/APPEND_SYSTEM.md 追加指令；后台权限和实际工具边界始终生效。

项目 .pi/prompts/*.md、显式全局 Pi 目录/prompts 和附加路径提供可复用任务模板。网页“使用”按钮展开到输入框，检查后发送；支持 Pi 的 $1、$ARGUMENTS、$@、${@:N} 参数。包内 examples/prompts/win7-review.md 是本适配版的示例，有明确来源标记。

会话菜单可重命名、从当前位置分支、下载 HTML 或 Pi v3 JSONL。分支保留原会话记录。运行中可用“插入指令”在下一次工具边界引导 Agent，或用“排队跟进”在当前任务结束后继续；使用的是真正 Pi Agent.steer/followUp。任务仍受20轮模型调用限制，停止或失败后，尚未执行的排队文字会保存为草稿，可在网页恢复到输入框，重启后仍保留。

移植来源、原版复用与兼容改写的区分见 PI-MIGRATION.md。本产品提供 Web 工作台，不附带 Pi CLI/TUI。

## 开发与打包

**构建机使用现代 Node（建议 22+）；Win7 只运行打包结果，不在 Win7 上运行 npm install。**

```text
npm ci
node scripts/fetch-runtime.js
npm run fetch:python
npm run build
npm test
.runtime\x64\node.exe scripts/test-runtime.js
npm run package
```

`fetch-runtime.js` 从 Node 官方站点下载 12.22.12 的 `node.exe`，核对同站 `SHASUMS256.txt`，并附带完整 Node 许可证和运行时元数据。`package.js` 再次校验 SHA-256，并将运行时、前后端、许可证和启动器复制到 `release`。若对应版本输出目录非空会停止，避免旧工作文件混入重新打包。不复制 `.state`、密钥、工作文件或开发依赖。

0.7.0 完整便携包仅支持 x64；打包器拒绝把 x64 Python 混入 x86 包。

Python 构建在现代 Windows x64 上执行：`fetch-python.js` 下载官方 ZIP 与精确 wheel，校验锁文件 SHA256、官方 Python PGP 签名，然后用隔离的构建解释器和固定 pip 离线安装并核验依赖。需要构建机有 GPG（例如 Git for Windows 自带版本，或 `--gpg` 显式指定）；不修改系统 Python，不向用户运行时安装 pip。再次构建可用 `node scripts/fetch-python.js --offline` 复用已核验缓存。独立验证：`node scripts/python/test-build.js`（ZIP/PE 解析边界）与 `node scripts/python/verify-runtime.js`（完整性、中文路径搬迁、文档和本地 HTTP）。打包再次校验全部 Python 文件，拒绝缺失、改动或多余内容。

开发启动：`npm start`。可用参数：`--workspace`、`--port`、`--state-dir` 和可重复的 `--allow-exe`。模型环境变量：`PI_BASE_URL`、`PI_MODEL`、`PI_API_KEY`。未指定工作目录且没有已保存设置时，默认使用固定数据目录中的 `workspace`；开发隔离测试可传 `--state-dir` 与 `--workspace`。

## 兼容设计与测试边界

- 锁定 Pi 0.51.6，真实使用其 `Agent`、agent loop、事件流和 AJV 工具参数验证。
- 只在构建时将 `pi-ai` 的宽入口替换为所需的真实 Pi 模块；不加载现代供应商 SDK。
- 自定义 `streamFn` 用 Node 原生 `http/https` 实现 SSE、工具调用片段拼接、取消和错误收尾。
- esbuild 将服务端打包为 Node 12.22 可执行的独立 CJS，补齐 `AbortController` 和 `structuredClone`；Node 服务不依赖 `node_modules` 或原生 Node 扩展；Python 包含清单中记录的原生 DLL/PYD。
- 前端使用浏览器原生功能，不依赖 CDN；以 Chrome 102 为构建目标，不使用现代文件系统授权 API 来替代后端。
- 自动化集成测试使用本地模拟模型服务，覆盖真实 Pi 文件工具调用和后续模型回合，不消耗 API 额度。
- Node 12.22.12 的官方构建曾支持 Win7；该运行时已停止维护。便携兼容路线的代价是维护旧运行时。服务限定本机访问，仍需要对真实模型端点的 TLS、企业证书和代理另行验收。
- **当前电脑运行旧 Node 成功，不代表所有 Win7 补丁水平都已验证；Chrome 102 实机测试和真实模型账号测试需要目标环境。**

## 来源

- Pi：<https://github.com/badlogic/pi-mono>，固定 npm 包 `@mariozechner/pi-agent-core@0.51.6` / `@mariozechner/pi-ai@0.51.6`，MIT。
- Web 界面复用和适配 DeepSeek Harness 的主题、字体、布局与组件样式，固定来源提交 `639ed015397290b3745d163aafe02ffee4aa3f84`：<https://github.com/deepseek-ai/deepseek-harness/tree/639ed015397290b3745d163aafe02ffee4aa3f84>。保留其 MIT 许可证及所用字体许可证；连接现有 Pi 后端，不包含 DSH 的插件后端或账号服务。
- Node 12 平台要求：<https://github.com/nodejs/node/blob/v12.22.12/BUILDING.md>。
- 构建输出包含 `dist/THIRD_PARTY_NOTICES.txt` 和 `dist/build-meta.json`，可检查实际打包依赖及许可证。
