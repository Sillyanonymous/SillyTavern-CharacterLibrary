# BotBooru Consistency Checklist

Context: follow-up pass before merging BotBooru into the AIO branch.

## Verified Fixed

- [x] Preview avatar opens the shared full-image viewer like maintainer providers.
- [x] Preview text sections render rich text correctly instead of leaking HTML entities like `&quot;`.

## In Progress

- [x] Reduce infinite-scroll stutter by avoiding full BotBooru grid rebuilds on load-more when append-only rendering is safe.
- [x] Reduce PFP/avatar flicker during load-more by preserving already-rendered cards and avoiding unnecessary image re-observation churn.
- [x] Bring BotBooru preview close behavior closer to maintainer-provider cleanup patterns so transient preview state does not linger between opens.

## Needs Verification / Follow-up

- [x] Remove the misleading clickable creator affordance until BotBooru exposes a verified author-scoped browse flow.
- [ ] If BotBooru later adds verified author-scoped search/browse, revisit creator filtering so it can match the maintainer-provider UX honestly instead of faking it.
