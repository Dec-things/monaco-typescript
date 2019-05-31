import { path } from './path'

type Directory = {
    files: { [filename: string]: string }
    folders: { [dirname: string]: Directory }
}

export class WorkerFileSystem {

    public fileVersions: { [filename: string]: number } = {}
    public mainDir: Directory

    constructor(dir: { uri: string, value: string }[]) {
        this.mainDir = { folders: {}, files: {} }
        dir.forEach((element) => {
            this.writeFile(element.uri, element.value)
        })
    }

    public exists(filename: string): boolean {
        let shortFilename = filename.substr(7)
        let dirname = path.dirname(shortFilename)
        let dirs = dirname.split("/")
        let dir = this.mainDir
        for (let subDir of dirs) {
            if (subDir === '') {
                continue
            }
            if (dir.folders.hasOwnProperty(subDir)) {
                dir = dir.folders[subDir]
            }
            else {
                return false
            }
        }
        return dir.files.hasOwnProperty(path.basename(shortFilename))
    }
    public directoryExists(dirname: string): boolean {
        let shortDirname = dirname.substr(7)
        let dirs = shortDirname.split("/")
        let dir = this.mainDir
        for (let subDir of dirs) {
            if (subDir === '') {
                continue
            }
            if (dir.folders.hasOwnProperty(subDir)) {
                dir = dir.folders[subDir]
            }
            else {
                return false
            }
        }
        return true
    }

    public mkDir(dirname: string) {
        let shortDirname = dirname.substr(7)
        let dirs = shortDirname.split("/")
        let dir = this.mainDir
        let index = 0
        for (let subDir of dirs) {
            index++
            if (subDir === '') {
                continue
            }
            if (index === dirs.length) {
                if (!dir.folders.hasOwnProperty(subDir)) {
                    dir.folders[subDir] = { files: {}, folders: {} }
                }
                return
            }
            if (!dir.folders.hasOwnProperty(subDir)) {
                dir.folders[subDir] = { files: {}, folders: {} }
            }
            dir = dir.folders[subDir]
        }
    }

    public rmDir(dirname: string) {
        let shortDirname = dirname.substr(7)
        let dirs = shortDirname.split("/")
        let dir = this.mainDir
        let index = 0
        for (let subDir of dirs) {
            index++
            if (subDir === '') {
                continue
            }
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
        let shortFilename = filename.substr(7)
        let dirname = path.dirname(shortFilename)
        let dirs = dirname.split("/")
        let dir = this.mainDir
        for (let subDir of dirs) {
            if (subDir === '') {
                continue
            }
            if (!dir.folders.hasOwnProperty(subDir)) {
                dir.folders[subDir] = { files: {}, folders: {} }
            }
            dir = dir.folders[subDir]
        }
        let basename = path.basename(shortFilename)
        if (dir.files.hasOwnProperty(basename)) {
            dir.files[basename] = value
            this.fileVersions[filename] = (this.fileVersions[filename] || 0) + 1
        }
        else {
            dir.files[basename] = value
        }
    }

    public rmFile(filename: string) {
        let shortFilename = filename.substring(7)
        let dirname = path.dirname(shortFilename)
        let dirs = dirname === "." ? [] : dirname.split("/")
        let dir = this.mainDir
        for (let subDir of dirs) {
            if (subDir === '') {
                continue
            }
            if (dir.folders.hasOwnProperty(subDir)) {
                dir = dir.folders[subDir]
            }
            else {
                throw new Error("Could not remove file: " + filename + ". The file does not exist.")
            }
        }
        let basename = path.basename(shortFilename)
        if (dir.files.hasOwnProperty(basename)) {
            delete dir.files[basename]
            delete this.fileVersions[filename]
        }
        else throw new Error("Could not remove file: " + filename + ". The file does not exist.")
    }

    public getFile(filename: string): { notFound?: boolean, notLoaded?: boolean, value?: string } {
        let shortFilename = filename.substr(7)
        let dirname = path.dirname(shortFilename)
        let dirs = dirname === "." ? [] : dirname.split("/")
        let dir = this.mainDir
        for (let subDir of dirs) {
            if (subDir === '') {
                continue
            }
            if (dir.folders.hasOwnProperty(subDir)) {
                dir = dir.folders[subDir]
            }
            else {
                return { notFound: true }
            }
        }
        let basename = path.basename(shortFilename)
        if (dir.files.hasOwnProperty(basename)) {
            let value = dir.files[basename]
            if (value === null) {
                return { notLoaded: true }
            }
            return { value }
        }
        return { notFound: true }
    }

    public readDirectory(dirname: string, extensions: string[], exclude?: string[], include?: string[], depth?: number) {
        let shortDirname = dirname.substr(7)
        let dirs = shortDirname.split("/")
        let dir = this.mainDir
        for (let subDir of dirs) {
            if (subDir === '') {
                continue
            }
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
        let shortDirname = dirname.substr(7)
        let dirs = shortDirname.split("/")
        let dir = this.mainDir
        for (let subDir of dirs) {
            if (subDir === '') {
                continue
            }
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