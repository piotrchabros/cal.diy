# Contract: Bot events, speaker additions

Extends `specs/001-meeting-transcription/contracts/bot-events-webhook.md`. Source of truth in code: `packages/lib/notetaker/botContract.ts`. Signing, ordering and idempotency are unchanged.

## Compatibility

Both additions are optional fields on an existing event. The schemas are not strict, so an application without this feature ignores them, and an application with this feature accepts a bot that does not send them. The bot and the application can therefore be deployed in either order.

## `transcript.passages` (unchanged shape, new values)

| Field | Before | Now |
|-------|--------|-----|
| `speakerKey` | `participant:name:<display name>` or `unknown:<n>` | `participant:<hash>` or `unknown:<n>`. The hash is salted per session inside the bot and is not reversible to the platform's participant id |
| `speakerName` | display name | display name; when two participants show the same name, the second and later carry a suffix: `"<name> (2)"`, `"<name> (3)"`, in order of first appearance |
| `unknownSpeakerNumber` | number per diarization voice | unchanged |

The rule that exactly one of `speakerName` and `unknownSpeakerNumber` is set is unchanged. The notetaker's own participant never appears as a speaker.

## `session.ended` (two optional fields added to `data`)

```text
data: {
  endReason, durationMs, interruptedAtMs, passageCount,      // unchanged
  speakerNamesAvailable?: boolean,
  speakerResolutions?: Array<{
    speakerKey: string,          // a key already sent, always of the form unknown:<n>
    resolvedSpeakerKey: string,  // participant:<hash>
    speakerName: string          // the name to show, 1..200 characters, already suffixed if needed
  }>                             // at most 64 entries, each speakerKey at most once
}
```

Rules:

- `speakerNamesAvailable` is `true` when at least one participant was identified during the session, `false` when none was. Absent means the bot predates this feature.
- A resolution is sent only when the bot's voice memory meets its threshold for that voice (research A4). A voice that never met it has no entry and stays unknown.
- The bot never resolves one participant key into another, and never resolves into an unknown key.

Application behaviour on `session.ended`:

1. Validate. An entry whose `speakerKey` does not start with `unknown:` or whose `resolvedSpeakerKey` does not start with `participant:` is dropped and logged; the event is still accepted.
2. For each remaining entry, update every passage of this session's transcript that has that `speakerKey`: set `speakerKey = resolvedSpeakerKey`, `speakerName = speakerName`, `unknownSpeakerNumber = null`.
3. Store `speakerNamesAvailable` on the transcript (null when absent).
4. Continue with the existing finalize and summary steps, which now read the resolved passages.

Reprocessing the same event is harmless: after step 2 no passage has the old key.

## Join request (unchanged shape, new text)

`noticeMessage` is composed by the application as before. When the event type's sharing mode is not `HOSTS_ONLY`, the application sends the wording that says colleagues of the host may read the transcript and summary, and records `colleagueSharingDisclosed = true` on the session in the same step.

## Platform adapter interface inside the bot (internal)

- `MeetingPage` gains one read: for every element matching a selector, return the values of a fixed list of attributes and the text of the first match of an inner selector. It never returns HTML, and it reads the main frame only.
- `MeetingPageDriver` gains an optional `readParticipants(page)` returning `{ participantId, name, sourceKeys[], isSelf }[]`. `BrowserPlatformAdapter` turns the result into the existing `source_identity` and `speaker` platform events. A driver that does not implement it keeps today's behaviour.
