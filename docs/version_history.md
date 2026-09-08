# Version history

[Back to the README](../README.md)

## 1.0.1

- Documentation improvements only, including clearer setup guidance and streamlined
release notes. No changes to app behavior.

## 1.0.0

Initial stable release.

- Reject malformed incident feeds without sending false resolution alerts or
  deleting stored incident records.
- Prevent overlapping manual and scheduled checks from duplicating alerts or
  overwriting delivery records with an installation-wide lock, automatic expiry,
  and ownership-checked release.
- Request Discord delivery confirmation before recording successful alerts.
- Preserve successful channel deliveries through temporary Redis write failures
  and retry tracking writes without repeating the notifications.
- Clear stale resolution timestamps and delivery markers when an incident
  reappears, so its eventual resolution reaches every eligible channel.
- Send channel notifications concurrently with serialized tracking writes and a
  shared delivery time budget; retry failed or deferred alerts on later checks.
- Fix the README's installation settings URL formatting.
- Refresh the README and setup guidance, including notification timeouts and retry
  behavior, and consolidate terms and privacy information in one document.

## 0.9.0 Beta

- Add setup and troubleshooting documentation for moderator configuration,
  manual checks, test alerts, and notification behavior.
- Move the full version history from the README into `docs/` and link the
  documentation from the README.

## 0.5.x Alpha

- Relicense the project under the MIT License.
- Display Discord incident, resolution, and test notifications as compact rich
  embeds with severity-based colors and structured details.
- Add moderator test outage alerts with severity filtering and clearly marked
  Discord, Slack, and Modmail messages.
- Add Slack incoming webhook alerts with independent delivery and retry
  tracking for active and resolved incidents.

## 0.3.x

- Fix status checks reading the configured minimum incident severity and
  prevent saving it without a selection.
- Add the app profile icon and align Devvit project dependencies.
- Include approximate incident durations in resolution alerts.
- Implement severity filtering in settings.
