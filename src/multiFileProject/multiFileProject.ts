import Emitter = monaco.Emitter
import Uri = monaco.Uri

import { Directory } from '../Directory'
import { onRequestReadFile, getTypescriptWorker, getJavascriptWorker } from './interceptWorker'

export const multiFileProjects: MultiFileProject[] = []
export const onMultiFileProjectCreated = new Emitter<MultiFileProject>()

const _onShouldValidate = new Emitter<MultiFileProject>()
export const onShouldValidate = _onShouldValidate.event

let tsUpdatePromise: Promise<void>
/**
 * Higher-order function for calling a function on the Typescript worker.
 *
 * This function makes sure to call the given function until the worker does not report that it needs to update.
 */
export async function callTsFunction<T = any>(f: () => Promise<T> | T): Promise<T> {
    let first = true
    while (first || tsUpdatePromise) {
        first = false
        await tsUpdatePromise
        if (!tsUpdatePromise) {
            var response = await f()
        }
    }
    return response
}

onRequestReadFile(async params => {
    for (let project of multiFileProjects) {
        if (project.id !== params.id) {
            continue
        }

        let promise = new Promise<any>(async resolve => {
            let value = await project.fs.readFile(params.filename)
            if (project.isDisposed) {
                resolve()
                return
            }
            if (params.mode === 'typescript') {
                var worker = await getTypescriptWorker()
            } else {
                var worker = await getJavascriptWorker()
            }
            await worker.setFile(params.id, params.filename, value)
            resolve()
        })

        if (tsUpdatePromise) {
            var _promise = tsUpdatePromise.then(() => promise)
        } else {
            var _promise = promise
        }
        tsUpdatePromise = _promise
        await _promise
        if (tsUpdatePromise === _promise) {
            tsUpdatePromise = null
        }
    }
})

export function createMultiFileProject(
    currentFile: string,
    fs: { readFile: (filename: string) => Promise<string>; readAllDirs: () => Promise<Directory> }
) {
    return new MultiFileProject(currentFile, fs)
}

export function isMultiFileMode() {
    return multiFileProjects.length > 0
}

export class MultiFileProject {
    private static idCounter = 0
    public id = (MultiFileProject.idCounter++).toString()

    private _uri: Uri
    public get uri() {
        return this._uri
    }

    private _currentFile: string
    public get currentFile() {
        return this._currentFile
    }

    private _extraLib: string
    public get extraLib() {
        return this._extraLib
    }

    public isDisposed = false
    private assertNotDisposed() {
        if (this.isDisposed) {
            throw new Error('The project was disposed.')
        }
    }

    constructor(
        currentFile: string,
        public fs: { readFile: (filename: string) => Promise<string>; readAllDirs: () => Promise<Directory> }
    ) {
        this.setCurrentFile(currentFile)
        onMultiFileProjectCreated.fire(this)
    }

    /**
     * Create a directory.
     */
    mkDir(dirname: string) {
        this.assertNotDisposed()
        let tsWorker = getTypescriptWorker()
        if (tsWorker) {
            tsWorker.mkDir(this.id, dirname)
        }
        let jsWorker = getJavascriptWorker()
        if (jsWorker) {
            jsWorker.mkDir(this.id, dirname)
        }
    }

    /**
     * Remove a directory.
     */
    rmDir(dirname: string) {
        this.assertNotDisposed()
        let tsWorker = getTypescriptWorker()
        if (tsWorker) {
            tsWorker.rmDir(this.id, dirname)
        }
        let jsWorker = getJavascriptWorker()
        if (jsWorker) {
            jsWorker.rmDir(this.id, dirname)
        }
        _onShouldValidate.fire(this)
    }

    /**
     * Write to a file. Will create the file as well as all required directories if they don't exist.
     */
    writeFile(filename: string, value: string) {
        this.assertNotDisposed()
        let tsWorker = getTypescriptWorker()
        if (tsWorker) {
            tsWorker.setFile(this.id, filename, value)
        }
        let jsWorker = getJavascriptWorker()
        if (jsWorker) {
            jsWorker.setFile(this.id, filename, value)
        }
        _onShouldValidate.fire(this)
    }

    /**
     * Remove a file.
     */
    rmFile(filename: string) {
        this.assertNotDisposed()
        let tsWorker = getTypescriptWorker()
        if (tsWorker) {
            tsWorker.rmFile(this.id, filename)
        }
        let jsWorker = getJavascriptWorker()
        if (jsWorker) {
            jsWorker.rmFile(this.id, filename)
        }
        _onShouldValidate.fire(this)
    }

    setCurrentFile(filename: string) {
        this.assertNotDisposed()

        this._currentFile = filename
        this._uri = Uri.file(filename)

        let tsWorker = getTypescriptWorker()
        if (tsWorker) {
            tsWorker.setCurrentFile(this.id, filename)
        }
        let jsWorker = getJavascriptWorker()
        if (jsWorker) {
            jsWorker.setCurrentFile(this.id, filename)
        }

        _onShouldValidate.fire(this)
    }

    public dispose() {
        this.isDisposed = true
        multiFileProjects.splice(multiFileProjects.indexOf(this), 1)
    }
}
