import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as child_process from 'child_process';

let projectProcess: child_process.ChildProcess | null = null;
let statusBarItem: vscode.StatusBarItem;
let currentProjectPath: string | undefined;
let currentScriptName: string | undefined;
let outputChannel: vscode.OutputChannel;
let terminal: vscode.Terminal | undefined;

function debounce(func: Function, wait: number): (...args: any[]) => void {
    let timeout: NodeJS.Timeout | null = null;
    return (...args: any[]) => {
        if (timeout) {
            clearTimeout(timeout);
        }
        timeout = setTimeout(() => func(...args), wait);
    };
}

export function activate(context: vscode.ExtensionContext) {
    console.log('插件 "Quick Node Runner" 已激活');

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'quickNodeRunner.showMenu';
    context.subscriptions.push(statusBarItem);

    // 创建输出通道
    outputChannel = vscode.window.createOutputChannel('Quick Node Runner');

    try {
        let showMenuDisposable = vscode.commands.registerCommand('quickNodeRunner.showMenu', async () => {
            if (projectProcess) {
                const items: vscode.QuickPickItem[] = [
                    {
                        label: '$(stop) 停止 Node 项目',
                        description: currentScriptName ? `当前脚本: ${currentScriptName}` : undefined
                    },
                    {
                        label: '$(folder-opened) 打开项目',
                        description: currentProjectPath
                    }
                ];

                const selectedItem = await vscode.window.showQuickPick(items, {
                    placeHolder: '选择操作'
                });

                if (selectedItem) {
                    if (selectedItem.label.includes('停止')) {
                        vscode.commands.executeCommand('quickNodeRunner.stop');
                    } else if (selectedItem.label.includes('打开项目')) {
                        vscode.commands.executeCommand('quickNodeRunner.openProject');
                    }
                }
            } else {
                vscode.commands.executeCommand('quickNodeRunner.start');
            }
        });

        let startDisposable = vscode.commands.registerCommand('quickNodeRunner.start', debounce(async function () {
            console.log('quickNodeRunner.start 命令被触发（防抖后）');
            const config = vscode.workspace.getConfiguration('quickNodeRunner');
            let projectPath = config.get<string>('projectPath');

            if (!projectPath) {
                const selectedFolder = await vscode.window.showOpenDialog({
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false,
                    openLabel: '选择 Node 项目目录'
                });

                if (!selectedFolder || selectedFolder.length === 0) {
                    return; // 静默返回，不显示错误消息
                }

                projectPath = selectedFolder[0].fsPath;
                
                const target = vscode.workspace.workspaceFolders 
                    ? vscode.ConfigurationTarget.Workspace 
                    : vscode.ConfigurationTarget.Global;
                
                await config.update('projectPath', projectPath, target);
                // 移除保存配置的提示信息
            }

            currentProjectPath = projectPath;

            const packageJsonPath = path.join(projectPath, 'package.json');

            if (!fs.existsSync(packageJsonPath)) {
                vscode.window.showErrorMessage('选择的目录不是一个有效的 Node 项目');
                return;
            }

            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            const scripts = packageJson.scripts || {};
            const scriptNames = Object.keys(scripts);

            let scriptToRun: string | undefined;

            if (scriptNames.length === 0) {
                vscode.window.showErrorMessage('package.json 中没有定义任何脚本');
                return;
            } else if (scriptNames.length === 1) {
                scriptToRun = scriptNames[0];
            } else {
                scriptToRun = await vscode.window.showQuickPick(scriptNames, {
                    placeHolder: '选择要运行的脚本'
                });
            }

            if (!scriptToRun) {
                return; // 静默返回，不显示错误消息
            }

            currentScriptName = scriptToRun;

            // 清空输出通道
            outputChannel.clear();
            // 显示输出通道
            outputChannel.show(true);

            outputChannel.appendLine(`正在启动 Node 项目，运行脚本: ${scriptToRun}`);

            // 使用子进程运行项目
            projectProcess = child_process.spawn('npm', ['run', scriptToRun], {
                cwd: projectPath,
                shell: true
            });

            projectProcess.stdout?.on('data', (data) => {
                outputChannel.append(data.toString());
            });

            projectProcess.stderr?.on('data', (data) => {
                outputChannel.append(data.toString());
            });

            projectProcess.on('close', (code) => {
                outputChannel.appendLine(`\n进程已退出`);
                projectProcess = null;
                updateStatusBar(false);
                // 移除项目停止的提示信息
            });

            updateStatusBar(true);
            // 移除项目启动的提示信息

        }, 500)); // 500ms 的防抖时间

        let stopDisposable = vscode.commands.registerCommand('quickNodeRunner.stop', () => {
            if (projectProcess) {
                projectProcess.kill();
                projectProcess = null;
                currentScriptName = undefined;
                updateStatusBar(false);
                outputChannel.appendLine('\n项目已手动停止');
                // 移除项目停止的提示信息
            }
        });

        let openProjectDisposable = vscode.commands.registerCommand('quickNodeRunner.openProject', () => {
            if (currentProjectPath) {
                vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(currentProjectPath), true);
            } else {
                // 移除错误提示，改为在状态栏显示
                statusBarItem.text = '$(error) 没有正在运行的项目';
                setTimeout(() => updateStatusBar(false), 3000); // 3秒后恢复正常状态
            }
        });

        context.subscriptions.push(showMenuDisposable, startDisposable, stopDisposable, openProjectDisposable, outputChannel);

        updateStatusBar(false);

    } catch (error) {
        console.error('插件激活过程中发生错误:', error);
        vscode.window.showErrorMessage('插件激活失败，请查看控制台日志');
    }
}

function updateStatusBar(isRunning: boolean) {
    if (isRunning) {
        statusBarItem.text = `$(radio-tower) ${currentScriptName || 'Node 项目运行中'}`;
        statusBarItem.tooltip = `点击查看选项`;
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
        statusBarItem.text = '$(play) 运行 Node 项目';
        statusBarItem.tooltip = '点击运行 Node 项目';
        statusBarItem.backgroundColor = undefined;
    }
    statusBarItem.show();
}

export function deactivate() {
    if (projectProcess) {
        projectProcess.kill();
    }
    if (outputChannel) {
        outputChannel.dispose();
    }
}
