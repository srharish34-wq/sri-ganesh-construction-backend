// ---------- Roles ----------
export const ROLES = Object.freeze({
  SUPER_ADMIN: 'super_admin',
  ENGINEER: 'engineer',
  WORKER: 'worker',
  CUSTOMER: 'customer',
});
export const ROLE_LIST = Object.values(ROLES);

// ---------- Projects ----------
export const PROJECT_STATUS = Object.freeze({
  PLANNING: 'planning',
  ACTIVE: 'active',
  ON_HOLD: 'on_hold',
  DELAYED: 'delayed',
  COMPLETED: 'completed',
});
export const PROJECT_STATUS_LIST = Object.values(PROJECT_STATUS);

export const MILESTONE_STATUS = Object.freeze({
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  OVERDUE: 'overdue',
});
export const MILESTONE_STATUS_LIST = Object.values(MILESTONE_STATUS);

// ---------- Approval workflow (reports, expenses, payments) ----------
export const APPROVAL_STATUS = Object.freeze({
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  PUBLISHED: 'published', // visible to the customer (reports only)
});
export const APPROVAL_STATUS_LIST = Object.values(APPROVAL_STATUS);

// ---------- Attendance ----------
export const ATTENDANCE_STATUS = Object.freeze({
  PRESENT: 'present',
  HALF_DAY: 'half_day',
  ABSENT: 'absent',
});
export const ATTENDANCE_STATUS_LIST = Object.values(ATTENDANCE_STATUS);

export const ATTENDANCE_SOURCE = Object.freeze({
  SELF_GPS: 'self_gps',          // worker or engineer checked in on their phone
  ENGINEER_ENTRY: 'engineer_entry', // engineer recorded it for a worker
  CORRECTION: 'correction',      // admin or engineer correction (audited)
});
export const ATTENDANCE_SOURCE_LIST = Object.values(ATTENDANCE_SOURCE);

// ---------- Work categories (daily reports and media) ----------
export const WORK_CATEGORIES = Object.freeze([
  'excavation',
  'foundation',
  'masonry',
  'concrete',
  'steel_work',
  'plastering',
  'plumbing',
  'electrical',
  'flooring',
  'painting',
  'carpentry',
  'roofing',
  'finishing',
  'site_cleanup',
  'inspection',
  'other',
]);

// ---------- Inventory ----------
export const INVENTORY_TXN_TYPE = Object.freeze({
  OPENING: 'opening',
  RECEIVED: 'received',
  USED: 'used',
  RETURNED: 'returned',
  ADJUSTMENT: 'adjustment',
});
export const INVENTORY_TXN_TYPE_LIST = Object.values(INVENTORY_TXN_TYPE);

export const MATERIAL_CATEGORIES = Object.freeze([
  'cement',
  'steel',
  'sand_aggregate',
  'bricks_blocks',
  'timber',
  'plumbing',
  'electrical',
  'paint',
  'tiles_flooring',
  'hardware',
  'other',
]);

export const UNITS = Object.freeze([
  'kg', 'tonne', 'bag', 'piece', 'cubic_metre', 'sq_metre', 'metre', 'litre', 'box', 'load',
]);

// ---------- Finance ----------
export const PAYMENT_STATUS = Object.freeze({
  PENDING: 'pending',     // entered, not yet confirmed. Does NOT count as received or paid.
  CONFIRMED: 'confirmed', // verified by an authorised person
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
});
export const PAYMENT_STATUS_LIST = Object.values(PAYMENT_STATUS);

export const PAYMENT_TYPE = Object.freeze({
  ADVANCE: 'advance',
  INSTALMENT: 'instalment',
  FINAL: 'final',
  OTHER: 'other',
});
export const PAYMENT_TYPE_LIST = Object.values(PAYMENT_TYPE);

export const PAYMENT_MODE = Object.freeze({
  CASH: 'cash',
  UPI: 'upi',
  BANK_TRANSFER: 'bank_transfer',
  CHEQUE: 'cheque',
  OTHER: 'other',
});
export const PAYMENT_MODE_LIST = Object.values(PAYMENT_MODE);

export const EXPENSE_CATEGORIES = Object.freeze([
  'material',
  'labour',
  'transport',
  'equipment_rental',
  'fuel',
  'food_and_stay',
  'permits_and_fees',
  'maintenance',
  'miscellaneous',
]);

// ---------- Media ----------
export const MEDIA_TYPE = Object.freeze({ IMAGE: 'image', VIDEO: 'video' });
export const MEDIA_TYPE_LIST = Object.values(MEDIA_TYPE);

// ---------- Notifications ----------
export const NOTIFICATION_TYPE = Object.freeze({
  REPORT_PUBLISHED: 'report_published',
  APPROVAL_PENDING: 'approval_pending',
  APPROVAL_RESULT: 'approval_result',
  MILESTONE_OVERDUE: 'milestone_overdue',
  LOW_STOCK: 'low_stock',
  TASK_ASSIGNED: 'task_assigned',
  PAYMENT_UPDATE: 'payment_update',
  GENERAL: 'general',
});
export const NOTIFICATION_TYPE_LIST = Object.values(NOTIFICATION_TYPE);

// ---------- Pagination ----------
export const PAGINATION = Object.freeze({ DEFAULT_LIMIT: 20, MAX_LIMIT: 100 });