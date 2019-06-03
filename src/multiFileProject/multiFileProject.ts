import Emitter = monaco.Emitter;
import Uri = monaco.Uri;

import { onRequestReadFile } from "./interceptWorker";
import { getTypescriptClient, getJavascriptClient, typescriptDefaults, javascriptDefaults } from "../monaco.contribution";
import { path } from "./path";
import { flattenDiagnosticMessageText } from "../languageFeatures";

export const multiFileProjects: MultiFileProject[] = [];
const _onMultiFileProjectCreated = new Emitter<MultiFileProject>();
export const onMultiFileProjectCreated = _onMultiFileProjectCreated.event;

const _onShouldValidate = new Emitter<MultiFileProject>();
export const onShouldValidate = _onShouldValidate.event;

let tsUpdatePromise: Promise<void>;
/**
 * Higher-order function for calling a function on the Typescript worker.
 *
 * This function makes sure to call the given function until the worker does not report that it needs to update.
 */
export async function callTsFunction<T = any>(f: () => Promise<T> | T): Promise<T> {
    if (!isMultiFileMode()) {
        return f();
    }
    let first = true;
    while (first || tsUpdatePromise) {
        first = false;
        await tsUpdatePromise;
        if (!tsUpdatePromise) {
            var response = await f();
        }
    }
    return response;
}

onRequestReadFile(async params => {
    for (let project of multiFileProjects) {
        if (project.id !== params.id) {
            continue;
        }

        let uri = monaco.Uri.parse(params.filename);

        let promise = new Promise<any>(async resolve => {
            let value = await project.fs.readFile(uri);
            if (project.isDisposed) {
                resolve();
                return;
            }
            (project as any)._fileValues.set(uri.toString(), value);
            if (params.mode === "typescript") {
                var worker = await getTypescriptClient();
            } else {
                var worker = await getJavascriptClient();
            }
            if (worker) {
                await worker.setFile(params.id, params.filename, value);
            }
            resolve();
        });

        if (tsUpdatePromise) {
            var _promise = tsUpdatePromise.then(() => promise);
        } else {
            var _promise = promise;
        }
        tsUpdatePromise = _promise;
        await _promise;
        if (tsUpdatePromise === _promise) {
            tsUpdatePromise = null;
        }
    }
});

export function createMultiFileProject(fs: {
    readFile: (uri: monaco.Uri) => Promise<string>;
    readAllDirs: () => Promise<{ uri: monaco.Uri; value: string }[]>;
}) {
    return new MultiFileProject(fs);
}

export function isMultiFileMode() {
    return Boolean(currentMultiFileProject);
}

export let currentMultiFileProject: string = null;
export async function setCurrentMultiFileProject(id: string) {
    currentMultiFileProject = id;
    getTypescriptClient().then(client => client && client.setCurrentMultiFileProject(id));
    getJavascriptClient().then(client => client && client.setCurrentMultiFileProject(id));
}

export class MultiFileProject {
    private static idCounter = 0;
    public id = (MultiFileProject.idCounter++).toString();

    private _currentFile: monaco.Uri = null;
    public get currentFile() {
        return this._currentFile;
    }

    private _extraLib: string;
    public get extraLib() {
        return this._extraLib;
    }

    public isDisposed = false;
    private assertNotDisposed() {
        if (this.isDisposed) {
            throw new Error("The project was disposed.");
        }
    }

    private _fileValues = new Map<string, string>();

    constructor(
        public fs: {
            readFile: (uri: monaco.Uri) => Promise<string>;
            readAllDirs: () => Promise<{ uri: monaco.Uri; value: string }[]>;
        }
    ) {
        setCurrentMultiFileProject(this.id);
        multiFileProjects.push(this);
        _onMultiFileProjectCreated.fire(this);
    }

    /**
     * Write to a file. Will create the file as well as all required directories if they don't exist.
     */
    async writeFile(uri: monaco.Uri, value: string) {
        this.assertNotDisposed();

        let uriString = uri.toString();

        this._fileValues.set(uriString, value);

        let tsWorker = await getTypescriptClient();
        if (this.isDisposed) {
            return;
        }
        if (tsWorker) {
            tsWorker.setFile(this.id, uriString, value);
        }
        let jsWorker = await getJavascriptClient();
        if (this.isDisposed) {
            return;
        }
        if (jsWorker) {
            jsWorker.setFile(this.id, uriString, value);
        }
        _onShouldValidate.fire(this);
    }

    /**
     * Remove a file.
     */
    async rmFile(uri: monaco.Uri) {
        this.assertNotDisposed();

        let uriString = uri.toString();

        let tsWorker = await getTypescriptClient();
        if (this.isDisposed) {
            return;
        }
        if (tsWorker) {
            tsWorker.rmFile(this.id, uri.toString());
        }
        let jsWorker = await getJavascriptClient();
        if (this.isDisposed) {
            return;
        }
        if (jsWorker) {
            jsWorker.rmFile(this.id, uri.toString());
        }

        this._fileValues.delete(uriString);

        _onShouldValidate.fire(this);
    }

    /**
     * Set the current file to compile.
     */
    async setCurrentFile(uri: monaco.Uri) {
        this.assertNotDisposed();

        let uriString = uri ? uri.toString() : null;

        this._currentFile = uri || null;

        let tsWorker = await getTypescriptClient();
        if (this.isDisposed) {
            return;
        }
        if (tsWorker) {
            tsWorker.setCurrentFile(this.id, uriString);
        }
        let jsWorker = await getJavascriptClient();
        if (this.isDisposed) {
            return;
        }
        if (jsWorker) {
            jsWorker.setCurrentFile(this.id, uriString);
        }

        _onShouldValidate.fire(this);
    }

    public offsetToPosition(uri: Uri, offset: number): monaco.IPosition {
        let text = this._fileValues.get(uri.toString())

        if (!text) {
            return null
        }

        if (offset > text.length) {
            let numLines = (text.match(/\n/g)||[]).length + 1
            return {
                lineNumber: numLines, column: text.length - text.lastIndexOf('\n')
            }
        }

        let totalLength = 0
        let line = 1
        let counter = offset
        while (true) {
            let length = text.indexOf('\n', totalLength)
            if (length >= counter) {
                return { lineNumber: line, column: counter + 1 }
            }
            totalLength += length
            line++
            counter -= length + 1
        }
    }

    public positionToOffset(uri: Uri, position: monaco.IPosition): number {
        let text = this._fileValues.get(uri.toString())

        if (!text) {
            return null
        }

        let lines = text.split('\n')

        let ln = position.lineNumber - 1
        let c = position.column - 1

        // handle the two cases where position might be greater than text length
        if (ln === lines.length - 1) {
            let lastLineLength = lines[lines.length - 1].length
            let actualColumn = Math.min(c, lastLineLength)
            return text.length - lastLineLength + actualColumn
        }
        if (ln > lines.length - 1) {
            return text.length
        }

        let counter = 0
        for (let i = 0; i < position.lineNumber - 1; i++) {
            counter += lines[i].length + 1
        }
        return counter + position.column - 1
    }

    private _convertDiagnostics(resource: Uri, diag: import('typescript').Diagnostic): monaco.editor.IMarkerData {
		const { lineNumber: startLineNumber, column: startColumn } = this.offsetToPosition(resource, diag.start);
		const { lineNumber: endLineNumber, column: endColumn } = this.offsetToPosition(resource, diag.start + diag.length);

		return {
			severity: monaco.MarkerSeverity.Error,
			startLineNumber,
			startColumn,
			endLineNumber,
			endColumn,
			message: flattenDiagnosticMessageText(diag.messageText, '\n')
		};
    }

    private _extraFilesToCompileIdCounter = 0

    async getModelMarkers(uri: monaco.Uri) {
        this.assertNotDisposed();

        let uriString = uri.toString();
        let extname = path.extname(uriString);

        if (extname === ".ts" || extname === ".tsx") {
            var worker = await getTypescriptClient();
            var defaults = typescriptDefaults;
        } else if (extname === ".js" || extname === ".jsx") {
            var worker = await getJavascriptClient();
            var defaults = javascriptDefaults;
        } else {
            return [];
        }

        if (this.isDisposed) {
            return;
        }

        let fileId = (this._extraFilesToCompileIdCounter++).toString()
        worker.addExtraFileToCompile(this.id, fileId, uriString)

        let diagnostics = await callTsFunction(() => {
            setCurrentMultiFileProject(this.id);
            const promises: Promise<import("typescript").Diagnostic[]>[] = [];
            const { noSyntaxValidation, noSemanticValidation } = defaults.getDiagnosticsOptions();
            if (!noSyntaxValidation) {
                promises.push(worker.getSyntacticDiagnostics(uri.toString()));
            }
            if (!noSemanticValidation) {
                promises.push(worker.getSemanticDiagnostics(uri.toString()));
            }
            return Promise.all(promises);
        });

        worker.removeExtraFileToCompile(this.id, fileId)

        if (!diagnostics) {
            return null;
        }

        return diagnostics.reduce((p, c) => c.concat(p), []).map(d => this._convertDiagnostics(uri, d));
    }

    getFileValue(filename: string) {
        return this._fileValues.get(filename);
    }

    public dispose() {
        this.isDisposed = true;
        multiFileProjects.splice(multiFileProjects.indexOf(this), 1);
    }
}
