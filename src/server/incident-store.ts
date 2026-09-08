import { randomUUID } from 'node:crypto';

import { redis, type RedisClient } from '@devvit/redis';

import type {
  IncidentStore,
  NotificationChannel,
  RedditIncident,
  StoredIncident,
} from './status.ts';

const ACTIVE_INCIDENTS_KEY = 'site-status-alerts:active-incidents:v1';
const CHECK_LOCK_KEY = 'site-status-alerts:check-lock:v1';
// Longer than Devvit's request lifetime; expiry recovers interrupted checks.
const CHECK_LOCK_MS = 5 * 60 * 1_000;

export type RedisIncidentClient = Pick<
  RedisClient,
  'hDel' | 'hGetAll' | 'hSet' | 'get' | 'set'
> & {
  watch(...keys: string[]): Promise<{
    multi(): Promise<void>;
    del(...keys: string[]): Promise<unknown>;
    exec(): Promise<unknown>;
    unwatch(): Promise<unknown>;
  }>;
};

export const redisIncidentStore = createRedisIncidentStore(redis);

export function createRedisIncidentStore(
  client: RedisIncidentClient,
): IncidentStore {
  return {
    async listActive(): Promise<StoredIncident[]> {
      const stored = await client.hGetAll(ACTIVE_INCIDENTS_KEY);
      return Object.entries(stored).flatMap(([incidentId, value]) => {
        const parsed = parseStoredIncident(value);
        if (!parsed || parsed.incident.id !== incidentId) {
          console.error(
            `Ignoring invalid stored Reddit incident record ${incidentId}.`,
          );
          return [];
        }
        return [parsed];
      });
    },

    async acquireCheckLock(): Promise<string | undefined> {
      const token = randomUUID();
      const result = await client.set(CHECK_LOCK_KEY, token, {
        nx: true,
        expiration: new Date(Date.now() + CHECK_LOCK_MS),
      });
      return result === 'OK' ? token : undefined;
    },

    async releaseCheckLock(token: string): Promise<void> {
      // WATCH makes the ownership check and deletion conditional on the same
      // lock value. An expired owner must never delete a successor's lock.
      const transaction = await client.watch(CHECK_LOCK_KEY);
      let executed = false;
      try {
        if ((await client.get(CHECK_LOCK_KEY)) !== token) {
          return;
        }
        await transaction.multi();
        await transaction.del(CHECK_LOCK_KEY);
        await transaction.exec();
        executed = true;
      } finally {
        if (!executed) {
          await transaction.unwatch();
        }
      }
    },

    async saveActive(incidents: StoredIncident[]): Promise<void> {
      if (incidents.length === 0) {
        return;
      }

      await client.hSet(
        ACTIVE_INCIDENTS_KEY,
        Object.fromEntries(
          incidents.map((stored) => [
            stored.incident.id,
            JSON.stringify(stored),
          ]),
        ),
      );
    },

    async removeActive(incidentIds: string[]): Promise<void> {
      if (incidentIds.length === 0) {
        return;
      }
      await client.hDel(ACTIVE_INCIDENTS_KEY, incidentIds);
    },
  };
}

function parseStoredIncident(value: string): StoredIncident | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed) || typeof parsed.alertedAt !== 'string') {
      return undefined;
    }

    const incident = parsed.incident;
    if (
      !isRecord(incident) ||
      typeof incident.id !== 'string' ||
      typeof incident.name !== 'string' ||
      typeof incident.status !== 'string' ||
      typeof incident.impact !== 'string' ||
      !Array.isArray(incident.updates)
    ) {
      return undefined;
    }

    if (
      (parsed.resolvedAt !== undefined &&
        typeof parsed.resolvedAt !== 'string') ||
      (parsed.activeNotificationChannels !== undefined &&
        !isNotificationChannelArray(parsed.activeNotificationChannels)) ||
      (parsed.resolvedNotificationChannels !== undefined &&
        !isNotificationChannelArray(parsed.resolvedNotificationChannels))
    ) {
      return undefined;
    }

    return {
      alertedAt: parsed.alertedAt,
      incident: incident as RedditIncident,
      ...(parsed.resolvedAt !== undefined
        ? { resolvedAt: parsed.resolvedAt }
        : {}),
      ...(parsed.activeNotificationChannels !== undefined
        ? {
            activeNotificationChannels:
              parsed.activeNotificationChannels as NotificationChannel[],
          }
        : {}),
      ...(parsed.resolvedNotificationChannels !== undefined
        ? {
            resolvedNotificationChannels:
              parsed.resolvedNotificationChannels as NotificationChannel[],
          }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function isNotificationChannelArray(
  value: unknown,
): value is NotificationChannel[] {
  return (
    Array.isArray(value) &&
    value.every(
      (channel) =>
        channel === 'discord' ||
        channel === 'slack' ||
        channel === 'modmail',
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
