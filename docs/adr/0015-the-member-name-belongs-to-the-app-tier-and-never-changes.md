# The member name belongs to the application tier and never changes

A member name is chosen at registration and kept for the life of the record. It belongs to the application tier, not the identity layer: the name registry (`app-tier/member-names.ts`) maps names to record ids, and nothing in the identity layer stores or reads a name (`apps/demo/test/invariants.test.ts` checks that no member name reaches it). The built-in rules (`member-name-rules.ts`) allow Latin letters, digits, and a hyphen or underscore between them.

**Why the app tier.** The identity layer answers only which principal is presenting, and policy belongs to the application: an identity store that holds policy acquires opinions about an application it cannot observe ([passkey identity gist](https://gist.github.com/ChristopherA/dfb0f82a1223a95fa199837142e0f989), BP-2). Which names are allowed and how they are shown are that kind of policy. The name is shown to others by design, which is why an operator may list names without a log entry (ADR 0010).

**Why it never changes.** The name is copied to places the library cannot reach. Each passkey's entry in a password manager shows the name beside its label; the recovery codes a person prints or saves carry it in their header; other members have seen it. The library cannot update any of these: `signalCurrentUserDetails` is unavailable because no user handle is stored (ADR 0009). A rename would leave every copy stale. Recovery also finds the record by name, so a renamed member would have to recover with a name their saved codes do not show.

**Why recovery takes a name.** Recovery takes a member name and a code. The name picks one record, and the code is checked only against that record's codes. So each guess can reach only one member, the record's own throttle allows five attempts an hour from each source, and the library needs no index of every record's code hashes. A code-alone design would test each guess against every member at once.

**Why Latin letters only.** Letters from other scripts can look identical to Latin ones, so two different names could look the same to people. Other scripts can be allowed later, behind a confusables check. Names that differ only in case or accents are already one name.

## Considered Options

- **Renaming, with or without a step-up.** Rejected for now: every copy listed above would go stale with no way to update it. Public #14 asks for it; a stepped-up rename can be designed after 0.1.0.
- **Name rules the application supplies.** Rejected for now: the library ships one set of built-in rules, and no other reason was recorded. Public #14 asks for them; they are to be designed after 0.1.0, together with renaming.
- **Recovery by code alone.** Rejected: guesses would no longer be bounded per member, and every code would need a global index.
- **All Unicode letters.** Rejected for now: not without a confusables check, for the lookalike reason above.

## Consequences

- An application that needs a changeable display name keeps it in its own data, beside the member name.
- The registry keeps each name's history (`name_history`). Attributions refer to record ids, not names, so when an operator lets a retired name be registered again, past attributions still resolve to the record that held it.
- Changing this rule means reconciling the copies above and recovery, not only the registry.
