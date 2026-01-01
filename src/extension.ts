import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';


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

const FLUSH_INTERVAL_MS = 30 * 1000; // dev mode

function getRepoPath(context: vscode.ExtensionContext) {
	return path.join(context.globalStorageUri.fsPath, 'activity-repo');
}

import { execSync } from 'child_process';

function ensureRepoCloned(context: vscode.ExtensionContext) {
	const repoPath = getRepoPath(context);

	if (fs.existsSync(path.join(repoPath, '.git'))) {
		return;
	}

	fs.mkdirSync(repoPath, { recursive: true });

	const repoUrl = 'https://github.com/skupperr/codepulse-activity.git';

	try {
		execSync(`git clone ${repoUrl} "${repoPath}"`, {
			stdio: 'ignore'
		});
	} catch (err: any) {
		vscode.window.showWarningMessage(
			`CodePulse: Failed to clone activity repo. Tracking will continue locally.`
		);
	}
}



// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	try {
		const gitVersion = execSync('git --version').toString();
		vscode.window.showInformationMessage(gitVersion);
	} catch (e: any) {
		vscode.window.showErrorMessage(
			`Git not available to CodePulse: ${e.message}`
		);
	}


	vscode.window.showInformationMessage('CodePulse is running');

	const disposable = vscode.workspace.onDidChangeTextDocument((event) => {
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

	const interval = setInterval(() => flushActivity(context), FLUSH_INTERVAL_MS);


	context.subscriptions.push({
		dispose: () => clearInterval(interval)
	});


	context.subscriptions.push(disposable);
}


export function deactivate() { }


function flushActivity(context: vscode.ExtensionContext) {
	if (
		activityBuffer.files.size === 0 &&
		activityBuffer.linesChanged === 0
	) {
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

	commitAndPush(getRepoPath(context));
}


function commitAndPush(repoPath: string) {
	try {
		if (!hasGitChanges(repoPath)) {
			return;
		}

		execSync('git add .', { cwd: repoPath });

		execSync(
			`git commit -m "activity: coding snapshot"`,
			{ cwd: repoPath }
		);

		execSync('git push', { cwd: repoPath });

		vscode.window.setStatusBarMessage(
			`CodePulse pushed to GitHub`,
			3000
		);

	} catch (err: any) {
		vscode.window.showWarningMessage(
			`CodePulse git error: ${err.message}`
		);
	}
}



function hasGitChanges(repoPath: string): boolean {
	try {
		const output = execSync('git status --porcelain', {
			cwd: repoPath
		}).toString();

		return output.trim().length > 0;
	} catch {
		return false;
	}
}
