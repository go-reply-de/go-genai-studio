import { logger } from '@librechat/data-schemas';
import { permissionsSchema } from 'librechat-data-provider';

type PermissionBits = Record<string, boolean | undefined>;
type PermissionUpdate = Record<string, Record<string, boolean>>;

/** The parts of a role record the caps read. */
export interface CappedRole {
  name: string;
  permissions?: Record<string, PermissionBits | undefined>;
}

/** The role methods the caps run through, so the DB write also refreshes the role cache. */
export interface RolePermissionCapMethods<R extends CappedRole = CappedRole> {
  findRolesByNames: (names: string[]) => Promise<R[]>;
  getRoleByName: (name: string) => Promise<R | null>;
  updateAccessPermissions: (name: string, update: PermissionUpdate, role?: R) => Promise<void>;
  updateRoleByName: (name: string, update: { permissions: R['permissions'] }) => Promise<unknown>;
}

function isKnownPermission(type: string, permission: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(permissionsSchema.shape, type)) {
    return false;
  }
  const bits = permissionsSchema.shape[type as keyof typeof permissionsSchema.shape].shape;
  return Object.prototype.hasOwnProperty.call(bits, permission);
}

/** `ROLE.TYPE.PERMISSION` entries, grouped by role, each forced to false. */
export function parseRolePermissionCaps(value: string | undefined): Map<string, PermissionUpdate> {
  const caps = new Map<string, PermissionUpdate>();
  for (const entry of (value ?? '').split(/[\s,]+/).filter(Boolean)) {
    const [role, type, permission, ...rest] = entry.split('.');
    if (!role || !type || !permission || rest.length > 0 || !isKnownPermission(type, permission)) {
      logger.warn(`[rolePermissionCaps] Ignoring unknown ROLE_PERMISSION_CAPS entry "${entry}"`);
      continue;
    }
    const update = caps.get(role) ?? {};
    update[type] = { ...update[type], [permission]: false };
    caps.set(role, update);
  }
  return caps;
}

function exceedsCap(role: CappedRole | null, update: PermissionUpdate): boolean {
  return Object.entries(update).some(([type, bits]) =>
    Object.keys(bits).some((permission) => role?.permissions?.[type]?.[permission] !== false),
  );
}

async function findStoredRole<R extends CappedRole>(
  methods: RolePermissionCapMethods<R>,
  name: string,
): Promise<R | null> {
  const roles = await methods.findRolesByNames([name]);
  return roles.find((role) => role.name === name) ?? null;
}

/**
 * Forces the ROLE_PERMISSION_CAPS bits false on every start, so a recreated role record cannot
 * reopen them. Only ever lowers; the stored record is read directly because the cache can be stale.
 */
export async function applyRolePermissionCaps<R extends CappedRole>(
  methods: RolePermissionCapMethods<R>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  for (const [name, update] of parseRolePermissionCaps(env.ROLE_PERMISSION_CAPS)) {
    const stored = await findStoredRole(methods, name);
    if (stored == null) {
      logger.warn(`[rolePermissionCaps] Role "${name}" not found; its caps were not applied`);
      continue;
    }

    if (exceedsCap(stored, update)) {
      await methods.updateAccessPermissions(name, update, stored);
      if (exceedsCap(await findStoredRole(methods, name), update)) {
        logger.error(`[rolePermissionCaps] Could not lower the capped permissions of "${name}"`);
      }
      continue;
    }

    /* The record is already capped; rewrite it once more if the cache still holds an older copy. */
    if (exceedsCap(await methods.getRoleByName(name), update)) {
      await methods.updateRoleByName(name, { permissions: stored.permissions });
    }
  }
}
