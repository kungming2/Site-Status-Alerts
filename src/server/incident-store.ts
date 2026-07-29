import { redis, type RedisClient } from '@devvit/redis';

import type {
  IncidentClaimKind,
  IncidentStore,
  NotificationChannel,
  RedditIncident,
  StoredIncident,
} from './status.ts';

const ACTIVE_INCIDENTS_KEY = 'site-status-alerts:active-incidents:v1';
const INCIDENT_CLAIMS_KEY = 'site-status-alerts:incident-claims:v1';
const STALE_CLAIM_MS = 5 * 60 * 1_000;

type RedisIncidentClient = Pick<
  RedisClient,
  'hDel' | 'hGet' | 'hGetAll' | 'hSet' | 'hSetNX'
>;

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

    async claim(
      kind: IncidentClaimKind,
      incidentId: string,
      claimedAt: Date,
    ): Promise<boolean> {
      const field = claimField(kind, incidentId);
      const claimedAtValue = claimedAt.toISOString();
      const claimed = await client.hSetNX(
        INCIDENT_CLAIMS_KEY,
        field,
        claimedAtValue,
      );
      if (claimed === 1) {
        return true;
      }

      const existing = await client.hGet(INCIDENT_CLAIMS_KEY, field);
      const existingTime = existing ? Date.parse(existing) : Number.NaN;
      if (
        Number.isFinite(existingTime) &&
        claimedAt.getTime() - existingTime < STALE_CLAIM_MS
      ) {
        return false;
      }

      await client.hDel(INCIDENT_CLAIMS_KEY, [field]);
      return (
        (await client.hSetNX(
          INCIDENT_CLAIMS_KEY,
          field,
          claimedAtValue,
        )) === 1
      );
    },

    async releaseClaims(
      kind: IncidentClaimKind,
      incidentIds: string[],
    ): Promise<void> {
      if (incidentIds.length === 0) {
        return;
      }
      await client.hDel(
        INCIDENT_CLAIMS_KEY,
        incidentIds.map((incidentId) => claimField(kind, incidentId)),
      );
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

function claimField(
  kind: IncidentClaimKind,
  incidentId: string,
): string {
  return `${kind}:${incidentId}`;
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
    value.every((channel) => channel === 'discord' || channel === 'modmail')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
