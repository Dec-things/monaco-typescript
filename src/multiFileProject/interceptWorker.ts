const _onRequestReadFile = new monaco.Emitter<{ mode: 'typescript' | 'javascript'; id: string; filename: string }>()
export const onRequestReadFile = _onRequestReadFile.event

// Monkey patch MonacoEnvironment in order to detect when a new worker is created
let oldEnvironment = (self as any).MonacoEnvironment
if (typeof oldEnvironment.getWorker !== 'function' && typeof oldEnvironment.getWorkerUrl !== 'function') {
    throw new Error('You must define a function MonacoEnvironment.getWorkerUrl or MonacoEnvironment.getWorker')
}
;(self as any).MonacoEnvironment = {
    getWorker(workerId, label) {
        if (typeof oldEnvironment.getWorker === 'function') {
            var w: Worker = oldEnvironment.getWorker(workerId, label)
        } else if (typeof oldEnvironment.getWorkerUrl === 'function') {
            var w = new Worker(oldEnvironment.getWorkerUrl(workerId, label))
        } else {
            throw new Error('You must define a function MonacoEnvironment.getWorkerUrl or MonacoEnvironment.getWorker')
        }
        if (label !== 'typescript' && label !== 'javascript') {
            return w
        }

        let oldOnMessage: Function
        let newOnMessage = async (msg: MessageEvent) => {
            let parsed = JSON.parse(msg.data)
            if (parsed.shouldBeIntercepted) {
                if (parsed.method === 'readFile') {
                    _onRequestReadFile.fire({ mode: label, id: parsed.id, filename: parsed.filename })
                }
            } else {
                oldOnMessage(msg)
            }
        }
        w.onmessage = newOnMessage
        let newWorker = {
            terminate: function() {
                w.terminate()
            },
            addEventListener: function(event, listener) {
                w.addEventListener(event, listener)
            },
            postMessage: function(msg) {
                w.postMessage(msg)
            },
            dispatchEvent: function(event) {
                w.dispatchEvent(event)
            },
            removeEventListener: function(event, listener) {
                w.removeEventListener(event, listener)
            }
        }
        Object.defineProperty(newWorker, 'onmessage', {
            get() {
                return newOnMessage
            },
            set(value) {
                oldOnMessage = value
            }
        })
        return newWorker
    }
}


