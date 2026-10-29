# DeskBuddy 提交材料

作品名称：DeskBuddy 鱼鱼桌宠。

选题方向：第五项自由发挥。作品由 AI 辅助编程与角色素材生成完成，结合桌面陪伴和效率工具。运行时使用本地规则，未接入大模型聊天。

## 提交文件

1. 作品本体：[DeskBuddy-Windows-x64.zip](https://github.com/kingofbuilding/deskbuddy/releases/download/v1.3.0/DeskBuddy-Windows-x64.zip)，Windows 10/11 64 位免安装运行包，内含启动说明，无需 Node.js 和 API Key。
2. 展示内容：`图文教程.docx`。同时提供 `图文教程.md` 和配图 `images/`，便于复制到公众号或小红书。
3. 创作说明：`创作说明.md`，正文不超过 300 字。
4. 源码补充：[DeskBuddy-Source.zip](https://github.com/kingofbuilding/deskbuddy/releases/download/v1.3.0/DeskBuddy-Source.zip)，包含源代码、完整 README、测试及素材说明，不含本地任务、运行数据或 node_modules。

[一并下载完整提交包](https://github.com/kingofbuilding/deskbuddy/releases/download/v1.3.0/DeskBuddy-Submission.zip)，包含以上文件、配图和运行包。

展示内容按要求选择图文教程这一项，包含标题、开头、操作步骤和效果图。

## 运行作品

完整解压 Windows 运行包，双击其中的 `DeskBuddy.exe`。不要只复制 exe；DLL、locales、resources 等目录需要一起保留。
如果普通启动立即退出，可运行包内的 `兼容启动.cmd`。本机运行包自检使用兼容参数通过；普通启动在当前工具环境中未通过。

单击角色打开菜单，双击打开任务，右键打开设置。找不到鱼鱼时，点击任务栏入口或按 Ctrl+Alt+P。关闭控制台会最小化，选择退出才会结束程序。

新安装默认关闭娱乐督促。体验自动砍刀和裂屏时，请添加一项任务，在设置中开启娱乐督促及自动特效，配置应用名单和等待时间。新配置默认等待 10 分钟，体验时可改为 1 分钟；默认冷却 15 分钟。菜单里也有立即预览入口。

识别依据为前台应用进程名单，不是视频内容；加入浏览器后，浏览器中的所有网页都会计时。关闭娱乐窗口需按钮确认。

## 完整验收

当前源码验收通过 134 个自动化用例、43 项应用检查与 7 条端到端流程。运行包另行执行启动和应用自检，结果见 `运行包验收.md`。
