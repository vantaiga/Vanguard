// Vanguard · events.js — Global event bus
// Single source of truth for all inter-module communication
// All 24 files use this. Zero dependencies.

import { EventEmitter } from 'events'

const _bus = new EventEmitter()
_bus.setMaxListeners(500)

export const emit = (event, data) => _bus.emit(event, data)
export const on   = (event, fn)   => { _bus.on(event, fn);   return () => _bus.off(event, fn) }
export const off  = (event, fn)   => _bus.off(event, fn)
export const once = (event, fn)   => _bus.once(event, fn)
export const listenerCount = (event) => _bus.listenerCount(event)
