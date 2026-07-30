import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkRedditStatus,
  fetchRedditIncidents,
  formatDiscordAlert,
  formatDiscordResolutionAlert,
  formatModmailAlert,
  formatModmailResolutionAlert,
  formatSlackAlert,
  formatSlackResolutionAlert,
  normalizeMinimumIncidentSeverity,
  sendSlackAlert,
  validateDiscordWebhookUrl,
  validateMinimumIncidentSeverity,
  validateSlackWebhookUrl,
  type IncidentClaimKind,
  type IncidentStore,
  type ModmailNotification,
  type RedditIncident,
  type StoredIncident,
} from './status.ts';

type StatusCheckDependencies = Parameters<typeof checkRedditStatus>[1];

const majorIncident: RedditIncident = {
  id: 'incident-major-1',
  name: 'Elevated API errors',
  status: 'investigating',
  impact: 'major',
  createdAt: '2026-07-29T20:00:00.000Z',
  updatedAt: '2026-07-29T20:30:00.000Z',
  shortlink: 'https://redditstatus.com/example',
  updates: [],
};

class MemoryIncidentStore implements IncidentStore {
  readonly active = new Map<string, StoredIncident>();
  readonly claims = new Set<string>();

  async listActive(): Promise<StoredIncident[]> {
    return [...this.active.values()];
  }

  async claim(
    kind: IncidentClaimKind,
    incidentId: string,
    _claimedAt: Date,
  ): Promise<boolean> {
    const claim = `${kind}:${incidentId}`;
    if (this.claims.has(claim)) {
      return false;
    }
    this.claims.add(claim);
    return true;
  }

  async releaseClaims(
    kind: IncidentClaimKind,
    incidentIds: string[],
  ): Promise<void> {
    for (const incidentId of incidentIds) {
      this.claims.delete(`${kind}:${incidentId}`);
    }
  }

  async saveActive(incidents: StoredIncident[]): Promise<void> {
    for (const stored of incidents) {
      this.active.set(stored.incident.id, stored);
    }
  }

  async removeActive(incidentIds: string[]): Promise<void> {
    for (const incidentId of incidentIds) {
      this.active.delete(incidentId);
    }
  }
}

function createStatusAndDiscordFetch(
  getIncidents: () => Record<string, unknown>[],
  discordMessages: string[],
): typeof fetch {
  return async (input, init) => {
    if (String(input).includes('redditstatus.com')) {
      return new Response(
        JSON.stringify({ incidents: getIncidents() }),
        { status: 200 },
      );
    }

    discordMessages.push(
      (JSON.parse(String(init?.body)) as { content: string }).content,
    );
    return new Response(null, { status: 204 });
  };
}

test('fetchRedditIncidents normalizes the Statuspage response', async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        incidents: [
          {
            id: majorIncident.id,
            name: 'Elevated API errors',
            status: 'investigating',
            impact: 'major',
            created_at: '2026-07-29T20:00:00.000Z',
            updated_at: '2026-07-29T20:30:00.000Z',
            shortlink_url: 'https://redditstatus.com/example',
            incident_updates: [{ body: 'Investigating', created_at: 'now' }],
          },
        ],
      }),
      { status: 200 },
    );

  const incidents = await fetchRedditIncidents(fakeFetch);

  assert.equal(incidents.length, 1);
  assert.deepEqual(incidents[0], {
    ...majorIncident,
    updates: [{ body: 'Investigating', createdAt: 'now' }],
  });
});

test('checkRedditStatus defaults to major and ignores lower impacts', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const incidentStore = new MemoryIncidentStore();
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });

    if (url.includes('redditstatus.com')) {
      return new Response(
        JSON.stringify({
          incidents: [
            {
              id: majorIncident.id,
              name: majorIncident.name,
              status: majorIncident.status,
              impact: majorIncident.impact,
            },
            {
              id: 'incident-minor-1',
              name: 'Small delay',
              status: 'monitoring',
              impact: 'MINOR',
            },
            {
              id: 'incident-none-1',
              name: 'Investigating a possible issue',
              status: 'investigating',
              impact: 'none',
            },
          ],
        }),
        { status: 200 },
      );
    }

    return new Response(null, { status: 204 });
  };

  const result = await checkRedditStatus(
    'https://discord.com/api/webhooks/123/token',
    { incidentStore, fetchImpl: fakeFetch },
  );

  assert.equal(result.totalIncidents, 3);
  assert.equal(result.reportableIncidents.length, 1);
  assert.equal(result.newReportableIncidents.length, 1);
  assert.equal(result.ongoingReportableIncidents.length, 0);
  assert.equal(result.resolvedIncidents.length, 0);
  assert.equal(result.ignoredIncidents, 2);
  assert.equal(result.minimumIncidentSeverity, 'major');
  assert.equal(result.notifications.active, 'sent');
  assert.equal(result.notifications.resolved, 'not-needed');
  assert.equal(incidentStore.active.size, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, 'https://discord.com/api/webhooks/123/token');
  assert.deepEqual(
    JSON.parse(String(requests[1].init?.body)),
    {
      content: formatDiscordAlert([
        {
          ...majorIncident,
          createdAt: undefined,
          updatedAt: undefined,
          shortlink: undefined,
        },
      ]),
      username: 'Reddit Site Status',
      allowed_mentions: { parse: [] },
    },
  );
});

test('checkRedditStatus applies configurable minimum incident severities', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const impacts = ['none', 'minor', 'major', 'critical', 'maintenance'];
  const fakeFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        incidents: impacts.map((impact) => ({
          id: `incident-${impact}`,
          name: `${impact} incident`,
          status: 'investigating',
          impact,
        })),
      }),
      { status: 200 },
    );

  const minorResult = await checkRedditStatus(
    {
      modmailEnabled: false,
      minimumIncidentSeverity: 'minor',
    },
    {
      incidentStore: new MemoryIncidentStore(),
      fetchImpl: fakeFetch,
    },
  );
  const criticalResult = await checkRedditStatus(
    {
      modmailEnabled: false,
      minimumIncidentSeverity: 'critical',
    },
    {
      incidentStore: new MemoryIncidentStore(),
      fetchImpl: fakeFetch,
    },
  );

  assert.deepEqual(
    minorResult.reportableIncidents.map((incident) => incident.impact),
    ['minor', 'major', 'critical'],
  );
  assert.equal(minorResult.ignoredIncidents, 2);
  assert.deepEqual(
    criticalResult.reportableIncidents.map((incident) => incident.impact),
    ['critical'],
  );
  assert.equal(criticalResult.ignoredIncidents, 4);
});

test('checkRedditStatus does not let webhook failures hide the status result', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  t.mock.method(console, 'log', () => undefined);
  const incidentStore = new MemoryIncidentStore();
  const fakeFetch: typeof fetch = async (input) => {
    if (String(input).includes('redditstatus.com')) {
      return new Response(
        JSON.stringify({
          incidents: [
            {
              id: majorIncident.id,
              name: majorIncident.name,
              status: majorIncident.status,
              impact: majorIncident.impact,
            },
          ],
        }),
        { status: 200 },
      );
    }

    return new Response('rate limited', { status: 429 });
  };

  const result = await checkRedditStatus(
    'https://discord.com/api/webhooks/123/token',
    { incidentStore, fetchImpl: fakeFetch },
  );

  assert.equal(result.reportableIncidents.length, 1);
  assert.equal(result.notifications.active, 'failed');
  assert.equal(incidentStore.active.size, 0);
});

test('checkRedditStatus re-validates stored webhook settings before sending', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  t.mock.method(console, 'log', () => undefined);
  const incidentStore = new MemoryIncidentStore();
  const requests: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    return new Response(
      JSON.stringify({
        incidents: [
          {
            id: majorIncident.id,
            name: majorIncident.name,
            status: majorIncident.status,
            impact: majorIncident.impact,
          },
        ],
      }),
      { status: 200 },
    );
  };

  const result = await checkRedditStatus(
    'https://discord.com/channels/not-a-webhook',
    { incidentStore, fetchImpl: fakeFetch },
  );

  assert.equal(result.notifications.active, 'invalid');
  assert.equal(incidentStore.active.size, 0);
  assert.deepEqual(requests, [
    'https://www.redditstatus.com/api/v2/incidents/unresolved.json',
  ]);
});

test('checkRedditStatus alerts once, stays quiet while active, and alerts when resolved', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const incidentStore = new MemoryIncidentStore();
  let feed: Record<string, unknown>[] = [
    {
      id: majorIncident.id,
      name: majorIncident.name,
      status: majorIncident.status,
      impact: majorIncident.impact,
      created_at: majorIncident.createdAt,
      updated_at: majorIncident.updatedAt,
      shortlink: majorIncident.shortlink,
    },
  ];
  const discordMessages: string[] = [];
  const resolvedAt = '2026-07-29T21:45:00.000Z';
  const fakeFetch = createStatusAndDiscordFetch(() => feed, discordMessages);

  const first = await checkRedditStatus(
    'https://discord.com/api/webhooks/123/token',
    {
      incidentStore,
      fetchImpl: fakeFetch,
      now: () => new Date(resolvedAt),
    },
  );
  const ongoing = await checkRedditStatus(
    'https://discord.com/api/webhooks/123/token',
    {
      incidentStore,
      fetchImpl: fakeFetch,
      now: () => new Date(resolvedAt),
    },
  );

  assert.equal(first.notifications.active, 'sent');
  assert.equal(ongoing.notifications.active, 'not-needed');
  assert.equal(ongoing.newReportableIncidents.length, 0);
  assert.equal(ongoing.ongoingReportableIncidents.length, 1);
  assert.equal(discordMessages.length, 1);

  feed = [];
  const resolved = await checkRedditStatus(
    'https://discord.com/api/webhooks/123/token',
    {
      incidentStore,
      fetchImpl: fakeFetch,
      now: () => new Date(resolvedAt),
    },
  );
  const afterResolution = await checkRedditStatus(
    'https://discord.com/api/webhooks/123/token',
    {
      incidentStore,
      fetchImpl: fakeFetch,
      now: () => new Date(resolvedAt),
    },
  );

  assert.equal(resolved.resolvedIncidents.length, 1);
  assert.equal(resolved.notifications.resolved, 'sent');
  assert.equal(afterResolution.resolvedIncidents.length, 0);
  assert.equal(incidentStore.active.size, 0);
  assert.equal(discordMessages.length, 2);
  assert.equal(
    discordMessages[1],
    formatDiscordResolutionAlert([{ incident: majorIncident, resolvedAt }]),
  );
});

test('checkRedditStatus does not resolve an incident that remains unresolved but becomes minor', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const incidentStore = new MemoryIncidentStore();
  await incidentStore.saveActive([
    {
      incident: majorIncident,
      alertedAt: '2026-07-29T20:00:00.000Z',
    },
  ]);
  const requests: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    requests.push(String(input));
    return new Response(
      JSON.stringify({
        incidents: [
          {
            id: majorIncident.id,
            name: majorIncident.name,
            status: 'monitoring',
            impact: 'minor',
          },
        ],
      }),
      { status: 200 },
    );
  };

  const result = await checkRedditStatus(
    'https://discord.com/api/webhooks/123/token',
    { incidentStore, fetchImpl: fakeFetch },
  );

  assert.equal(result.reportableIncidents.length, 0);
  assert.equal(result.resolvedIncidents.length, 0);
  assert.equal(result.notifications.resolved, 'not-needed');
  assert.equal(incidentStore.active.size, 1);
  assert.equal(requests.length, 1);
});

test('checkRedditStatus retains resolved incidents when the resolution alert fails', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const incidentStore = new MemoryIncidentStore();
  await incidentStore.saveActive([
    {
      incident: majorIncident,
      alertedAt: '2026-07-29T20:00:00.000Z',
    },
  ]);
  let discordStatus = 429;
  let now = new Date('2026-07-29T21:45:00.000Z');
  const discordMessages: string[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    if (String(input).includes('redditstatus.com')) {
      return new Response(JSON.stringify({ incidents: [] }), { status: 200 });
    }
    discordMessages.push(
      (JSON.parse(String(init?.body)) as { content: string }).content,
    );
    return new Response(null, { status: discordStatus });
  };
  const dependencies = {
    incidentStore,
    fetchImpl: fakeFetch,
    now: () => now,
  };

  const failed = await checkRedditStatus(
    'https://discord.com/api/webhooks/123/token',
    dependencies,
  );

  assert.equal(failed.notifications.resolved, 'failed');
  assert.equal(incidentStore.active.size, 1);
  assert.equal(
    incidentStore.active.get(majorIncident.id)?.resolvedAt,
    '2026-07-29T21:45:00.000Z',
  );

  discordStatus = 204;
  now = new Date('2026-07-29T22:45:00.000Z');
  const retried = await checkRedditStatus(
    'https://discord.com/api/webhooks/123/token',
    dependencies,
  );

  assert.equal(retried.notifications.resolved, 'sent');
  assert.equal(incidentStore.active.size, 0);
  assert.equal(discordMessages.length, 2);
  assert.equal(discordMessages[0], discordMessages[1]);
  assert.match(discordMessages[1] ?? '', /1 hour 45 minutes/);
});

test('concurrent checks claim a new incident only once', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const incidentStore = new MemoryIncidentStore();
  let discordRequests = 0;
  const fakeFetch: typeof fetch = async (input) => {
    if (String(input).includes('redditstatus.com')) {
      return new Response(
        JSON.stringify({
          incidents: [
            {
              id: majorIncident.id,
              name: majorIncident.name,
              status: majorIncident.status,
              impact: majorIncident.impact,
            },
          ],
        }),
        { status: 200 },
      );
    }

    discordRequests += 1;
    return new Response(null, { status: 204 });
  };

  await Promise.all([
    checkRedditStatus('https://discord.com/api/webhooks/123/token', {
      incidentStore,
      fetchImpl: fakeFetch,
    }),
    checkRedditStatus('https://discord.com/api/webhooks/123/token', {
      incidentStore,
      fetchImpl: fakeFetch,
    }),
  ]);

  assert.equal(discordRequests, 1);
  assert.equal(incidentStore.active.size, 1);
});

test('Modmail can be the only notification channel for the full incident lifecycle', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const incidentStore = new MemoryIncidentStore();
  let feed: Record<string, unknown>[] = [
    {
      id: majorIncident.id,
      name: majorIncident.name,
      status: majorIncident.status,
      impact: majorIncident.impact,
      created_at: majorIncident.createdAt,
      updated_at: majorIncident.updatedAt,
      shortlink: majorIncident.shortlink,
    },
  ];
  const modmailNotifications: Array<{
    subject: string;
    bodyMarkdown: string;
  }> = [];
  const resolvedAt = '2026-07-29T21:45:00.000Z';
  const fakeFetch: typeof fetch = async (input) => {
    assert.match(String(input), /redditstatus\.com/);
    return new Response(JSON.stringify({ incidents: feed }), { status: 200 });
  };
  const dependencies: StatusCheckDependencies = {
    incidentStore,
    fetchImpl: fakeFetch,
    now: () => new Date(resolvedAt),
    sendModmailNotification: async (notification: ModmailNotification) => {
      modmailNotifications.push(notification);
    },
  };

  const first = await checkRedditStatus(
    { modmailEnabled: true },
    dependencies,
  );
  const ongoing = await checkRedditStatus(
    { modmailEnabled: true },
    dependencies,
  );

  assert.equal(first.channelNotifications.discord.active, 'not-configured');
  assert.equal(first.channelNotifications.modmail.active, 'sent');
  assert.equal(first.notifications.active, 'sent');
  assert.equal(ongoing.channelNotifications.modmail.active, 'not-needed');
  assert.deepEqual(
    incidentStore.active.get(majorIncident.id)?.activeNotificationChannels,
    ['modmail'],
  );
  assert.deepEqual(modmailNotifications, [formatModmailAlert([majorIncident])]);

  feed = [];
  const resolved = await checkRedditStatus(
    { modmailEnabled: true },
    dependencies,
  );

  assert.equal(resolved.channelNotifications.modmail.resolved, 'sent');
  assert.equal(incidentStore.active.size, 0);
  assert.deepEqual(modmailNotifications, [
    formatModmailAlert([majorIncident]),
    formatModmailResolutionAlert([{ incident: majorIncident, resolvedAt }]),
  ]);
});

test('dual-channel retries do not resend the channel that already succeeded', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  t.mock.method(console, 'log', () => undefined);
  const incidentStore = new MemoryIncidentStore();
  let feed: Record<string, unknown>[] = [
    {
      id: majorIncident.id,
      name: majorIncident.name,
      status: majorIncident.status,
      impact: majorIncident.impact,
    },
  ];
  const discordMessages: string[] = [];
  const modmailSubjects: string[] = [];
  let failNextModmail = true;
  const fakeFetch = createStatusAndDiscordFetch(() => feed, discordMessages);
  const dependencies: StatusCheckDependencies = {
    incidentStore,
    fetchImpl: fakeFetch,
    sendModmailNotification: async ({ subject }: ModmailNotification) => {
      modmailSubjects.push(subject);
      if (failNextModmail) {
        failNextModmail = false;
        throw new Error('Temporary Modmail failure');
      }
    },
  };
  const configuration = {
    discordWebhookUrl: 'https://discord.com/api/webhooks/123/token',
    modmailEnabled: true,
  };

  const partial = await checkRedditStatus(configuration, dependencies);
  const retried = await checkRedditStatus(configuration, dependencies);

  assert.equal(partial.channelNotifications.discord.active, 'sent');
  assert.equal(partial.channelNotifications.modmail.active, 'failed');
  assert.equal(retried.channelNotifications.discord.active, 'not-needed');
  assert.equal(retried.channelNotifications.modmail.active, 'sent');
  assert.equal(discordMessages.length, 1);
  assert.equal(modmailSubjects.length, 2);
  assert.deepEqual(
    incidentStore.active.get(majorIncident.id)?.activeNotificationChannels,
    ['discord', 'modmail'],
  );

  feed = [];
  failNextModmail = true;
  const partialResolution = await checkRedditStatus(
    configuration,
    dependencies,
  );
  const retriedResolution = await checkRedditStatus(
    configuration,
    dependencies,
  );

  assert.equal(partialResolution.channelNotifications.discord.resolved, 'sent');
  assert.equal(partialResolution.channelNotifications.modmail.resolved, 'failed');
  assert.equal(
    retriedResolution.channelNotifications.discord.resolved,
    'not-needed',
  );
  assert.equal(retriedResolution.channelNotifications.modmail.resolved, 'sent');
  assert.equal(discordMessages.length, 2);
  assert.equal(modmailSubjects.length, 4);
  assert.equal(incidentStore.active.size, 0);
});

test('Slack can be the only notification channel for the full incident lifecycle', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const incidentStore = new MemoryIncidentStore();
  let feed: Record<string, unknown>[] = [
    {
      id: majorIncident.id,
      name: majorIncident.name,
      status: majorIncident.status,
      impact: majorIncident.impact,
      created_at: majorIncident.createdAt,
      updated_at: majorIncident.updatedAt,
      shortlink: majorIncident.shortlink,
    },
  ];
  const slackMessages: string[] = [];
  const resolvedAt = '2026-07-29T21:45:00.000Z';
  const webhookUrl =
    'https://hooks.slack.com/services/T00000000/B00000000/secret-token';
  const fakeFetch: typeof fetch = async (input, init) => {
    if (String(input).includes('redditstatus.com')) {
      return new Response(JSON.stringify({ incidents: feed }), { status: 200 });
    }

    assert.equal(String(input), webhookUrl);
    slackMessages.push(
      (JSON.parse(String(init?.body)) as { text: string }).text,
    );
    return new Response('ok', { status: 200 });
  };
  const configuration = {
    slackWebhookUrl: webhookUrl,
    modmailEnabled: false,
  };
  const dependencies: StatusCheckDependencies = {
    incidentStore,
    fetchImpl: fakeFetch,
    now: () => new Date(resolvedAt),
  };

  const first = await checkRedditStatus(configuration, dependencies);
  const ongoing = await checkRedditStatus(configuration, dependencies);

  assert.equal(first.channelNotifications.slack.active, 'sent');
  assert.equal(first.channelNotifications.discord.active, 'not-configured');
  assert.equal(ongoing.channelNotifications.slack.active, 'not-needed');
  assert.deepEqual(
    incidentStore.active.get(majorIncident.id)?.activeNotificationChannels,
    ['slack'],
  );
  assert.deepEqual(slackMessages, [formatSlackAlert([majorIncident])]);

  feed = [];
  const resolved = await checkRedditStatus(configuration, dependencies);

  assert.equal(resolved.channelNotifications.slack.resolved, 'sent');
  assert.equal(incidentStore.active.size, 0);
  assert.deepEqual(slackMessages, [
    formatSlackAlert([majorIncident]),
    formatSlackResolutionAlert([{ incident: majorIncident, resolvedAt }]),
  ]);
});

test('formatDiscordAlert includes incident details', () => {
  const message = formatDiscordAlert([majorIncident]);

  assert.match(message, /Active Reddit Incidents/);
  assert.match(message, /🟠/);
  assert.match(message, /Elevated API errors/);
  assert.match(message, /Investigating \(major\)/);
  assert.match(message, /<t:1785355200:F> \(<t:1785355200:R>\)/);
  assert.match(message, /<t:1785357000:F> \(<t:1785357000:R>\)/);
});

test('formatDiscordResolutionAlert includes the previous incident state', () => {
  const message = formatDiscordResolutionAlert([
    {
      incident: majorIncident,
      resolvedAt: '2026-07-29T21:45:00.000Z',
    },
  ]);

  assert.match(message, /Reddit Incidents Resolved/);
  assert.match(message, /🟠/);
  assert.match(message, /Elevated API errors/);
  assert.match(message, /Status:\*\* Resolved/);
  assert.match(message, /Previous state:\*\* Investigating \(major\)/);
  assert.match(message, /Approx\. duration:\*\* 1 hour 45 minutes/);
});

test('formatSlackAlert uses mrkdwn links, escaped text, and localized timestamps', () => {
  const message = formatSlackAlert([
    {
      ...majorIncident,
      name: 'API <danger> & <!channel>',
    },
  ]);

  assert.match(message, /\*⚠️ Active Reddit Incidents\*/);
  assert.match(
    message,
    /<https:\/\/redditstatus\.com\/example\|API &lt;danger&gt; &amp; &lt;!channel&gt;>/,
  );
  assert.doesNotMatch(message, /<!channel>/);
  assert.match(
    message,
    /<!date\^1785355200\^\{date_long_pretty\} at \{time\}\|2026-07-29 20:00:00 UTC>/,
  );
});

test('formatSlackResolutionAlert includes the previous incident state', () => {
  const message = formatSlackResolutionAlert([
    {
      incident: majorIncident,
      resolvedAt: '2026-07-29T21:45:00.000Z',
    },
  ]);

  assert.match(message, /Reddit Incidents Resolved/);
  assert.match(message, /\*Status:\* Resolved/);
  assert.match(message, /\*Previous state:\* Investigating \(major\)/);
  assert.match(message, /\*Approx\. duration:\* 1 hour 45 minutes/);
});

test('Discord, Slack, and Modmail use an emoji for each incident severity', () => {
  const incidents = [
    { ...majorIncident, id: 'minor', impact: 'minor' },
    { ...majorIncident, id: 'major', impact: 'major' },
    { ...majorIncident, id: 'critical', impact: 'critical' },
    { ...majorIncident, id: 'unknown', impact: 'unknown' },
  ];
  const discordMessage = formatDiscordAlert(incidents);
  const slackMessage = formatSlackAlert(incidents);
  const modmailMessage = formatModmailAlert(incidents).bodyMarkdown;

  for (const message of [discordMessage, slackMessage, modmailMessage]) {
    assert.match(message, /🟡/);
    assert.match(message, /🟠/);
    assert.match(message, /🔴/);
    assert.match(message, /⚠️/);
  }
});

test('Modmail links UTC timestamps to Timeanddate local conversions', () => {
  const message = formatModmailAlert([majorIncident]).bodyMarkdown;

  assert.match(
    message,
    /\[2026-07-29 20:00:00 UTC]\(https:\/\/www\.timeanddate\.com\/worldclock\/fixedtime\.html\?iso=20260729T200000&p1=1440\)/,
  );
  assert.match(
    message,
    /\[2026-07-29 20:30:00 UTC]\(https:\/\/www\.timeanddate\.com\/worldclock\/fixedtime\.html\?iso=20260729T203000&p1=1440\)/,
  );
});

test('validateDiscordWebhookUrl accepts copied Discord URLs and blanks', () => {
  assert.equal(validateDiscordWebhookUrl(undefined), undefined);
  assert.equal(validateDiscordWebhookUrl(''), undefined);
  assert.equal(
    validateDiscordWebhookUrl(
      'https://discord.com/api/webhooks/123456/secret-token',
    ),
    undefined,
  );
});

test('validateDiscordWebhookUrl rejects non-Discord and malformed URLs', () => {
  assert.match(
    validateDiscordWebhookUrl('https://example.com/api/webhooks/123/token') ??
      '',
    /discord\.com/,
  );
  assert.match(
    validateDiscordWebhookUrl('https://discord.com/channels/123') ?? '',
    /channel integration/,
  );
});

test('validateSlackWebhookUrl accepts copied Slack URLs and blanks', () => {
  assert.equal(validateSlackWebhookUrl(undefined), undefined);
  assert.equal(validateSlackWebhookUrl(''), undefined);
  assert.equal(
    validateSlackWebhookUrl(
      'https://hooks.slack.com/services/T00000000/B00000000/secret-token',
    ),
    undefined,
  );
});

test('validateSlackWebhookUrl rejects non-Slack and malformed URLs', () => {
  assert.match(
    validateSlackWebhookUrl(
      'https://example.com/services/T00000000/B00000000/token',
    ) ?? '',
    /hooks\.slack\.com/,
  );
  assert.match(
    validateSlackWebhookUrl('https://hooks.slack.com/workflows/123') ?? '',
    /incoming webhook/i,
  );
});

test('sendSlackAlert posts the required JSON text payload and reports failures', async () => {
  const webhookUrl =
    'https://hooks.slack.com/services/T00000000/B00000000/secret-token';
  let requestBody = '';
  const successFetch: typeof fetch = async (input, init) => {
    assert.equal(String(input), webhookUrl);
    assert.equal(init?.method, 'POST');
    assert.deepEqual(init?.headers, { 'Content-Type': 'application/json' });
    requestBody = String(init?.body);
    return new Response('ok', { status: 200 });
  };

  await sendSlackAlert(webhookUrl, '*Test alert*', successFetch);
  assert.deepEqual(JSON.parse(requestBody), { text: '*Test alert*' });

  await assert.rejects(
    sendSlackAlert(
      webhookUrl,
      '*Test alert*',
      async () => new Response('invalid_token', { status: 403 }),
    ),
    /Slack webhook returned HTTP 403/,
  );
});

test('normalizeMinimumIncidentSeverity uses a migration-safe major default', () => {
  assert.equal(normalizeMinimumIncidentSeverity(undefined), 'major');
  assert.equal(normalizeMinimumIncidentSeverity(''), 'major');
  assert.equal(normalizeMinimumIncidentSeverity([]), 'major');
  assert.equal(normalizeMinimumIncidentSeverity('unexpected'), 'major');
  assert.equal(normalizeMinimumIncidentSeverity(' CRITICAL '), 'critical');
  assert.equal(normalizeMinimumIncidentSeverity([' CRITICAL ']), 'critical');
});

test('validateMinimumIncidentSeverity requires a recognized selection', () => {
  assert.match(validateMinimumIncidentSeverity(undefined) ?? '', /choose/i);
  assert.match(validateMinimumIncidentSeverity([]) ?? '', /choose/i);
  assert.match(validateMinimumIncidentSeverity(['']) ?? '', /choose/i);
  assert.match(
    validateMinimumIncidentSeverity(['unexpected']) ?? '',
    /choose/i,
  );
  assert.equal(validateMinimumIncidentSeverity(['major']), undefined);
  assert.equal(validateMinimumIncidentSeverity([' CRITICAL ']), undefined);
});
