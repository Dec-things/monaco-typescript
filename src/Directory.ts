export type Directory = {
    files: { [filename: string]: string }
    folders: { [dirname: string]: Directory }
}