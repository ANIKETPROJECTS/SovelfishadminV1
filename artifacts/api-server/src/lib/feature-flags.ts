/**
 * Scheduling compatibility switch.
 *
 * Keep the timeslot routes, schemas, and order compatibility logic intact.
 * To restore scheduled orders later, enable timeslots and turn off
 * direct-order-only mode here and in the admin app feature-flags file.
 */
export const TIMESLOT_FEATURE_ENABLED = false;
export const DIRECT_ORDER_ONLY = true;
