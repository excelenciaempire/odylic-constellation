/**
 * Delivery status: Meta's `effective_status` folded into the buckets people
 * ask for ("is it live or paused?"), for group-by, the dimension filter, the
 * dashboards' creative source and the 3D space. An ad paused at the ad set or
 * campaign counts as Paused: it isn't delivering either way. The exact Meta
 * value stays on the row as `effective_status` (the Status column).
 */
export const DELIVERY_STATUS_KEY = 'delivery_status'

export const DELIVERY_STATUSES = ['Live', 'Paused', 'In review', 'Issues', 'Archived'] as const
export type DeliveryStatus = typeof DELIVERY_STATUSES[number]

export function deliveryStatus(effective?: string | null): DeliveryStatus | '' {
  switch ((effective || '').toUpperCase()) {
    case 'ACTIVE': return 'Live'
    case 'PAUSED':
    case 'ADSET_PAUSED':
    case 'CAMPAIGN_PAUSED': return 'Paused'
    case 'PENDING_REVIEW':
    case 'IN_PROCESS':
    case 'PREAPPROVED': return 'In review'
    case 'DISAPPROVED':
    case 'WITH_ISSUES':
    case 'PENDING_BILLING_INFO': return 'Issues'
    case 'ARCHIVED':
    case 'DELETED': return 'Archived'
    default: return ''
  }
}
