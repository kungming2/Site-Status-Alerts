# Site Status Alerts

**Site Status Alerts** (SSA) is a Devvit app that alerts moderators about Reddit's 
sitewide incidents listed on their [service status page](https://www.redditstatus.com/). 
Unsure if Reddit is actually down or if your internet is just acting a bit
weird? SSA can send you notifications on Discord, Slack, or modmail.

## Implementation

Every 30 minutes, this app checks Reddit's public [Statuspage API](https://www.redditstatus.com/#) for unresolved
incidents. Active incidents whose severity meets the subreddit's configured 
minimum can be sent to Discord, Slack, the subreddit's native Modmail, or any
combination of the three.
When an incident is resolved, the app sends resolution alerts through
the enabled channels and removes any stored records.

The app also adds a moderator-only **Check Reddit site status** item to the
subreddit menu. A manual check shows the result in a Reddit toast and runs
the otherwise automated 30-minute check.

Moderators can use **Send test outage alerts** from the same menu to send
clearly marked minor, major, and critical mock incidents through the configured
notification channels. The configured minimum severity still applies. Test
alerts have a bold test-only notice and do not create incident records or later
send resolution alerts.

## Configuration

After installing the app, open its subreddit settings:

- Under **Incident filtering**, choose a **Minimum incident severity**:
  🟡 **Minor or higher**, 🟠 **Major or higher**, or 🔴 **Critical only**. 
  The default is **Major or higher**.
- Under **Discord notifications**, enter a **Discord webhook URL**. (optional)
- Under **Slack notifications**, enter a **Slack incoming webhook URL**.
  Follow [Slack's incoming webhook guide](https://api.slack.com/messaging/webhooks)
  to create one for the desired channel. Treat this URL as a secret. (optional)
- Under **Modmail notifications**, turn on **Enable Modmail notifications**.

Please note that the app has no way of notifying moderators if modmail 
notifications are turned off *and* neither webhook is configured.

Discord and Slack render incident timestamps in each viewer's locale and time
zone. Modmail keeps the UTC timestamp visible and links it to
[Timeanddate](https://www.timeanddate.com/)'s local-time conversion page.

## Data Storage

Each subreddit installation stores only the public details of incidents for
which it successfully sent an active alert, together with which enabled
notification channels have succeeded. Incident records are stored in
installation-scoped Devvit [Redis](https://developers.reddit.com/docs/capabilities/server/redis), refreshed while the incident remains active,
and deleted after the enabled resolution notifications are complete.

## Fetch Domains

The app requests access to these three domains:

- `redditstatus.com` — fetches Reddit's unresolved incident feed.
- `discord.com` — posts incident and resolution alerts when a webhook is
  configured. Discord is on the Devvit [global fetch allowlist](https://developers.reddit.com/docs/capabilities/http-fetch#global-fetch-allowlist).
- `slack.com` — posts incident and resolution alerts when a Slack incoming
  webhook is configured. Slack is on the Devvit [global fetch allowlist](https://developers.reddit.com/docs/capabilities/http-fetch#global-fetch-allowlist).

## Version History

* **0.5.2**: Display Discord incident, resolution, and test notifications as
  compact rich embeds with severity-based colors and structured details.
* **0.5.1**: Add moderator test outage alerts with severity filtering and
  clearly marked Discord, Slack, and Modmail messages.
* **0.5.0**: Add Slack incoming webhook alerts with independent delivery and
  retry tracking for active and resolved incidents.
* **0.3.4**: Fix status checks reading the configured minimum incident severity
  and prevent saving it without a selection.
* **0.3.3**: Add the app profile icon and align Devvit project dependencies.
* **0.3.2**: Include approximate incident durations in resolution alerts.
* **0.3.0**: Implement severity filtering in settings.
