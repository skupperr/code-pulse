import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);


type ActivityBuffer = {
	files: Set<string>;
	languages: Set<string>;
	linesChanged: number;
};

let activityBuffer: ActivityBuffer = {
	files: new Set(),
	languages: new Set(),
	linesChanged: 0
};

let gitInProgress = false;
let pushPending = false;
let successNotifiedForBatch = false;
let repoGeneration = 0;



// const FLUSH_INTERVAL_MS = 30 * 10000; // dev mode

function getConfig() {
	return vscode.workspace.getConfiguration('codepulse');
}


function getRepoPath(context: vscode.ExtensionContext) {
	return path.join(context.globalStorageUri.fsPath, 'activity-repo');
}



function ensureRepoCloned(context: vscode.ExtensionContext) {
	const repoUrl = getConfig().get<string>('repoUrl', '').trim();
	const repoPath = getRepoPath(context);

	if (!repoUrl) {
		return; // user hasn’t configured it yet
	}

	if (fs.existsSync(path.join(repoPath, '.git'))) {
		return;
	}

	fs.mkdirSync(repoPath, { recursive: true });

	// try {
	// 	execSync(`git clone ${repoUrl} "${repoPath}"`, {
	// 		stdio: 'ignore'
	// 	});
	// } catch {
	// 	notifyWarn(
	// 		'CodePulse: Failed to clone activity repo. Check repo URL and authentication.'
	// 	);
	// }

	try {
		execSync(`git clone ${repoUrl} "${repoPath}"`, {
			stdio: 'pipe'
		});
	} catch {
		notifyWarn(
			'CodePulse: Failed to clone activity repo. Check repo URL and authentication.'
		);
	}

}




// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('codepulse.snapshotIntervalMinutes')) {
			clearInterval(interval);
			interval = setInterval(
				() => flushActivity(context),
				getSnapshotIntervalMs()
			);
		}

		if (e.affectsConfiguration('codepulse.repoUrl')) {
			repoGeneration++;

			const repoPath = getRepoPath(context);

			if (fs.existsSync(repoPath)) {
				fs.rmSync(repoPath, { recursive: true, force: true });
			}

			ensureRepoCloned(context);
		}


	});


	function getSnapshotIntervalMs() {
		const minutes = getConfig().get<number>(
			'snapshotIntervalMinutes',
			30
		);
		return Math.max(minutes, 5) * 60 * 1000;
	}

	try {
		const gitVersion = execSync('git --version').toString();
		notifyInfo(gitVersion);
	} catch (e: any) {
		vscode.window.showErrorMessage(
			`Git not available to CodePulse: ${e.message}`
		);
	}


	notifyInfo('CodePulse is running');

	const disposable = vscode.workspace.onDidChangeTextDocument((event) => {
		if (!getConfig().get<boolean>('enabled')) {
			return;
		}

		const doc = event.document;

		if (doc.uri.scheme !== 'file') {
			return;
		}

		activityBuffer.files.add(doc.uri.fsPath);
		activityBuffer.languages.add(doc.languageId);

		for (const change of event.contentChanges) {
			const newLines = change.text.split('\n').length - 1;
			const oldLines = change.range.end.line - change.range.start.line;
			activityBuffer.linesChanged += Math.abs(newLines - oldLines);
		}

		vscode.window.setStatusBarMessage(
			`CodePulse: ${activityBuffer.files.size} files · ${activityBuffer.linesChanged} LOC`,
			1500
		);
	});

	ensureRepoCloned(context);

	const repoUrl = getConfig().get<string>('repoUrl', '').trim();

	if (!repoUrl && getConfig().get<boolean>('enableGitSync')) {
		notifyWarn(
			'CodePulse: Set a Git repository URL to enable syncing.'
		);
	}

	void tryPush(getRepoPath(context));

	let interval = setInterval(
		() => flushActivity(context),
		getSnapshotIntervalMs()
	);


	context.subscriptions.push({
		dispose: () => clearInterval(interval)
	});

	const pushRetryInterval = setInterval(() => {
		if (!pushPending || gitInProgress) {
			return;
		}

		void tryPush(getRepoPath(context));
	}, 60 * 1000);


	context.subscriptions.push({
		dispose: () => clearInterval(pushRetryInterval)
	});



	context.subscriptions.push(disposable);

	const forceSnapshotCommand = vscode.commands.registerCommand(
		'codepulse.forceSnapshot',
		() => {
			flushActivity(context, true);
		}
	);

	context.subscriptions.push(forceSnapshotCommand);

	const statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100
	);

	statusBarItem.text = '$(pulse) CodePulse';
	statusBarItem.command = 'codepulse.forceSnapshot';
	statusBarItem.tooltip = 'Force snapshot and sync activity';
	statusBarItem.show();

	context.subscriptions.push(statusBarItem);


}


export function deactivate() { }


function flushActivity(context: vscode.ExtensionContext, manual = false) {

	if (!getConfig().get<boolean>('enabled')) {
		return;
	}


	if (
		activityBuffer.files.size === 0 &&
		activityBuffer.linesChanged === 0
	) {
		if (manual) {
			notifyInfo('CodePulse: No activity to snapshot');
		}
		return;
	}


	const now = new Date();

	const snapshot = {
		timestamp: now.toISOString(),
		filesTouched: activityBuffer.files.size,
		languages: Array.from(activityBuffer.languages),
		linesChanged: activityBuffer.linesChanged
	};

	const baseDir = path.join(getRepoPath(context), 'activity');

	const dirPath = path.join(
		baseDir,
		now.getFullYear().toString(),
		String(now.getMonth() + 1).padStart(2, '0'),
		String(now.getDate()).padStart(2, '0')
	);

	fs.mkdirSync(dirPath, { recursive: true });

	const fileName = `${String(now.getHours()).padStart(2, '0')}-${String(
		now.getMinutes()
	).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}.json`;


	const filePath = path.join(dirPath, fileName);

	fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2));

	vscode.window.setStatusBarMessage(
		`CodePulse snapshot written`,
		3000
	);

	console.log("Dir: ", baseDir);
	// Reset buffer
	activityBuffer = {
		files: new Set(),
		languages: new Set(),
		linesChanged: 0
	};

	if (
		getConfig().get<boolean>('enableGitSync') &&
		getConfig().get<string>('repoUrl')?.trim()
	) {
		void commitAndPush(getRepoPath(context));
	}


}


async function commitAndPush(repoPath: string) {
	if (gitInProgress) return;
	gitInProgress = true;

	try {
		const { stdout } = await execAsync('git status --porcelain', {
			cwd: repoPath
		});

		if (!stdout.trim()) {
			return;
		}

		await execAsync('git add .', { cwd: repoPath });
		await execAsync(
			'git commit -m "activity: coding snapshot"',
			{ cwd: repoPath }
		);

		successNotifiedForBatch = false;

		await tryPush(repoPath);
	}
	// catch (err: any) {
	// 	console.warn('CodePulse git error:', err.message);
	// }
	catch (err: any) {
		const msg = err.stderr?.toString() || err.message;
		notifyWarn(classifyGitError(msg));
		pushPending = false; // ❗ not retryable
	}

	finally {
		gitInProgress = false;
	}
}



async function tryPush(repoPath: string, generation = repoGeneration) {
	if (generation !== repoGeneration) return;

	try {
		await execAsync('git push', { cwd: repoPath });

		if (!successNotifiedForBatch) {
			notifyInfo('CodePulse synced to GitHub');
			successNotifiedForBatch = true;
		}

		pushPending = false;
	}
	// catch (err: any) {
	// 	if (generation !== repoGeneration) return;

	// 	const stderr = err?.stderr || err?.message || '';
	// 	const classification = classifyGitError(stderr);

	// 	if (classification.type === 'network') {
	// 		pushPending = true;
	// 		notifyWarn(classification.message);
	// 		return;
	// 	}

	// 	// ❌ Fatal errors — do NOT retry
	// 	pushPending = false;

	// 	notifyWarn(
	// 		`CodePulse sync failed: ${classification.message}`
	// 	);
	// }
	catch (err: any) {
		const msg = err.stderr?.toString() || err.message;
		const userMessage = classifyGitError(msg);

		notifyWarn(userMessage);

		// Retry ONLY for network issues
		if (userMessage.includes('offline')) {
			pushPending = true;
		} else {
			pushPending = false;
		}
	}

}



// function classifyGitError(stderr: string): {
// 	type: 'auth' | 'repo' | 'network' | 'unknown';
// 	message: string;
// } {
// 	const msg = stderr.toLowerCase();

// 	if (
// 		msg.includes('permission denied') ||
// 		msg.includes('access denied') ||
// 		msg.includes('403') ||
// 		msg.includes('authentication failed') ||
// 		msg.includes('could not read from remote repository')
// 	) {
// 		return {
// 			type: 'auth',
// 			message:
// 				'You do not have permission to push to this repository.'
// 		};
// 	}

// 	if (
// 		msg.includes('repository not found') ||
// 		msg.includes('not found') ||
// 		msg.includes('does not exist') ||
// 		msg.includes('not a git repository')

// 	) {
// 		return {
// 			type: 'repo',
// 			message:
// 				'The configured repository does not exist or is incorrect.'
// 		};
// 	}

// 	if (
// 		msg.includes('could not resolve host') ||
// 		msg.includes('network') ||
// 		msg.includes('timed out') ||
// 		msg.includes('connection')
// 	) {
// 		return {
// 			type: 'network',
// 			message:
// 				'Network issue detected. Changes will sync automatically.'
// 		};
// 	}

// 	return {
// 		type: 'unknown',
// 		message: 'Git push failed due to an unknown error.'
// 	};
// }

function classifyGitError(message: string): string {
	const msg = message.toLowerCase();

	if (msg.includes('repository not found')) {
		return 'The configured repository does not exist or the URL is incorrect.';
	}

	if (msg.includes('access denied') || msg.includes('permission')) {
		return 'You do not have permission to push to this repository.';
	}

	if (msg.includes('not a git repository')) {
		return 'The configured repository is invalid or was not cloned correctly.';
	}

	if (msg.includes('could not resolve host') || msg.includes('network')) {
		return 'CodePulse is offline. Changes will sync automatically.';
	}

	return 'CodePulse push failed due to an unknown Git error.';
}




function notifyInfo(message: string) {
	if (getConfig().get<boolean>('enableNotifications')) {
		vscode.window.showInformationMessage(message);
	}
}

function notifyWarn(message: string) {
	if (getConfig().get<boolean>('enableNotifications')) {
		vscode.window.showWarningMessage(message);
	}
}
