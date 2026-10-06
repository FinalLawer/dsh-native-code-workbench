# Windows 完整工作台嵌入验证

本次采用 coder/code-server 官方 Windows x64 发行版 4.140.0（Code 1.140.0），没有打包微软发行的 VS Code。它仍需要保留整个发行目录中的 LICENSE、ThirdPartyNotices.txt 和 Code - OSS 的第三方声明。正式发布前需独立核对所有分发组件的许可证。

来源：https://github.com/coder/code-server/releases/tag/v4.140.0

下载包：code-server-4.140.0-windows-amd64.tar.gz，208924361 字节。

已对照 GitHub release asset digest 验证 SHA256：

`f79a06ec2fe3dc12283aa78d53040738b6535cac0bb2db77e9123c0131f7e38b`

## 运行

在项目根目录，用 PowerShell 7 执行：

```powershell
./tools/start-vscode-validation.ps1
```

服务只监听 127.0.0.1:18789，启用密码登录；密码位于本目录 config.yaml，配置、用户数据、扩展和日志都使用独立目录。下载包、运行时、密码文件与用户数据属于本机实验材料，不应放入插件发布包或公共仓库。

刷新 DSH 的插件界面，在工作台上方选择「完整 VS Code（实验）」，点击「连接 / 重载」。iframe 使用当前会话 cwd，Windows 路径转换为 `/C:/...` URI 路径。iframe 首次使用需要密码登录。

停止时先检查 server.pid 记录的进程确实属于此目录下的 code-server，然后停止该进程及它的子进程。插件当前没有负责服务生命周期，不应将此入口当作自动安装或生产集成。

## 实测结果

桌面端登录排查：服务端密码 POST 返回 302 成功，登录 Cookie 为 `SameSite=Lax`。跨站 iframe 可能无法保存/发送该 Cookie。插件在父页面使用本机 HTTP(S) 时统一 localhost/127.0.0.1 主机名，并提供「独立窗口打开」作为可靠的顶层登录入口。桌面自定义协议下仍需要后续同源代理（HTTP 与 WebSocket）或专用 WebView 适配；不通过关闭认证解决。独立窗口登录不能保证与桌面 WebView 共享 Cookie。

- Windows 发行版下载和摘要校验通过。
- 本地密码登录通过，完整工作台界面和扩展宿主连接建立。
- 在 127.0.0.1:18790 的独立 HTML 验证页面内，跨端口 iframe 加载通过。
- 工作区文件树、读取和 Ctrl+S 保存已通过，在磁盘确认 `edit-probe.txt` 的修改。原先失败来自错误的工作区地址，不是无法支持 Windows：插件现在通过带身份校验的 Host 接口，从会话 cwd 解析真实路径（含目录链接），再转换为 `/C:/...` URI 路径。
- 浏览器自动化与新版 EditContext 输入不兼容，本机实验用户设置使用 `editor.editContext: false`，同时关闭编辑器内置 AI 界面，避免与 DSH 对话混淆。
- Windows 原生文件监听器存在反斜杠 glob 的 `regex_error(error_backref)`。启动脚本应用版本受控的兼容补丁：归一化 ignore 路径，并将固定目录的 `/**` 排除转为目录排除。原生快照测试证明可见文件被检测、排除目录仍被忽略。工作台日志不再出现该错误，但浏览器中的外部更新自动刷新尚未确认；重新打开能读取最新磁盘内容。
- 跨端口 iframe 的界面和文件显示通过，自动化工具在 iframe 内键盘操作失败，因此不能宣称 iframe 内编辑保存已实测通过。直接页面编辑保存已经实测通过。
- 初始启动存在默认 AppData 目录权限错误；启动脚本给子进程配置独立 APPDATA / LOCALAPPDATA，避免使用默认目录。
- DSH 桌面端内的 iframe、Cookie/CSP、窗口切换和工作区路径需要用户实测。独立浏览器中的成功不能证明桌面端已通过。
- 原轻量工作台保留，模式切换时组件不卸载，以保留未保存内容。
- DSH 代码引用、独立 API 的 Tab AI 补全、DSH 自动保存设置尚未桥接；内嵌编辑器使用自己的设置。

下一步验证 DSH 桌面端实际 iframe 输入、自动同步、终端与扩展，随后实现引用及补全桥接。停止服务可执行 `./tools/stop-vscode-validation.ps1`，脚本核对记录 PID 的运行时路径后停止其进程树。
