# 便携 Python 与内置 portable-python Skill 设计

状态：**0.7.0 已按本设计实现，Win7 实机验收待进行**。本文保留原方案的来源核查与候选矩阵；当前构建脚本、精确锁文件和实际 Skill 分别位于 scripts/fetch-python.js、scripts/python-runtime-lock.json 和 builtin-skills/portable-python。0.7.0 以含自检脚本的 x64 预发布验收包交付，不宣称原生包已通过 Win7 实测。核查日期：2026-09-30。

## 1. 建议与已验证范围

解释器采用 **Python.org 官方 CPython 3.8.10 x64 embeddable ZIP** 作为首个可复现的兼容性基线。目标系统写为 **Windows 7 SP1 x64，具备必要的系统更新和 C Runtime**。先完成这一条运行链，再评估社区新版解释器。

3.8.10 是 3.8 最后一个常规维护版本，并提供官方 Windows 嵌入包；后续 3.8 安全版本只发布源码。Python 3.8 已于 2024-10-07 结束支持。因此，“官方历史兼容基线”不表示“仍获安全维护”。[Python 3.8.10 官方发布页](https://www.python.org/downloads/release/python-3810/)、[Python 官方 Windows 使用说明](https://docs.python.org/3/using/windows.html)。

设计阶段完成了以下**资料核查**（实现和测试结果另见根目录 VALIDATION.md）：

- 实时读取 PyPI JSON，检查候选包的 `Requires-Python`、非 extra 依赖、指定 wheel 文件名、大小、SHA256、`yanked=false`。
- 阅读 CPython 固定版本源码文档、Microsoft 部署文档、NumPy 官方问题讨论和 Pillow 官方平台表。
- 设计阶段仅联网读取文本及 JSON。后续 0.7.0 构建已加入下载字节校验、隔离离线安装、运行时探测和工具集成；尚未在 Win7 上运行导入测试。

因此，目前确认的是**候选依赖闭包有 Python 3.8 / Windows x64 可用的分发文件**。所有包含原生代码的包还必须通过第 8 节验收，才能成为本产品的 Win7 发布基线。`cp38-cp38-win_amd64` 描述解释器、ABI 和平台，文件名没有表达 Windows 的最低系统版本。[PyPA wheel 平台标签规范](https://packaging.python.org/en/latest/specifications/platform-compatibility-tags/)。

## 2. 解释器选型

| 方案 | 作用 | 取舍 |
| --- | --- | --- |
| 官方 3.8.10 x64 embeddable | 首轮实现和 Win7 复现基线 | 来源清楚、约 7.8 MB ZIP；解释器及其旧 OpenSSL 已停止维护，须记录在组件清单中 |
| 自行编译官方 3.8.20 源码 | 后续兼容性研究 | 3.8 最终源码补丁更全，但不是 Python.org 官方 Windows 二进制；需自行维护构建、签名和测试，且 3.8 仍已 EOL |
| 社区新版 Python 兼容发行版 | 独立实验通道 | 可获得较新的 Python，但增加补丁、兼容 DLL 和构建链；解释器能启动也不意味着第三方 wheel 能运行 |

官方文件名固定为 `python-3.8.10-embed-amd64.zip`，从 [Python.org 3.8.10 下载目录](https://www.python.org/ftp/python/3.8.10/) 获取。实施时核验发布签名，并将实收文件 SHA256 写入构建清单；本轮没有下载该 ZIP，不能给出自行计算的散列。

原 `adang1345/PythonWin7` 地址目前重定向到维护者的 [PythonVista 仓库](https://github.com/adang1345/PythonVista)。其 README 声明支持 Win7 SP1，提供 embeddable 包，并说明新版包含源码兼容补丁及 `api-ms-win-core-path-l1-1-0.dll`。这是**社区发行者自己的支持声明**，不是 PSF 对新版 Python 的 Win7 支持。若进入实验通道，单独固定版本、提交、下载文件和散列，不直接追踪“latest”，不覆盖官方基线目录。

## 3. 原生依赖的 Win7 证据与候选矩阵

| 组件 | 核查结果 | 本项目决定 |
| --- | --- | --- |
| NumPy 1.24.4 | 有 cp38 x64 wheel；1.24 发布文档保留 Win7 支持文字，但官方 issue 中维护者明确表示 Win7 已不受支持。32 位 Python 的 1.24 导入崩溃有多份报告 | 不把旧文档当作当前保证；先测 1.23.5，1.24.4 放在扩展矩阵 |
| NumPy 1.23.5 | 有 cp38 x64 wheel；NumPy 维护者针对上述 Win7 故障建议使用 1.23.5 或更早版本 | 首测候选，仍不是本项目的实测结果 |
| NumPy 1.21.6 | 有 cp38 x64 wheel，Python 要求 `>=3.7,<3.11` | 回退比较候选；没有证据证明它是统一适用的“最后 Win7 版本” |
| pandas 2.0.3 | 官方文档支持 Python 3.8，PyPI 有 cp38 x64 wheel；未找到足以证明这一 wheel 在目标 Win7 环境工作的证据 | 首测候选，与 NumPy 1.23.5 组成 A 组 |
| pandas 1.3.5 | 有 cp38 x64 wheel；本轮同样没有完成 Win7 DLL/导入验证 | 与 NumPy 1.21.6 组成 B 组，不能提前贴“已兼容”标签 |
| Pillow 10.4.0 | 有 cp38 x64 wheel；官方平台表的 Win7 测试记录只列 Python 3.7 / Pillow 7.0.0 | 图片功能单独验收；9.5.0 可用于回退对比，也不是认证版本 |
| lxml 6.1.3 | 有 cp38 x64 wheel，Python 要求 `>=3.8`；未找到该 wheel 的 Win7 运行保证 | 单独验收原生依赖；4.9.4 仅作诊断对比，不静默降级 |

NumPy 证据应一并阅读：[1.24 发布文档](https://numpy.org/doc/1.24/dev/releasing.html)、[#23324 维护者回复](https://github.com/numpy/numpy/issues/23324#issuecomment-1453563758)、[#24832 维护者的回退建议](https://github.com/numpy/numpy/issues/24832#issuecomment-1741706225)、[#23731 关于 MSVC 2019 / 老 CPU 的讨论](https://github.com/numpy/numpy/issues/23731#issuecomment-1540871247)。其中 #23324 的机器虽然是 64 位 Windows，使用的却是 **32 位 Python**；#24832 报告者还称 64 位 Python 可以工作。不能将这些报告泛化为所有 x64 wheel 必然失败，也不能将单个用户报告视为产品认证。

其他边界来自 [pandas 2.0.3 安装文档](https://pandas.pydata.org/pandas-docs/version/2.0/getting_started/install.html)、[Pillow 官方平台表](https://pillow.readthedocs.io/en/stable/installation/platform-support.html)、[lxml 6.1.3 发布记录](https://pypi.org/project/lxml/6.1.3/)。lxml 6.1.3 修复了默认外部参数实体解析问题；不能因为旧版本“可能更兼容”就忽略已知修复。若新 wheel 的 DLL 无法加载，先查清缺失 API/运行库，再决定受控重编译或独立兼容配置。

**首测顺序**：标准库与纯 Python 请求链 → A 组 `numpy==1.23.5` / `pandas==2.0.3` → lxml / Pillow / Office 文件功能。A 组失败才定位后对比 B 组 `numpy==1.21.6` / `pandas==1.3.5`。成功结果须记录确切文件散列、OS 补丁、解释器位数、CPU 和测试日志。当前不宣布任何原生组合已经通过 Win7。

## 4. 精确依赖候选与闭包

下表是 **A 组首测候选清单**，不是已经验收的发布锁文件。每行来源均为该版本的 PyPI JSON；不存在 `>=` 浮动安装。`py3` 和 `py2.py3` 均指 `none-any` 纯 Python wheel。四个原生组件为 NumPy、pandas、lxml、Pillow。

| 分发包固定版本 | Python 要求（摘要） | 选定 wheel 标签 | 运行依赖 / 用途 | 元数据 |
| --- | --- | --- | --- | --- |
| requests==2.32.4 | >=3.8 | py3 | charset-normalizer、idna、urllib3、certifi | [JSON](https://pypi.org/pypi/requests/2.32.4/json) |
| urllib3==2.2.3 | >=3.8 | py3 | HTTP/TLS 底层；不启用 extras | [JSON](https://pypi.org/pypi/urllib3/2.2.3/json) |
| charset-normalizer==3.4.4 | >=3.7 | **py3** | 特意选择纯 Python wheel，减少原生 DLL | [JSON](https://pypi.org/pypi/charset-normalizer/3.4.4/json) |
| idna==3.10 | >=3.6 | py3 | IDNA 主机名 | [JSON](https://pypi.org/pypi/idna/3.10/json) |
| certifi==2026.7.22 | >=3.7 | py3 | 固定 CA 证书数据；随产品版本更新 | [JSON](https://pypi.org/pypi/certifi/2026.7.22/json) |
| numpy==1.23.5 | >=3.8 | cp38-cp38-win_amd64 | 数值计算，原生 DLL / CPU 验收项 | [JSON](https://pypi.org/pypi/numpy/1.23.5/json) |
| pandas==2.0.3 | >=3.8 | cp38-cp38-win_amd64 | numpy、python-dateutil、pytz、tzdata | [JSON](https://pypi.org/pypi/pandas/2.0.3/json) |
| python-dateutil==2.9.0.post0 | 支持 3.8 | py2.py3 | six | [JSON](https://pypi.org/pypi/python-dateutil/2.9.0.post0/json) |
| six==1.17.0 | 支持 3.8 | py2.py3 | python-dateutil 的依赖 | [JSON](https://pypi.org/pypi/six/1.17.0/json) |
| pytz==2025.2 | 未声明 Requires-Python | py2.py3 | pandas 时区依赖 | [JSON](https://pypi.org/pypi/pytz/2025.2/json) |
| tzdata==2025.2 | >=2 | py2.py3 | pandas 时区数据 | [JSON](https://pypi.org/pypi/tzdata/2025.2/json) |
| python-docx==1.1.2 | >=3.7 | py3 | lxml、typing-extensions；导入名 docx | [JSON](https://pypi.org/pypi/python-docx/1.1.2/json) |
| python-pptx==1.0.2 | >=3.8 | py3 | Pillow、XlsxWriter、lxml、typing-extensions；导入名 pptx | [JSON](https://pypi.org/pypi/python-pptx/1.0.2/json) |
| lxml==6.1.3 | >=3.8 | cp38-cp38-win_amd64 | XML；捆绑原生库须审计 | [JSON](https://pypi.org/pypi/lxml/6.1.3/json) |
| Pillow==10.4.0 | >=3.8 | cp38-cp38-win_amd64 | 图片；导入名 PIL | [JSON](https://pypi.org/pypi/Pillow/10.4.0/json) |
| XlsxWriter==3.2.5 | >=3.8 | py3 | 写 xlsx / pptx 图表数据 | [JSON](https://pypi.org/pypi/XlsxWriter/3.2.5/json) |
| openpyxl==3.1.5 | >=3.8 | py2.py3 | et-xmlfile；读写 xlsx | [JSON](https://pypi.org/pypi/openpyxl/3.1.5/json) |
| et-xmlfile==2.0.0 | >=3.8 | py3 | openpyxl 的 XML 写入依赖 | [JSON](https://pypi.org/pypi/et-xmlfile/2.0.0/json) |
| typing-extensions==4.13.2 | >=3.8 | py3 | docx/pptx 的类型兼容依赖 | [JSON](https://pypi.org/pypi/typing-extensions/4.13.2/json) |
| defusedxml==0.7.1 | 支持 3.8 | py2.py3 | XML 读取辅助；不是所有解析器的自动保护层 | [JSON](https://pypi.org/pypi/defusedxml/0.7.1/json) |

闭包校核结果：

- Requests 要求 `charset_normalizer>=2,<4`、`idna>=2.5,<4`、`urllib3>=1.21.1,<3`、`certifi>=2017.4.17`，上述固定值满足元数据约束。
- Python 3.8 下 pandas 2.0.3 要求 `numpy>=1.20.3`、`python-dateutil>=2.8.2`、`pytz>=2020.1`、`tzdata>=2022.1`；NumPy 1.23.5 满足该声明。此结论仅是版本约束成立，不是 ABI/系统加载测试。
- docx 要求 `lxml>=3.1.0`、`typing-extensions>=4.9.0`；pptx 另要求 `Pillow>=3.3.2`、`XlsxWriter>=0.5.7`，固定值均满足。
- 不启用 `requests[socks]`、`pandas[all]`、lxml 的 HTML extras、测试或文档 extras；不顺带引入 SciPy、PyArrow、Jupyter、浏览器、Office COM 或编译器。
- openpyxl 的 XML 风险说明建议安装 defusedxml，因此列入候选；仍需限制文档和解压大小。[openpyxl 官方说明](https://openpyxl.readthedocs.io/en/stable/)。

构建工具单独固定 `pip==25.0.1`（[PyPI 元数据](https://pypi.org/pypi/pip/25.0.1/json)，Requires-Python >=3.8），不作为用户运行时能力。以上版本是一次具体候选，不表示所有包都是当前最新版本，也不表示已经完成漏洞审计。

### 核对过的精确 wheel 与 SHA256

以下散列直接来自上述 PyPI JSON；0.7.0 构建脚本按精确锁文件校验下载字节，不只核对文件名。`charset-normalizer` 只能使用这里列出的纯 Python 文件。

```text
requests-2.32.4-py3-none-any.whl 27babd3cda2a6d50b30443204ee89830707d396671944c998b5975b031ac2b2c
urllib3-2.2.3-py3-none-any.whl ca899ca043dcb1bafa3e262d73aa25c465bfb49e0bd9dd5d59f1d0acba2f8fac
charset_normalizer-3.4.4-py3-none-any.whl 7a32c560861a02ff789ad905a2fe94e3f840803362c84fecf1851cb4cf3dc37f
idna-3.10-py3-none-any.whl 946d195a0d259cbba61165e88e65941f16e9b36ea6ddb97f00452bae8b1287d3
certifi-2026.7.22-py3-none-any.whl 62f22742b58a1a33014a2b6b706588a8d7e2a88ae7bd1a6ebe8c992928483775
numpy-1.23.5-cp38-cp38-win_amd64.whl ca51fcfcc5f9354c45f400059e88bc09215fb71a48d3768fb80e357f3b457e1e
pandas-2.0.3-cp38-cp38-win_amd64.whl 69d7f3884c95da3a31ef82b7618af5710dba95bb885ffab339aad925c3e8ce78
python_dateutil-2.9.0.post0-py2.py3-none-any.whl a8b2bc7bffae282281c8140a97d3aa9c14da0b136dfe83f850eea9a5f7470427
six-1.17.0-py2.py3-none-any.whl 4721f391ed90541fddacab5acf947aa0d3dc7d27b2e1e8eda2be8970586c3274
pytz-2025.2-py2.py3-none-any.whl 5ddf76296dd8c44c26eb8f4b6f35488f3ccbf6fbbd7adee0b7262d43f0ec2f00
tzdata-2025.2-py2.py3-none-any.whl 1a403fada01ff9221ca8044d701868fa132215d84beb92242d9acd2147f667a8
python_docx-1.1.2-py3-none-any.whl 08c20d6058916fb19853fcf080f7f42b6270d89eac9fa5f8c15f691c0017fabe
python_pptx-1.0.2-py3-none-any.whl 160838e0b8565a8b1f67947675886e9fea18aa5e795db7ae531606d68e785cba
lxml-6.1.3-cp38-cp38-win_amd64.whl d44442effeb8781f392340c5dc8c6716fba41dbeacb82fd4c0f09026fb5ff682
pillow-10.4.0-cp38-cp38-win_amd64.whl 5161eef006d335e46895297f642341111945e2c1c899eb406882a6c61a4357ab
xlsxwriter-3.2.5-py3-none-any.whl 4f4824234e1eaf9d95df9a8fe974585ff91d0f5e3d3f12ace5b71e443c1c6abd
openpyxl-3.1.5-py2.py3-none-any.whl 5282c12b107bffeef825f4617dc029afaf41d0ea60823bbb665ef3079dc79de2
et_xmlfile-2.0.0-py3-none-any.whl 7a91720bc756843502c3b7504c77b8fe44217c85c537d85037f0f536151b2caa
typing_extensions-4.13.2-py3-none-any.whl a439e7c04b49fec3e5d3e2beaa21755cadbbdc391694e28ccdd36ca4a1408f8c
defusedxml-0.7.1-py2.py3-none-any.whl a352e7e428770286cc899e2542b6cdaedb2b4953ff269a210103ec58f6198a61
```

回退/比较候选同样已核实有对应文件，尚未 Win7 实测：

| 版本 | 精确 cp38 x64 wheel SHA256 | 来源 |
| --- | --- | --- |
| numpy 1.21.6 | bf2ec4b75d0e9356edea834d1de42b31fe11f726a81dfb2c2112bc1eaa508fcf | [JSON](https://pypi.org/pypi/numpy/1.21.6/json) |
| numpy 1.24.4 | 692f2e0f55794943c5bfff12b3f56f99af76f902fc47487bdfe97856de51a706 | [JSON](https://pypi.org/pypi/numpy/1.24.4/json) |
| pandas 1.3.5 | a395692046fd8ce1edb4c6295c35184ae0c2bbe787ecbe384251da609e27edcb | [JSON](https://pypi.org/pypi/pandas/1.3.5/json) |
| lxml 4.9.4 | 701847a7aaefef121c5c0d855b2affa5f9bd45196ef00266724a80e439220e46 | [JSON](https://pypi.org/pypi/lxml/4.9.4/json) |
| Pillow 9.5.0 | e49eb4e95ff6fd7c0c402508894b1ef0e01b99a44320ba7d8ecbabefddcc5569 | [JSON](https://pypi.org/pypi/Pillow/9.5.0/json) |

## 5. 离线构建与便携目录

0.7.0 随包目录（另含 runtime-probe.py、developer-probe.json 和 pe-imports.json）：

```text
runtime/python38-x64/
  python.exe
  python38.dll
  python38.zip
  python38._pth
  Lib/site-packages/
  LICENSE.txt
  THIRD_PARTY_NOTICES.txt
  runtime-manifest.json
builtin-skills/
  portable-python/
    SKILL.md
    references/
    scripts/
```

构建发生在开发机/CI，用户 Win7 运行时不执行 pip、不联网解析依赖、不安装 Visual Studio：

1. 从官方来源获取解释器及第 4 节**精确文件**，校验 SHA256，生成只包含选定 wheel 的 wheelhouse。可以使用 pip 的 `--platform win_amd64 --python-version 3.8 --implementation cp --abi cp38 --only-binary=:all:` 参数检查目标文件；纯 Python 的 charset-normalizer 单独选 `none-any`，不能让 resolver 换成原生版本。[pip download 文档](https://pip.pypa.io/en/stable/cli/pip_download/)。
2. 在干净的真实 CPython 3.8 x64 构建环境中运行固定 pip，用 `--no-index --find-links wheelhouse --only-binary=:all: --require-hashes` 安装完整锁文件，检查依赖闭包。禁止 sdist 回退、禁止临时编译。散列锁定规则见 [pip secure installs](https://pip.pypa.io/en/stable/topics/secure-installs/)。
3. 使用构建环境的 pip 再以 `--target staging/runtime/python38-x64/Lib/site-packages` 安装相同闭包。不是复制整个 venv，也不是往 embeddable 包塞 get-pip。保留每个包的 `.dist-info`、许可证和捆绑 DLL，包资源不得盲目删减。
4. `python38._pth` 显式列 `python38.zip`、`.`、`Lib/site-packages`。初始保持 `import site` 禁用；若包依赖 `.pth` 初始化，先审计并解决其固定路径/DLL需求，再决定是否启用。不要让运行成功依赖用户的 PATH、注册表 Python、PYTHONPATH 或虚拟环境激活。
5. 在构建机验证可搬迁和基本功能；在 Win7 上通过第 8 节后，才将该 manifest 标为产品验收版本。运行时只分发已展开的运行目录；wheelhouse 留作构建归档，避免终端用户包内双份占用。

官方 embeddable 本来就不包含 pip，官方建议将第三方依赖作为应用的一部分交付，而非让用户按普通 Python 环境自由升级。[CPython v3.8.10 固定文档](https://github.com/python/cpython/blob/v3.8.10/Doc/using/windows.rst#the-embeddable-package)。

“运行无需网络”指启动和本地文件任务不下载依赖；使用 requests 访问远程网站或远程模型仍需网络。Python 3.8.10 构建配置固定 OpenSSL 1.1.1k，满足 urllib3 2.2 系列的 OpenSSL 最低门槛，但不是当前维护中的 TLS 实现。保持证书校验；不能把 `verify=False` 当作兼容修复。[CPython 构建配置](https://github.com/python/cpython/blob/v3.8.10/PCbuild/python.props)、[urllib3 迁移说明](https://urllib3.readthedocs.io/en/stable/v2-migration-guide.html)。

## 6. Windows 系统依赖

- Python 3.8 的官方文档明确指出 Win7 需要 KB2533623，embeddable 不负责检测，缺失时可能直接运行失败。允许被后续更新替代，不仅凭 KB 名称是否出现在列表里判断；应检测相应 DLL 加载能力。[CPython v3.8.10 文档](https://github.com/python/cpython/blob/v3.8.10/Doc/using/windows.rst#the-embeddable-package)。
- UCRT 是另一项依赖。KB2999226 支持 Win7 SP1，或系统已有后续 UCRT 更新。Win7 RTM 不作为目标。[Microsoft KB2999226](https://support.microsoft.com/en-us/servicing/os/windows/2020/04/update-for-universal-c-runtime-in-windows)。
- 若必须覆盖缺少系统 UCRT 的设备，可以研究合法 SDK Redistributable 的 app-local 方案；Win8 之前的系统要求 UCRT 和转发 DLL 位于主可执行文件目录，此处应是 `python.exe` 同级。不能从当前电脑随意复制 System32 DLL，也不能只给每个 `.pyd` 放一个 `ucrtbase.dll`。[Microsoft UCRT 部署规则](https://learn.microsoft.com/en-us/cpp/windows/universal-crt-deployment)。
- 额外 VC Runtime 以选定 wheel 的真实 PE 依赖为准。构建时提取 `.pyd` / `.dll` 的 imports 和 delay imports，检查 `VCRUNTIME140*.dll`、`MSVCP140*.dll`、UCRT、OpenBLAS 等以及所调用的 Win32 API。记录工具链最低运行库要求，固定合法可再分发文件的版本和散列。
- 不使用滚动的“最新 VC++ 运行库”链接作为 Win7 修复方法：Microsoft 当前最新 v14 的支持系统已经不包括 Win7。PE 检查也不能发现全部动态 `GetProcAddress` 或 CPU 指令问题，所以仍需实机运行。[Microsoft VC++ Redistributable 支持表与分发规则](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist)。

因此，第一版“解压即用”的承诺只能针对满足系统前提的机器。**无需安装 Python/pip，不等于一台无补丁 Win7 不需要任何系统组件。** 本方案没有自动安装补丁或修改系统运行库的步骤。

## 7. 一个内置 Skill 与现有 Agent 的衔接

首版只提供一个 **portable-python Skill**，统一负责包选择、自检、数据处理、Word、PowerPoint 与 HTTP 任务。先实现标准库 smoke 自检，返回 Python/位数/SSL/路径和小型 JSON、CSV 文件结果；之后逐项验证 pandas、docx、pptx、requests 能力。复杂示例和固定辅助脚本放在同一 Skill 的 supporting resources 中按需读取，不预先拆分多个 Skill，也不把完整说明常驻系统提示。

包名称与导入名必须正确：安装 `python-docx` / `python-pptx`，导入 `docx` / `pptx`。首轮只承诺 CSV/JSON/XLSX、DOCX、PPTX 的对应功能；不把旧 `.doc/.ppt/.xls`、宏执行、Office 渲染、PDF 导出、公式计算、Parquet 当作已经具备。

调用路径设计：

- 下一版拟提供 `run_python({script, args, cwd?, timeoutMs?})`；`script` 指待执行的 Python 文件，`args` 为字面参数数组。后台固定选择包内解释器，再复用 `run_process` 的执行、输出和审批逻辑。模型无需猜测解压目录；该接口不接受任意 `executable` 或 `env` 覆盖。这是拟议接口，本轮没有实现。
- 使用内置 runtime ID / app-relative metadata，在每次启动时根据当前 ROOT 解析绝对 `python.exe` 和脚本路径。升级、换解压目录后仍然有效；用户显式配置的外部路径不做任意字符串替换。
- 沿用已有进程权限检查与 `run_process` 包装。`read-only` / `workspace-write` 的程序执行需要原有审批，完全访问模式沿用其现有策略；加载 Skill 不等于授权执行脚本。
- Node 使用绝对 exe、参数数组、`shell:false`、隐藏窗口，建议参数为 `-I -X utf8 -u`。不使用 `py`、PATH 查找、activate、pip.exe、CMD 或 PowerShell。固定 worker 的中文输入输出须有端到端测试。
- 沿用输出上限、超时和取消；审批能看见解释器、脚本、参数、cwd 和输入输出。需要如实说明当前取消只保证直接子进程，不宣称已经实现全进程树终止。
- 启动环境应统一清理 ambient API_KEY/TOKEN/PASSWORD/SECRET/CREDENTIAL/COOKIE/AUTH 类秘密及 PYTHONPATH/PYTHONHOME/PYTHONSTARTUP，不把应用保存的模型密钥注入 Python。
- `-I`、工作目录和脚本路径限制**不是 OS 安全沙箱**。获准运行的 Python 仍可能访问当前用户文件或网络；权限页面不能产生相反印象。[CPython v3.8.10 命令行选项](https://github.com/python/cpython/blob/v3.8.10/Doc/using/cmdline.rst)。

增加动态运行时状态：是否找到包内解释器、解释器版本/位数、manifest 版本和散列、各模块探测结果、缺失 DLL/补丁提示、Win7 验收状态。状态只能报告实际探测结果，不能根据文件存在就标为“可用”；同时联测 `-I -X utf8 -u`、`python38._pth` 与 vendored site-packages 的加载。现阶段的 [portable-python Skill 草稿](skills/portable-python/SKILL.md) 位于设计目录，不由当前版本默认发现或打包。

Skill 可以附带经过复核的中文表格、Word、PowerPoint 示例和结构化输出模板。运行时不得依据模型建议临时 `pip install`；扩展包通过新版构建清单和验收更新。

## 8. 验收与发布条件

目前下表均为待实施测试，不是已通过结果。

| 层次 | 验收项 | 通过证据 |
| --- | --- | --- |
| 静态构建 | 原始文件散列、完整 dependency closure、wheel 的 METADATA、DLL imports / delay imports、许可证 | manifest、依赖图、组件清单和静态检查日志 |
| 开发机 | 所有 import；CSV/Excel 往返；DOCX/PPTX 生成后重读；Pillow PNG/JPEG；NumPy 基本计算、矩阵乘法、linalg | 自动测试日志；只能标开发机通过 |
| Win7 SP1 x64 | 无系统 Python、无 PATH 配置，完全断网启动；同一份最终 ZIP 解压并跑相同测试 | 系统 build/补丁、CPU、exe/wheel hash、stdout/stderr/退出码 |
| 老 CPU | 至少覆盖用户目标 CPU；重点 NumPy/OpenBLAS，不能只看成功 import | 运算正确性及不崩溃记录 |
| DLL 前提 | 已更新系统与缺必要组件的环境分别验证；缺组件时给具体错误，不循环尝试重装 | 自检报告和失败路径记录 |
| 可搬迁/中文 | 解压路径、用户名、workspace 和产物含中文/空格；移动整个目录；从其他 cwd 启动 | 自动测试或用户实机回传 |
| Agent 集成 | Chrome102 触发 Skill、实际程序审批、拒绝后不执行、取消、超时、输出截断、持久化历史 | Node12 服务端集成与浏览器验证 |
| TLS | 启用证书验证的受控 HTTPS 请求、错误证书拒绝、代理/企业 CA 的显式配置 | 独立联网测试；不作为离线启动依赖 |

发布记录应区分“资料核查”“开发机通过”“Win7 实机通过”。若某个原生库失败，记录缺失 DLL/API/CPU 指令和散列，单独调整该组件的候选矩阵并重跑其依赖功能；不在用户机静默换版本。

## 9. 体积与许可证

按 PyPI JSON 的选定文件大小相加，A 组 **20 个运行依赖的 wheel 共 34,824,700 字节，约 33.21 MiB**。其中 NumPy 和 pandas 合计约 25.45 MB，其余约 9.37 MB。官方 Python ZIP 另约 7.8 MB。换成 NumPy 1.24.4 的比较组合则为 35,019,934 字节。

这些是已核查的**下载文件大小**，不能直接等同最终 ZIP 或解压占用。本轮没有安装或打包测量；可先为 Python 附加组件预留约 45–70 MB 压缩包、150–250 MB 解压空间作为工程预算，最终以构建报告替代估算。VC Runtime、字体或其他后续组件会额外增加体积。终端包只保留展开运行目录，不重复塞 wheelhouse。

许可证按元数据初步分类：Python / typing-extensions / defusedxml 为 PSF 系许可；requests 为 Apache-2.0；urllib3、charset-normalizer、docx、pptx、openpyxl、et-xmlfile、six、pytz 为 MIT；pandas、NumPy、idna、lxml、XlsxWriter 为各自 BSD 条款；python-dateutil 包含 Apache/BSD 条款；tzdata 为 Apache-2.0；certifi 为 MPL-2.0；Pillow 10.4 的元数据为 HPND。**以实际分发文件中的许可证为准，不能只复制这份分类表。**

需要保留 CPython LICENSE、各 wheel 的 `.dist-info` / licenses、NumPy 所带 OpenBLAS 等组件声明、Pillow 的图像编解码组件声明、lxml 的 libxml2/libxslt 相关声明、certifi 的证书和许可文件。MSVC/UCRT 的分发遵循相应微软条款。构建生成完整 `THIRD_PARTY_NOTICES.txt` 与包含名称、版本、来源、SHA256、文件大小、许可证、Win7 验收状态的 `runtime-manifest.json`。

第一个交付为 **0.7.0 含自检脚本的 x64 便携 Python 预发布验收包**。下一步在用户 Win7 SP1 机器运行设置页环境检查和 Skill 离线文档自检，依据实际 DLL/CPU/系统补丁错误决定是否需要候选 B；没有实测依据时不静默更换依赖矩阵。
