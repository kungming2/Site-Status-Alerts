# Privacy Policy

Reddit Site Status does not collect or persist Reddit user content, usernames,
or activity.

The app reads Reddit's public site-status incident feed. When a non-minor
incident is active, the app can send its public details to a configured Discord
webhook, the installed subreddit's native Modmail, or both. Discord's handling
of webhook messages is governed by the
[Discord Privacy Policy](https://discord.com/privacy). Native Modmail
notifications remain within Reddit.

After sending an active-incident alert, the app stores that incident's public
status details and successful notification channels in the subreddit
installation's Devvit Redis storage. This prevents duplicate hourly alerts and
allows the app to send resolution notifications without resending a channel
that already succeeded. The stored incident record is deleted after the enabled
resolution notifications are complete.

The Discord webhook URL is stored by Reddit as a subreddit installation
setting. Moderators who can manage the app's installation settings may view or
replace it. The app does not include the webhook URL in logs or outgoing message
content. The Modmail on/off option is also stored as a subreddit installation
setting.

Other app and installation data is handled under the
[Reddit Privacy Policy](https://www.reddit.com/policies/privacy-policy).

See the [Terms of Service](TERMS.md).
