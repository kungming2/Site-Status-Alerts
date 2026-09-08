# Setup and troubleshooting

[Back to the README](../README.md)

Site Status Alerts checks Reddit's [public incident status page](https://www.redditstatus.com/) every 30 minutes and
can notify a subreddit's moderators through Discord, Slack, Modmail, or any
combination of those channels.

Observations from a [previous outage](https://www.redditstatus.com/incidents/s4ffy6g43v5h)
suggest that Devvit will remain operational during some Reddit outages, allowing
the app to send status notifications even when Reddit's website or other services
are unavailable. 

## Configure an installation

After installing the app on your subreddit, open its subreddit settings at `https://developers.reddit.com/r/SUBREDDIT/apps/site-status-alerts`:.

1. Under **Incident filtering**, choose **Minimum incident severity**.
2. Configure at least one notification channel using the settings below.
3. Save the settings, then use **[SSA] Send test outage alerts** in the
   subreddit menu to check delivery.

| Minimum incident severity | Included severities        |
|---------------------------|----------------------------|
| Minor or higher           | Minor, major, and critical |
| Major or higher (default) | Major and critical         |
| Critical only             | Critical                   |

Generally speaking, only major incidents result in widespread site issues.

The app ignores impact values of `none` and `maintenance`. Unrecognized impact
values remain eligible so if Reddit creates a new category, 
an unexpected feed value does not silently suppress an incident.

| Settings group        | Setting                      | Default                  |
|-----------------------|------------------------------|--------------------------|
| Discord notifications | Discord webhook URL          | Empty; no Discord alerts |
| Slack notifications   | Slack incoming webhook URL   | Empty; no Slack alerts   |
| Modmail notifications | Enable Modmail notifications | Off                      |

By default, the app can't really do anything without some configuration 
as to where it should send the status alerts.

Enter the webhook URL for the destination Discord or Slack channel. Webhook
URLs can be left blank when those channels are unused. Modmail requires only
the toggle. If both webhook fields are empty and Modmail is off, the app has
no notification destination.

## Check status manually (menu item)

Choose **[SSA] Check Reddit site status** from the subreddit menu. This
moderator-only action runs the same check as the scheduled task: it can send
real incident and resolution alerts and update stored delivery records. The
Reddit toast pop-up reports the result, including delivery failures where applicable.

An all-clear result means the feed has no incidents meeting the configured
minimum. 

## Send test alerts (menu item)

Choose **[SSA] Send test outage alerts** from the same menu. This sends clearly
marked mock incidents to your configured destinations using the current
severity filter:

- **Minor or higher** includes all three mock incidents.
- **Major or higher** includes the major and critical mock incidents.
- **Critical only** includes the critical mock incident.

The toast pop-up reports which channels succeeded, failed, or have invalid settings.
Test alerts do not fetch the live incident feed, create incident records, or
produce later resolution alerts. To retry a failed test, run the menu action
again.

## What to expect from real alerts

An active incident is normally sent once per notification channel. Later
checks refresh its stored details without repeatedly announcing it. Failed
deliveries are eligible for retry on a later scheduled or manual check while
the incident remains reportable.

When a previously alerted incident disappears from the unresolved feed, the
app sends a resolution alert to each still-enabled channel that received its
active alert. Resolution delivery failures are retried on later checks. If an incident
reappears, its previous resolution state is cleared so the next resolution uses
the new observation time and can notify all eligible channels again.

Channels send concurrently. Each delivery attempt has up to 10 seconds within a
shared 20-second delivery budget for the check, leaving time for storage and
cleanup. Failed or deferred alerts remain eligible for a later check. A request
that times out can still reach its destination, particularly Modmail, whose API
does not support cancellation; retries can therefore occasionally duplicate an
alert.

Discord uses rich embeds. Discord and Slack display timestamps in the viewer's
locale and time zone; Modmail displays UTC with a local-time conversion link.
Resolution durations are approximate because the app uses the time it first
observes the incident missing from the feed.

## Troubleshooting

| Symptom                                         | What to check                                                                                                   |
|-------------------------------------------------|-----------------------------------------------------------------------------------------------------------------|
| No notifications arrive                         | Enable at least one channel, save settings, and send a test alert.                                              |
| Minor incidents are missing                     | The default minimum is major; select minor to include them.                                                     |
| Only some mock incidents appear                 | Test alerts use the same severity filter as real alerts.                                                        |
| An ongoing incident is not announced again      | A successful alert is remembered per channel; use test alerts to check delivery again.                          |
| A new destination does not receive an old alert | Tracking is by channel type, not webhook URL; replacing a Discord or Slack URL does not reset delivery history. |
| A resolution alert is missing                   | That channel must have received the active alert and still be enabled when resolution is processed.             |
| The manual check fails                          | Retry later; a failed feed request cannot establish whether an incident has resolved.                           |

Checks run every 30 minutes, so changes in Reddit's published incident feed
are not reported immediately. Incidents that begin and end between successful
checks may be missed. Reddit or Devvit disruptions can also delay checks and
Modmail delivery.
