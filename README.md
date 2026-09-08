# Site Status Alerts

**Site Status Alerts** (SSA) is a Devvit app that alerts moderators about Reddit's
sitewide incidents listed on their [service status page](https://www.redditstatus.com/).
Unsure if Reddit is actually down or if *your* internet is just acting a bit
weird? SSA can send you notifications on [Discord](https://discord.com/),
[Slack](https://slack.com/), or [modmail](https://support.reddithelp.com/hc/en-us/articles/210896606-What-s-mod-mail-and-how-do-I-send-a-message).

## How it works

Every 30 minutes, this app checks Reddit's public [Atlassian Statuspage API](https://www.redditstatus.com/#) for unresolved
incidents. Active incidents whose severity meets the subreddit's configured
minimum can be sent to Discord, Slack, the subreddit's native Modmail, or any
combination of the three.
When an incident is resolved, the app sends an alert letting folks know it's resolved through
the enabled channels and removes any stored records.

### Added Menu Items

The app also adds a moderator-only **[SSA] Check Reddit site status** item to the
subreddit menu for moderators to manually check the site's status.
A manual check shows the result in a brief on-screen message and runs
the otherwise automated 30-minute check.

Moderators can also use **[SSA] Send test outage alerts** from the same menu to send
clearly marked minor, major, and critical mock incidents through the configured
notification channels. Your configured minimum severity still applies. Test
alerts have a bold test-only notice and do not create incident records or later
send resolution alerts.

## Configuration

After installing the app, open its subreddit settings at `https://developers.reddit.com/r/SUBREDDIT/apps/site-status-alerts`:

- Under **Incident filtering**, choose a **Minimum incident severity**:
  🟡 **Minor or higher**, 🟠 **Major or higher**, or 🔴 **Critical only**.
  The default is **Major or higher**.
- Under **Discord notifications**, enter a **Discord webhook URL**. (optional)
- Under **Slack notifications**, enter a **Slack incoming webhook URL**. (optional)
- Under **Modmail notifications**, turn on **Enable Modmail notifications** (optional).

Please note that the app has no way of notifying moderators if Modmail
notifications are turned off *and* neither webhook is configured.

Discord and Slack messages will automatically convert the incident timestamps
to your locale and time zone. Modmail alerts will keep the UTC timestamp visible and link it to
[Timeanddate](https://www.timeanddate.com/)'s local-time conversion page.

## Data Storage

Each subreddit installation stores only the public details of incidents for
which it successfully sent an active alert, together with which enabled
notification channels have succeeded. Incident records are stored in
installation-scoped Devvit [Redis](https://developers.reddit.com/docs/capabilities/server/redis), refreshed while the incident remains active,
and deleted after the enabled resolution notifications are complete.

Please see the [terms and privacy document](docs/terms_and_privacy.md) for more details.

## Fetch Domains

The app has access to these three domains:

- `redditstatus.com` — fetches Reddit's unresolved incident feed.
- `discord.com` — posts incident and resolution alerts when a [webhook](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks) is
  configured. Discord is on the Devvit [global fetch allowlist](https://developers.reddit.com/docs/capabilities/http-fetch#global-fetch-allowlist).
- `hooks.slack.com` — posts incident and resolution alerts when a [Slack incoming
  webhook](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/) is configured. Slack is on the Devvit [global fetch allowlist](https://developers.reddit.com/docs/capabilities/http-fetch#global-fetch-allowlist).

## Version History

* **1.0.1**: Documentation improvements and an update to Devvit 0.14.3.
* **1.0.0**: Initial release with bug/incident hardening.

See the [full version history](docs/version_history.md) for previous and alpha/beta releases.

## Documentation

- [Setup and troubleshooting](docs/setup.md): Explains how to configure notification channels,
  test delivery, and understand alert behavior.
- [Version history](docs/version_history.md): A history of current and previous releases.
- [Terms and privacy](docs/terms_and_privacy.md): Explains the app's terms of use, what it stores, and where alerts go.


## License

This project is licensed under the [MIT License](https://opensource.org/license/mit).
See [LICENSE](LICENSE) for the project's license text. Source code
is available on [GitHub](https://github.com/kungming2/Site-Status-Alerts).
