/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict'

import { WorkerManager } from './workerManager'
import { TypeScriptWorker } from './tsWorker'
import { LanguageServiceDefaultsImpl } from './monaco.contribution'
import * as languageFeatures from './languageFeatures'

import Uri = monaco.Uri

let javaScriptWorker: (first: Uri, ...more: Uri[]) => Promise<TypeScriptWorker>
let typeScriptWorker: (first: Uri, ...more: Uri[]) => Promise<TypeScriptWorker>

export function setupTypeScript(defaults: LanguageServiceDefaultsImpl) {
	let mode = setupMode(defaults, 'typescript')
	typeScriptWorker = mode.worker
	return mode.client
}

export function setupJavaScript(defaults: LanguageServiceDefaultsImpl) {
	let mode = setupMode(defaults, 'javascript')
	javaScriptWorker = mode.worker
	return mode.client
}

export function getJavaScriptWorker(): Promise<(first: Uri, ...more: Uri[]) => Promise<TypeScriptWorker>> {
    return new Promise((resolve, reject) => {
        if (!javaScriptWorker) {
            return reject('JavaScript not registered!')
        }

        resolve(javaScriptWorker)
    })
}

export function getTypeScriptWorker(): Promise<(first: Uri, ...more: Uri[]) => Promise<TypeScriptWorker>> {
    return new Promise((resolve, reject) => {
        if (!typeScriptWorker) {
            return reject('TypeScript not registered!')
        }

        resolve(typeScriptWorker)
    })
}

function setupMode(
    defaults: LanguageServiceDefaultsImpl,
    modeId: 'typescript' | 'javascript'
): { client: WorkerManager; worker: (first: Uri, ...more: Uri[]) => Promise<TypeScriptWorker> } {
    const client = new WorkerManager(modeId, defaults)
    const worker = (): Promise<TypeScriptWorker> => {
        return client.getLanguageServiceWorker()
    }

    monaco.languages.registerCompletionItemProvider(modeId, new languageFeatures.SuggestAdapter(worker, modeId))
    monaco.languages.registerSignatureHelpProvider(modeId, new languageFeatures.SignatureHelpAdapter(worker, modeId))
    monaco.languages.registerHoverProvider(modeId, new languageFeatures.QuickInfoAdapter(worker, modeId))
    monaco.languages.registerDocumentHighlightProvider(modeId, new languageFeatures.OccurrencesAdapter(worker, modeId))
    monaco.languages.registerDefinitionProvider(modeId, new languageFeatures.DefinitionAdapter(worker, modeId))
    monaco.languages.registerReferenceProvider(modeId, new languageFeatures.ReferenceAdapter(worker, modeId))
    monaco.languages.registerDocumentSymbolProvider(modeId, new languageFeatures.OutlineAdapter(worker, modeId))
    monaco.languages.registerDocumentRangeFormattingEditProvider(modeId, new languageFeatures.FormatAdapter(worker, modeId))
    monaco.languages.registerOnTypeFormattingEditProvider(modeId, new languageFeatures.FormatOnTypeAdapter(worker, modeId))
    new languageFeatures.DiagnostcsAdapter(defaults, modeId, worker)

    return { client, worker }
}
