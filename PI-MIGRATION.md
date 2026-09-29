# Pi / DSH 移植记录

目标是 Windows 7 SP1、Chrome 102 的 Web 工作台。没有把 Pi CLI、TUI、Bash 或 Shell 入口装进运行包。

| 能力 | 来源与接入方式 |
| --- | --- |
| Agent 工具循环、参数验证、流式事件、steer/followUp | 原版 @mariozechner/pi-agent-core / pi-ai 0.51.6；复用实际模块 |
| 会话 parentId 树、分支上下文、v3 JSONL | 原版 Pi coding-agent SessionManager、messages 源文件；仅 randomUUID/fs.promises/config 默认路径经 Node12 shim 适配 |
| 自动/手动压缩 | Pi 0.51.6 原版摘要/更新提示词；0.4.0 根据唯一上下文长度自动派生预留/近期/输出预算，适配 Web 持久化、中文估算、完整工具组和分块请求 |
| 项目指令、系统提示、Markdown 模板及参数 | 按 Pi resource-loader、system-prompt、prompt-templates 原版规则移植；加有界读取和显式全局路径 |
| 重试 | 沿用 Pi 的有限重试策略，用兼容 Node12 的原生 HTTP 实现；已输出的请求不重放，实际超窗最多压缩重试一次 |
| Skills | SKILL.md 发现、名称/描述渐进加载、只读支持文件，兼容 .pi/skills 与 .agents/skills；不宣称完整 YAML 或自动脚本执行 |
| 文件工具 | 为无 Shell 与权限模式定制的 Node12 工具；没有用模糊匹配静默改写文件无关区域 |
| DSH UI | 锁定提交639ed015397290b3745d163aafe02ffee4aa3f84的主题、字体、CSS/SVG与权限交互；Web交互接入Pi后台 |
| DSH内置系统预设 | 标准/精简 persona及适用工具指导；按本版实际工具名改写。PTC/Cordis依赖未迁入功能，禁用并标明原因 |
| MCP | 独立Node12协议适配，stdio + Streamable HTTP；第三方服务需要自身兼容Win7 |

当前 Web 的完整历史仍使用原有 JSON 归档；Pi SessionManager用于真实分支构建与标准导出，而非声称整个 AgentSession 已原样运行。HTML 导出为本版安全的静态文本模板。

## 当前未接入

- Pi 完整动态 TypeScript ExtensionAPI、Pi npm/git 包安装器及依赖 TUI 的扩展组件。
- Pi CLI/TUI、终端交互、PTY、Bash、外部编辑器和原生剪贴板/图像依赖。
- DSH PTC run_code、Cordis 动态插件运行器及实验性 Auto review。
- 原生 Anthropic/Responses 等额外模型协议、OAuth、独立 MCP resources/prompts 面板。
- 会话共享上传、后台作业/进程树隔离、跨项目全局搜索。

这些能力没有被界面开关伪装成已实现。原包标注 Node>=20；整包直接导入会连带现代 SDK、TUI、jiti 和原生/WASM依赖，所以按实际可验证模块移植。

Pi源码来自官方npm @mariozechner/pi-coding-agent@0.51.6（tarball shasum 97448b940854f16deb6bb144cb2fa4fdb88e3e73）和对应Git标签。出处与改写记录见 src/vendor 下的 PROVENANCE.txt；发布包保留 dist/THIRD_PARTY_NOTICES.txt。
