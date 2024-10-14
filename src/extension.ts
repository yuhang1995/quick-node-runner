import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as child_process from 'child_process';
import psTree from 'ps-tree';

let statusBarItem: vscode.StatusBarItem;
let currentProjectPath: string | undefined;
let currentScriptName: { path: string, script: string } | undefined;
let outputChannel: vscode.OutputChannel;
let terminal: vscode.Terminal | undefined;

let globalStateKey: string | undefined;
let statusCheckInterval: NodeJS.Timeout | undefined;

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

    // 监听窗口状态变化
    context.subscriptions.push(vscode.window.onDidChangeWindowState(e => {
        if (e.focused) {
            syncOutputChannel(context);
        }
    }));

    try {
        let showMenuDisposable = vscode.commands.registerCommand('quickNodeRunner.showMenu', async () => {
            const globalState = getGlobalState(context);
            if (globalState.isRunning) {
                const items: vscode.QuickPickItem[] = [
                    {
                        label: '$(stop) 停止 Node 项目',
                        description: globalState.scriptInfo ? `当前脚本: ${globalState.scriptInfo.script}` : undefined
                    },
                    {
                        label: '$(folder-opened) 打开项目',
                        description: globalState.scriptInfo?.path
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
            
            const globalState = getGlobalState(context);
            // 检查是否已有项目在运行
            if (globalState.isRunning) {
                const action = await vscode.window.showInformationMessage(
                    `已有项目正在运行：${globalState.scriptInfo?.script} (${path.basename(globalState.scriptInfo?.path || '')})。是否停止当前项目并启动新项目？`,
                    '是', '否'
                );
                if (action !== '是') {
                    return;
                }
                await vscode.commands.executeCommand('quickNodeRunner.stop');
            }

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
            globalStateKey = `quickNodeRunner.${projectPath}`;

            const packageJsonPath = path.join(projectPath, 'package.json');

            if (!fs.existsSync(packageJsonPath)) {
                vscode.window.showErrorMessage('选择的目录不是一个有效的 Node 项目');
                return;
            }

            let packageJson;
            try {
                packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            } catch (error) {
                vscode.window.showErrorMessage('无法解析 package.json 文件');
                return;
            }

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
                return; // 用户取消选择
            }

            currentScriptName = { path: projectPath, script: scriptToRun };

            // 清空并显示输出通道
            appendToOutput(`正在启动 Node 项目，运行脚本: ${scriptToRun}\n`, context);

            // 使用子进程运行项目
            const projectProcess = child_process.spawn('npm', ['run', scriptToRun], {
                cwd: projectPath,
                shell: true
            });

            // 保存进程 ID 到全局状态
            updateGlobalState(context, true, currentScriptName, projectProcess.pid);

            projectProcess.stdout?.on('data', (data) => {
                appendToOutput(data.toString(), context);
            });

            projectProcess.stderr?.on('data', (data) => {
                appendToOutput(data.toString(), context);
            });

            projectProcess.on('error', (error) => {
                appendToOutput(`\n启动进程时发生错误: ${error.message}\n`, context);
                updateGlobalState(context, false);
            });

            projectProcess.on('close', (code) => {
                appendToOutput(`\n进程已退出，退出码: ${code}\n`, context);
                updateGlobalState(context, false);
            });

            startStatusCheck(context);

        }, 500));

        let stopDisposable = vscode.commands.registerCommand('quickNodeRunner.stop', async () => {
            const globalState = getGlobalState(context);
            if (globalState.isRunning && globalState.pid) {
                try {
                    await killProcessTree(globalState.pid);
                    appendToOutput('\n项目已停止\n', context);
                    updateGlobalState(context, false);
                } catch (error) {
                    appendToOutput(`\n停止进程时发生错误: ${error}\n`, context);
                    // 如果进程已经不存在，我们也应该更新状态
                    updateGlobalState(context, false);
                }
            } else {
                vscode.window.showInformationMessage('没有正在运行的项目');
            }
        });

        let openProjectDisposable = vscode.commands.registerCommand('quickNodeRunner.openProject', () => {
            if (currentProjectPath) {
                vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(currentProjectPath), true);
            } else {
                // 移除错误提示，改为在状态栏显示
                statusBarItem.text = '$(error) 没有正在运行的项目';
                setTimeout(() => updateStatusBar(context), 3000); // 3秒后恢复正常状态
            }
        });

        context.subscriptions.push(
            showMenuDisposable,
            startDisposable,
            stopDisposable,
            openProjectDisposable,
            vscode.commands.registerCommand('quickNodeRunner.showOutput', () => {
                outputChannel.show();
            })
        );

        updateStatusBar(context);
        startStatusCheck(context);

    } catch (error) {
        console.error('插件激活过程中发生错误:', error);
        vscode.window.showErrorMessage('插件激活失败，请查看控制台日志');
    }
}

function getGlobalState(context: vscode.ExtensionContext) {
    const state = context.globalState.get('quickNodeRunner.globalState') as { 
        isRunning: boolean, 
        scriptInfo?: { path: string, script: string }, 
        pid?: number,
        timestamp: number 
    } | undefined;
    return state || { isRunning: false, timestamp: Date.now() };
}

function updateGlobalState(
    context: vscode.ExtensionContext, 
    isRunning: boolean, 
    scriptInfo?: { path: string, script: string },
    pid?: number
) {
    context.globalState.update('quickNodeRunner.globalState', { isRunning, scriptInfo, pid, timestamp: Date.now() });
    updateStatusBar(context);
}

function startStatusCheck(context: vscode.ExtensionContext) {
    stopStatusCheck();
    statusCheckInterval = setInterval(() => {
        const globalState = getGlobalState(context);
        const stopSignal = context.globalState.get('quickNodeRunner.stopSignal') as number | undefined;

        if (stopSignal && stopSignal > globalState.timestamp) {
            // 收到停止信号，更新状态
            updateGlobalState(context, false);
            context.globalState.update('quickNodeRunner.stopSignal', undefined);
        } else {
            updateStatusBar(context);
        }
    }, 1000);
}

function stopStatusCheck() {
    if (statusCheckInterval) {
        clearInterval(statusCheckInterval);
        statusCheckInterval = undefined;
    }
}

function updateStatusBar(context: vscode.ExtensionContext) {
    const globalState = getGlobalState(context);
    if (globalState.isRunning && globalState.scriptInfo) {
        const projectName = path.basename(globalState.scriptInfo.path);
        statusBarItem.text = `$(radio-tower) ${globalState.scriptInfo.script} (${projectName})`;
        statusBarItem.tooltip = `正在运行: ${globalState.scriptInfo.script}\n项目: ${projectName}\n点击查看选项`;
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
        statusBarItem.text = '$(play) 运行 Node 项目';
        statusBarItem.tooltip = '点击运行 Node 项目';
        statusBarItem.backgroundColor = undefined;
    }
    statusBarItem.show();
}

function killProcessTree(pid: number): Promise<void> {
    return new Promise((resolve, reject) => {
        psTree(pid, (err: Error | null, children: readonly psTree.PS[]) => {
            if (err) {
                reject(err);
                return;
            }
            
            children.forEach((child) => {
                try {
                    process.kill(parseInt(child.PID));
                } catch (e) {
                    // 忽略已经不存在的进程
                }
            });
            
            try {
                process.kill(pid);
            } catch (e) {
                // 忽略已经不存在的进程
            }
            
            resolve();
        });
    });
}

// 新增函数：同步输出通道
function syncOutputChannel(context: vscode.ExtensionContext) {
    const outputContent = context.globalState.get<string>('quickNodeRunner.outputContent');
    if (outputContent) {
        outputChannel.clear();
        outputChannel.append(outputContent);
    }
}

// 修改现有的输出函数
function appendToOutput(text: string, context: vscode.ExtensionContext) {
    outputChannel.append(text);
    // 保存输出内容到全局状态
    const currentContent = context.globalState.get<string>('quickNodeRunner.outputContent') || '';
    context.globalState.update('quickNodeRunner.outputContent', currentContent + text);
}

export function deactivate() {
    if (outputChannel) {
        outputChannel.dispose();
    }
    stopStatusCheck();
}