import AuditLog from '../models/AuditLog.js';

const SECRET_KEYS = new Set([
  'passwordhash', 'password', 'newpassword', 'currentpassword', 'confirmpassword',
  'token', 'tokenhash', 'refreshtoken', 'accesstoken',
]);

function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !SECRET_KEYS.has(key.toLowerCase()))
        .map(([key, v]) => [key, clean(v)])
    );
  }
  return value;
}

// Plain copy of a document (or object) with any secret fields removed
export function snapshot(doc) {
  if (doc == null) return undefined;
  const plain = JSON.parse(JSON.stringify(typeof doc.toJSON === 'function' ? doc.toJSON() : doc));
  return clean(plain);
}

/*
  Writes one audit entry. A failure to write is logged but does not break the
  request. For payments we can make this strict later.
*/
export async function logAudit(req, { action, entityType, entityId, project, before, after, note }) {
  try {
    await AuditLog.create({
      actor: req.user?._id,
      actorRole: req.user?.role,
      actorName: req.user?.name,
      action,
      entityType,
      entityId,
      project,
      before: snapshot(before),
      after: snapshot(after),
      note: note ? String(note).slice(0, 500) : undefined,
      ip: req.ip,
      userAgent: req.get?.('user-agent')?.slice(0, 300),
    });
  } catch (err) {
    console.error('⚠️ Audit log write failed:', action, err.message);
  }
}