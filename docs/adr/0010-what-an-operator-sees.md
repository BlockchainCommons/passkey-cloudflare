# What an operator sees follows three tiers

What the app shows an operator falls into three tiers, and each tier decides how it may be shown and whether showing it is logged.

- **Tier 0, member names.** An operator may list every member name, with whether it is retired, and the listing writes no operator log entry. A member name is shown to others by definition (see **Member name** in `CONTEXT.md`), so showing it to an operator discloses nothing new.
- **Tier 1, a member's state and counts.** When the record was created, whether it is suspended or removed, how many passkeys, live sessions and unused recovery codes it has, and whether a rebind link is outstanding. An operator sees these one member at a time, by looking that member up, and each lookup writes an entry against that member's record before it answers.
- **Tier 2, device detail.** Passkey providers, last use and session browsers. The app never shows them to an operator.

Every item shown to an operator is a disclosure, so a lookup keeps to what an operator needs to act on a member. This is why the per-member lookup shows state and counts but not devices, and why every lookup is logged. A member's counts say how exposed and how active they are: one passkey and no recovery codes left is the easiest target for a rebind, and a live session count says they are signed in now. That is why tier 1 is seen one member at a time and logged against that member: the member's own history then shows each time someone looked.

The tiers apply to data an application adds as well as to member data. An application places its own data on one of the tiers, and a view that shows tier-1 data for many items at once is ruled out for application data too.

Reading the operator log is a second read that is declared and not logged, separate from tier 0. The log is the operators' own record, not member data, and logging each view of it would add an entry every time it was opened. Reading it still requires the operator role and a step-up, as every operator route does.

None of this is a privacy guarantee against an operator. An operator runs the deployment and can read its storage directly. The tiers limit what the app puts in front of an operator day to day, and make what it does show accountable.

## Considered Options

- **Log the name list too.** Rejected: member names are not private, so a log entry for showing them would record a disclosure that did not happen, and every listing would add an entry the operator log's readers must skip.
- **A table of every member's state and counts, with one log entry per listing.** Rejected: the listing would be missing from each member's own history, so a member's history would no longer show every time their state and counts were seen. One entry per member per listing would keep the history, at a log write for every member on every listing.

## Consequences

- An operator view that shows state or counts for many members at once, or any device detail, is ruled out. A new operator view says which tier its data is on before it is built.
- The member list holds names only, and an operator finds a member's state and counts by looking that member up from it.
- `memberNames()` reads the whole name registry in one call, with no paging. A listing makes no call to any member's identity record, so it does not grow by one Durable Object call per member.
