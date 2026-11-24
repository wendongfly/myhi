import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.myhi');
const ROLES_FILE = join(CONFIG_DIR, 'roles.json');
const USERS_FILE = join(CONFIG_DIR, 'users.json');

const ROLE_LEVELS = { admin: 3, operator: 2, viewer: 1 };

let rolesConfig = null;
let usersConfig = null;

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export function loadRoles() {
  try {
    if (existsSync(ROLES_FILE)) {
      rolesConfig = JSON.parse(readFileSync(ROLES_FILE, 'utf8'));
      return rolesConfig;
    }
  } catch (err) {
    console.warn('[角色] 加载 roles.json 失败:', err.message);
  }
  rolesConfig = null;
  return null;
}

// 按「明文密码」查表只认自有属性：users.json / roles.json 是 JSON.parse 出的普通对象，
// 直接 obj[password] 会顺着原型链取到 constructor / __proto__ / toString 等继承成员 → 拿这些词当密码就能登录
function _own(obj, key) {
  if (!obj || typeof key !== 'string' || !key) return null;
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : null;
}
// 不能拿来当密码键的名字（写进对象会改原型 / 和继承成员撞名）
const _BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export function isReservedPassword(pw) { return typeof pw !== 'string' || _BAD_KEYS.has(pw); }

export function lookupPassword(password) {
  if (!rolesConfig?.passwords) return null;
  const entry = _own(rolesConfig.passwords, password);
  return entry ? { name: entry.name || '用户', role: entry.role || 'viewer' } : null;
}

export function hasPermission(role, action) {
  return (ROLE_LEVELS[role] || 0) >= (ROLE_LEVELS[action] || 0);
}

export function isMultiUserMode() {
  return (
    rolesConfig !== null &&
    rolesConfig.passwords &&
    Object.keys(rolesConfig.passwords).length > 0
  );
}

export function getDefaultRole() {
  return rolesConfig?.defaultRole || 'admin';
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export function loadUsers() {
  try {
    if (existsSync(USERS_FILE)) {
      usersConfig = JSON.parse(readFileSync(USERS_FILE, 'utf8'));
      return usersConfig;
    }
  } catch (err) {
    console.warn('[用户] 加载 users.json 失败:', err.message);
  }
  usersConfig = null;
  return null;
}

export function hasUsers() {
  return (
    usersConfig !== null &&
    usersConfig.users &&
    Object.keys(usersConfig.users).length > 0
  );
}

// 使用模式：0～1 个登录账号 = 单用户（安装时建的那个账号就是主人，全部权限、不用去 /admin）；
// ≥2 个 = 多用户，这时才区分管理员 / 成员、成员权限受限
export function userCount() {
  return usersConfig?.users ? Object.keys(usersConfig.users).length : 0;
}
export function isMultiUser() {
  return userCount() >= 2;
}
// 账号登录后的角色：单用户时就是管理员，多用户时是成员
export function memberRole() {
  return isMultiUser() ? 'operator' : 'admin';
}

export function isExclusiveMode() {
  return isMultiUser() && usersConfig.exclusive === true;
}

export function setExclusiveMode(flag) {
  if (!usersConfig) {
    usersConfig = { users: {} };
  }
  usersConfig.exclusive = !!flag;
  _writeUsers();
}

export function lookupUser(password) {
  if (!usersConfig?.users) return null;
  const entry = _own(usersConfig.users, password);
  return entry ? { name: entry.name || '用户', dir: entry.dir } : null;
}

export function listUsers() {
  if (!usersConfig?.users) return [];
  return Object.entries(usersConfig.users).map(([password, info]) => ({
    password: password.slice(0, 2) + '*'.repeat(password.length - 2),
    name: info.name,
    dir: info.dir,
  }));
}

export function addUser(password, name, dir) {
  if (!usersConfig) {
    usersConfig = { users: {} };
  }
  if (!usersConfig.users) {
    usersConfig.users = {};
  }
  if (isReservedPassword(password)) throw new Error('该密码不可用，请换一个');
  usersConfig.users[password] = { name, dir };
  _writeUsers();
}

export function removeUser(password) {
  if (!usersConfig?.users || !_own(usersConfig.users, password)) return false;
  delete usersConfig.users[password];
  _writeUsers();
  return true;
}

/**
 * 成员用户自助改密：原密码验证通过才能改，新密码不得与其他用户的密码重复。
 * users.json 以明文密码为键（历史设计），改密 = 换键，用户条目（name/dir）原样保留。
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function changeUserPassword(oldPassword, newPassword, name) {
  if (!usersConfig?.users || !Object.keys(usersConfig.users).length) {
    return { ok: false, error: '未配置成员用户' };
  }
  const users = usersConfig.users;
  const entry = _own(users, oldPassword);
  // 原密码必须存在，且属于本人（会话身份与原密码归属一致，防止拿他人原密码改自己）
  if (!entry || (name && entry.name !== name)) {
    return { ok: false, error: '原密码不正确' };
  }
  if (isReservedPassword(newPassword)) {
    return { ok: false, error: '该密码不可用，请换一个' };
  }
  if (oldPassword === newPassword) {
    return { ok: false, error: '新密码不能与原密码相同' };
  }
  for (const [pw, info] of Object.entries(users)) {
    if (pw !== oldPassword && pw === newPassword) {
      return { ok: false, error: `新密码与用户「${info.name || '未命名'}」的密码重复，请换一个` };
    }
  }
  delete users[oldPassword];
  users[newPassword] = entry;
  _writeUsers();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _writeUsers() {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(USERS_FILE, JSON.stringify(usersConfig, null, 2), { mode: 0o600 });
}
