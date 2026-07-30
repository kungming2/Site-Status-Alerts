import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRedisIncidentStore,
  type RedisIncidentClient,
} from './incident-store.ts';
import type { RedditIncident } from './status.ts';

function createMemoryRedisClient(): RedisIncidentClient {
  const hashes = new Map<string, Map<string, string>>();
  const getHash = (key: string): Map<string, string> => {
    let hash = hashes.get(key);
    if (!hash) {
      hash = new Map();
      hashes.set(key, hash);
    }
    return hash;
  };

  return {
    async hGetAll(key) {
      return Object.fromEntries(hashes.get(key) ?? []);
    },

    async hGet(key, field) {
      return hashes.get(key)?.get(field);
    },

    async hSet(key, fieldValues) {
      const hash = getHash(key);
      let added = 0;
      for (const [field, value] of Object.entries(fieldValues)) {
        if (!hash.has(field)) {
          added += 1;
        }
        hash.set(field, value);
      }
      return added;
    },

    async hSetNX(key, field, value) {
      const hash = getHash(key);
      if (hash.has(field)) {
        return 0;
      }
      hash.set(field, value);
      return 1;
    },

    async hDel(key, fields) {
      const hash = getHash(key);
      let removed = 0;
      for (const field of fields) {
        if (hash.delete(field)) {
          removed += 1;
        }
      }
      return removed;
    },
  };
}

const incident: RedditIncident = {
  id: 'incident-1',
  name: 'Elevated API errors',
  status: 'investigating',
  impact: 'major',
  updates: [],
};

test('Redis incident store saves, reads, and removes active incidents', async () => {
  const client = createMemoryRedisClient();
  const store = createRedisIncidentStore(client);
  const stored = {
    incident,
    alertedAt: '2026-07-29T20:00:00.000Z',
  };

  await store.saveActive([stored]);
  assert.deepEqual(await store.listActive(), [stored]);

  await store.removeActive([incident.id]);
  assert.deepEqual(await store.listActive(), []);

  const storedWithChannels = {
    ...stored,
    resolvedAt: '2026-07-29T21:45:00.000Z',
    activeNotificationChannels: ['discord', 'slack', 'modmail'] as const,
    resolvedNotificationChannels: ['discord', 'slack'] as const,
  };
  await store.saveActive([
    {
      ...storedWithChannels,
      activeNotificationChannels: [...storedWithChannels.activeNotificationChannels],
      resolvedNotificationChannels: [
        ...storedWithChannels.resolvedNotificationChannels,
      ],
    },
  ]);
  assert.deepEqual(await store.listActive(), [storedWithChannels]);
});

test('Redis incident claims prevent overlap and allow stale claims to recover', async () => {
  const client = createMemoryRedisClient();
  const store = createRedisIncidentStore(client);
  const firstClaim = new Date('2026-07-29T20:00:00.000Z');

  assert.equal(await store.claim('active', incident.id, firstClaim), true);
  assert.equal(
    await store.claim(
      'active',
      incident.id,
      new Date('2026-07-29T20:01:00.000Z'),
    ),
    false,
  );
  assert.equal(
    await store.claim(
      'active',
      incident.id,
      new Date('2026-07-29T20:06:00.000Z'),
    ),
    true,
  );

  await store.releaseClaims('active', [incident.id]);
  assert.equal(
    await store.claim(
      'active',
      incident.id,
      new Date('2026-07-29T20:07:00.000Z'),
    ),
    true,
  );
});
