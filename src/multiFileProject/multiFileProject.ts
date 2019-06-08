import Emitter = monaco.Emitter;
import Uri = monaco.Uri;

import { onRequestReadFile } from "./interceptWorker";
import { getTypescriptClient, getJavascriptClient } from "../monaco.contribution";

export const multiFileProjects: MultiFileProject[] = [];
const _onMultiFileProjectCreated = new Emitter<MultiFileProject>();
export const onMultiFileProjectCreated = _onMultiFileProjectCreated.event;

const _onShouldValidateTypescript = new Emitter<{ project: MultiFileProject, uri: monaco.Uri }>();
export const onShouldValidateTypescript = _onShouldValidateTypescript.event;
const _onShouldValidateJavascript = new Emitter<{ project: MultiFileProject, uri: monaco.Uri }>();
export const onShouldValidateJavacript = _onShouldValidateJavascript.event;

let tsUpdatePromise: { typescript: Promise<any>, javascript: Promise<any> } = { typescript: null, javascript: null };
/**
 * Higher-order function for calling a function on the Typescript worker.
 *
 * This function makes sure to call the given function until the worker does not report that it needs to update.
 */
export async function callWorkerFunction<T = any>(selector: 'typescript' | 'javascript', f: () => Promise<T> | T): Promise<T> {
    let first = true;
    while (first || tsUpdatePromise[selector]) {
        first = false;
        await tsUpdatePromise[selector];
        if (!tsUpdatePromise[selector]) {
            var response = await f();
        }
    }
    return response;
}

/**
 * Interupt the worker until the given promise resolves. This will delay any pending worker functions until the promise is complete.
 */
async function interuptWorker(selector: 'typescript' | 'javascript', promise: Promise<any>) {
    if (tsUpdatePromise[selector]) {
        var _promise = tsUpdatePromise[selector].then(() => promise);
    } else {
        var _promise = promise;
    }
    tsUpdatePromise[selector] = _promise;
    await _promise;
    if (tsUpdatePromise[selector] === _promise) {
        tsUpdatePromise[selector] = null;
    }
}

onRequestReadFile(async params => {
    for (let project of multiFileProjects) {
        if (project.id !== params.id) {
            continue;
        }

        let uri = monaco.Uri.parse(params.filename);

        let promise = new Promise<void>(async resolve => {
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

        interuptWorker(params.mode, promise)
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
    let tsPromise = new Promise(async resolve => {
        let tsClient = await getTypescriptClient()
        if (tsClient) {
            tsClient.setCurrentMultiFileProject(id)
        }
        resolve()
    })
    let jsPromise = new Promise(async resolve => {
        let jsClient = await getJavascriptClient()
        if (jsClient) {
            jsClient.setCurrentMultiFileProject(id)
        }
        resolve()
    })
    interuptWorker('typescript', tsPromise)
    interuptWorker('javascript', jsPromise)
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
        interuptWorker('javascript', this._registerPromise)
        interuptWorker('typescript', this._registerPromise)
        return this._registerPromise
    }

    /**
     * Write to a file. Will create the file as well as all required directories if they don't exist.
     */
    async writeFile(uri: Uri, value: string) {
        this.assertNotDisposed();

        let uriString = uri.toString();

        this._fileValues.set(uriString, value);

        let tsPromise = new Promise(async resolve => {
            await this.awaitRegister()
            if (this.isDisposed) {
                resolve()
                return;
            }
            let tsWorker = await getTypescriptClient();
            if (this.isDisposed) {
                resolve()
                return;
            }
            if (tsWorker) {
                tsWorker.setFile(this.id, uriString, value);
                _onShouldValidateTypescript.fire({ project: this, uri: this.currentFile })
            }

            resolve()
        })
        interuptWorker('typescript', tsPromise)

        let jsPromise = new Promise(async resolve => {
            await this.awaitRegister()
            if (this.isDisposed) {
                resolve()
                return;
            }
            let jsWorker = await getJavascriptClient();
            if (this.isDisposed) {
                resolve()
                return;
            }
            if (jsWorker) {
                jsWorker.setFile(this.id, uriString, value);
                _onShouldValidateJavascript.fire({ project: this, uri: this.currentFile })
            }

            resolve()
        })
        interuptWorker('javascript', jsPromise)

        await Promise.all([tsPromise, jsPromise])
    }

    /**
     * Remove a file.
     */
    async rmFile(uri: monaco.Uri) {
        this.assertNotDisposed();

        let uriString = uri.toString();

        let tsPromise = new Promise(async resolve => {
            await this.awaitRegister()
            if (this.isDisposed) {
                resolve()
                return;
            }
            let tsWorker = await getTypescriptClient();
            if (this.isDisposed) {
                resolve()
                return;
            }
            if (tsWorker) {
                tsWorker.rmFile(this.id, uriString);
                _onShouldValidateTypescript.fire({ project: this, uri: this.currentFile })
            }

            resolve()
        })
        interuptWorker('typescript', tsPromise)

        let jsPromise = new Promise(async resolve => {
            await this.awaitRegister()
            if (this.isDisposed) {
                resolve()
                return;
            }
            let jsWorker = await getJavascriptClient();
            if (this.isDisposed) {
                resolve()
                return;
            }
            if (jsWorker) {
                jsWorker.rmFile(this.id, uriString);
                _onShouldValidateJavascript.fire({ project: this, uri: this.currentFile })
            }

            resolve()
        })
        interuptWorker('javascript', jsPromise)

        await Promise.all([tsPromise, jsPromise])

        this._fileValues.delete(uriString);
    }

    /**
     * Set the current file to compile.
     */
    async setCurrentFile(uri: monaco.Uri) {
        this.assertNotDisposed();

        let uriString = uri ? uri.toString() : null;

        this._currentFile = uri || null;

        let tsPromise = new Promise(async resolve => {
            await this.awaitRegister()
            if (this.isDisposed) {
                resolve()
                return;
            }
            let tsWorker = await getTypescriptClient();
            if (this.isDisposed) {
                resolve()
                return;
            }
            if (tsWorker) {
                tsWorker.setCurrentFile(this.id, uriString);
                _onShouldValidateTypescript.fire({ project: this, uri: this.currentFile })
            }

            resolve()
        })
        interuptWorker('typescript', tsPromise)

        let jsPromise = new Promise(async resolve => {
            await this.awaitRegister()
            if (this.isDisposed) {
                resolve()
                return;
            }
            let jsWorker = await getJavascriptClient();
            if (this.isDisposed) {
                resolve()
                return;
            }
            if (jsWorker) {
                jsWorker.setCurrentFile(this.id, uriString);
                _onShouldValidateJavascript.fire({ project: this, uri: this.currentFile })
            }

            resolve()
        })
        interuptWorker('javascript', jsPromise)

        await Promise.all([tsPromise, jsPromise])
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

        _onShouldValidateTypescript.fire({ project: this, uri })
        _onShouldValidateJavascript.fire({ project: this, uri })
    }

    getFileValue(filename: string) {
        return this._fileValues.get(filename);
    }

    public dispose() {
        this.isDisposed = true;
        multiFileProjects.splice(multiFileProjects.indexOf(this), 1);
    }
}
