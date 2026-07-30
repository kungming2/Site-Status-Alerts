import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  reddit,
  settings,
  type TaskRequest,
  type TaskResponse,
} from '@devvit/web/server';
import type {
  SettingsValidationRequest,
  SettingsValidationResponse,
  UiResponse,
} from '@devvit/web/shared';

import { redisIncidentStore } from './incident-store.ts';
import {
  checkRedditStatus,
  normalizeMinimumIncidentSeverity,
  sendTestOutageAlerts,
  validateDiscordWebhookUrl,
  validateMinimumIncidentSeverity,
  validateSlackWebhookUrl,
  type ModmailNotification,
  type NotificationConfiguration,
  type NotificationTestResult,
  type StatusCheckResult,
} from './status.ts';

const DISCORD_WEBHOOK_SETTING = 'discordWebhookUrl';
const SLACK_WEBHOOK_SETTING = 'slackWebhookUrl';
const MODMAIL_NOTIFICATIONS_SETTING = 'modmailNotificationsEnabled';
const MINIMUM_INCIDENT_SEVERITY_SETTING = 'minimumIncidentSeverity';

type ErrorResponse = {
  error: string;
  status: number;
};

export async function onRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    await route(request, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Unhandled server error:', error);
    writeJson(response, 500, { error: message, status: 500 });
  }
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const pathname = new URL(
    request.url ?? '/',
    'https://reddit-site-status.local',
  ).pathname;

  if (request.method !== 'POST') {
    writeJson(response, 404, { error: 'Not found', status: 404 });
    return;
  }

  switch (pathname) {
    case '/internal/menu/check-reddit-status':
      writeJson(response, 200, await handleManualCheck());
      return;
    case '/internal/menu/send-test-outage-alerts':
      writeJson(response, 200, await handleTestOutageAlerts());
      return;
    case '/internal/scheduler/check-reddit-status':
      await readJson<TaskRequest>(request);
      writeJson(response, 200, await handleScheduledCheck());
      return;
    case '/internal/settings/validate-discord-webhook':
      writeJson(response, 200, await handleWebhookValidation(request));
      return;
    case '/internal/settings/validate-slack-webhook':
      writeJson(response, 200, await handleSlackWebhookValidation(request));
      return;
    case '/internal/settings/validate-minimum-incident-severity':
      writeJson(response, 200, await handleMinimumSeverityValidation(request));
      return;
    default:
      writeJson(response, 404, { error: 'Not found', status: 404 });
  }
}

async function handleManualCheck(): Promise<UiResponse> {
  try {
    const result = await runConfiguredCheck();
    return {
      showToast: {
        text: manualCheckMessage(result),
        appearance: result.reportableIncidents.length === 0 ? 'success' : 'neutral',
      },
    };
  } catch (error) {
    console.error('Manual Reddit status check failed:', error);
    return {
      showToast: {
        text: `Reddit status check failed: ${errorMessage(error)}`,
        appearance: 'neutral',
      },
    };
  }
}

async function handleTestOutageAlerts(): Promise<UiResponse> {
  try {
    const result = await runConfiguredNotificationTest();
    const deliveryResults = Object.values(result.channelNotifications);
    return {
      showToast: {
        text: notificationTestMessage(result),
        appearance:
          deliveryResults.includes('sent') &&
          !deliveryResults.includes('failed') &&
          !deliveryResults.includes('invalid')
            ? 'success'
            : 'neutral',
      },
    };
  } catch (error) {
    console.error('Test outage notification failed:', error);
    return {
      showToast: {
        text: `Test outage notification failed: ${errorMessage(error)}`,
        appearance: 'neutral',
      },
    };
  }
}

async function handleScheduledCheck(): Promise<TaskResponse> {
  try {
    const result = await runConfiguredCheck();
    console.log(scheduledCheckMessage(result));
  } catch (error) {
    // Match the original report's fail-soft behavior so a temporary API or
    // webhook failure does not disable future hourly checks.
    console.error('Scheduled Reddit status check failed:', error);
  }

  return { status: 'ok' };
}

async function handleWebhookValidation(
  request: IncomingMessage,
): Promise<SettingsValidationResponse> {
  const { value } =
    await readJson<SettingsValidationRequest<string>>(request);
  const validationError = validateDiscordWebhookUrl(value);

  return validationError
    ? { success: false, error: validationError }
    : { success: true };
}

async function handleMinimumSeverityValidation(
  request: IncomingMessage,
): Promise<SettingsValidationResponse> {
  const { value } =
    await readJson<SettingsValidationRequest<string[]>>(request);
  const validationError = validateMinimumIncidentSeverity(value);

  return validationError
    ? { success: false, error: validationError }
    : { success: true };
}

async function handleSlackWebhookValidation(
  request: IncomingMessage,
): Promise<SettingsValidationResponse> {
  const { value } =
    await readJson<SettingsValidationRequest<string>>(request);
  const validationError = validateSlackWebhookUrl(value);

  return validationError
    ? { success: false, error: validationError }
    : { success: true };
}

async function runConfiguredCheck(): Promise<StatusCheckResult> {
  const configuration = await readNotificationConfiguration();

  return checkRedditStatus(configuration, {
    incidentStore: redisIncidentStore,
    sendModmailNotification: createModmailNotificationSender(),
  });
}

async function runConfiguredNotificationTest(): Promise<NotificationTestResult> {
  const configuration = await readNotificationConfiguration();
  return sendTestOutageAlerts(configuration, {
    sendModmailNotification: createModmailNotificationSender(),
  });
}

async function readNotificationConfiguration(): Promise<NotificationConfiguration> {
  const [
    discordWebhookUrl,
    slackWebhookUrl,
    modmailEnabled,
    minimumIncidentSeverity,
  ] =
    await Promise.all([
      settings.get<string>(DISCORD_WEBHOOK_SETTING),
      settings.get<string>(SLACK_WEBHOOK_SETTING),
      settings.get<boolean>(MODMAIL_NOTIFICATIONS_SETTING),
      settings.get<string[]>(MINIMUM_INCIDENT_SEVERITY_SETTING),
    ]);

  return {
    discordWebhookUrl: discordWebhookUrl?.trim(),
    slackWebhookUrl: slackWebhookUrl?.trim(),
    modmailEnabled: modmailEnabled === true,
    minimumIncidentSeverity: normalizeMinimumIncidentSeverity(
      minimumIncidentSeverity,
    ),
  };
}

function createModmailNotificationSender(): (
  notification: ModmailNotification,
) => Promise<void> {
  let subredditPromise: ReturnType<typeof reddit.getCurrentSubreddit> | undefined;

  return async ({ subject, bodyMarkdown }) => {
    subredditPromise ??= reddit.getCurrentSubreddit();
    const subreddit = await subredditPromise;
    await reddit.modMail.createModNotification({
      subject,
      bodyMarkdown,
      subredditId: subreddit.id,
    });
  };
}

function manualCheckMessage(result: StatusCheckResult): string {
  const reportableCount = result.reportableIncidents.length;
  const newCount = result.newReportableIncidents.length;
  const ongoingCount = result.ongoingReportableIncidents.length;
  const resolvedCount = result.resolvedIncidents.length;
  const ignoredCount = result.ignoredIncidents;
  const severity = titleCase(result.minimumIncidentSeverity);
  const messages: string[] = [];

  if (reportableCount === 0) {
    const ignoredText =
      ignoredCount === 0
        ? ''
        : ` (${ignoredCount} incident record${
            ignoredCount === 1 ? '' : 's'
          } below the minimum ignored)`;
    messages.push(
      `All clear: no Reddit incidents meeting the ${severity} minimum${ignoredText}.`,
    );
  } else if (
    newCount === 0 &&
    result.channelNotifications.discord.active === 'not-needed' &&
    result.channelNotifications.slack.active === 'not-needed' &&
    result.channelNotifications.modmail.active === 'not-needed'
  ) {
    messages.push(
      `Found ${ongoingCount} ongoing incident${
        ongoingCount === 1 ? '' : 's'
      } meeting the ${severity} minimum; no new notification was needed.`,
    );
  } else {
    messages.push(
      activeNotificationMessage(
        newCount || ongoingCount,
        newCount > 0 ? 'new' : 'ongoing',
        result.channelNotifications,
      ),
    );
  }

  if (resolvedCount > 0) {
    messages.push(
      resolvedNotificationMessage(
        resolvedCount,
        result.channelNotifications,
      ),
    );
  }

  return messages.join(' ');
}

function notificationTestMessage(result: NotificationTestResult): string {
  const sent = testChannelNamesForResult(result, 'sent');
  const failed = testChannelNamesForResult(result, 'failed');
  const invalid = testChannelNamesForResult(result, 'invalid');
  const included = result.incidents.length;
  const total = included + result.excludedIncidents;
  const severity = titleCase(result.minimumIncidentSeverity);
  const delivery: string[] = [];

  if (sent) {
    delivery.push(`sent to ${sent}`);
  }
  if (failed) {
    delivery.push(`${failed} delivery failed`);
  }
  if (invalid) {
    delivery.push(`${invalid} webhook configuration is invalid`);
  }
  if (delivery.length === 0) {
    delivery.push(
      'not sent because no Discord or Slack webhook is configured and Modmail notifications are disabled',
    );
  }

  const excluded =
    result.excludedIncidents === 0
      ? ''
      : `; ${result.excludedIncidents} lower-severity mock incident${
          result.excludedIncidents === 1 ? ' was' : 's were'
        } excluded`;

  return `Test notification ${delivery.join(
    '; ',
  )}. Included ${included} of ${total} mock incidents at the ${severity} minimum${excluded}.`;
}

function scheduledCheckMessage(result: StatusCheckResult): string {
  return [
    'Reddit status check complete:',
    `${result.newReportableIncidents.length} new reportable,`,
    `${result.ongoingReportableIncidents.length} ongoing reportable,`,
    `minimum severity=${result.minimumIncidentSeverity},`,
    `${result.ignoredIncidents} below minimum,`,
    `${result.resolvedIncidents.length} resolved;`,
    `Discord active=${result.channelNotifications.discord.active},`,
    `resolved=${result.channelNotifications.discord.resolved};`,
    `Slack active=${result.channelNotifications.slack.active},`,
    `resolved=${result.channelNotifications.slack.resolved};`,
    `Modmail active=${result.channelNotifications.modmail.active},`,
    `resolved=${result.channelNotifications.modmail.resolved}.`,
  ].join(' ');
}

function activeNotificationMessage(
  incidentCount: number,
  lifecycle: 'new' | 'ongoing',
  notifications: StatusCheckResult['channelNotifications'],
): string {
  const incidentText = `${incidentCount} ${lifecycle} incident${
    incidentCount === 1 ? '' : 's'
  }`;

  return `Found ${incidentText}; ${notificationSummary(
    'active',
    notifications,
  )}.`;
}

function resolvedNotificationMessage(
  incidentCount: number,
  notifications: StatusCheckResult['channelNotifications'],
): string {
  const incidentText = `${incidentCount} incident${
    incidentCount === 1 ? '' : 's'
  } resolved`;

  return `${incidentText}; ${notificationSummary(
    'resolved',
    notifications,
  )}.`;
}

function notificationSummary(
  kind: 'active' | 'resolved',
  notifications: StatusCheckResult['channelNotifications'],
): string {
  const sent = channelNamesForResult(kind, notifications, 'sent');
  const failed = channelNamesForResult(kind, notifications, 'failed');
  const invalid = channelNamesForResult(kind, notifications, 'invalid');
  const parts: string[] = [];

  if (sent) {
    parts.push(`${sent} ${kind === 'active' ? 'alert' : 'resolution alert'}${
      sent.includes(' and ') ? 's were' : ' was'
    } sent`);
  }
  if (failed) {
    parts.push(`${failed} delivery failed and will be retried`);
  }
  if (invalid) {
    parts.push(
      `the configured ${invalid} webhook URL${
        invalid.includes(' and ') ? 's are' : ' is'
      } invalid`,
    );
  }

  if (parts.length > 0) {
    return parts.join('; ');
  }

  const allNotConfigured =
    notifications.discord[kind] === 'not-configured' &&
    notifications.slack[kind] === 'not-configured' &&
    notifications.modmail[kind] === 'not-configured';
  if (allNotConfigured) {
    return 'configure a Discord or Slack webhook, or enable Modmail notifications to receive alerts';
  }

  return 'no notification was needed';
}

function channelNamesForResult(
  kind: 'active' | 'resolved',
  notifications: StatusCheckResult['channelNotifications'],
  result: StatusCheckResult['notifications']['active'],
): string {
  const channels = [
    notifications.discord[kind] === result ? 'Discord' : undefined,
    notifications.slack[kind] === result ? 'Slack' : undefined,
    notifications.modmail[kind] === result ? 'Modmail' : undefined,
  ].filter((channel): channel is string => channel !== undefined);

  if (channels.length < 3) {
    return channels.join(' and ');
  }

  return `${channels.slice(0, -1).join(', ')}, and ${channels.at(-1)}`;
}

function testChannelNamesForResult(
  testResult: NotificationTestResult,
  result: StatusCheckResult['notifications']['active'],
): string {
  const channels = [
    testResult.channelNotifications.discord === result ? 'Discord' : undefined,
    testResult.channelNotifications.slack === result ? 'Slack' : undefined,
    testResult.channelNotifications.modmail === result ? 'Modmail' : undefined,
  ].filter((channel): channel is string => channel !== undefined);

  if (channels.length < 3) {
    return channels.join(' and ');
  }

  return `${channels.slice(0, -1).join(', ')}, and ${channels.at(-1)}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'Unknown error';
}

function titleCase(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1).toLowerCase()}`;
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const decoder = new TextDecoder();
  let body = '';

  for await (const chunk of request) {
    body += decoder.decode(
      typeof chunk === 'string' ? Buffer.from(chunk) : chunk,
      { stream: true },
    );
  }
  body += decoder.decode();

  if (!body) {
    throw new Error('Request body is required');
  }

  return JSON.parse(body) as T;
}

function writeJson(
  response: ServerResponse,
  status: number,
  payload:
    | UiResponse
    | TaskResponse
    | SettingsValidationResponse
    | ErrorResponse,
): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json',
  });
  response.end(body);
}
