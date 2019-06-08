/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { LanguageServiceDefaultsImpl } from './monaco.contribution';
import { TypeScriptWorker } from './tsWorker';

import IDisposable = monaco.IDisposable;
import Uri = monaco.Uri;
import { MultiFileProject, multiFileProjects, onMultiFileProjectCreated, currentMultiFileProject } from './multiFileProject/multiFileProject';

export class WorkerManager {

	private _modeId: string;
	private _defaults: LanguageServiceDefaultsImpl;
	private _idleCheckInterval: number;
	private _lastUsedTime: number;
	private _configChangeListener: IDisposable;
	private _updateExtraLibsToken: number;
	private _extraLibsChangeListener: IDisposable;

	private _worker: monaco.editor.MonacoWebWorker<TypeScriptWorker>;
	public client: Promise<TypeScriptWorker>;

	constructor(modeId: string, defaults: LanguageServiceDefaultsImpl) {
		this._modeId = modeId;
		this._defaults = defaults;
		this._worker = null;
		this._idleCheckInterval = setInterval(() => this._checkIfIdle(), 30 * 1000);
		this._lastUsedTime = 0;
		this._configChangeListener = this._defaults.onDidChange(() => this._stopWorker());
		this._updateExtraLibsToken = 0;
		this._extraLibsChangeListener = this._defaults.onDidExtraLibsChange(() => this._updateExtraLibs());
	}

	private _stopWorker(): void {
		if (this._worker) {
			this._worker.dispose();
			this._worker = null;
		}
		this.client = null;
	}

	dispose(): void {
		clearInterval(this._idleCheckInterval);
		this._configChangeListener.dispose();
		this._extraLibsChangeListener.dispose();
		this._stopWorker();
		this.disposeClient()
	}

	private async _updateExtraLibs(): Promise<void> {
		if (!this._worker) {
			return;
		}
		const myToken = ++this._updateExtraLibsToken;
		const proxy = await this._worker.getProxy();
		if (this._updateExtraLibsToken !== myToken) {
			// avoid multiple calls
			return;
		}
		proxy.updateExtraLibs(this._defaults.getExtraLibs());
	}

	private _checkIfIdle(): void {
		if (!this._worker) {
			return;
		}
		const maxIdleTime = this._defaults.getWorkerMaxIdleTime();
		const timePassedSinceLastUsed = Date.now() - this._lastUsedTime;
		if (maxIdleTime > 0 && timePassedSinceLastUsed > maxIdleTime) {
			this._stopWorker();
		}
	}

	private disposeClient = () => {}
	private _getClient(): Promise<TypeScriptWorker> {
		this._lastUsedTime = Date.now();

		if (!this.client) {
			this._worker = monaco.editor.createWebWorker<TypeScriptWorker>({

				// module that exports the create() method and returns a `TypeScriptWorker` instance
				moduleId: 'vs/language/typescript/tsWorker',

				label: this._modeId,

				// passed in to the create() method
				createData: {
					compilerOptions: this._defaults.getCompilerOptions(),
					extraLibs: this._defaults.getExtraLibs()
				}
			});

			let p = new Promise<TypeScriptWorker>(async resolve => {
				this.disposeClient()

				let cancelled = false
				this.disposeClient = () => {
					cancelled = true
					onCreatedListener.dispose()
				}

				let client = await this._worker.getProxy()

				function register(project: MultiFileProject, dirs: { uri: Uri, value: string }[]) {
                    client.registerMultiFileProject(project.id, project.currentFile ? project.currentFile.toString() : null, dirs.map((element) => { return { uri: element.uri.toString(), value: element.value } }), project.extraLib);
				}

				let onCreatedListener = onMultiFileProjectCreated(project => {
					project.register().then(dirs => {
						register(project, dirs)
					})
				});
				await Promise.all(multiFileProjects.map(project => {
					return project.register().then(dirs => {
						if (cancelled) {
							return
						}
						register(project, dirs);
					})
				}))

				if (currentMultiFileProject) {
					client.setCurrentMultiFileProject(currentMultiFileProject)
				}

				resolve(client)
			})

			if (this._defaults.getEagerModelSync()) {
				p = p.then(worker => {
					return this._worker.withSyncedResources(monaco.editor.getModels()
						.filter(model => model.getModeId() === this._modeId)
						.map(model => model.uri)
					);
				})
			}

			this.client = p;
		}

		return this.client;
	}

	getLanguageServiceWorker(): Promise<TypeScriptWorker> {
		return this._getClient()
	}
}
