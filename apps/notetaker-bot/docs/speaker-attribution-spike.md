# Speaker attribution spike (task T175)

## 1. Status

The spike of task T175 has NOT been run. T175 is open. Nothing on this page is a result: it is a protocol that a human is meant to follow on a real Google Meet call, and every results table below is deliberately empty. Risk 1 under "Risks to resolve early" and open question 18 in `specs/001-meeting-transcription/research.md` are both still open. SC-005 (the success criterion that, in meetings of up to 8 participants, at least 90% of passages are attributed to the correct speaker, judged on a reviewed sample) is not promised until this protocol has been run and its answers are written down.

## 2. The four questions

The spike exists to answer four questions, and then one closing question that depends on them. The terms are explained where they first appear.

1. Q1. Does the incoming WebRTC audio of a Google Meet call arrive as one audio track per participant, or as a few mixed streams that carry only the currently loudest speakers? WebRTC is the browser technology that carries the call audio; a "track" is one audio stream inside it. If there is one track per participant, naming a speaker is easy. If there are only a few mixed streams, the audio alone cannot say who is speaking.
2. Q2. Is contributing-source information available, and can a source be tied to a participant? In WebRTC, every audio stream that is mixed into a received track can be identified by a number. A CSRC (contributing source) is such a number for a participant whose audio was mixed into the stream by the sender, typically the meeting server. An SSRC (synchronization source) is the number that identifies the sender of a stream itself. The browser exposes both per receiver, optionally with an audio level and a timestamp, through `getContributingSources()` and `getSynchronizationSources()`. The question is whether those entries are present in Meet, whether they carry levels, and whether a human or the bot can learn which participant each number belongs to.
3. Q3. Can the meeting page's own "who is speaking" indicator be read from the page's DOM (the document structure of the page)? This is the active-speaker timeline: a record of when each participant's tile showed that they were speaking.
4. Q4. What does the Soniox realtime speech-to-text service return for per-token language and for diarization? Diarization means separating speakers by voice alone and labelling them "speaker 1", "speaker 2" and so on, without knowing their names.

Closing question: is SC-005 achievable, and which signals must `SpeakerAttributor` (`apps/notetaker-bot/src/speakers/SpeakerAttributor.ts`) rely on, in which order?

## 3. What is believed, and from where

Every belief below is unconfirmed. The status column says "not measured" on every row, and that is the truth: no measurement exists anywhere in this repository.

| Belief | Source | Status |
|---|---|---|
| Google Meet sends a small number of mixed "loudest speaker" audio streams, and Teams on the web is similar. | The designer's own knowledge, recorded in `research.md` risk 1. | not measured |
| The original tech-stack note assumed one audio track per participant. | The tech-stack note that the plan started from; `research.md` treats it as an unverified risk. | not measured |
| The bot's capture produces one mixed audio stream, so a speaker's name can only come from signals, never from the audio channel. | Build-plan correction C14. | not measured |
| Soniox returns per-token fields called `speaker` and `language`. | Written from memory in `src/stt/sonioxProtocol.ts`. Confirmed on 2026-10-09 with `scripts/soniox-smoke.ts` on a 16 s two-speaker English sample file (not a Meet call): both fields present, speakers separated correctly. | measured on a sample only |
| Meet's participant tiles, speaking indicators and audio elements can be found with the candidate selectors in the probe script. | Guesses from memory, written in `scripts/spike-speaker-attribution.ts`. | not measured |

## 4. `PROVISIONAL_ATTRIBUTION_RULES` are guesses

`SpeakerAttributor` is driven by six rules, exported as `PROVISIONAL_ATTRIBUTION_RULES` from `src/speakers/SpeakerAttributor.ts`. None of the six values comes from data. They were chosen so that the code could be written and exercised with fake data only, never with a real call.

| Rule | Provisional value | What it controls |
|---|---|---|
| `signalOrder` | `["CONTRIBUTING_SOURCE","UI_ACTIVE_SPEAKER"]` | Which signals are asked, in order. `CONTRIBUTING_SOURCE` means audio activity of a contributing source that has been tied to a participant; `UI_ACTIVE_SPEAKER` means the meeting page's speaking indicator. The first signal that names a speaker wins; an empty list means nobody is ever named. |
| `minOverlapRatio` | 0.6 | The share of an utterance's duration that the best candidate must cover. At least this share is required (inclusive). |
| `maxRunnerUpRatio` | 0.3 | The largest share of the utterance that the second-best candidate may cover (inclusive). A higher share makes the signal stay silent rather than guess. |
| `sourceActivityHoldMs` | 500 | How long, in milliseconds, one qualifying source-activity sample is treated as speech. |
| `minSourceLevel` | 0.05 | The lowest audio level (0 to 1) at which a source-activity sample counts at all (inclusive). |
| `retentionMs` | 120000 | How far behind the newest attributed utterance, in milliseconds, recorded signals are kept before being discarded. |

The rules silently make two assumptions that the spike should check. First, that one activity sample means roughly 500 ms of speech. Second, that samples arrive about every 250 ms, which is the sampling interval in `DEFAULT_AUDIO_CAPTURE_OPTIONS`; if the real interval is longer than the hold, there will be gaps, and if it is much shorter, the hold is longer than it needs to be.

Fixed behaviours to keep in mind when reading results, because they are not tunable:

- An exact tie for best coverage names nobody, whatever the thresholds say.
- A participant whose name has never been seen is never named, although that participant still counts as a candidate and as a runner-up.
- A source that has not been tied to a participant is ignored completely.
- A speaking interval that has started and has not been closed by a "stopped speaking" sample counts as speaking until one arrives.
- A conflict inside the first signal (two participants too close to call) does not stop the second signal from naming somebody.

## 5. Before you start

You need:

- One operator, who runs the script and fills in the tables.
- Up to 8 participants who have agreed to take part, each on a separate device, and who have been told that the call is used for a test.
- A throwaway Google Meet link created for this test only. Do not write the link, any account name or any key into this document or anywhere in the repository.
- A machine with Google Chrome installed, and permission to run the script on it.

FR-030 (the requirement that the system must not retain the meeting's audio or video) applies to this spike. Nothing is recorded: the script stores no audio, writes no file and reads no names or transcript text. Do not start a screen recording and do not start a Meet recording. All results are typed into the table in section 7 by hand.

The command below has never been run in this repository. Run it from the repository root:

```
yarn workspace @calcom/notetaker-bot tsx scripts/spike-speaker-attribution.ts <meeting-url> [--selector <css>]...
```

`<meeting-url>` must be an `https://meet.google.com/...` address. `--selector <css>` may be repeated; each one adds an extra candidate selector to the probe, named `custom1`, `custom2` and so on in the output. `--help` prints the usage. A wrong argument prints a message and the usage and exits with code 2.

Once the page is open, the script prints one line of JSON per second. Every value is a number; no name, id or text is printed. The fields are:

| Field | Meaning |
|---|---|
| `t` | Whole seconds since the script started. |
| `peerConnections` | How many WebRTC connections the page has open (not closed). |
| `audioReceivers` | How many audio receivers those connections have. A receiver is the part of a connection that takes in one incoming stream. Q1 is about how this number behaves. |
| `liveRemoteAudioTracks` | How many incoming audio tracks are in the "live" state. |
| `unmutedRemoteAudioTracks` | How many incoming audio tracks are not muted. |
| `contributing` | Figures for contributing sources (CSRC), described next. |
| `synchronization` | The same figures for synchronization sources (SSRC). |
| `selectorMatches` | For each candidate selector, how many elements on the page match it, or -1 if the selector is invalid. |

Each of `contributing` and `synchronization` has five numbers: `entries` (how many sources the browser reports across all audio receivers), `withLevel` (how many of them report an audio level), `active` (how many have a level of at least 0.05), `distinctIds` (how many different ids there are among the entries), and `maxLevel` (the highest level, rounded to two decimals, or 0 when there is none).

Instead of the numbers, a line may show `probe: "not_installed"`, meaning the page did not run the probe code, or `probe: "unavailable"`, meaning the page could not be queried at that moment. Note either one in the results.

## 6. Protocol

Follow the steps in order. Decide and write down the speaking order before the call starts, so that you know who spoke when.

1. Start the script with the throwaway link. A Chrome window opens on the Meet page.
2. By hand, in that window: dismiss any dialogs, keep the microphone and the camera off, type a name for the probe, and ask to join. One participant admits it.
3. Baseline. With only 2 people in the call (the probe and one participant), nobody speaks for 20 seconds. Note the counts in the printed lines.
4. One speaker at a time. Each participant speaks alone for 20 seconds, in the written order. For each speaker, note the number of audio receivers, live tracks and unmuted tracks; the CSRC and SSRC entries, distinct ids and maximum level; and the match count of each selector.
5. Two people speak at once for 20 seconds. Note the same figures.
6. Grow the call to 4, then 6, then 8 participants. At each size repeat step 4 with three speakers. This is the heart of Q1: do the receivers grow with the number of participants, or stay at a small fixed number?
7. One participant leaves and another joins. Note whether the ids and the counts follow.
8. DOM (Q3). Open Chrome DevTools on the participant tiles and find what changes on a tile while its owner speaks (an attribute, a class, an indicator). Re-run the script with `--selector` for each candidate. A good selector matches exactly 1 element while one person speaks and 0 in silence. Also note where the participant's name and a stable per-participant id can be read from the page.
9. Mapping (Q2). Decide whether a CSRC or SSRC id can be tied to a participant, either from data the page holds or from the tile. Write down how, or write "no".
10. Soniox (Q4). This cannot be done with the script. It needs parts of the bot that other work delivers. When `docs/smoke-test-google-meet.md` exists, run the bot in real mode on the same call, read the resulting transcript in the app, and, for the scripted turn order, note whether `language` is set on each passage and whether the unknown-speaker numbers separate the speakers. The raw token fields must be checked against Soniox's own documentation. Only `scripts/soniox-smoke.ts --trace` prints tokens, and it takes an audio file, not a call.
11. SC-005 sample. Using the scripted turn order as ground truth, count how many passages are attributed to the right speaker, over at least 100 passages in a call of 8 participants.
12. Close the window or press Ctrl+C. Confirm that no file was created.

## 7. Results

Fill this in by hand. Every cell is empty on purpose.

| Item | Value |
|---|---|
| Date | |
| Operator | |
| Chrome version (see `chrome://version`) | |

| Item | 2 participants | 4 participants | 6 participants | 8 participants |
|---|---|---|---|---|
| Audio receivers | | | | |
| Live remote audio tracks | | | | |
| Unmuted while one speaks | | | | |
| CSRC entries | | | | |
| CSRC distinct ids | | | | |
| CSRC levels present (y/n) | | | | |
| CSRC max level | | | | |
| SSRC entries | | | | |
| SSRC distinct ids | | | | |
| SSRC levels present (y/n) | | | | |
| SSRC max level | | | | |

| Item | Value |
|---|---|
| Id-to-participant mapping possible (how) | |
| Selector that tracks the speaker | |
| Where the name and the stable id come from | |
| Behaviour with two speakers | |
| Behaviour on leave and join | |
| Soniox language per token | |
| Soniox speaker labels stable | |
| Reviewed sample correct / total (%) | |

Answers

- Q1:
- Q2:
- Q3:
- Q4:

## 8. Decision table

Read the row that matches your results and apply it. A row that says SC-005 is "only if the reviewed sample is at least 90%" means the sample from step 11 decides, not the signals alone.

| Result | `signalOrder` | Thresholds | SC-005 |
|---|---|---|---|
| CSRC or SSRC entries carry levels and map to participants; DOM speaker readable | `["CONTRIBUTING_SOURCE","UI_ACTIVE_SPEAKER"]` (unchanged) | set `minSourceLevel` just above the silence level seen, and `sourceActivityHoldMs` to at least the sampling interval | only if the reviewed sample is at least 90% |
| Sources map to participants; DOM not readable | `["CONTRIBUTING_SOURCE"]` | as above | only if the sample is at least 90% |
| Sources present but cannot be tied to a participant, or no levels; DOM readable | `["UI_ACTIVE_SPEAKER"]` | consider a lower `minOverlapRatio` if the indicator lags; keep `maxRunnerUpRatio` | only if the sample is at least 90%; expect overlapping speech to become unknown |
| Neither signal usable | `[]` | not applicable | cannot be promised: every speaker is a numbered unknown, at best separated by diarization |
| Soniox gives no stable speaker label | unchanged | not applicable | unknown speakers collapse into one number; note it under FR-009 |
| Soniox gives no per-token language | unchanged | not applicable | passages carry `language: null`; SC-005 unaffected |
| Sample below 90% with the best order | keep the best order | tune once, re-sample once | not promised; record the measured figure |

FR-009 is the requirement that each transcript passage is attributed to a named participant where identifiable and to a distinct "unknown speaker" label otherwise.

## 9. After the spike

When the protocol has actually been run, the human who ran it does the following:

1. Write the findings into `specs/001-meeting-transcription/research.md`, under risk 1 and open question 18.
2. Change `PROVISIONAL_ATTRIBUTION_RULES` to the values the decision table gives, and rename it if it is no longer provisional.
3. Fill in the row for this check in `docs/verification-status.md`.
4. Remove the "UNVERIFIED" marker from the top of `src/speakers/SpeakerAttributor.ts`.
5. Tick T175 in `specs/001-meeting-transcription/tasks.md`.
6. State, in `research.md`, whether SC-005 is promised.

## 10. Known limits of the probe

- The probe script has never been run, not even against a fake page.
- The candidate selectors are guesses from memory.
- It reports counts only, so by itself it cannot tell who a source belongs to; that is why step 9 is done by a human.
- It sees only connections that the page creates after the probe code was installed, so a connection made earlier would be missed.
- Whether Meet's Content Security Policy or its Trusted Types handling lets the injected code run at all is unknown.
- Q4 has no tool here; step 10 depends on other work.
