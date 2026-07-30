const REDDIT_STATUS_URL =
  'https://www.redditstatus.com/api/v2/incidents/unresolved.json';
const DISCORD_CONTENT_LIMIT = 2_000;
const SLACK_TEXT_LIMIT = 4_000;
const REQUEST_TIMEOUT_MS = 10_000;
const INCIDENT_SEVERITY_RANK = {
  minor: 1,
  major: 2,
  critical: 3,
} as const;

type Fetch = typeof fetch;

export type IncidentSeverity = keyof typeof INCIDENT_SEVERITY_RANK;

export type IncidentUpdate = {
  body?: string;
  createdAt?: string;
};

export type RedditIncident = {
  id: string;
  name: string;
  status: string;
  impact: string;
  createdAt?: string;
  updatedAt?: string;
  shortlink?: string;
  updates: IncidentUpdate[];
};

export type NotificationResult =
  | 'failed'
  | 'invalid'
  | 'not-configured'
  | 'not-needed'
  | 'sent';

export type NotificationChannel = 'discord' | 'slack' | 'modmail';

export type NotificationConfiguration = {
  discordWebhookUrl?: string;
  slackWebhookUrl?: string;
  modmailEnabled: boolean;
  minimumIncidentSeverity?: IncidentSeverity;
};

export type ModmailNotification = {
  subject: string;
  bodyMarkdown: string;
};

type ChannelNotificationResults = Record<
  NotificationChannel,
  {
    active: NotificationResult;
    resolved: NotificationResult;
  }
>;

export type StatusCheckResult = {
  totalIncidents: number;
  reportableIncidents: RedditIncident[];
  newReportableIncidents: RedditIncident[];
  ongoingReportableIncidents: RedditIncident[];
  resolvedIncidents: RedditIncident[];
  ignoredIncidents: number;
  minimumIncidentSeverity: IncidentSeverity;
  notifications: {
    active: NotificationResult;
    resolved: NotificationResult;
  };
  channelNotifications: ChannelNotificationResults;
};

export type StoredIncident = {
  incident: RedditIncident;
  alertedAt: string;
  resolvedAt?: string;
  activeNotificationChannels?: NotificationChannel[];
  resolvedNotificationChannels?: NotificationChannel[];
};

export type IncidentResolution = {
  incident: RedditIncident;
  resolvedAt?: string;
};

export type IncidentClaimKind = 'active' | 'resolved';

export type IncidentStore = {
  listActive(): Promise<StoredIncident[]>;
  claim(
    kind: IncidentClaimKind,
    incidentId: string,
    claimedAt: Date,
  ): Promise<boolean>;
  releaseClaims(kind: IncidentClaimKind, incidentIds: string[]): Promise<void>;
  saveActive(incidents: StoredIncident[]): Promise<void>;
  removeActive(incidentIds: string[]): Promise<void>;
};

type StatusCheckDependencies = {
  incidentStore: IncidentStore;
  fetchImpl?: Fetch;
  now?: () => Date;
  sendModmailNotification?: (
    notification: ModmailNotification,
  ) => Promise<void>;
};

export async function checkRedditStatus(
  configuration: NotificationConfiguration | string | undefined,
  dependencies: StatusCheckDependencies,
): Promise<StatusCheckResult> {
  const notificationConfiguration = normalizeNotificationConfiguration(
    configuration,
  );
  const minimumIncidentSeverity =
    notificationConfiguration.minimumIncidentSeverity ?? 'major';
  const discordWebhookUrl =
    notificationConfiguration.discordWebhookUrl?.trim();
  const slackWebhookUrl = notificationConfiguration.slackWebhookUrl?.trim();
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const now = dependencies.now?.() ?? new Date();
  const incidentStore = dependencies.incidentStore;
  const incidents = await fetchRedditIncidents(fetchImpl);
  const incidentById = new Map(
    incidents.map((incident) => [incident.id, incident]),
  );
  const reportableIncidents = [
    ...new Map(
      incidents
        .filter((incident) =>
          meetsMinimumSeverity(incident.impact, minimumIncidentSeverity),
        )
        .map((incident) => [incident.id, incident]),
    ).values(),
  ];
  const ignoredIncidents = incidents.filter(
    (incident) =>
      !meetsMinimumSeverity(incident.impact, minimumIncidentSeverity),
  ).length;
  const storedIncidents = await incidentStore.listActive();
  const storedById = new Map(
    storedIncidents.map((stored) => [stored.incident.id, stored]),
  );
  const newReportableIncidents = reportableIncidents.filter(
    (incident) => !storedById.has(incident.id),
  );
  const ongoingReportableIncidents = reportableIncidents.filter((incident) =>
    storedById.has(incident.id),
  );
  const resolvedStored = storedIncidents
    .filter((stored) => !incidentById.has(stored.incident.id))
    .map((stored) => ({
      ...stored,
      resolvedAt: stored.resolvedAt ?? now.toISOString(),
    }));
  const resolvedIncidents = resolvedStored.map((stored) => stored.incident);
  if (resolvedStored.length > 0) {
    await incidentStore.saveActive(resolvedStored);
    for (const stored of resolvedStored) {
      storedById.set(stored.incident.id, stored);
    }
  }

  const refreshedStoredIncidents = storedIncidents.flatMap((stored) => {
    const current = incidentById.get(stored.incident.id);
    return current ? [{ ...stored, incident: current }] : [];
  });
  if (refreshedStoredIncidents.length > 0) {
    await incidentStore.saveActive(refreshedStoredIncidents);
    for (const stored of refreshedStoredIncidents) {
      storedById.set(stored.incident.id, stored);
    }
  }

  for (const incident of reportableIncidents) {
    logIncident(incident);
  }

  const channelNotifications: ChannelNotificationResults = {
    discord: {
      active: 'not-needed',
      resolved: 'not-needed',
    },
    slack: {
      active: 'not-needed',
      resolved: 'not-needed',
    },
    modmail: {
      active: 'not-needed',
      resolved: 'not-needed',
    },
  };
  const discordValidationError =
    validateDiscordWebhookUrl(discordWebhookUrl);
  const slackValidationError = validateSlackWebhookUrl(slackWebhookUrl);
  const activePending = {
    discord: discordWebhookUrl
      ? reportableIncidents.filter(
          (incident) =>
            !activeChannelsFor(storedById.get(incident.id)).includes(
              'discord',
            ),
        )
      : [],
    slack: slackWebhookUrl
      ? reportableIncidents.filter(
          (incident) =>
            !activeChannelsFor(storedById.get(incident.id)).includes('slack'),
        )
      : [],
    modmail: notificationConfiguration.modmailEnabled
      ? reportableIncidents.filter(
          (incident) =>
            !activeChannelsFor(storedById.get(incident.id)).includes(
              'modmail',
            ),
        )
      : [],
  };

  if (newReportableIncidents.length > 0 && !discordWebhookUrl) {
    channelNotifications.discord.active = 'not-configured';
  } else if (
    activePending.discord.length > 0 &&
    discordValidationError
  ) {
    channelNotifications.discord.active = 'invalid';
    console.error(
      `Discord webhook setting is invalid: ${discordValidationError}`,
    );
  }

  if (newReportableIncidents.length > 0 && !slackWebhookUrl) {
    channelNotifications.slack.active = 'not-configured';
  } else if (activePending.slack.length > 0 && slackValidationError) {
    channelNotifications.slack.active = 'invalid';
    console.error(
      `Slack webhook setting is invalid: ${slackValidationError}`,
    );
  }

  if (
    newReportableIncidents.length > 0 &&
    !notificationConfiguration.modmailEnabled
  ) {
    channelNotifications.modmail.active = 'not-configured';
  }

  const sendableActive = uniqueIncidents([
    ...(discordValidationError ? [] : activePending.discord),
    ...(slackValidationError ? [] : activePending.slack),
    ...activePending.modmail,
  ]);
  const claimedActive = await claimIncidents(
    incidentStore,
    'active',
    sendableActive,
    now,
  );

  try {
    const claimedActiveIds = new Set(
      claimedActive.map((incident) => incident.id),
    );
    const discordActive = activePending.discord.filter((incident) =>
      claimedActiveIds.has(incident.id),
    );
    const slackActive = activePending.slack.filter((incident) =>
      claimedActiveIds.has(incident.id),
    );
    const modmailActive = activePending.modmail.filter((incident) =>
      claimedActiveIds.has(incident.id),
    );

    if (
      !discordValidationError &&
      discordWebhookUrl &&
      discordActive.length > 0
    ) {
      channelNotifications.discord.active = await notifyActiveChannel(
        'discord',
        discordActive,
        storedById,
        incidentStore,
        now,
        () =>
          sendDiscordAlert(
            discordWebhookUrl,
            formatDiscordAlert(discordActive),
            fetchImpl,
          ),
      );
    }

    if (
      !slackValidationError &&
      slackWebhookUrl &&
      slackActive.length > 0
    ) {
      channelNotifications.slack.active = await notifyActiveChannel(
        'slack',
        slackActive,
        storedById,
        incidentStore,
        now,
        () =>
          sendSlackAlert(
            slackWebhookUrl,
            formatSlackAlert(slackActive),
            fetchImpl,
          ),
      );
    }

    if (modmailActive.length > 0) {
      channelNotifications.modmail.active = await notifyActiveChannel(
        'modmail',
        modmailActive,
        storedById,
        incidentStore,
        now,
        async () => {
          if (!dependencies.sendModmailNotification) {
            throw new Error('The Modmail notification sender is unavailable');
          }
          await dependencies.sendModmailNotification(
            formatModmailAlert(modmailActive),
          );
        },
      );
    }
  } finally {
    await releaseClaimsSafely(
      incidentStore,
      'active',
      claimedActive.map((incident) => incident.id),
    );
  }

  const resolvedPending = {
    discord:
      discordWebhookUrl && !discordValidationError
        ? resolvedStored.filter(
            (stored) =>
              activeChannelsFor(stored).includes('discord') &&
              !resolvedChannelsFor(stored).includes('discord'),
          )
        : [],
    slack:
      slackWebhookUrl && !slackValidationError
        ? resolvedStored.filter(
            (stored) =>
              activeChannelsFor(stored).includes('slack') &&
              !resolvedChannelsFor(stored).includes('slack'),
          )
        : [],
    modmail: notificationConfiguration.modmailEnabled
      ? resolvedStored.filter(
          (stored) =>
            activeChannelsFor(stored).includes('modmail') &&
            !resolvedChannelsFor(stored).includes('modmail'),
        )
      : [],
  };

  if (
    discordWebhookUrl &&
    discordValidationError &&
    resolvedStored.some(
      (stored) =>
        activeChannelsFor(stored).includes('discord') &&
        !resolvedChannelsFor(stored).includes('discord'),
    )
  ) {
    channelNotifications.discord.resolved = 'invalid';
    console.error(
      `Discord webhook setting is invalid: ${discordValidationError}`,
    );
  }

  if (
    slackWebhookUrl &&
    slackValidationError &&
    resolvedStored.some(
      (stored) =>
        activeChannelsFor(stored).includes('slack') &&
        !resolvedChannelsFor(stored).includes('slack'),
    )
  ) {
    channelNotifications.slack.resolved = 'invalid';
    console.error(
      `Slack webhook setting is invalid: ${slackValidationError}`,
    );
  }

  const claimedResolved = await claimIncidents(
    incidentStore,
    'resolved',
    uniqueIncidents([
      ...resolvedPending.discord.map((stored) => stored.incident),
      ...resolvedPending.slack.map((stored) => stored.incident),
      ...resolvedPending.modmail.map((stored) => stored.incident),
    ]),
    now,
  );

  try {
    const claimedResolvedIds = new Set(
      claimedResolved.map((incident) => incident.id),
    );
    const discordResolved = resolvedPending.discord.filter((stored) =>
      claimedResolvedIds.has(stored.incident.id),
    );
    const slackResolved = resolvedPending.slack.filter((stored) =>
      claimedResolvedIds.has(stored.incident.id),
    );
    const modmailResolved = resolvedPending.modmail.filter((stored) =>
      claimedResolvedIds.has(stored.incident.id),
    );

    if (discordWebhookUrl && discordResolved.length > 0) {
      channelNotifications.discord.resolved = await notifyResolvedChannel(
        'discord',
        discordResolved,
        storedById,
        incidentStore,
        () =>
          sendDiscordAlert(
            discordWebhookUrl,
            formatDiscordResolutionAlert(
              discordResolved.map(({ incident, resolvedAt }) => ({
                incident,
                resolvedAt,
              })),
            ),
            fetchImpl,
          ),
      );
    }

    if (slackWebhookUrl && slackResolved.length > 0) {
      channelNotifications.slack.resolved = await notifyResolvedChannel(
        'slack',
        slackResolved,
        storedById,
        incidentStore,
        () =>
          sendSlackAlert(
            slackWebhookUrl,
            formatSlackResolutionAlert(
              slackResolved.map(({ incident, resolvedAt }) => ({
                incident,
                resolvedAt,
              })),
            ),
            fetchImpl,
          ),
      );
    }

    if (modmailResolved.length > 0) {
      channelNotifications.modmail.resolved = await notifyResolvedChannel(
        'modmail',
        modmailResolved,
        storedById,
        incidentStore,
        async () => {
          if (!dependencies.sendModmailNotification) {
            throw new Error('The Modmail notification sender is unavailable');
          }
          await dependencies.sendModmailNotification(
            formatModmailResolutionAlert(
              modmailResolved.map(({ incident, resolvedAt }) => ({
                incident,
                resolvedAt,
              })),
            ),
          );
        },
      );
    }

    const completedResolvedIds = resolvedStored
      .map((stored) => storedById.get(stored.incident.id) ?? stored)
      .filter((stored) =>
        resolutionComplete(
          stored,
          notificationConfiguration,
          discordValidationError,
          slackValidationError,
        ),
      )
      .map((stored) => stored.incident.id);
    await incidentStore.removeActive(completedResolvedIds);
  } finally {
    await releaseClaimsSafely(
      incidentStore,
      'resolved',
      claimedResolved.map((incident) => incident.id),
    );
  }

  const notifications = {
    active: aggregateNotificationResult(
      channelNotifications.discord.active,
      channelNotifications.slack.active,
      channelNotifications.modmail.active,
    ),
    resolved: aggregateNotificationResult(
      channelNotifications.discord.resolved,
      channelNotifications.slack.resolved,
      channelNotifications.modmail.resolved,
    ),
  };

  return {
    totalIncidents: incidents.length,
    reportableIncidents,
    newReportableIncidents,
    ongoingReportableIncidents,
    resolvedIncidents,
    ignoredIncidents,
    minimumIncidentSeverity,
    notifications,
    channelNotifications,
  };
}

export async function fetchRedditIncidents(
  fetchImpl: Fetch = fetch,
): Promise<RedditIncident[]> {
  const response = await fetchImpl(REDDIT_STATUS_URL, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `Reddit Status API returned HTTP ${response.status}`,
    );
  }

  const payload = (await response.json()) as unknown;
  if (!isRecord(payload)) {
    throw new Error('Reddit Status API returned an invalid response');
  }

  const rawIncidents = payload.incidents;
  if (rawIncidents == null) {
    return [];
  }
  if (!Array.isArray(rawIncidents)) {
    throw new Error('Reddit Status API returned an invalid incidents list');
  }

  return rawIncidents
    .filter(isRecord)
    .map(normalizeIncident);
}

export async function sendDiscordAlert(
  webhookUrl: string,
  content: string,
  fetchImpl: Fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content,
      username: 'Reddit Site Status',
      allowed_mentions: { parse: [] },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Discord webhook returned HTTP ${response.status}`);
  }
}

export async function sendSlackAlert(
  webhookUrl: string,
  text: string,
  fetchImpl: Fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Slack webhook returned HTTP ${response.status}`);
  }
}

export function formatDiscordAlert(incidents: RedditIncident[]): string {
  const header = '### ⚠️ Active Reddit Incidents';
  const blocks = incidents.map((incident) =>
    formatIncident(incident, formatDiscordTimestamp),
  );
  let message = header;

  for (let index = 0; index < blocks.length; index += 1) {
    const candidate = `${message}\n${blocks[index]}`;
    if (candidate.length <= DISCORD_CONTENT_LIMIT) {
      message = candidate;
      continue;
    }

    const omitted = blocks.length - index;
    const suffix = `\n\n_${omitted} additional incident${
      omitted === 1 ? '' : 's'
    } omitted to fit Discord's message limit._`;
    const available = DISCORD_CONTENT_LIMIT - suffix.length;
    return `${message.slice(0, available).trimEnd()}${suffix}`;
  }

  return message;
}

export function formatDiscordResolutionAlert(
  incidents: Array<RedditIncident | IncidentResolution>,
): string {
  const header = '### ✅ Reddit Incidents Resolved';
  const blocks = incidents.map(formatResolvedIncident);
  let message = header;

  for (let index = 0; index < blocks.length; index += 1) {
    const candidate = `${message}\n${blocks[index]}`;
    if (candidate.length <= DISCORD_CONTENT_LIMIT) {
      message = candidate;
      continue;
    }

    const omitted = blocks.length - index;
    const suffix = `\n\n_${omitted} additional resolved incident${
      omitted === 1 ? '' : 's'
    } omitted to fit Discord's message limit._`;
    const available = DISCORD_CONTENT_LIMIT - suffix.length;
    return `${message.slice(0, available).trimEnd()}${suffix}`;
  }

  return message;
}

export function formatSlackAlert(incidents: RedditIncident[]): string {
  return formatSlackMessage(
    '*⚠️ Active Reddit Incidents*',
    incidents.map(formatSlackIncident),
    'incident',
  );
}

export function formatSlackResolutionAlert(
  incidents: Array<RedditIncident | IncidentResolution>,
): string {
  return formatSlackMessage(
    '*✅ Reddit Incidents Resolved*',
    incidents.map(formatSlackResolvedIncident),
    'resolved incident',
  );
}

export function formatModmailAlert(
  incidents: RedditIncident[],
): ModmailNotification {
  return {
    subject: `Reddit site status: ${incidents.length} active incident${
      incidents.length === 1 ? '' : 's'
    }`,
    bodyMarkdown: [
      '## ⚠️ Active Reddit Incidents',
      '',
      ...incidents.map((incident) =>
        formatIncident(incident, formatModmailTimestamp),
      ),
    ].join('\n'),
  };
}

export function formatModmailResolutionAlert(
  incidents: Array<RedditIncident | IncidentResolution>,
): ModmailNotification {
  return {
    subject: `Reddit site status: ${incidents.length} incident${
      incidents.length === 1 ? '' : 's'
    } resolved`,
    bodyMarkdown: [
      '## ✅ Reddit Incidents Resolved',
      '',
      ...incidents.map(formatResolvedIncident),
    ].join('\n'),
  };
}

export function validateDiscordWebhookUrl(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return 'Enter a valid Discord webhook URL.';
  }

  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'discord.com' ||
    (url.port !== '' && url.port !== '443') ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    return 'The webhook must be an HTTPS URL on discord.com.';
  }

  if (!/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[^/]+\/?$/.test(url.pathname)) {
    return 'Enter a Discord webhook URL copied from a channel integration.';
  }

  return undefined;
}

export function validateSlackWebhookUrl(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return 'Enter a valid Slack incoming webhook URL.';
  }

  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'hooks.slack.com' ||
    (url.port !== '' && url.port !== '443') ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    return 'The webhook must be an HTTPS URL on hooks.slack.com.';
  }

  if (!/^\/services\/[^/]+\/[^/]+\/[^/]+\/?$/.test(url.pathname)) {
    return 'Enter a Slack incoming webhook URL copied from your app settings.';
  }

  return undefined;
}

function normalizeIncident(raw: Record<string, unknown>): RedditIncident {
  const rawUpdates = Array.isArray(raw.incident_updates)
    ? raw.incident_updates
    : [];
  const name = stringValue(raw.name) ?? 'Unknown';
  const createdAt = stringValue(raw.created_at);
  const shortlink =
    stringValue(raw.shortlink) ?? stringValue(raw.shortlink_url);

  return {
    id:
      stringValue(raw.id) ??
      shortlink ??
      `${name}:${createdAt ?? 'unknown-created-at'}`,
    name,
    status: stringValue(raw.status) ?? 'N/A',
    impact: stringValue(raw.impact) ?? 'unknown',
    createdAt,
    updatedAt: stringValue(raw.updated_at),
    shortlink,
    updates: rawUpdates.filter(isRecord).map((update) => ({
      body: stringValue(update.body)?.trim(),
      createdAt: stringValue(update.created_at),
    })),
  };
}

function formatSlackMessage(
  header: string,
  blocks: string[],
  omittedLabel: string,
): string {
  let message = header;

  for (let index = 0; index < blocks.length; index += 1) {
    const candidate = `${message}\n${blocks[index]}`;
    if (candidate.length <= SLACK_TEXT_LIMIT) {
      message = candidate;
      continue;
    }

    const omitted = blocks.length - index;
    const suffix = `\n\n_${omitted} additional ${omittedLabel}${
      omitted === 1 ? '' : 's'
    } omitted to fit Slack's message limit._`;
    const available = SLACK_TEXT_LIMIT - suffix.length;
    return `${message.slice(0, available).trimEnd()}${suffix}`;
  }

  return message;
}

function formatSlackIncident(incident: RedditIncident): string {
  return [
    `• ${incidentSeverityEmoji(incident.impact)} ${formatSlackIncidentTitle(
      incident,
    )}`,
    `  • *Status:* ${escapeSlackText(titleCase(incident.status))} (${escapeSlackText(
      incident.impact,
    )})`,
    `  • *Created:* ${formatSlackTimestamp(incident.createdAt)}`,
    `  • *Updated:* ${formatSlackTimestamp(incident.updatedAt)}`,
  ].join('\n');
}

function formatSlackResolvedIncident(
  resolution: RedditIncident | IncidentResolution,
): string {
  const { incident, resolvedAt } =
    'incident' in resolution
      ? resolution
      : { incident: resolution, resolvedAt: resolution.updatedAt };

  return [
    `• ${incidentSeverityEmoji(incident.impact)} ${formatSlackIncidentTitle(
      incident,
    )}`,
    '  • *Status:* Resolved',
    `  • *Previous state:* ${escapeSlackText(
      titleCase(incident.status),
    )} (${escapeSlackText(incident.impact)})`,
    `  • *Approx. duration:* ${escapeSlackText(
      formatIncidentDuration(incident.createdAt, resolvedAt),
    )}`,
  ].join('\n');
}

function formatSlackIncidentTitle(incident: RedditIncident): string {
  const label = escapeSlackText(incident.name);
  if (!incident.shortlink) {
    return `*${label}*`;
  }

  try {
    const url = new URL(incident.shortlink);
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      return `*<${url.toString()}|${label}>*`;
    }
  } catch {
    // Fall back to an unlinked title when Statuspage supplies a malformed URL.
  }

  return `*${label}*`;
}

function formatIncident(
  incident: RedditIncident,
  formatTimestamp: (value: string | undefined) => string,
): string {
  const title = incident.shortlink
    ? `**[${incident.name}](${incident.shortlink})**`
    : `**${incident.name}**`;
  const severityEmoji = incidentSeverityEmoji(incident.impact);

  return [
    `- ${severityEmoji} ${title}`,
    `  - **Status:** ${titleCase(incident.status)} (${incident.impact})`,
    `  - **Created:** ${formatTimestamp(incident.createdAt)}`,
    `  - **Updated:** ${formatTimestamp(incident.updatedAt)}`,
  ].join('\n');
}

function formatResolvedIncident(
  resolution: RedditIncident | IncidentResolution,
): string {
  const { incident, resolvedAt } =
    'incident' in resolution
      ? resolution
      : { incident: resolution, resolvedAt: resolution.updatedAt };
  const title = incident.shortlink
    ? `**[${incident.name}](${incident.shortlink})**`
    : `**${incident.name}**`;
  const severityEmoji = incidentSeverityEmoji(incident.impact);

  return [
    `- ${severityEmoji} ${title}`,
    '  - **Status:** Resolved',
    `  - **Previous state:** ${titleCase(incident.status)} (${incident.impact})`,
    `  - **Approx. duration:** ${formatIncidentDuration(
      incident.createdAt,
      resolvedAt,
    )}`,
  ].join('\n');
}

function formatIncidentDuration(
  createdAt: string | undefined,
  resolvedAt: string | undefined,
): string {
  const created = parseDate(createdAt);
  const resolved = parseDate(resolvedAt);
  if (!created || !resolved || resolved < created) {
    return 'Unknown';
  }

  const elapsedMilliseconds = resolved.getTime() - created.getTime();
  if (elapsedMilliseconds < 60_000) {
    return 'Less than 1 minute';
  }

  let remainingMinutes = Math.floor(elapsedMilliseconds / 60_000);
  const days = Math.floor(remainingMinutes / (24 * 60));
  remainingMinutes -= days * 24 * 60;
  const hours = Math.floor(remainingMinutes / 60);
  const minutes = remainingMinutes - hours * 60;
  const parts: string[] = [];

  if (days > 0) {
    parts.push(`${days} day${days === 1 ? '' : 's'}`);
  }
  if (hours > 0) {
    parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  }
  if (minutes > 0) {
    parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  }

  return parts.join(' ');
}

function incidentSeverityEmoji(impact: string): string {
  switch (impact.trim().toLowerCase()) {
    case 'minor':
      return '🟡';
    case 'major':
      return '🟠';
    case 'critical':
      return '🔴';
    default:
      return '⚠️';
  }
}

function formatDiscordTimestamp(value: string | undefined): string {
  const date = parseDate(value);
  if (!date) {
    return 'N/A';
  }

  const unixTimestamp = Math.floor(date.getTime() / 1_000);
  return `<t:${unixTimestamp}:F> (<t:${unixTimestamp}:R>)`;
}

function formatSlackTimestamp(value: string | undefined): string {
  const date = parseDate(value);
  if (!date) {
    return 'N/A';
  }

  const unixTimestamp = Math.floor(date.getTime() / 1_000);
  return `<!date^${unixTimestamp}^{date_long_pretty} at {time}|${escapeSlackText(
    formatUtc(value),
  )}>`;
}

function formatModmailTimestamp(value: string | undefined): string {
  const date = parseDate(value);
  if (!date) {
    return 'N/A';
  }

  const compactUtc = date
    .toISOString()
    .slice(0, 19)
    .replaceAll('-', '')
    .replaceAll(':', '');
  const conversionUrl =
    `https://www.timeanddate.com/worldclock/fixedtime.html?` +
    `iso=${compactUtc}&p1=1440`;

  return `[${formatUtc(value)}](${conversionUrl})`;
}

function escapeSlackText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

async function claimIncidents(
  incidentStore: IncidentStore,
  kind: IncidentClaimKind,
  incidents: RedditIncident[],
  claimedAt: Date,
): Promise<RedditIncident[]> {
  const claims = await Promise.all(
    incidents.map(async (incident) => ({
      incident,
      claimed: await incidentStore.claim(kind, incident.id, claimedAt),
    })),
  );

  return claims
    .filter(({ claimed }) => claimed)
    .map(({ incident }) => incident);
}

async function notifyActiveChannel(
  channel: NotificationChannel,
  incidents: RedditIncident[],
  storedById: Map<string, StoredIncident>,
  incidentStore: IncidentStore,
  now: Date,
  send: () => Promise<void>,
): Promise<NotificationResult> {
  try {
    await send();
  } catch (error) {
    console.error(
      `${channelLabel(channel)} active-incident notification failed:`,
      error,
    );
    return 'failed';
  }

  try {
    const records = incidents.map((incident) => {
      const existing = storedById.get(incident.id);
      return {
        incident,
        alertedAt: existing?.alertedAt ?? now.toISOString(),
        activeNotificationChannels: uniqueChannels([
          ...activeChannelsFor(existing),
          channel,
        ]),
        resolvedNotificationChannels:
          existing?.resolvedNotificationChannels,
      };
    });
    await incidentStore.saveActive(records);
    for (const stored of records) {
      storedById.set(stored.incident.id, stored);
    }
    return 'sent';
  } catch (error) {
    console.error(
      `${channelLabel(channel)} active-incident alert was sent, but Redis tracking failed:`,
      error,
    );
    return 'failed';
  }
}

async function notifyResolvedChannel(
  channel: NotificationChannel,
  incidents: StoredIncident[],
  storedById: Map<string, StoredIncident>,
  incidentStore: IncidentStore,
  send: () => Promise<void>,
): Promise<NotificationResult> {
  try {
    await send();
  } catch (error) {
    console.error(
      `${channelLabel(channel)} resolved-incident notification failed:`,
      error,
    );
    return 'failed';
  }

  try {
    const records = incidents.map((stored) => {
      const current = storedById.get(stored.incident.id) ?? stored;
      return {
        ...current,
        resolvedNotificationChannels: uniqueChannels([
          ...resolvedChannelsFor(current),
          channel,
        ]),
      };
    });
    await incidentStore.saveActive(records);
    for (const stored of records) {
      storedById.set(stored.incident.id, stored);
    }
    return 'sent';
  } catch (error) {
    console.error(
      `${channelLabel(channel)} resolution alert was sent, but Redis tracking failed:`,
      error,
    );
    return 'failed';
  }
}

function normalizeNotificationConfiguration(
  configuration: NotificationConfiguration | string | undefined,
): NotificationConfiguration {
  if (typeof configuration === 'string' || configuration === undefined) {
    return {
      discordWebhookUrl: configuration,
      slackWebhookUrl: undefined,
      modmailEnabled: false,
      minimumIncidentSeverity: 'major',
    };
  }

  return {
    discordWebhookUrl: configuration.discordWebhookUrl,
    slackWebhookUrl: configuration.slackWebhookUrl,
    modmailEnabled: configuration.modmailEnabled,
    minimumIncidentSeverity: normalizeMinimumIncidentSeverity(
      configuration.minimumIncidentSeverity,
    ),
  };
}

export function normalizeMinimumIncidentSeverity(
  value: string | readonly string[] | undefined,
): IncidentSeverity {
  const normalized = selectedIncidentSeverity(value);
  return normalized === 'minor' ||
    normalized === 'major' ||
    normalized === 'critical'
    ? normalized
    : 'major';
}

export function validateMinimumIncidentSeverity(
  value: string | readonly string[] | undefined,
): string | undefined {
  const normalized = selectedIncidentSeverity(value);
  return normalized === 'minor' ||
    normalized === 'major' ||
    normalized === 'critical'
    ? undefined
    : 'Choose a minimum incident severity.';
}

function selectedIncidentSeverity(
  value: string | readonly string[] | undefined,
): string | undefined {
  const selectedValue = typeof value === 'string' ? value : value?.[0];
  return selectedValue?.trim().toLowerCase();
}

function meetsMinimumSeverity(
  impact: string,
  minimumSeverity: IncidentSeverity,
): boolean {
  const normalizedImpact = impact.trim().toLowerCase();
  const rank =
    INCIDENT_SEVERITY_RANK[
      normalizedImpact as keyof typeof INCIDENT_SEVERITY_RANK
    ];

  if (rank !== undefined) {
    return rank >= INCIDENT_SEVERITY_RANK[minimumSeverity];
  }

  // `none` and `maintenance` are Statuspage impact values, but neither is an
  // incident severity. Unknown values remain reportable so a future API change
  // cannot silently suppress an incident.
  return normalizedImpact !== 'none' && normalizedImpact !== 'maintenance';
}

function activeChannelsFor(
  stored: StoredIncident | undefined,
): NotificationChannel[] {
  if (!stored) {
    return [];
  }

  // Records created before Modmail support were only persisted after a
  // successful Discord alert.
  return stored.activeNotificationChannels ?? ['discord'];
}

function resolvedChannelsFor(
  stored: StoredIncident,
): NotificationChannel[] {
  return stored.resolvedNotificationChannels ?? [];
}

function uniqueChannels(
  channels: NotificationChannel[],
): NotificationChannel[] {
  return [...new Set(channels)];
}

function uniqueIncidents(incidents: RedditIncident[]): RedditIncident[] {
  return [
    ...new Map(incidents.map((incident) => [incident.id, incident])).values(),
  ];
}

function resolutionComplete(
  stored: StoredIncident,
  configuration: NotificationConfiguration,
  discordValidationError: string | undefined,
  slackValidationError: string | undefined,
): boolean {
  const activeChannels = activeChannelsFor(stored);
  const resolvedChannels = resolvedChannelsFor(stored);
  const discordConfigured = Boolean(
    configuration.discordWebhookUrl?.trim(),
  );
  const slackConfigured = Boolean(configuration.slackWebhookUrl?.trim());

  if (
    discordConfigured &&
    activeChannels.includes('discord') &&
    (discordValidationError || !resolvedChannels.includes('discord'))
  ) {
    return false;
  }

  if (
    slackConfigured &&
    activeChannels.includes('slack') &&
    (slackValidationError || !resolvedChannels.includes('slack'))
  ) {
    return false;
  }

  return !(
    configuration.modmailEnabled &&
    activeChannels.includes('modmail') &&
    !resolvedChannels.includes('modmail')
  );
}

function aggregateNotificationResult(
  ...results: NotificationResult[]
): NotificationResult {
  for (const result of [
    'failed',
    'invalid',
    'sent',
    'not-configured',
    'not-needed',
  ] as const) {
    if (results.includes(result)) {
      return result;
    }
  }

  return 'not-needed';
}

function channelLabel(channel: NotificationChannel): string {
  switch (channel) {
    case 'discord':
      return 'Discord';
    case 'slack':
      return 'Slack';
    case 'modmail':
      return 'Modmail';
  }
}

async function releaseClaimsSafely(
  incidentStore: IncidentStore,
  kind: IncidentClaimKind,
  incidentIds: string[],
): Promise<void> {
  try {
    await incidentStore.releaseClaims(kind, incidentIds);
  } catch (error) {
    console.error(`Failed to release ${kind} incident claims:`, error);
  }
}

function logIncident(incident: RedditIncident): void {
  const latestUpdate = [...incident.updates]
    .sort((left, right) =>
      (right.createdAt ?? '').localeCompare(left.createdAt ?? ''),
    )
    .find((update) => update.body)?.body;

  console.log(
    [
      `[Reddit Incident] ${incident.name} — ${incident.status.toUpperCase()} (${incident.impact})`,
      `Created: ${formatUtc(incident.createdAt)} | Updated: ${formatUtc(incident.updatedAt)}`,
      latestUpdate ? `Latest update: ${latestUpdate}` : 'No update text.',
      `Link: ${incident.shortlink ?? 'N/A'}`,
    ].join('\n'),
  );
}

function formatUtc(value: string | undefined): string {
  const date = parseDate(value);
  if (!date) {
    return 'N/A';
  }

  return date
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, ' UTC');
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/(^|[\s_-])([a-z])/g, (_match, prefix: string, letter: string) =>
      `${prefix}${letter.toUpperCase()}`,
    );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
