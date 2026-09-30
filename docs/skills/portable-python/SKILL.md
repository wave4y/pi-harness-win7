---
name: portable-python
description: 使用随包 Python 和 run_python 处理 HTTP/JSON、CSV/Excel、Word DOCX、PowerPoint PPTX 或图片；实际内置 Skill 位于 builtin-skills/portable-python。
---

# 便携 Python

本 Skill 已实现；自动发现入口为 [builtin-skills/portable-python/SKILL.md](../../../builtin-skills/portable-python/SKILL.md)。这里保留原设计文档路径，使用时读取该入口及任务所需脚本。

运行时由宿主提供。实际使用前检查工具列表中的 `run_python`；缺失时说明需要带 Python 的版本，不假设系统已安装 Python，也不自行下载解释器或安装包。

## 调用方式

1. 按需要读取用户指定的输入文件，确认输出位置。用 `write_file` 将 Python 3.8 兼容脚本保存到当前工作目录，例如 `.agent-python/task.py`。
2. 调用 `run_python`，提交 `script` 路径、字符串数组 `args`，必要时设置 `cwd` 和 `timeoutMs`。自定义脚本相对工作区解析；内置支持脚本可用其真实绝对路径调用。解释器由宿主选择；不要使用 `python` PATH 搜索、激活虚拟环境，或启动 CMD/PowerShell。
3. 使用 UTF-8 文本与 `pathlib.Path` 处理中文路径。不要采用 Python 3.9+ 才有的语法/API，例如 `str.removeprefix` 或运行时内置泛型标注；需要注解时使用 `typing`。
4. 工具仍遵循当前审批模式。拒绝执行后不要改用另一进程工具绕过。Python 使用当前 Windows 用户权限，不是文件沙箱。

## 选择包

| 任务 | 安装分发名 | Python 导入名 | 做法 |
| --- | --- | --- | --- |
| HTTP/JSON | requests | requests | 设置连接和读取超时，保留 TLS 验证；大响应分块读取；不要打印认证头或密钥 |
| CSV、表格统计 | pandas、numpy | pandas、numpy | 明确编码、分隔符、日期与缺失值；输出行数/列名便于核对 |
| Excel XLSX | openpyxl、XlsxWriter | openpyxl、xlsxwriter | 编辑现有工作簿用 openpyxl；生成新工作簿可用 XlsxWriter；复杂原有格式不要只经 DataFrame 往返 |
| Word DOCX | python-docx | docx | 处理 OOXML，不依赖已安装的 Microsoft Word；不要安装名称为 docx 的另一个分发包 |
| PowerPoint PPTX | python-pptx | pptx | 处理 OOXML，不依赖已安装的 PowerPoint；不要安装名称为 pptx 的另一个分发包 |
| 图片 | Pillow | PIL | 按实际需要读取/缩放/转换；不假设当前可用额外格式插件 |
| XML/HTML | lxml | lxml | 对非可信 XML 禁止外部实体和网络解析 |

使用运行时清单中的实际版本；缺包或 DLL 导入失败时报告具体包名和错误，不在目标 Win7 上临时 `pip install`，也不把安装成功当作系统兼容证明。

## 检查结果

内置 [self_test.py](../../../builtin-skills/portable-python/scripts/self_test.py) 支持 `--output-dir`，在该目录下创建唯一的中文空格子目录，默认离线、不覆盖原文件；生成并重开 CSV/XLSX/DOCX/PPTX/PNG/JPEG，检查 NumPy 运算和 XML。输出包含真实产物路径与逐项结果的 JSON，退出码为 0/1。可通过 `run_python` 调用，设置 `timeoutMs: 120000`。另有六个独立任务示例，按内置 Skill 的路由表按需读取。

- 默认将新产物保存为新文件。需要覆盖用户原文件时，先确认当前请求确实要求覆盖。
- XLSX 保存后重新打开，检查关键工作表、行列和公式；DOCX 检查段落/表格；PPTX 检查页数及目标文本；图片重新加载检查尺寸和格式。检查失败不得报告已完成。
- docx/pptx 成功重新打开只证明文件结构可读，不证明 Office 排版正确。本包未承诺随附 Office 或 PDF 渲染器；有可用渲染工具时再做视觉检查，并如实说明检查范围。
- 完成后报告输出文件的真实路径和实际验证结果。外部网络写入、上传或发送文件依然需要用户对该动作的授权，安装了 requests 不代表已有授权。
- 当前操作系统运行成功不能替代在 Win7 上的实际测试。
