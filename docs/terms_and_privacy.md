# Terms and Privacy

Site Status Alerts helps moderators keep up with Reddit outages by sending
alerts to their chosen Discord, Slack, or Modmail channels.

## Using the app

The app is provided as is, with no guarantee that every outage will be detected
or every alert delivered. It relies on Reddit's public status reports and the
services used to send notifications. Please feel free to change your alert settings or
uninstall the app at any time.

## What the app stores

Data is stored separately for each subreddit installation on Reddit's Devvit
platform. This includes:

- **Alert settings:** your minimum incident severity, whether Modmail alerts
  are enabled, and any Discord or Slack webhook URLs you provide.
- **Public incident details:** incident IDs, titles, status, severity, updates,
  links, and timestamps from Reddit's status page for incidents the app has
  alerted your subreddit about.
- **Delivery records:** when an incident was first alerted or marked resolved,
  which notification channels received alerts, and temporary records that help
  prevent duplicate alerts when checks overlap.

Incident records are updated while an incident is active and removed once
resolution notifications are complete for the enabled channels. If delivery
fails, records may remain so the app can retry. Test alerts do not create stored
incident records.

## No user data

**Site Status Alerts does not collect or store user data.** It does not save
usernames, user IDs, profiles, posts, comments, or personal messages.

## Where alerts go

If you configure Discord or Slack, the app sends incident information to the
destination linked to your webhook URL. If you enable Modmail, it sends alerts
to your subreddit's moderators. The app also produces operational logs about
status checks and delivery errors.

Reddit, Discord, and Slack handle data within their own services under their
own policies. Removing an incident record from the app does not delete alerts
already sent to those services.
