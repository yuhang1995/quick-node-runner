import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as child_process from 'child_process';
import psTree from 'ps-tree';

let statusBarItem: vscode.StatusBarItem;
let currentProjectPath: string | undefined;
let currentScriptName: { path: string, script: string } | undefined;
let outputChannel: vscode.OutputChannel;

// 在文件顶部添加一个常量来定义最大输出长度
const MAX_OUTPUT_LENGTH = 100000; // 例如，限制为 100,000 个字符

// 在文件顶部添加这个常量
const OUTPUT_SEPARATOR = '\n[QuickNodeRunner_LOG_SEPARATOR]\n';

// 添加一个新的常量用于全局状态的键
const GLOBAL_STATE_KEY = 'quickNodeRunner.globalProjectState';

function debounce(func: Function, wait: number): (...args: any[]) => void {
    let timeout: NodeJS.Timeout | null = null;
    return (...args: any[]) => {
        if (timeout) {
            clearTimeout(timeout);
        }
        timeout = setTimeout(() => func(...args), wait);
    };
}

async function detectPackageManager(projectPath: string): Promise<string> {
    const packageManagers = ['yarn', 'pnpm', 'npm'];
    for (const pm of packageManagers) {
        const lockFile = pm === 'npm' ? 'package-lock.json' : `${pm}.lock`;
        if (fs.existsSync(path.join(projectPath, lockFile))) {
            return pm;
        }
    }
    return 'npm'; // 默认使用 npm
}

function getProjectPath(): string | undefined {
    const workspaceConfig = vscode.workspace.getConfiguration('quickNodeRunner', vscode.workspace.workspaceFolders?.[0]?.uri);
    let projectPath = workspaceConfig.get<string>('projectPath');
    
    if (!projectPath) {
        const globalConfig = vscode.workspace.getConfiguration('quickNodeRunner', null);
        projectPath = globalConfig.get<string>('projectPath');
    }
    
    return projectPath;
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
            syncGlobalState(context);
        }
    }));

    // 添加工作区关闭事件监听器
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(event => {
        event.removed.forEach(() => {
            cleanupOnProjectClose(context);
        });
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
                    },
                    {
                        label: '$(output) 查看输出',
                        description: '打开输出面板'
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
                    } else if (selectedItem.label.includes('查看输出')) {
                        vscode.commands.executeCommand('quickNodeRunner.showOutput');
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

            let projectPath = getProjectPath();

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
                
                await vscode.workspace.getConfiguration('quickNodeRunner').update('projectPath', projectPath, target);
            }

            currentProjectPath = projectPath;

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

            // 检测包管理器
            const packageManager = await detectPackageManager(projectPath);

            // 清空并显示输出通道
            appendToOutput(`正在使用 ${packageManager} 启动 Node 项目，运行脚本: ${scriptToRun}\n`, context);

            // 使用检测到的包管理器运行项目
            const projectProcess = child_process.spawn(packageManager, ['run', scriptToRun], {
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
                appendToOutput(`\n启进程时发生错误: ${error.message}\n`, context);
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

        let setProjectPathDisposable = vscode.commands.registerCommand('quickNodeRunner.setProjectPath', async () => {
            const selectedFolder = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: '选择 Node 项目目录'
            });

            if (selectedFolder && selectedFolder.length > 0) {
                const projectPath = selectedFolder[0].fsPath;
                const config = vscode.workspace.getConfiguration('quickNodeRunner');
                await config.update('projectPath', projectPath, vscode.ConfigurationTarget.Workspace);
                vscode.window.showInformationMessage(`项目路径已更新: ${projectPath}`);
                checkAndSyncProjectStatus(context);
            }
        });

        context.subscriptions.push(setProjectPathDisposable);

        checkAndSyncProjectStatus(context);

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

// 添加新的函数来检查和同步项目状态
async function checkAndSyncProjectStatus(context: vscode.ExtensionContext) {
    const projectPath = getProjectPath();

    if (projectPath && fs.existsSync(projectPath)) {
        const globalState = getGlobalState(context);
        if (globalState.isRunning && globalState.scriptInfo) {
            // 检查进程是否仍在运行
            try {
                process.kill(globalState.pid!, 0);
                // 如果没有出错误，进程仍在运行
                updateStatusBar(context);
            } catch (e) {
                // 进程不存在，更新状态
                updateGlobalState(context, false);
                vscode.window.showInformationMessage('之前运行的项目已停止');
            }
        } else {
            // 项目未运行，更新状态栏
            updateStatusBar(context);
        }
    } else {
        // 项目路径不存在，清除状态
        updateGlobalState(context, false);
        vscode.window.showWarningMessage('配置的项目路径不存在，请重新设置');
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
    let newState;
    if (isRunning) {
        newState = { isRunning, scriptInfo, pid, timestamp: Date.now() };
    } else {
        // 当进程停止时，清空所有状态
        newState = { isRunning: false, scriptInfo: undefined, pid: undefined, timestamp: Date.now() };
    }
    context.globalState.update('quickNodeRunner.globalState', newState);
    context.globalState.update(GLOBAL_STATE_KEY, newState);
    updateStatusBar(context);

    // 如果进程停止，清空输出内容
    if (!isRunning) {
        context.globalState.update('quickNodeRunner.outputContent', undefined);
        outputChannel.clear();
    }
}

function startStatusCheck(context: vscode.ExtensionContext) {
    const globalState = getGlobalState(context);
    const stopSignal = context.globalState.get('quickNodeRunner.stopSignal') as number | undefined;

    if (stopSignal && stopSignal > globalState.timestamp) {
        // 收到停止信号，更新状态
        updateGlobalState(context, false);
        context.globalState.update('quickNodeRunner.stopSignal', undefined);
    } else {
        updateStatusBar(context);
    }
}

function updateStatusBar(context: vscode.ExtensionContext) {
    const globalState = getGlobalState(context);
    const projectPath = getProjectPath();

    if (!projectPath || !fs.existsSync(projectPath)) {
        statusBarItem.text = '$(warning) 未设置项目路径';
        statusBarItem.tooltip = '点击设置 Node 项目路径';
        statusBarItem.command = 'quickNodeRunner.setProjectPath';
        statusBarItem.show();
        return;
    }

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
    statusBarItem.command = 'quickNodeRunner.showMenu';
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
                // 忽略已经不存的进程
            }
            
            resolve();
        });
    });
}

function appendToOutput(text: string, context: vscode.ExtensionContext) {
    outputChannel.append(text);

    // 获取当前存储的内容
    let currentContent = context.globalState.get<string>('quickNodeRunner.outputContent') || '';

    // 添加新的文本，使用分隔符
    currentContent += (currentContent ? OUTPUT_SEPARATOR : '') + text.trim();

    // 如果内容超过最大长度，则截取最新的部分
    if (currentContent.length > MAX_OUTPUT_LENGTH) {
        const lastSeparatorIndex = currentContent.lastIndexOf(OUTPUT_SEPARATOR, currentContent.length - MAX_OUTPUT_LENGTH);
        if (lastSeparatorIndex !== -1) {
            currentContent = currentContent.slice(lastSeparatorIndex + OUTPUT_SEPARATOR.length);
        } else {
            currentContent = currentContent.slice(-MAX_OUTPUT_LENGTH);
        }
    }

    // 更新全局状态
    context.globalState.update('quickNodeRunner.outputContent', currentContent);
}

// 修改 syncOutputChannel 函数
function syncOutputChannel(context: vscode.ExtensionContext) {
    const outputContent = context.globalState.get<string>('quickNodeRunner.outputContent');
    if (outputContent) {
        outputChannel.clear();
        // 将内容按分隔符分割，然后重新组合，去除分隔符
        const contentWithoutSeparators = outputContent
            .split(OUTPUT_SEPARATOR)
            .filter(Boolean)  // 移除空字符串
            .join('\n');
        outputChannel.append(contentWithoutSeparators);
    }
}

function cleanupOnProjectClose(context: vscode.ExtensionContext) {
    console.log('工作区已关闭，清理 Quick Node Runner 状态');

    // 停止正在运行的进程
    const globalState = getGlobalState(context);
    if (globalState.isRunning && globalState.pid) {
        try {
            killProcessTree(globalState.pid);
        } catch (error) {
            console.error('停止进程时发生错误:', error);
        }
    }

    // 清空全局状态
    context.globalState.update('quickNodeRunner.globalState', undefined);
    context.globalState.update('quickNodeRunner.outputContent', undefined);
    context.globalState.update('quickNodeRunner.stopSignal', undefined);

    // 清空输出通道
    if (outputChannel) {
        outputChannel.clear();
    }

    // 更新状态栏
    updateStatusBar(context);

    // 清空全局项目状态
    context.globalState.update(GLOBAL_STATE_KEY, undefined);

    console.log('Quick Node Runner 状态已清理');
}

export function deactivate(context: vscode.ExtensionContext) {
    console.log('插件 "Quick Node Runner" 正在停用');

    cleanupOnProjectClose(context);

    // 处理输出通道
    if (outputChannel) {
        outputChannel.dispose();
    }

    // 移除状态栏项
    if (statusBarItem) {
        statusBarItem.dispose();
    }

    // 清空配置
    const config = vscode.workspace.getConfiguration('quickNodeRunner');
    config.update('projectPath', undefined, vscode.ConfigurationTarget.Global);

    console.log('插件 "Quick Node Runner" 已完全停用并清理');
}

// 同步全局状态
function syncGlobalState(context: vscode.ExtensionContext) {
    const globalProjectState = context.globalState.get(GLOBAL_STATE_KEY) as {
        isRunning: boolean,
        scriptInfo?: { path: string, script: string },
        pid?: number,
        timestamp: number
    } | undefined;

    if (globalProjectState && globalProjectState.timestamp > getGlobalState(context).timestamp) {
        // 全局状态比当前窗口状态新，更新当前窗口状态
        context.globalState.update('quickNodeRunner.globalState', globalProjectState);
        updateStatusBar(context);
        if (globalProjectState.isRunning) {
            startStatusCheck(context);
        }
    }
}