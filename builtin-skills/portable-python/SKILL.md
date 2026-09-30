---
name: portable-python
description: 使用随包 Python 和 run_python 处理 HTTP/JSON、CSV/Excel、Word DOCX、PowerPoint PPTX 或图片；也用于验证便携 Python 的文档和数据处理能力。
---

# 便携 Python

使用工具列表中的 `run_python`。解释器和依赖由宿主提供；工具缺失或报告运行时不可用时，说明具体缺失项，不搜索系统 Python、不启动 CMD/PowerShell，也不自行安装包。

## 执行

- 自定义任务先用 `write_file` 将 Python 3.8 兼容脚本写到工作区，例如 `.agent-python/task.py`，再调用 `run_python`：

  ```json
  {"script":".agent-python/task.py","args":["--output","成果/分析.csv"],"timeoutMs":120000}
  ```

- `script` 相对工作区解析；`cwd` 可指定脚本工作目录，默认工作区。`args` 是字面字符串数组，不拼 shell 命令。支持脚本可直接使用本 Skill 目录下的绝对路径；从当前加载的 `SKILL.md` 路径定位，不猜安装目录。只读/工作区模式运行 Python 需要逐次批准，完全访问模式依照宿主设置执行。被拒绝后不要换工具绕过。
- 使用 `pathlib.Path` 处理中文路径，读写文本明确 `encoding="utf-8"`（面向旧 Excel 的 CSV 可用 `utf-8-sig`）。不用 Python 3.9+ 的语法/API，如 `str.removeprefix` 或运行时 `list[str]` 注解。
- 依赖以实际运行时清单和导入结果为准；缺包/DLL 错误应报告原异常，不在目标 Win7 临时 `pip install`。Python 具有当前 Windows 用户权限，并非文件沙箱。

## 按任务读取资源

只读所需示例，不预先加载全部脚本。下面示例生成新文件，`--output` 已存在会失败；它们是可调整的起点，不会自动处理用户现有文件。

| 任务 | 示例与参数 | 关键选择 |
| --- | --- | --- |
| HTTP JSON | [requests_get.py](scripts/requests_get.py)：`--url URL --output 响应.json` | 仅 GET；连接/读取超时、TLS 校验、响应大小限制，不打印认证信息；不会自动跟随重定向 |
| CSV / 统计 | [pandas_csv.py](scripts/pandas_csv.py)：`--output 汇总.csv`；可选 `--input 输入.csv` | 示例输入字段为 `项目,数量,单价`；明确类型和缺失值，NumPy 计算金额，保存后重读核对 |
| Excel XLSX | [excel_workbook.py](scripts/excel_workbook.py)：`--output 报表.xlsx` | XlsxWriter 生成样式/公式/缓存值，openpyxl 检查；编辑现有文件用 openpyxl，复杂格式避免 DataFrame 往返 |
| Word DOCX | [word_document.py](scripts/word_document.py)：`--output 报告.docx` | 导入名 `docx`，分发名 `python-docx`；重开核对段落/表格，不依赖 Word |
| PowerPoint PPTX | [powerpoint_slides.py](scripts/powerpoint_slides.py)：`--output 汇报.pptx` | 导入名 `pptx`，分发名 `python-pptx`；重开核对页数/文字，不依赖 PowerPoint |
| 图片 | [pillow_image.py](scripts/pillow_image.py)：`--output 预览.png`；可选 `--input 原图.png` | Pillow 使用 `PIL` 导入；校正 EXIF 朝向，等比缩小，重开核对尺寸/格式 |

处理不可信 XML 时，使用 `lxml.etree.XMLParser(resolve_entities=False, no_network=True)`。HTTP 写入、上传、发送文件仍需该任务的授权；已安装 requests 不代表用户已授权外部操作。

## 离线自检

用户要求验证运行环境时，调用 [self_test.py](scripts/self_test.py)，不要用生成示例代替用户要求的实际产物：

```json
{"script":"本 Skill 绝对目录/scripts/self_test.py","args":["--output-dir","成果/Python 自检"],"timeoutMs":120000}
```

将 `script` 替换成真实路径。脚本在输出目录新建唯一的中文空格子目录，不覆盖已有文件；默认不联网。它检查依赖导入、NumPy 矩阵运算和 XML，生成并重开 CSV、XLSX、DOCX、PPTX、PNG、JPEG。标准输出为 JSON，`ok` 和每项 `checks[].ok` 表示结果，退出码为 0/1。`outputDirectory` 和各项 `files` 给出真实产物路径。HTTP 能力可另用 requests 示例访问用户指定地址或本地测试服务。

## 完成前验证

保存后重新打开实际交付文件并核对关键内容。XLSX 公式写入与缓存值不等于完整公式重算；DOCX/PPTX 重新打开只证明文件结构和内容可读，不证明 Office 排版正确。有可用渲染工具时再检查视觉效果，并如实报告验证范围。

说明真实输出路径、核对结果和未验证部分。当前系统运行成功不能替代用户在 Win7 上的实际测试。
