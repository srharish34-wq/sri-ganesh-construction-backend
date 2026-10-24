import { PAGINATION } from '../config/constants.js';

export function getPagination(query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(
    PAGINATION.MAX_LIMIT,
    Math.max(1, parseInt(query.limit, 10) || PAGINATION.DEFAULT_LIMIT)
  );
  return { page, limit, skip: (page - 1) * limit };
}

export function buildPage(items, total, { page, limit }) {
  const totalPages = Math.ceil(total / limit);
  return { items, pagination: { page, limit, total, totalPages, hasMore: page < totalPages } };
}

export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');