# Site Status Alerts

**Site Status Alerts** (SSA) is a Devvit app that alerts moderators about Reddit's 
sitewide incidents listed on their [service status page](https://www.redditstatus.com/). 
Unsure if Reddit is actually down or if your internet is just acting a bit
weird? SSA can send you notifications on Discord, Slack, or modmail.

## Documentation

- [Setup and troubleshooting](docs/setup.md): configure notification channels,
  test delivery, and understand alert behavior.
- [Version history](docs/version_history.md): current and previous releases.

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
- Under **Slack notifications**, enter a **Slack incoming webhook URL**. (optional)
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
- `discord.com` — posts incident and resolution alerts when a [webhook](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks) is
  configured. Discord is on the Devvit [global fetch allowlist](https://developers.reddit.com/docs/capabilities/http-fetch#global-fetch-allowlist).
- `slack.com` — posts incident and resolution alerts when a [Slack incoming
  webhook](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/) is configured. Slack is on the Devvit [global fetch allowlist](https://developers.reddit.com/docs/capabilities/http-fetch#global-fetch-allowlist).

## Version History

* **0.9.0**: Add setup and troubleshooting documentation for notification
  channels, manual checks, and test alerts; move the full release history to `docs/`.

See the [full version history](docs/version_history.md) for previous releases.

## License

This project is licensed under the [MIT License](https://opensource.org/license/mit).
See [LICENSE](LICENSE) for the project's license text.
