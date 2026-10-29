# DeskBuddy 环境验证记录

记录日期：2026-10-29。

## 当前验证范围

开发与自检环境为 Windows x64，Node.js 20.19.5，Electron 40.10.2。最新完整验收见 [acceptance-report.md](acceptance-report.md)：105 个核心测试、29 个 DOM 与覆盖层测试、43 项应用检查，以及 7 条端到端流程通过。

Windows 免安装运行包另行通过 43 项应用自检，使用了 --no-sandbox --disable-gpu。普通启动在当前工具环境中立即退出，退出码为 -2147483645；尚未完成另一台干净 Windows 电脑的普通启动验证。运行包内附兼容启动入口，详见 [运行包验收](../submission/运行包验收.md)。

ELECTRON_RUN_AS_NODE 残留会使 Electron 以 Node 模式运行；启动脚本会清除此变量。兼容参数只作用于本次进程，不修改系统设置。

## 源码验证

安装依赖 npm install 后，以 npm start 启动，npm run verify 执行完整验收。

首次安装需下载 Electron 与开发依赖。任务、设置和计时写入当前运行实例的用户数据目录；测试使用独立目录，不应复制本地 .tmp 数据给其他人。