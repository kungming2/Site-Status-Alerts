import assert from 'node:assert/strict';
import test from 'node:test';

import { createRedisIncidentStore } from './incident-store.ts';
import type { RedditIncident } from './status.ts';

class MemoryRedisClient {
  readonly hashes = new Map<string, Map<string, string>>();

  async hGetAll(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }

  async hGet(key: string, field: string): Promise<string | undefined> {
    return this.hashes.get(key)?.get(field);
  }

  async hSet(
    key: string,
    fieldValues: Record<string, string>,
  ): Promise<number> {
    const hash = this.getHash(key);
    let added = 0;
    for (const [field, value] of Object.entries(fieldValues)) {
      if (!hash.has(field)) {
        added += 1;
      }
      hash.set(field, value);
    }
    return added;
  }

  async hSetNX(
    key: string,
    field: string,
    value: string,
  ): Promise<number> {
    const hash = this.getHash(key);
    if (hash.has(field)) {
      return 0;
    }
    hash.set(field, value);
    return 1;
  }

  async hDel(key: string, fields: string[]): Promise<number> {
    const hash = this.getHash(key);
    let removed = 0;
    for (const field of fields) {
      if (hash.delete(field)) {
        removed += 1;
      }
    }
    return removed;
  }

  private getHash(key: string): Map<string, string> {
    let hash = this.hashes.get(key);
    if (!hash) {
      hash = new Map();
      this.hashes.set(key, hash);
    }
    return hash;
  }
}

const incident: RedditIncident = {
  id: 'incident-1',
  name: 'Elevated API errors',
  status: 'investigating',
  impact: 'major',
  updates: [],
};

test('Redis incident store saves, reads, and removes active incidents', async () => {
  const client = new MemoryRedisClient();
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
    activeNotificationChannels: ['discord', 'modmail'] as const,
    resolvedNotificationChannels: ['discord'] as const,
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
  const client = new MemoryRedisClient();
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
