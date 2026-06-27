import { EventEmitter } from 'events'
const bus = new EventEmitter()
bus.setMaxListeners(0)
export const emit = (e,d) => bus.emit(e,d)
export const on   = (e,f) => bus.on(e,f)
export const off  = (e,f) => bus.off(e,f)
export const once = (e,f) => bus.once(e,f)
