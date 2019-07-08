/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
"use strict";

import * as ts from "./lib/typescriptServices";
import { lib_dts, lib_es6_dts } from "./lib/lib";
import { IExtraLibs } from "./monaco.contribution";

import { WorkerFileSystem } from "./multiFileProject/tsWorkerFileSystem";

import IWorkerContext = monaco.worker.IWorkerContext;

const DEFAULT_LIB = {
    NAME: "defaultLib:lib.d.ts",
    CONTENTS: lib_dts
};

const ES6_LIB = {
    NAME: "defaultLib:lib.es6.d.ts",
    CONTENTS: lib_es6_dts
};

export class TypeScriptWorker implements ts.LanguageServiceHost {
    // --- model sync -----------------------

    private _ctx: IWorkerContext;
    private _extraLibs: IExtraLibs = Object.create(null);
    private _languageService = ts.createLanguageService(this);
    private _compilerOptions: ts.CompilerOptions;

    constructor(ctx: IWorkerContext, createData: ICreateData) {
        this._ctx = ctx;
        this._compilerOptions = createData.compilerOptions;
        this._extraLibs = createData.extraLibs;
    }

    // --- multi file project ------------------

    private _multiFileProjects = new Map<
        string,
        {
            fs: WorkerFileSystem;
            extraLib: string;
            extraFilesToCompile: Map<string, string>;
            currentFile: string;
        }
    >();
    private _currentMultiFileProject: string = null;

    registerMultiFileProject(
        id: string,
        currentFile: string,
        dir: { uri: string; value: string }[],
        extraLib: string
    ): Promise<void> {
        this._multiFileProjects.set(id, {
            fs: new WorkerFileSystem(dir),
            extraLib,
            extraFilesToCompile: new Map(),
            currentFile
        });
        return Promise.resolve();
    }

    disposeMultiFileProject(id: string) {
        this._multiFileProjects.delete(id);
        if (this._currentMultiFileProject === id) {
            this._currentMultiFileProject = null;
        }
    }

    setCurrentMultiFileProject(id: string): Promise<void> {
        this._currentMultiFileProject = id;
        return Promise.resolve();
    }

    setFile(id: string, filename: string, value: string) {
        let project = this._multiFileProjects.get(id);
        project.fs.writeFile(filename, value);
        return Promise.resolve();
    }

    mkDir(id: string, dirname: string) {
        let project = this._multiFileProjects.get(id);
        project.fs.mkDir(dirname);
    }

    rmDir(id: string, dirname: string) {
        let project = this._multiFileProjects.get(id);
        project.fs.rmDir(dirname);
    }

    rmFile(id: string, filename: string) {
        let project = this._multiFileProjects.get(id);
        project.fs.rmFile(filename);
    }

    setCurrentFile(id: string, filename: string) {
        let project = this._multiFileProjects.get(id);
        project.currentFile = filename;
    }

    addExtraFileToCompile(id: string, fileId: string, filename: string) {
        let project = this._multiFileProjects.get(id);
        project.extraFilesToCompile.set(fileId, filename);
    }

    removeExtraFileToCompile(id: string, fileId: string) {
        let project = this._multiFileProjects.get(id);
        project.extraFilesToCompile.delete(fileId);
    }

    // --- language service host ---------------

    getCompilationSettings(): ts.CompilerOptions {
        return this._compilerOptions;
    }

    getScriptFileNames(): string[] {
        if (this._currentMultiFileProject) {
            let project = this._multiFileProjects.get(this._currentMultiFileProject);
            let set = new Set<string>();
            if (project.currentFile) {
                set.add(project.currentFile);
            }
            project.extraFilesToCompile.forEach(value => {
                set.add(value);
            });
            let arr = [];
            set.forEach(element => arr.push(element));
            return arr;
        } else {
            let models = this._ctx.getMirrorModels().map(model => model.uri.toString());
            return models.concat(Object.keys(this._extraLibs));
        }
    }

    private _getModel(fileName: string): monaco.worker.IMirrorModel {
        let models = this._ctx.getMirrorModels();
        for (let i = 0; i < models.length; i++) {
            if (models[i].uri.toString() === fileName) {
                return models[i];
            }
        }
        return null;
    }

    getScriptVersion(fileName: string): string {
        if (this._currentMultiFileProject) {
            if (this.isDefaultLibFileName(fileName)) {
                // default lib is static
                return "1";
            }
            let project = this._multiFileProjects.get(this._currentMultiFileProject);
            return project.fs.getFileVersion(fileName).toString();
        } else {
            let model = this._getModel(fileName);
            if (model) {
                return model.version.toString();
            } else if (this.isDefaultLibFileName(fileName)) {
                // default lib is static
                return "1";
            } else if (fileName in this._extraLibs) {
                return String(this._extraLibs[fileName].version);
            }
        }
    }

    getScriptSnapshot(fileName: string): ts.IScriptSnapshot {
        let text: string;

        if (this._currentMultiFileProject) {
            if (fileName === DEFAULT_LIB.NAME) {
                text = DEFAULT_LIB.CONTENTS;
            } else if (fileName === ES6_LIB.NAME) {
                text = ES6_LIB.CONTENTS;
            } else {
                let project = this._multiFileProjects.get(this._currentMultiFileProject);
                let file = project.fs.getFile(fileName);
                if (file.notFound) {
                    throw new Error("In ts-worker file system: The file wasn't found.");
                } else if (file.notLoaded) {
                    (postMessage as any)(
                        JSON.stringify({
                            shouldBeIntercepted: true,
                            method: "readFile",
                            id: this._currentMultiFileProject,
                            filename: fileName
                        })
                    );
                    text = "";
                } else {
                    text = file.value;
                }
            }
        } else {
            let model = this._getModel(fileName);
            if (model) {
                // a true editor model
                text = model.getValue();
            } else if (fileName in this._extraLibs) {
                // extra lib
                text = this._extraLibs[fileName].content;
            } else if (fileName === DEFAULT_LIB.NAME) {
                text = DEFAULT_LIB.CONTENTS;
            } else if (fileName === ES6_LIB.NAME) {
                text = ES6_LIB.CONTENTS;
            } else {
                return;
            }
        }

        return <ts.IScriptSnapshot>{
            getText: (start, end) => text.substring(start, end),
            getLength: () => text.length,
            getChangeRange: () => undefined
        };
    }

    getScriptKind?(fileName: string): ts.ScriptKind {
        const suffix = fileName.substr(fileName.lastIndexOf(".") + 1);
        switch (suffix) {
            case "ts":
                return ts.ScriptKind.TS;
            case "tsx":
                return ts.ScriptKind.TSX;
            case "js":
                return ts.ScriptKind.JS;
            case "jsx":
                return ts.ScriptKind.JSX;
            default:
                return this.getCompilationSettings().allowJs ? ts.ScriptKind.JS : ts.ScriptKind.TS;
        }
    }

    getCurrentDirectory(): string {
        return "";
    }

    getDefaultLibFileName(options: ts.CompilerOptions): string {
        // TODO@joh support lib.es7.d.ts
        return options.target <= ts.ScriptTarget.ES5 ? DEFAULT_LIB.NAME : ES6_LIB.NAME;
    }

    isDefaultLibFileName(fileName: string): boolean {
        return fileName === this.getDefaultLibFileName(this._compilerOptions);
    }

    fileExists(filename: string) {
        if (this._currentMultiFileProject) {
            let project = this._multiFileProjects.get(this._currentMultiFileProject);
            return project.fs.exists(filename);
        }
        return false;
    }

    directoryExists(directoryName: string) {
        if (this._currentMultiFileProject) {
            let project = this._multiFileProjects.get(this._currentMultiFileProject);
            return project.fs.directoryExists(directoryName);
        }
        return false;
    }

    getDirectories(directoryName: string) {
        if (this._currentMultiFileProject) {
            let project = this._multiFileProjects.get(this._currentMultiFileProject);
            return project.fs.getDirectories(directoryName);
        }
        return [];
    }

    readDirectory(path: string, extensions: string[], exclude?: string[], include?: string[], depth?: number) {
        if (this._currentMultiFileProject) {
            let project = this._multiFileProjects.get(this._currentMultiFileProject);
            return project.fs.readDirectory(path, extensions, exclude, include, depth);
        }
        return [];
    }

    // --- language features

    private static clearFiles(diagnostics: ts.Diagnostic[]) {
        // Clear the `file` field, which cannot be JSON'yfied because it
        // contains cyclic data structures.
        diagnostics.forEach(diag => {
            diag.file = undefined;
            const related = <ts.Diagnostic[]>diag.relatedInformation;
            if (related) {
                related.forEach(diag2 => (diag2.file = undefined));
            }
        });
    }

    getSyntacticDiagnostics(fileName: string): Promise<ts.Diagnostic[]> {
        const diagnostics = this._languageService.getSyntacticDiagnostics(fileName);
        TypeScriptWorker.clearFiles(diagnostics);
        return Promise.resolve(diagnostics);
    }

    getSemanticDiagnostics(fileName: string): Promise<ts.Diagnostic[]> {
        const diagnostics = this._languageService.getSemanticDiagnostics(fileName);
        TypeScriptWorker.clearFiles(diagnostics);
        return Promise.resolve(diagnostics);
    }

    getCompilerOptionsDiagnostics(fileName: string): Promise<ts.Diagnostic[]> {
        const diagnostics = this._languageService.getCompilerOptionsDiagnostics();
        TypeScriptWorker.clearFiles(diagnostics);
        return Promise.resolve(diagnostics);
    }

    getCompletionsAtPosition(fileName: string, position: number): Promise<ts.CompletionInfo> {
        return Promise.resolve(this._languageService.getCompletionsAtPosition(fileName, position, undefined));
    }

    getCompletionEntryDetails(fileName: string, position: number, entry: string): Promise<ts.CompletionEntryDetails> {
        return Promise.resolve(
            this._languageService.getCompletionEntryDetails(fileName, position, entry, undefined, undefined, undefined)
        );
    }

    getSignatureHelpItems(fileName: string, position: number): Promise<ts.SignatureHelpItems> {
        return Promise.resolve(this._languageService.getSignatureHelpItems(fileName, position, undefined));
    }

    getQuickInfoAtPosition(fileName: string, position: number): Promise<ts.QuickInfo> {
        return Promise.resolve(this._languageService.getQuickInfoAtPosition(fileName, position));
    }

    getOccurrencesAtPosition(fileName: string, position: number): Promise<ReadonlyArray<ts.ReferenceEntry>> {
        return Promise.resolve(this._languageService.getOccurrencesAtPosition(fileName, position));
    }

    getDefinitionAtPosition(fileName: string, position: number): Promise<ReadonlyArray<ts.DefinitionInfo>> {
        return Promise.resolve(this._languageService.getDefinitionAtPosition(fileName, position));
    }

    getReferencesAtPosition(fileName: string, position: number): Promise<ts.ReferenceEntry[]> {
        return Promise.resolve(this._languageService.getReferencesAtPosition(fileName, position));
    }

    getNavigationBarItems(fileName: string): Promise<ts.NavigationBarItem[]> {
        return Promise.resolve(this._languageService.getNavigationBarItems(fileName));
    }

    getFormattingEditsForDocument(fileName: string, options: ts.FormatCodeOptions): Promise<ts.TextChange[]> {
        return Promise.resolve(this._languageService.getFormattingEditsForDocument(fileName, options));
    }

    getFormattingEditsForRange(
        fileName: string,
        start: number,
        end: number,
        options: ts.FormatCodeOptions
    ): Promise<ts.TextChange[]> {
        return Promise.resolve(this._languageService.getFormattingEditsForRange(fileName, start, end, options));
    }

    getFormattingEditsAfterKeystroke(
        fileName: string,
        postion: number,
        ch: string,
        options: ts.FormatCodeOptions
    ): Promise<ts.TextChange[]> {
        return Promise.resolve(this._languageService.getFormattingEditsAfterKeystroke(fileName, postion, ch, options));
    }

    getEmitOutput(fileName: string): Promise<ts.EmitOutput> {
        return Promise.resolve(this._languageService.getEmitOutput(fileName));
    }

    updateExtraLibs(extraLibs: IExtraLibs) {
        this._extraLibs = extraLibs;
    }
}

export interface ICreateData {
    compilerOptions: ts.CompilerOptions;
    extraLibs: IExtraLibs;
}

export function create(ctx: IWorkerContext, createData: ICreateData): TypeScriptWorker {
    return new TypeScriptWorker(ctx, createData);
}
