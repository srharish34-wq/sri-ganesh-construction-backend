// All "days" in this app are Indian dates (IST, UTC+5:30), whatever the server's timezone.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export const keyOf = (date) => new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
export const todayKeyIST = () => keyOf(new Date());
export const dayStart = (key) => new Date(`${key}T00:00:00+05:30`);
export const dayEnd = (key) => new Date(`${key}T23:59:59.999+05:30`);

// Today -> the current moment. A past day -> noon IST of that day.
export const dateFromKeyOrNow = (key) =>
  !key || key === todayKeyIST() ? new Date() : new Date(`${key}T12:00:00+05:30`);
