import Emitter = monaco.Emitter;
import Uri = monaco.Uri;

import { onRequestReadFile } from "./interceptWorker";
import { getTypescriptClient, getJavascriptClient } from "../monaco.contribution";

export const multiFileProjects: MultiFileProject[] = [];
const _onMultiFileProjectCreated = new Emitter<MultiFileProject>();
export const onMultiFileProjectCreated = _onMultiFileProjectCreated.event;

const _onShouldValidate = new Emitter<{ project: MultiFileProject, uri: monaco.Uri }>();
export const onShouldValidate = _onShouldValidate.event;

let tsUpdatePromise: Promise<void>;
/**
 * Higher-order function for calling a function on the Typescript worker.
 *
 * This function makes sure to call the given function until the worker does not report that it needs to update.
 */
export async function callTsFunction<T = any>(f: () => Promise<T> | T): Promise<T> {
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

export let currentMultiFileProject: string = null;
export function setCurrentMultiFileProject(id: string) {
    currentMultiFileProject = id;
    getTypescriptClient().then(client => client && client.setCurrentMultiFileProject(id));
    getJavascriptClient().then(client => client && client.setCurrentMultiFileProject(id));
}

export function getCurrentMultiFileProject() {
    for (let project of multiFileProjects) {
        if (project.id === currentMultiFileProject) {
            return project
        }
    }
    return null
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

    _onModelMarkers = new Emitter<{ uri: Uri, markers: monaco.editor.IMarkerData[] }>()
    public onModelMarkers = this._onModelMarkers.event

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

    private _registerPromise: Promise<{ uri: Uri, value: string }[]>;
    async awaitRegister() {
        let initPromise: any
        while (initPromise !== this._registerPromise) {
            initPromise = this._registerPromise
            await this._registerPromise
        }
    }

    async register() {
        this._registerPromise = new Promise<any>(async resolve => {
            let dirs = await this.fs.readAllDirs();
            if (this.isDisposed) {
                return;
            }
            resolve(dirs)
        });
        return this._registerPromise
    }

    /**
     * Write to a file. Will create the file as well as all required directories if they don't exist.
     */
    async writeFile(uri: Uri, value: string) {
        this.assertNotDisposed();

        let uriString = uri.toString();

        this._fileValues.set(uriString, value);

        await this.awaitRegister()

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
        if (this.currentFile) {
            _onShouldValidate.fire({ project: this, uri: this.currentFile });
        }
    }

    /**
     * Remove a file.
     */
    async rmFile(uri: monaco.Uri) {
        this.assertNotDisposed();

        let uriString = uri.toString();

        await this.awaitRegister()

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

        if (this.currentFile) {
            _onShouldValidate.fire({ project: this, uri: this.currentFile });
        }
    }

    /**
     * Set the current file to compile.
     */
    async setCurrentFile(uri: monaco.Uri) {
        this.assertNotDisposed();

        let uriString = uri ? uri.toString() : null;

        this._currentFile = uri || null;

        await this.awaitRegister()

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

        if (this.currentFile) {
            _onShouldValidate.fire({ project: this, uri: this.currentFile });
        }
    }

    public offsetToPosition(uri: Uri, offset: number): monaco.IPosition {
        let text = this._fileValues.get(uri.toString());

        if (!text) {
            return null;
        }

        if (offset > text.length) {
            let numLines = (text.match(/\n/g) || []).length + 1;
            return {
                lineNumber: numLines,
                column: text.length - text.lastIndexOf("\n")
            };
        }

        let newLineIndex = text.lastIndexOf('\n', offset - 1)
        if (newLineIndex === -1) {
            return { lineNumber: 1, column: offset + 1 }
        }
        let lineNumber = (text.substring(0, offset).match(/\n/g) || []).length;

        return { lineNumber: lineNumber + 1, column: offset - newLineIndex }
    }

    public positionToOffset(uri: Uri, position: monaco.IPosition): number {
        let text = this._fileValues.get(uri.toString());

        if (!text) {
            return null;
        }

        let ln = position.lineNumber - 1;
        let c = position.column - 1;

        let line = 0
        let previousIndex = -1
        while (true) {
            let nextIndex = text.indexOf('\n', previousIndex + 1)
            if (line === ln) {
                return Math.min(nextIndex, previousIndex + c + 1)
            }
            if (nextIndex < 0 || nextIndex > text.length) {
                return text.length
            }
            line++
            previousIndex = nextIndex
        }
    }

    async calculateModelMarkers(uri: monaco.Uri) {
        this.assertNotDisposed();

        _onShouldValidate.fire({ project: this, uri })
    }

    getFileValue(filename: string) {
        return this._fileValues.get(filename);
    }

    public dispose() {
        this.isDisposed = true;
        multiFileProjects.splice(multiFileProjects.indexOf(this), 1);
    }
}
