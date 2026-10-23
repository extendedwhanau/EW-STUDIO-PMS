/**
 * Time Tracker Feature Configuration
 * 
 * Allowlist of email addresses that can access the time tracker.
 * To roll out to more users, add their email addresses to this array.
 */

export const TIME_TRACKER_ALLOWLIST = [
  'max@extendedwhanau.com',
];

/**
 * Maps studio email addresses to their Streamtime user IDs.
 * Add entries here when enabling time tracking for new users.
 */
export const STREAMTIME_USER_ID_MAP = {
  'max@extendedwhanau.com': 102129,
};

/**
 * Standard working hours per day (in hours)
 */
export const STANDARD_WORK_HOURS = 8;

/**
 * Check if a user (by email) has access to the time tracker
 */
export function canAccessTimeTracker(email) {
  const normalized = String(email || '').trim().toLowerCase();
  return TIME_TRACKER_ALLOWLIST.includes(normalized);
}

/**
 * Get Streamtime user ID for a studio email
 */
export function getStreamtimeUserId(email) {
  const normalized = String(email || '').trim().toLowerCase();
  return STREAMTIME_USER_ID_MAP[normalized] || null;
}
