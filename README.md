# Quick Node Runner

Quick Node Runner 是一个 Visual Studio Code 扩展，旨在简化 Node.js 项目的运行和管理过程。它允许用户快速启动、停止 Node.js 项目，并提供了方便的状态栏控制和输出查看功能。

<div align="center">
    <img src="https://github.com/yuhang1995/quick-node-runner/raw/HEAD/assets/demo.gif" alt="Demo" width="100%" />
</div>

## 安装

该插件没有发布在市场中，可以直接通过 VSIX 文件安装

1. 访问 [GitHub Releases 页面](https://github.com/yuhang1995/quick-node-runner/releases)
2. 在最新的 release 中下载 `.vsix` 文件
3. 在 VS Code 中，转到扩展视图
4. 点击视图右上角的 "..." 菜单，选择 "从 VSIX 安装..."
5. 选择下载的 `.vsix` 文件并安装

## 功能

- 快速启动 Node.js 项目
- 从 package.json 中选择并运行 npm 脚本
- 通过状态栏按钮控制项目运行状态
- 在 VS Code 输出面板中查看项目输出
- 快速打开当前运行的项目文件夹

## 使用方法

1. **启动项目**
   - 点击状态栏上的 "运行 Node 项目" 按钮
   - 如果是首次使用，会提示选择项目文件夹
   - 如果 package.json 中有多个脚本，会提示选择要运行的脚本

2. **查看项目输出**
   - 项目启动后，输出会自动显示在 VS Code 的输出面板中
   - 在输出面板的下拉菜单中选择 "Quick Node Runner" 查看输出

3. **停止项目**
   - 当项目正在运行时，点击状态栏上的项目名称
   - 在弹出的菜单中选择 "停止 Node 项目"

4. **打开项目文件夹**
   - 当项目正在运行时，点击状态栏上的项目名称
   - 在弹出的菜单中选择 "打开项目"

5. **更改项目路径**
   - 在 VS Code 设置中搜索 "quickNodeRunner.projectPath"
   - 修改路径为新的项目文件夹路径

## 注意事项

- 确保项目文件夹中包含有效的 package.json 文件
- 如果项目需要特定的环境变量，请在启动 VS Code 之前设置它们
- 本项目开发环境使用 Node.js 20.9.0 版本。如果您在本地开发或贡献代码,请确保使用相同版本的 Node.js 以保持一致性

## 许可证

本项目采用 MIT 许可证。详情请参阅 [LICENSE](LICENSE) 文件。

## 发布

本项目使用 GitHub Actions 自动发布新版本。当推送一个新的 tag (格式为 `v*`，例如 `v1.0.0`) 时,会自动触发构建、打包和发布流程。发布的 release 将包含打包好的 VS Code 扩展文件 (.vsix)。

要发布新版本,请遵循以下步骤:

1. 更新 `package.json` 中的版本号。
2. 提交更改并推送到 GitHub。
3. 创建一个新的 tag:
   ```
   git tag v1.0.0
   git push origin v1.0.0
   ```
4. GitHub Actions 将自动处理剩余的发布流程。

您可以在 GitHub 仓库的 "Releases" 页面查看所有发布的版本。
