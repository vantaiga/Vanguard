// Vanguard · events.js
// ZERO dependencies. The spine of all inter-module communication.
// Every file imports this. Nothing else imports into this file.

import { EventEmitter } from 'events'

const _bus = new EventEmitter()
_bus.setMaxListeners(1000)

export const emit          = (event, data) => { try { _bus.emit(event, data) } catch {} }
export const on            = (event, fn)   => { _bus.on(event, fn); return () => _bus.off(event, fn) }
export const off           = (event, fn)   => _bus.off(event, fn)
export const once          = (event, fn)   => _bus.once(event, fn)
export const listenerCount = (event)       => _bus.listenerCount(event)

export const EVENTS = {
  MEGA_SWAP:            'mega_swap',
  CHAIN_FUNDED:         'chain_funded',
  DEPLOY_SUCCESS:       'deploy_success',
  DEPLOY_FAILED:        'deploy_failed',
  NEXUS_DECISION:       'nexus_decision',
  APEX_SUCCESS:         'apex_success',
  APEX_FAILED:          'apex_failed',
  RS1_REVENUE:          'rs1_revenue',
  RS2_REVENUE:          'rs2_revenue',
  RS3_REVENUE:          'rs3_revenue',
  RS3_UPDATE:           'rs3_update',
  RS5_REVENUE:          'rs5_revenue',
  LIQUIDATION_DETECTED: 'liquidation_detected',
  ORACLE_PENDING:       'oracle_pending',
  DEPEG_DETECTED:       'depeg_detected',
  FUNDING_OPPORTUNITY:  'funding_opportunity',
  XCHAIN_DISLOCATION:   'xchain_dislocation',
  ARB_OPPORTUNITY:      'arb_opportunity',
  SYSTEM_HALT:          'system_halt',
  SYSTEM_RESUME:        'system_resume',
  EMERGENCY_HALT:       'emergency_halt',
  PROPELLER_CHANGED:    'propeller_changed',
  PROPELLER_CEILING:    'propeller_ceiling_reached',
  CRASH_MODE_ON:        'crash_mode_activated',
  CRASH_MODE_OFF:       'crash_mode_deactivated',
  OVERLAY_STORED:       'overlay_stored',
  OVERLAY_EXECUTED:     'overlay_executed',
  CEX_PRICE:            'cex_price',
  SV_UPDATE:            'sv_update',
  WITHDRAWAL_CREATED:   'withdrawal_created',
  USB_VAULT_ADD:        'usb_vault_add',
  USB_VAULT_RESTORE:    'usb_vault_restore',
}
