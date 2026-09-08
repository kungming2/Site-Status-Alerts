import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRedisIncidentStore,
  type RedisIncidentClient,
} from './incident-store.ts';
import type { RedditIncident } from './status.ts';

function createMemoryRedisClient(): RedisIncidentClient {
  const hashes = new Map<string, Map<string, string>>();
  const strings = new Map<string, { value: string; expiration?: Date }>();
  const revisions = new Map<string, number>();
  const touch = (key: string): void => {
    revisions.set(key, (revisions.get(key) ?? 0) + 1);
  };
  const getString = (key: string): string | undefined => {
    const entry = strings.get(key);
    if (entry?.expiration && entry.expiration.getTime() <= Date.now()) {
      strings.delete(key);
      touch(key);
      return undefined;
    }
    return entry?.value;
  };
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

    async get(key) {
      return getString(key);
    },

    async set(key, value, options) {
      if (options?.nx && getString(key) !== undefined) return '';
      strings.set(key, { value, expiration: options?.expiration });
      touch(key);
      return 'OK';
    },

    async watch(...keys) {
      for (const key of keys) getString(key);
      const watched = keys.map((key) => revisions.get(key) ?? 0);
      const deleted: string[] = [];
      let finished = false;
      const transaction = {
        async multi() {},
        async del(...keysToDelete: string[]) {
          deleted.push(...keysToDelete);
          return transaction;
        },
        async exec() {
          finished = true;
          for (const key of keys) getString(key);
          if (keys.some((key, i) => (revisions.get(key) ?? 0) !== watched[i])) {
            return [];
          }
          for (const key of deleted) {
            strings.delete(key);
            touch(key);
          }
          return [deleted.length];
        },
        async unwatch() {
          assert.equal(finished, false, 'Do not reuse an executed transaction');
          finished = true;
          return transaction;
        },
      };
      return transaction;
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

test('Redis check locks allow one owner and expire for interrupted checks', async (t) => {
  let now = Date.parse('2026-09-08T10:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const client = createMemoryRedisClient();
  // Separate store instances model separate request handlers.
  const firstStore = createRedisIncidentStore(client);
  const secondStore = createRedisIncidentStore(client);
  const first = await firstStore.acquireCheckLock();
  assert.ok(first);
  assert.equal(await secondStore.acquireCheckLock(), undefined);

  now += 6 * 60 * 1_000;
  const claims = await Promise.all([
    firstStore.acquireCheckLock(), secondStore.acquireCheckLock(),
  ]);
  const recovered = claims.filter((token) => token !== undefined);
  assert.equal(recovered.length, 1);
  assert.notEqual(recovered[0], first);

  // A late release from the expired run cannot unlock the successor.
  await firstStore.releaseCheckLock(first);
  assert.equal(await secondStore.acquireCheckLock(), undefined);
  await secondStore.releaseCheckLock(recovered[0]!);
  assert.ok(await firstStore.acquireCheckLock());
});

test('Redis lock release cannot delete a replacement acquired during release', async (t) => {
  let now = Date.parse('2026-09-08T10:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const client = createMemoryRedisClient();
  const successor = createRedisIncidentStore(client);
  let replacement: string | undefined;
  const racingClient: RedisIncidentClient = {
    ...client,
    async watch(...keys) {
      const transaction = await client.watch(...keys);
      return {
        ...transaction,
        async exec() {
          // Expire and replace after ownership was checked but before DEL.
          now += 6 * 60 * 1_000;
          replacement = await successor.acquireCheckLock();
          return transaction.exec();
        },
      };
    },
  };
  const original = createRedisIncidentStore(racingClient);
  const token = await original.acquireCheckLock();
  assert.ok(token);
  await original.releaseCheckLock(token);
  assert.ok(replacement);
  assert.equal(await successor.acquireCheckLock(), undefined);
  await successor.releaseCheckLock(replacement);
  assert.ok(await successor.acquireCheckLock());
});
