---
id: NNN
slug: <NNN-kebab-name>
title: <feature>
# draft → approved and frozen together at the spec gate → superseded if a rewrite replaces it.
status: draft
created: YYYY-MM-DD
# The spec gate. What it certifies is that the criteria were agreed *before* anyone read the
# implementation — which is why the interview and the request come first, and the explorers
# open the code only after the criteria to fill in the plan below.
approved: ""
# The same gate: keel sets both dates when the spec is approved. From here the spec folder is
# refused in red, green and gate, and a change is a dated amendment.
frozen: ""
# Set only when another spec replaces this one, so an archived spec says what happened to it.
superseded_by: ""
contract: <contracts/openapi.yaml#operationId, or "no contract impact">
---

# <Title: what is built, in one line>

<!-- keel's spec template (keel v1's spec, with the evidence a spike or an investigation brings).
     keel's spec check refuses a spec without: Goal, User stories, Findings (evidence),
     Acceptance criteria, Test layers (every criterion), Validation and security rules, Edge
     cases, Risks and cost, Definition of done, and Unverified and open questions when the
     spec relies on outside facts. Cut another section only when it has nothing to say.
     Keep lines under 80 columns. -->

## Request

<the person's words, copied (at most 5 lines), and where the work came from: a spike, a fix,
a change flow>

## Goal

<why this exists and what changes for whom, in two or three sentences. Not the
how: the outcome someone outside the code would notice>

## User stories

<!-- One per distinct actor. Same role on every line usually means there is one
story, and a story with no "so that" is a task with a role bolted on. -->

- As a <role>, I want <capability>, so that <benefit>.

## Decisions

<!-- Each interview answer as a sentence, with the question it answers:
     "Unknown ETA (asked): the field stays absent, never null." -->

## Findings (evidence)

<!-- What is true today, each claim with its file:line or URL. Trace every path
     the change touches: inbound (the endpoint, webhook or job that receives it), internal
     messages (queue, event, their contract: e.g. a schema with additionalProperties: false,
     and the old messages already queued when the change deploys), persistence (table,
     column, migration), outbound (what is sent on, to whom, when). Name the tests that exist
     today for this path, or say there are none. A gap that is a product choice ("an ETA-only
     update triggers no outbound webhook") is a decision to make, not a fact: put it under
     Decisions or Unverified and open questions. -->

- <claim> — `<path>:<line>` / <URL>

## Acceptance criteria

<!-- Numbered, layer-tagged, testable from outside: Given / when / then, the then
     observable (a status, a stored value, a message sent, text on screen). Cover: the value
     absent, valid, malformed, a later update, an old message still queued, the docs. -->

- **AC-001** [API] Given <state>, when <action>, then <observable result>.
- **AC-002** [WEB] Given <state>, when <action>, then <observable result>.

## Test layers

<!-- Every criterion: the layers that prove it, the lowest first: unit, functional,
     integration, smoke, e2e. Say why a layer is not used ("e2e: no browser path; the
     integration test covers the queue"). -->

- AC-001: unit (<what>), integration (<what>); e2e: not needed, <why>
- AC-002: …

## UI mockup

<Only with a [WEB] criterion. Four states, 80 columns, box-drawing: default, empty, loading,
error. Draw them before the criteria list is final: a state you draw is how you find the
criterion you would otherwise miss.>

```
Default
┌─ <screen> ──────────────────────────────────────────┐
│  [ <input>                      ]  ( <action> )     │
│  <content>                                          │
└─────────────────────────────────────────────────────┘

Empty     <what the user sees instead of content, and what invites them to act>
Loading   <what is on screen while the request is in flight>
Error     <what failed, what it says, where it says it, and what survives>
```

## Request path

<Only with an [API] criterion. Each hop marked + new or ~ changed; both the success and the
failure response.>

```
<METHOD> <path>                                        + endpoint
  → <Controller>.<method>                              +
    → <use case or service>                            + <the rule>
      → <repository>.<method>                          ~
        → <table>                                      ~ migration V<n>
  ← <success status> { <fields> }                       +
  ← <failure status> { <shape> }                        +
```

## Data and migrations

<tables and columns, the migration and its strategy (rows today, locks, backfill), how it
rolls back; message and contract changes (schemas, versions); or "none">

## Validation and security rules

<what is refused and how (status, message), who may read and change what, what
never reaches a response or a log>

## Edge cases

<the value absent, empty, malformed, duplicated, at its limit; a later update; an
old message or client still in flight; two callers at once>

## Risks and cost

<files and modules touched; a migration or not; the rolling deploy order between
producer and consumer (which goes first, what the old one does with the new message); what
is ambiguous and who decides it; the effort>

## Assumptions

<what you decided yourself, one choice each with its reason, so the reviewer can object>

## Unverified and open questions

<!-- Required when the spec relies on facts from outside this repository (a vendor API, a
     webhook payload, a library's behaviour): each fact no source confirmed, and what must
     be confirmed, by whom. Open questions the person still has to answer. -->

- Unverified: <fact> — confirm <how / with whom>.

## Out of scope

<!-- One line each. Where an exclusion has a known cost in the code — a pattern that will be
     duplicated, a branch that will be unreachable, a check that cannot be tested — write the
     cost next to it. -->

## Definition of done

This feature is done only when all of it holds:

- [ ] Every criterion is green on the layers named under Test layers.
- [ ] Each criterion's test failed before its code (keel refused anything else).
- [ ] The contract and the docs match the new behaviour, or this spec says nothing changes.
- [ ] Validation, authorization and ownership rules here are tested.
- [ ] No sensitive data in a response or a log; error responses are intentional.
- [ ] The migration and the rollout order ran as written, and the rollback is stated.
- [ ] The review passed, and no behaviour outside this spec was added.
- [ ] Every non-obvious decision has an ADR; every dependency added was a criterion here.

## Plan

<!-- Appended by the plan step, after the criteria are settled and the explorers read the
     code: the AC order (dependencies first), the files per AC, the test layer per AC, the
     contract delta (or "none"), and "- AC-n depends on: AC-x" lines. -->

---

<!-- Amendments go below, appended and dated, once `frozen` is set at the spec gate. Never
     edit above this line: a criterion rewritten in place leaves a document that reads as
     though it always said that. -->

## Amendments
