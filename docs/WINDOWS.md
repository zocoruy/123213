# Windows 构建与试用

SprintSelect 面向 Windows 10 / 11 的 x64 电脑。照片处理和号码识别在本机完成；号码识别模型随安装包提供。

## 直接运行

- `SprintSelect-0.1.0-Setup-x64.exe`：安装版，可选择安装目录并创建桌面快捷方式。
- `SprintSelect-0.1.0-Portable-x64.exe`：免安装版，双击解压启动。
- 首次打开后选择照片文件夹；建议先用 20～50 张照片确认筛选与导出流程，再导入完整赛事。

当前版本没有商业代码签名，Windows 可能显示“未知发布者”。请核对下载来源和 `SHA256SUMS.txt`。安装与运行不需要关闭杀毒软件或系统防护。

原片保留在导入目录。缩略图、分析结果和人工标记存放于 `%APPDATA%\sprintselect\library`（以系统实际的应用数据目录为准）。卸载时保留这些数据；免安装版也会使用应用数据目录。移动或删除原片后，请从新的位置重新导入。

## 从源码构建

要求：Windows x64、Node.js 24 LTS、npm 和能访问 npm / Electron 官方下载服务的网络。无须另外安装 Python 或 Visual Studio，sharp 使用其官方预编译依赖。

在仓库目录的 PowerShell 7 中执行：

```powershell
pwsh -File .\scripts\build-windows.ps1
```

也可以逐条执行以下等价命令：

```powershell
npm ci --include=optional
npm test
npm run build
npm exec -- electron-builder --win nsis portable --x64 --publish never
```

构建脚本默认重新安装锁定依赖、运行单元测试、编译界面与 Electron，然后生成安装版、免安装版和 SHA-256 文件到 `release/`。只构建安装版可加 `-Target Installer`；已有依赖且明确无变更时可用 `-SkipInstall`。

`sharp` 的原生模块必须匹配目标系统。不要把 Linux 的 `node_modules` 直接复制到 Windows 包；Windows 构建需保留 optional dependencies。OCR 的 worker、WebAssembly 和模型依赖会解包到应用资源目录，以支持离线调用。

## GitHub Actions

在 Actions 中手动运行 **Build Windows app**，完成后从运行记录下载 `SprintSelect-Windows-x64`。向 `main` 提交 PR 或推送 `v*` 标签也会触发构建。标签触发的构建成功后会把两个 EXE 和校验文件发布到同仓库的 GitHub Release；PR 和手动构建仅保留构建附件。发布任务单独授予仓库内容写入权限，构建任务只读。

## 交付验证边界

构建成功和包结构检查不等于 Windows 实机验证。发布前仍应在 Windows 10 / 11 x64 上检查：安装与卸载、免安装启动、中文路径导入、号码识别、相似照片归组、清晰度分析、键盘选片及导出。最终交付说明会列出本次实际完成的检查。
