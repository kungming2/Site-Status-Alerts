import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkRedditStatus,
  fetchRedditIncidents,
  formatDiscordAlert,
  formatDiscordResolutionAlert,
  formatDiscordTestAlert,
  formatModmailAlert,
  formatModmailResolutionAlert,
  formatModmailTestAlert,
  formatSlackAlert,
  formatSlackResolutionAlert,
  formatSlackTestAlert,
  normalizeMinimumIncidentSeverity,
  sendSlackAlert,
  sendDiscordAlert,
  StatusCheckInProgressError,
  sendTestOutageAlerts,
  validateDiscordWebhookUrl,
  validateMinimumIncidentSeverity,
  validateSlackWebhookUrl,
  type DiscordWebhookPayload,
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
  lockToken: string | undefined;
  private nextToken = 0;

  async listActive(): Promise<StoredIncident[]> {
    return [...this.active.values()];
  }

  async acquireCheckLock(): Promise<string | undefined> {
    if (this.lockToken !== undefined) return undefined;
    this.lockToken = String(++this.nextToken);
    return this.lockToken;
  }

  async releaseCheckLock(token: string): Promise<void> {
    if (this.lockToken === token) this.lockToken = undefined;
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
  discordMessages: DiscordWebhookPayload[],
): typeof fetch {
  return async (input, init) => {
    if (String(input).includes('redditstatus.com')) {
      return new Response(
        JSON.stringify({ incidents: getIncidents() }),
        { status: 200 },
      );
    }

    const payload = JSON.parse(
      String(init?.body),
    ) as DiscordWebhookPayload;
    discordMessages.push({ embeds: payload.embeds });
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
  assert.equal(requests[1].url, 'https://discord.com/api/webhooks/123/token?wait=true');
  assert.deepEqual(
    JSON.parse(String(requests[1].init?.body)),
    {
      ...formatDiscordAlert([
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
  const discordMessages: DiscordWebhookPayload[] = [];
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
  assert.deepEqual(
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
  const discordMessages: DiscordWebhookPayload[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    if (String(input).includes('redditstatus.com')) {
      return new Response(JSON.stringify({ incidents: [] }), { status: 200 });
    }
    const payload = JSON.parse(
      String(init?.body),
    ) as DiscordWebhookPayload;
    discordMessages.push({ embeds: payload.embeds });
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
  assert.deepEqual(discordMessages[0], discordMessages[1]);
  assert.match(
    JSON.stringify(discordMessages[1] ?? {}),
    /1 hour 45 minutes/,
  );
});

test('concurrent checks skip the overlap and send a new incident only once', async (t) => {
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

  const results = await Promise.allSettled([
    checkRedditStatus('https://discord.com/api/webhooks/123/token', {
      incidentStore,
      fetchImpl: fakeFetch,
    }),
    checkRedditStatus('https://discord.com/api/webhooks/123/token', {
      incidentStore,
      fetchImpl: fakeFetch,
    }),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const skipped = results.find((result) => result.status === 'rejected');
  assert.ok(skipped?.status === 'rejected');
  assert.ok(skipped.reason instanceof StatusCheckInProgressError);
  assert.equal(incidentStore.lockToken, undefined);
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
  const discordMessages: DiscordWebhookPayload[] = [];
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
  const embed = message.embeds[0]!;
  const renderedEmbed = JSON.stringify(embed);

  assert.equal(embed.title, '⚠️ Active Reddit Incidents');
  assert.equal(embed.color, 0xf59e0b);
  assert.equal(embed.fields.length, 1);
  assert.match(renderedEmbed, /🟠/);
  assert.match(renderedEmbed, /Elevated API errors/);
  assert.match(renderedEmbed, /Investigating \(major\)/);
  assert.match(renderedEmbed, /<t:1785355200:F> \(<t:1785355200:R>\)/);
  assert.match(renderedEmbed, /<t:1785357000:F> \(<t:1785357000:R>\)/);
  assert.match(renderedEmbed, /View incident details/);
  assert.match(embed.footer.text, /1 active incident$/);
});

test('formatDiscordResolutionAlert includes the previous incident state', () => {
  const message = formatDiscordResolutionAlert([
    {
      incident: majorIncident,
      resolvedAt: '2026-07-29T21:45:00.000Z',
    },
  ]);
  const embed = message.embeds[0]!;
  const renderedEmbed = JSON.stringify(embed);

  assert.equal(embed.title, '✅ Reddit Incidents Resolved');
  assert.equal(embed.color, 0x57f287);
  assert.match(renderedEmbed, /🟠/);
  assert.match(renderedEmbed, /Elevated API errors/);
  assert.match(renderedEmbed, /Status:\*\* Resolved/);
  assert.match(renderedEmbed, /Previous state:\*\* Investigating \(major\)/);
  assert.match(renderedEmbed, /Approx\. duration:\*\* 1 hour 45 minutes/);
  assert.match(embed.footer.text, /1 resolved incident$/);
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
    /<!date\^1785355200\^\{date_long_pretty} at \{time}\|2026-07-29 20:00:00 UTC>/,
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

  for (const message of [
    JSON.stringify(discordMessage),
    slackMessage,
    modmailMessage,
  ]) {
    assert.match(message, /🟡/);
    assert.match(message, /🟠/);
    assert.match(message, /🔴/);
    assert.match(message, /⚠️/);
  }
});

test('test outage alerts respect severity and make the test section bold', async () => {
  const webhookMessages = new Map<string, Record<string, unknown>>();
  const modmailMessages: ModmailNotification[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    webhookMessages.set(String(input), payload);
    return new Response(null, { status: 204 });
  };

  const result = await sendTestOutageAlerts(
    {
      discordWebhookUrl: 'https://discord.com/api/webhooks/123/token',
      slackWebhookUrl: 'https://hooks.slack.com/services/T000/B000/token',
      modmailEnabled: true,
      minimumIncidentSeverity: 'major',
    },
    {
      fetchImpl: fakeFetch,
      now: () => new Date('2026-07-30T18:00:00.000Z'),
      sendModmailNotification: async (notification) => {
        modmailMessages.push(notification);
      },
    },
  );

  assert.deepEqual(
    result.incidents.map((incident) => incident.impact),
    ['major', 'critical'],
  );
  assert.equal(result.excludedIncidents, 1);
  assert.deepEqual(result.channelNotifications, {
    discord: 'sent',
    slack: 'sent',
    modmail: 'sent',
  });
  assert.equal(webhookMessages.size, 2);
  const discordPayload = webhookMessages.get(
    'https://discord.com/api/webhooks/123/token?wait=true',
  ) as DiscordWebhookPayload | undefined;
  const discordEmbed = discordPayload?.embeds[0];
  assert.equal(discordEmbed?.title, '🧪 Test: Active Reddit Incidents');
  assert.equal(discordEmbed?.color, 0x5865f2);
  assert.match(
    discordEmbed?.description ?? '',
    /^\*\*This is not a real Reddit outage\.\*\*/,
  );
  assert.match(
    String(
      webhookMessages.get(
        'https://hooks.slack.com/services/T000/B000/token',
      )?.text ?? '',
    ),
    /^\*🧪 TEST NOTIFICATION — This is not a real Reddit outage\.\*/,
  );
  assert.equal(modmailMessages[0]?.subject.startsWith('[TEST]'), true);
  assert.match(
    modmailMessages[0]?.bodyMarkdown ?? '',
    /^\*\*🧪 TEST NOTIFICATION — This is not a real Reddit outage\.\*\*/,
  );
});

test('test alert formatters label messages without modifying real alerts', () => {
  const discord = formatDiscordTestAlert([majorIncident]);
  const slack = formatSlackTestAlert([majorIncident]);
  const modmail = formatModmailTestAlert([majorIncident]);

  assert.match(discord.embeds[0]?.title ?? '', /Active Reddit Incidents/);
  assert.match(
    discord.embeds[0]?.description ?? '',
    /This is not a real Reddit outage/,
  );
  assert.match(slack, /Active Reddit Incidents/);
  assert.match(modmail.bodyMarkdown, /Active Reddit Incidents/);
  assert.doesNotMatch(
    JSON.stringify(formatDiscordAlert([majorIncident])),
    /Test notification/,
  );
  assert.doesNotMatch(formatSlackAlert([majorIncident]), /TEST NOTIFICATION/);
  assert.doesNotMatch(
    formatModmailAlert([majorIncident]).bodyMarkdown,
    /TEST NOTIFICATION/,
  );
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


test('malformed feeds preserve incident records and release the check lock', async () => {
  for (const payload of [{}, { incidents: null }, { incidents: {} },
    { incidents: [null] }, { incidents: [{}] }, { incidents: [{ id: '' }] },
    { incidents: [majorIncident, 42] }]) {
    const incidentStore = new MemoryIncidentStore();
    const stored: StoredIncident = {
      incident: majorIncident,
      alertedAt: '2026-07-29T20:00:00.000Z',
      activeNotificationChannels: ['discord'],
    };
    await incidentStore.saveActive([stored]);
    let webhookCalls = 0;
    await assert.rejects(checkRedditStatus(
      'https://discord.com/api/webhooks/123/token',
      {
        incidentStore,
        fetchImpl: async (input) => {
          if (!String(input).includes('redditstatus.com')) webhookCalls++;
          return new Response(JSON.stringify(payload));
        },
      },
    ), /Reddit Status API returned an invalid/);
    assert.equal(webhookCalls, 0);
    assert.deepEqual(await incidentStore.listActive(), [stored]);
    assert.equal(incidentStore.lockToken, undefined);
  }
});

test('a delayed second check reads delivery state after acquiring the lock', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  let finishFirst!: () => void;
  const firstFinished = new Promise<void>((resolve) => { finishFirst = resolve; });
  class DelayedStore extends MemoryIncidentStore {
    attempts = 0;
    override async acquireCheckLock(): Promise<string | undefined> {
      if (++this.attempts === 2) await firstFinished;
      return super.acquireCheckLock();
    }
  }
  const incidentStore = new DelayedStore();
  const messages: DiscordWebhookPayload[] = [];
  const dependencies = {
    incidentStore,
    fetchImpl: createStatusAndDiscordFetch(() => [majorIncident], messages),
  };
  const url = 'https://discord.com/api/webhooks/123/token';
  const first = checkRedditStatus(url, dependencies).finally(finishFirst);
  const second = checkRedditStatus(url, dependencies);
  await Promise.all([first, second]);
  assert.equal(messages.length, 1);
  assert.equal(incidentStore.active.size, 1);
});

test('the check lock covers resolution delivery and record deletion', async () => {
  const incidentStore = new MemoryIncidentStore();
  await incidentStore.saveActive([{
    incident: majorIncident,
    alertedAt: '2026-07-29T20:00:00.000Z',
    activeNotificationChannels: ['discord'],
  }]);
  let started!: () => void;
  let finish!: () => void;
  const sending = new Promise<void>((resolve) => { started = resolve; });
  const finishSending = new Promise<void>((resolve) => { finish = resolve; });
  let feeds = 0;
  let messages = 0;
  const dependencies: StatusCheckDependencies = {
    incidentStore,
    fetchImpl: async (input) => {
      if (String(input).includes('redditstatus.com')) {
        feeds++;
        return new Response(JSON.stringify({ incidents: [] }));
      }
      messages++;
      started();
      await finishSending;
      return new Response(null, { status: 204 });
    },
  };
  const url = 'https://discord.com/api/webhooks/123/token';
  const first = checkRedditStatus(url, dependencies);
  await sending;
  await assert.rejects(checkRedditStatus(url, dependencies), StatusCheckInProgressError);
  assert.equal(feeds, 1);
  finish();
  await first;
  await checkRedditStatus(url, dependencies);
  assert.equal(messages, 1);
  assert.equal(incidentStore.active.size, 0);
});

test('a failed feed request releases the lock so a later check can run', async () => {
  const incidentStore = new MemoryIncidentStore();
  await assert.rejects(checkRedditStatus(undefined, {
    incidentStore,
    fetchImpl: async () => { throw new Error('Network unavailable'); },
  }), /Network unavailable/);
  await checkRedditStatus(undefined, {
    incidentStore,
    fetchImpl: async () => new Response(JSON.stringify({ incidents: [] })),
  });
  assert.equal(incidentStore.lockToken, undefined);
});

test('Discord requests delivery confirmation and preserves other query parameters', async () => {
  const payload = formatDiscordAlert([majorIncident]);
  for (const query of ['', '?wait=false&thread_id=456']) {
    await sendDiscordAlert(`https://discord.com/api/webhooks/123/token${query}`, payload,
      async (input, init) => {
        const url = new URL(String(input));
        assert.equal(url.searchParams.get('wait'), 'true');
        assert.equal(url.searchParams.getAll('wait').length, 1);
        assert.equal(url.searchParams.get('thread_id'), query ? '456' : null);
        assert.equal(init?.method, 'POST');
        assert.deepEqual(JSON.parse(String(init?.body)).embeds, payload.embeds);
        return new Response(JSON.stringify({ id: 'message-1' }), { status: 200 });
      });
  }
  await assert.rejects(sendDiscordAlert('https://discord.com/api/webhooks/123/token',
    payload, async () => new Response('Cannot send message', { status: 400 })),
    /Discord webhook returned HTTP 400/);
});


test('failed delivery-record writes are retried without forgetting successful channels', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  t.mock.method(console, 'error', () => undefined);
  for (const withSlack of [false, true]) {
    class FlakyStore extends MemoryIncidentStore {
      failNext = true;
      override async saveActive(records: StoredIncident[]): Promise<void> {
        if (this.failNext) {
          this.failNext = false;
          throw new Error('Temporary Redis failure');
        }
        await super.saveActive(records);
      }
    }
    const incidentStore = new FlakyStore();
    let incidents: Record<string, unknown>[] = [majorIncident];
    const messages: string[] = [];
    const configuration = {
      discordWebhookUrl: 'https://discord.com/api/webhooks/123/token',
      slackWebhookUrl: withSlack ? 'https://hooks.slack.com/services/T/B/token' : undefined,
      modmailEnabled: false,
    };
    const dependencies = {
      incidentStore,
      fetchImpl: (async (input) => {
        const host = new URL(String(input)).hostname;
        if (host === 'www.redditstatus.com') {
          return new Response(JSON.stringify({ incidents }));
        }
        messages.push(host);
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    };
    await checkRedditStatus(configuration, dependencies);
    assert.deepEqual(incidentStore.active.get(majorIncident.id)?.activeNotificationChannels,
      withSlack ? ['discord', 'slack'] : ['discord']);
    await checkRedditStatus(configuration, dependencies);
    assert.equal(messages.length, withSlack ? 2 : 1);
    incidents = [];
    await checkRedditStatus(configuration, dependencies);
    assert.equal(messages.filter((host) => host === 'discord.com').length, 2);
    assert.equal(incidentStore.active.size, 0);
  }
});

test('resolution write failures retain acknowledgements while another channel retries', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  class FlakyStore extends MemoryIncidentStore {
    writes = 0;
    override async saveActive(records: StoredIncident[]): Promise<void> {
      if (++this.writes === 2) throw new Error('Temporary Redis failure');
      await super.saveActive(records);
    }
  }
  const incidentStore = new FlakyStore();
  incidentStore.active.set(majorIncident.id, {
    incident: majorIncident, alertedAt: majorIncident.createdAt!,
    activeNotificationChannels: ['discord', 'slack'],
  });
  let failSlack = true;
  let discordSends = 0;
  const configuration = {
    discordWebhookUrl: 'https://discord.com/api/webhooks/123/token',
    slackWebhookUrl: 'https://hooks.slack.com/services/T/B/token', modmailEnabled: false,
  };
  const dependencies: StatusCheckDependencies = {
    incidentStore,
    fetchImpl: async (input) => {
      const host = new URL(String(input)).hostname;
      if (host === 'www.redditstatus.com') return new Response('{"incidents":[]}');
      if (host === 'discord.com') discordSends++;
      return new Response(null, { status: host === 'hooks.slack.com' && failSlack ? 500 : 204 });
    },
  };
  await checkRedditStatus(configuration, dependencies);
  assert.deepEqual(incidentStore.active.get(majorIncident.id)?.resolvedNotificationChannels, ['discord']);
  failSlack = false;
  await checkRedditStatus(configuration, dependencies);
  assert.equal(discordSends, 1);
  assert.equal(incidentStore.active.size, 0);
});

test('a reappearing incident clears prior resolution state even below the severity threshold', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const incidentStore = new MemoryIncidentStore();
  incidentStore.active.set(majorIncident.id, {
    incident: majorIncident, alertedAt: majorIncident.createdAt!,
    activeNotificationChannels: ['discord', 'slack'],
    resolvedAt: '2026-07-29T20:30:00.000Z', resolvedNotificationChannels: ['discord'],
  });
  let incidents: Record<string, unknown>[] = [{
    ...majorIncident, impact: 'minor', created_at: majorIncident.createdAt,
  }];
  const messages: Record<string, unknown>[] = [];
  const configuration = {
    discordWebhookUrl: 'https://discord.com/api/webhooks/123/token',
    slackWebhookUrl: 'https://hooks.slack.com/services/T/B/token', modmailEnabled: false,
  };
  const dependencies: StatusCheckDependencies = {
    incidentStore, now: () => new Date('2026-07-29T22:00:00.000Z'),
    fetchImpl: async (input, init) => {
      if (String(input).includes('redditstatus.com')) return new Response(JSON.stringify({ incidents }));
      messages.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    },
  };
  await checkRedditStatus(configuration, dependencies);
  const stored = incidentStore.active.get(majorIncident.id)!;
  assert.equal(stored.resolvedAt, undefined);
  assert.equal(stored.resolvedNotificationChannels, undefined);
  assert.deepEqual(stored.activeNotificationChannels, ['discord', 'slack']);
  assert.equal(messages.length, 0);
  incidents = [];
  await checkRedditStatus(configuration, dependencies);
  assert.equal(messages.length, 2);
  assert.match(JSON.stringify(messages), /2 hours/);
  assert.equal(incidentStore.active.size, 0);
});

test('all channel and lifecycle sends run concurrently and persist merged delivery records', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const incidentStore = new MemoryIncidentStore();
  incidentStore.active.set('old', {
    incident: { ...majorIncident, id: 'old' }, alertedAt: majorIncident.createdAt!,
    activeNotificationChannels: ['discord', 'slack', 'modmail'],
  });
  let sends = 0;
  let release!: () => void;
  const allStarted = new Promise<void>((resolve) => { release = resolve; });
  const send = async () => {
    if (++sends === 6) release();
    await allStarted;
  };
  const result = await checkRedditStatus({
    discordWebhookUrl: 'https://discord.com/api/webhooks/123/token',
    slackWebhookUrl: 'https://hooks.slack.com/services/T/B/token', modmailEnabled: true,
  }, {
    incidentStore,
    fetchImpl: async (input) => {
      if (String(input).includes('redditstatus.com')) return new Response(JSON.stringify({ incidents: [majorIncident] }));
      await send();
      return new Response(null, { status: 204 });
    },
    sendModmailNotification: send,
  });
  assert.equal(sends, 6);
  assert.equal(result.notifications.active, 'sent');
  assert.equal(result.notifications.resolved, 'sent');
  assert.deepEqual(new Set(incidentStore.active.get(majorIncident.id)?.activeNotificationChannels),
    new Set(['discord', 'slack', 'modmail']));
  assert.equal(incidentStore.active.has('old'), false);
});

test('delivery timeouts abort HTTP, bound Modmail waits, and leave retries pending', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  t.mock.method(console, 'error', () => undefined);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let elapsed = 0;
  t.mock.method(Date, 'now', () => elapsed);
  const incidentStore = new MemoryIncidentStore();
  let started!: () => void;
  const sending = new Promise<void>((resolve) => { started = resolve; });
  let stalled = 0;
  let signal: AbortSignal | undefined;
  const stall = () => {
    if (++stalled === 2) started();
    return new Promise<void>(() => {});
  };
  const check = checkRedditStatus({
    discordWebhookUrl: 'https://discord.com/api/webhooks/123/token',
    slackWebhookUrl: 'https://hooks.slack.com/services/T/B/token', modmailEnabled: true,
  }, {
    incidentStore,
    fetchImpl: async (input, init) => {
      const host = new URL(String(input)).hostname;
      if (host === 'www.redditstatus.com') {
        elapsed = 15_000; // Feed and storage work consumed most of the budget.
        return new Response(JSON.stringify({ incidents: [majorIncident] }));
      }
      if (host === 'discord.com') {
        signal = init?.signal ?? undefined;
        await stall();
      }
      return new Response(null, { status: 204 });
    },
    sendModmailNotification: stall,
  });
  await sending;
  t.mock.timers.tick(5_001);
  const result = await check;
  assert.equal(signal?.aborted, true);
  assert.equal(result.channelNotifications.discord.active, 'failed');
  assert.equal(result.channelNotifications.modmail.active, 'failed');
  assert.equal(result.channelNotifications.slack.active, 'sent');
  assert.deepEqual(incidentStore.active.get(majorIncident.id)?.activeNotificationChannels, ['slack']);
  assert.equal(incidentStore.lockToken, undefined);
});

test('an exhausted shared budget defers sends until the next check', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  t.mock.method(console, 'error', () => undefined);
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const incidentStore = new MemoryIncidentStore();
  let sends = 0;
  const configuration = { discordWebhookUrl: 'https://discord.com/api/webhooks/123/token', modmailEnabled: false };
  const dependencies: StatusCheckDependencies = {
    incidentStore,
    fetchImpl: async (input) => {
      if (String(input).includes('redditstatus.com')) {
        now += 20_001;
        return new Response(JSON.stringify({ incidents: [majorIncident] }));
      }
      sends++;
      return new Response(null, { status: 204 });
    },
  };
  const result = await checkRedditStatus(configuration, dependencies);
  assert.equal(result.channelNotifications.discord.active, 'failed');
  assert.equal(sends, 0);
  assert.equal(incidentStore.active.size, 0);
  await checkRedditStatus(configuration, {
    ...dependencies,
    fetchImpl: async (input) => {
      if (String(input).includes('redditstatus.com')) return new Response(JSON.stringify({ incidents: [majorIncident] }));
      sends++;
      return new Response(null, { status: 204 });
    },
  });
  assert.equal(sends, 1);
});


test('persistent tracking failures fail the check without deleting a resolved record', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  class FailingStore extends MemoryIncidentStore {
    writes = 0;
    override async saveActive(records: StoredIncident[]): Promise<void> {
      if (++this.writes > 1) throw new Error('Redis remains unavailable');
      await super.saveActive(records);
    }
  }
  const incidentStore = new FailingStore();
  incidentStore.active.set(majorIncident.id, {
    incident: majorIncident, alertedAt: majorIncident.createdAt!,
    activeNotificationChannels: ['discord'],
  });
  const messages: DiscordWebhookPayload[] = [];
  await assert.rejects(checkRedditStatus('https://discord.com/api/webhooks/123/token', {
    incidentStore, fetchImpl: createStatusAndDiscordFetch(() => [], messages),
  }), /Redis remains unavailable/);
  assert.equal(messages.length, 1);
  assert.equal(incidentStore.active.size, 1);
  assert.equal(incidentStore.lockToken, undefined);
});
