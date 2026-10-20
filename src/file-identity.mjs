const exact = (value) => typeof value === "bigint" ? String(value)
  : typeof value === "string" ? (/^-?\d+$/.test(value) ? value : null)
    : Number.isSafeInteger(value) ? String(value) : null;

export function fileIdentity(stat) {
  if (typeof stat?.dev !== "bigint" || typeof stat.ino !== "bigint") throw new TypeError("File identity requires bigint stats");
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

export function sameFileIdentity(left, right) {
  const values = [left?.dev, left?.ino, right?.dev, right?.ino].map(exact);
  return values.every((value) => value !== null) && values[0] === values[2] && values[1] === values[3];
}
