/**
 * Scheduling compatibility switch.
 *
 * Timeslot screens and logic are intentionally retained for possible future
 * reactivation. To restore scheduled orders later, enable timeslots and turn
 * off direct-order-only mode here and in the API server feature-flags file.
 */
export const TIMESLOT_FEATURE_ENABLED = false;
export const DIRECT_ORDER_ONLY = true;
