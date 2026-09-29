---
name: win7-smoke-test
description: 测试本机 Skills 按需加载、支持文件读取和 Pi 的只读文件工具。
---

# Win7 Skills 测试

当用户要求测试这个 Skill 时：

1. 先调用 `read_skill`，以 `skill: "win7-smoke-test"`、`path: "checklist.md"` 读取支持文件。
2. 调用 `list_directory` 列出当前工作目录第一层条目。
3. 用中文报告支持文件中的测试标记，以及实际看到的目录条目数量。
4. 明确写出：“Skill 通过按需读取加载，未运行脚本。”

不要创建、修改或删除任何文件。此 Skill 不会扩展当前会话的权限。
