import bcrypt from "bcryptjs";

const PASSWORD_COST = 12;

export function hashPassword(password: string) {
  return bcrypt.hash(password, PASSWORD_COST);
}

export function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}
