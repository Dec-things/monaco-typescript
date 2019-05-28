import { path } from './path'
import { Directory } from '../Directory';

export class WorkerFileSystem {

    public fileVersions: { [filename: string]: number } = {}

    constructor(public mainDir: Directory = { files: {}, folders: {} }) {
    }

    public exists(filename: string): boolean {
        if (filename.substr(0, 8) === 'file:///') {
            filename = filename.substr(8)
        }
        let dirname = path.dirname(filename)
        let dir = this.mainDir
        if (dirname !== ".") {
            let dirs = dirname.split("/")
            for (let subDir of dirs) {
                if (dir.folders.hasOwnProperty(subDir)) {
                    dir = dir.folders[subDir]
                }
                else {
                    return false
                }
            }
        }
        return dir.files.hasOwnProperty(path.basename(filename))
    }
    public directoryExists(dirname: string): boolean {
        if (dirname.substr(0, 8) === 'file:///') {
            dirname = dirname.substr(8)
        }
        if (dirname === "") {
            return true
        }
        let dirs = dirname.split("/")
        let dir = this.mainDir
        for (let subDir of dirs) {
            if (dir.folders.hasOwnProperty(subDir)) {
                dir = dir.folders[subDir]
            }
            else {
                return false
            }
        }
        return true
    }

    public mkDir(dirname: string, createRecursively?: boolean) {
        let dirs = (dirname === "" || dirname === ".") ? [] : dirname.split("/")
        let dir = this.mainDir
        let index = 0
        for (let subDir of dirs) {
            index++
            if (index === dirs.length) {
                if (!dir.folders.hasOwnProperty(subDir)) {
                    dir.folders[subDir] = { files: {}, folders: {} }
                }
                return
            }
            if (!dir.folders.hasOwnProperty(subDir)) {
                if (createRecursively) {
                    dir.folders[subDir] = { files: {}, folders: {} }
                }
                else {
                    throw new Error("Could not create directory: " + dirname + ". The parent directory does not exist")
                }
            }
            dir = dir.folders[subDir]
        }
    }

    public rmDir(dirname: string) {
        let dirs = (dirname === "" || dirname === ".") ? [] : dirname.split("/")
        let dir = this.mainDir
        let index = 0
        for (let subDir of dirs) {
            index++
            if (index === dirs.length) {
                if (dir.folders.hasOwnProperty(subDir)) {
                    delete dir.folders[subDir]
                }
                return
            }
            if (!dir.folders.hasOwnProperty(subDir)) {
                throw new Error("Could not remove directory: " + dirname + ". The directory does not exist.")
            }
            dir = dir.folders[subDir]
        }
    }

    public writeFile(filename: string, value: string) {
        let dirname = path.dirname(filename)
        let dirs = dirname === "." ? [] : dirname.split("/")
        let dir = this.mainDir
        for (let subDir of dirs) {
            if (!dir.folders.hasOwnProperty(subDir)) {
                dir.folders[subDir] = { files: {}, folders: {} }
            }
            dir = dir.folders[subDir]
        }
        let basename = path.basename(filename)
        if (dir.files.hasOwnProperty(basename)) {
            dir.files[basename] = value
            this.fileVersions[filename] = (this.fileVersions[filename] || 0) + 1
        }
        else {
            dir.files[basename] = value
        }
    }

    public rmFile(filename: string) {
        let dirname = path.dirname(filename)
        let dirs = dirname === "." ? [] : dirname.split("/")
        let dir = this.mainDir
        for (let subDir of dirs) {
            if (dir.folders.hasOwnProperty(subDir)) {
                dir = dir.folders[subDir]
            }
            else {
                throw new Error("Could not remove file: " + filename + ". The file does not exist.")
            }
        }
        let basename = path.basename(filename)
        if (dir.files.hasOwnProperty(basename)) {
            delete dir.files[basename]
            delete this.fileVersions[filename]
        }
        else throw new Error("Could not remove file: " + filename + ". The file does not exist.")
    }

    public getFile(filename: string): { notFound?: boolean, notLoaded?: boolean, value?: string } {
        if (filename.substr(0, 8) === 'file:///') {
            filename = filename.substr(8)
        }
        let dirname = path.dirname(filename)
        let dirs = dirname === "." ? [] : dirname.split("/")
        let dir = this.mainDir
        for (let subDir of dirs) {
            if (dir.folders.hasOwnProperty(subDir)) {
                dir = dir.folders[subDir]
            }
            else {
                return { notFound: true }
            }
        }
        let basename = path.basename(filename)
        if (dir.files.hasOwnProperty(basename)) {
            let value = dir.files[basename]
            if (value === null) {
                return { notLoaded: true }
            }
            return { value }
        }
        return { notFound: true }
    }

    public readDirectory(dirname: string, extensions: string[], exclude, include) {
        if (dirname.substr(0, 8) === 'file:///') {
            dirname = dirname.substr(8)
        }
        let dirs = (dirname === "." || dirname === "") ? [] : dirname.split("/")
        let dir = this.mainDir
        for (let subDir of dirs) {
            if (dir.folders.hasOwnProperty(subDir)) {
                dir = dir.folders[subDir]
            }
            else {
                throw new Error("Could not read directory: " + dirname + ". The file does not exist.")
            }
        }
        return Object.keys(dir.files).filter((element) => {
            return extensions.indexOf(path.extname(element)) >= 0 && (!exclude || exclude.indexOf(element) < 0)
        })
    }

    public getDirectories(dirname: string) {
        if (dirname.substr(0, 8) === 'file:///') {
            dirname = dirname.substr(8)
        }
        let dirs = (dirname === "." || dirname === "") ? [] : dirname.split("/")
        let dir = this.mainDir
        for (let subDir of dirs) {
            if (dir.folders.hasOwnProperty(subDir)) {
                dir = dir.folders[subDir]
            }
            else {
                throw new Error("Could not get directories inside: " + dirname + ". The file does not exist.")
            }
        }
        return Object.keys(dir.folders)
    }

    public getFileVersion(filename: string) {
        return this.fileVersions[filename] || 0
    }

    public increaseFileVersion(filename: string) {
        this.fileVersions[filename] = this.getFileVersion(filename) + 1
    }
}