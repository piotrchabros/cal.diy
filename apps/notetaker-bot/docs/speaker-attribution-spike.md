# Speaker attribution spike (task T175)

## 1. Status

The spike of task T175 has NOT been run as written. T175 is open. Sections 1 to 10 are the original protocol; their results tables stay empty. One part of it was answered on 2026-10-10 by the two-minute speech measurement of section 11 (two speakers, one call): see there for what was measured and what was not. Risk 1 under "Risks to resolve early" and open question 18 in `specs/001-meeting-transcription/research.md` are both still open. SC-005 (the success criterion that, in meetings of up to 8 participants, at least 90% of passages are attributed to the correct speaker, judged on a reviewed sample) is not promised until this protocol has been run and its answers are written down.

## 2. The four questions

The spike exists to answer four questions, and then one closing question that depends on them. The terms are explained where they first appear.

1. Q1. Does the incoming WebRTC audio of a Google Meet call arrive as one audio track per participant, or as a few mixed streams that carry only the currently loudest speakers? WebRTC is the browser technology that carries the call audio; a "track" is one audio stream inside it. If there is one track per participant, naming a speaker is easy. If there are only a few mixed streams, the audio alone cannot say who is speaking.
2. Q2. Is contributing-source information available, and can a source be tied to a participant? In WebRTC, every audio stream that is mixed into a received track can be identified by a number. A CSRC (contributing source) is such a number for a participant whose audio was mixed into the stream by the sender, typically the meeting server. An SSRC (synchronization source) is the number that identifies the sender of a stream itself. The browser exposes both per receiver, optionally with an audio level and a timestamp, through `getContributingSources()` and `getSynchronizationSources()`. The question is whether those entries are present in Meet, whether they carry levels, and whether a human or the bot can learn which participant each number belongs to.
3. Q3. Can the meeting page's own "who is speaking" indicator be read from the page's DOM (the document structure of the page)? This is the active-speaker timeline: a record of when each participant's tile showed that they were speaking.
4. Q4. What does the Soniox realtime speech-to-text service return for per-token language and for diarization? Diarization means separating speakers by voice alone and labelling them "speaker 1", "speaker 2" and so on, without knowing their names.

Closing question: is SC-005 achievable, and which signals must `SpeakerAttributor` (`apps/notetaker-bot/src/speakers/SpeakerAttributor.ts`) rely on, in which order?

## 3. What is believed, and from where

The beliefs below were written before any measurement. The status column was updated for the rows the measurement of 2026-10-10 (section 11) answered; the other rows are still not measured.

| Belief | Source | Status |
|---|---|---|
| Google Meet sends a small number of mixed "loudest speaker" audio streams, and Teams on the web is similar. | The designer's own knowledge, recorded in `research.md` risk 1. | Meet: measured on 2026-10-10 with two remote participants: at most 4 receivers, sources are per speaker (one contributing source each) and one contributing source is audible with everybody. Teams: not measured |
| The original tech-stack note assumed one audio track per participant. | The tech-stack note that the plan started from; `research.md` treats it as an unverified risk. | not measured |
| The bot's capture produces one mixed audio stream, so a speaker's name can only come from signals, never from the audio channel. | Build-plan correction C14. | not measured |
| Soniox returns per-token fields called `speaker` and `language`. | Written from memory in `src/stt/sonioxProtocol.ts`. Confirmed on 2026-10-09 with `scripts/soniox-smoke.ts` on a 16 s two-speaker English sample file (not a Meet call): both fields present, speakers separated correctly. | measured on a sample only |
| Meet's participant tiles, speaking indicators and audio elements can be found with the candidate selectors in the probe script. | Guesses from memory, written in `scripts/spike-speaker-attribution.ts`. | superseded: the tile and the indicator class tokens were measured with `meet-probe` on 2026-10-10 (section 11); the old script was not run |

## 4. `PROVISIONAL_ATTRIBUTION_RULES` are guesses

`SpeakerAttributor` is driven by twelve rules, exported as `PROVISIONAL_ATTRIBUTION_RULES` from `src/speakers/SpeakerAttributor.ts`. None of the twelve values comes from data. The first six are the original ones. The last six were added for speaker names (specification 002); their values come from the shape of the 2026-10-10 measurement and were exercised against fakes only. They were chosen so that the code could be written and exercised with fake data only, never with a real call.

| Rule | Provisional value | What it controls |
|---|---|---|
| `signalOrder` | `["CONTRIBUTING_SOURCE","UI_ACTIVE_SPEAKER"]` | Which signals are asked, in order. `CONTRIBUTING_SOURCE` means audio activity of a contributing source that has been tied to a participant; `UI_ACTIVE_SPEAKER` means the meeting page's speaking indicator. The first signal that names a speaker wins; an empty list means nobody is ever named. |
| `minOverlapRatio` | 0.6 | The share of an utterance's duration that the best candidate must cover. At least this share is required (inclusive). |
| `maxRunnerUpRatio` | 0.3 | The largest share of the utterance that the second-best candidate may cover (inclusive). A higher share makes the signal stay silent rather than guess. |
| `sourceActivityHoldMs` | 500 | How long, in milliseconds, one qualifying source-activity sample is treated as speech. |
| `minSourceLevel` | 0.05 | The lowest audio level (0 to 1) at which a source-activity sample counts at all (inclusive). |
| `retentionMs` | 120000 | How far behind the newest attributed utterance, in milliseconds, recorded signals are kept before being discarded. |
| `minVoiceVotes` | 3 | How many passages named by a signal a diarization label needs before the voice alone may name a later passage. |
| `minVoiceAgreement` | 0.9 | The share of those passages that must point at one participant (inclusive). |
| `minLinkVotes` | 12 | How many votes a source needs for a participant, and how many votes a participant needs to count as established, before a link is learned (section 11, "How the bot links a source to a participant"). |
| `minLinkShare` | 0.8 | The share of a source's presence, normalised by each participant's talk time, that must belong to one participant. |
| `maxIndicatorAgeMs` | 1500 | The oldest tile reading, in milliseconds, that may be paired with a source-activity sample as a vote. |
| `learnableSourcePrefix` | `"csrc:"` | Only sources whose key starts with this are learned; an SSRC is a stream slot that can carry another person later. |

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

For the Google Meet observations (where the speaker's name and the speaking indicator sit on the page), run the Meet probe instead: section 12 of [smoke-test-google-meet.md](smoke-test-google-meet.md). It joins the way the bot does, with the bot's own launcher and account, and it also records the leave path, which this script does not. `scripts/spike-speaker-attribution.ts` stays in the repository; the command below remains the way to take the receiver and source counts by hand across call sizes.

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
| Sources carry levels and timestamps but the page does not tie them to tiles; the speaking indicator is readable as class tokens on the tile (the 2026-10-10 result) | `["CONTRIBUTING_SOURCE","UI_ACTIVE_SPEAKER"]`, with the source linked to a participant by learning | the six link and voice rules of section 4 | not promised: only two speakers were measured; the percentage is measured in specification 002 task T049 |

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

## 11. Two-minute speech measurement (meet-probe, research A1)

### Status

This measurement was run on 2026-10-10 (task T004 of `specs/002-speaker-names-team-sharing/tasks.md`): one call, two speakers, 120 s. The questions here are Q1, Q2 and Q3 of Decision A1 in `specs/002-speaker-names-team-sharing/research.md`. They are not the Q1 to Q4 of section 2 above, which belong to the first spike. The results are in the table at the end, followed by what the measurement disproved, how the bot uses it, how to measure again, and what was not measured. The measurement is one call with two speakers, so it supports the design but does not prove it for larger calls.

The three questions:

- Q1. Does a participant tile carry a source id (the `data-ssrc` attribute) that equals the id of a receiver audio source whose level rises above 0.05 while that tile is the only one active?
- Q2. Does some per-tile class token or attribute toggle with speech at least twice as often as in silence?
- Q3. Are the timestamps of the receiver sources within 1000 ms of the page clock?

### Who is needed

- The owner, person A.
- A second person, person B.
- The notetaker Google account, invited to the event or ready to be admitted.
- Microphones on. Cameras are optional. Nobody else speaks, and there is no music or screen share with sound.

### What to tell the participants before the call

Say this word for word:

"A diagnostic tool joins this call for two minutes. It records the structure of the Meet page and audio levels as numbers. It records no audio, no video, no screenshots, no chat and no names; participant and audio-source ids are stored only as one-way scrambled values."

### Command

Load the bot environment of section 12 of [smoke-test-google-meet.md](smoke-test-google-meet.md), then run from the repository root:

```
yarn workspace @calcom/notetaker-bot meet-probe "<meeting url>" --out /root/meet-probe-speech.json --duration 120
```

The out file must not exist yet.

### Schedule

Count from the chat notice, which is posted at admission, or from admission when `--no-notice` is used.

| Seconds | Who speaks |
|---|---|
| 0 to 10 | nobody |
| 10 to 30 | person A alone |
| 30 to 50 | person B alone |
| 50 to 60 | nobody |
| 60 to 80 | person A alone |
| 80 to 100 | person B alone |
| 100 to 120 | nobody |

Rules while speaking:

- Talk continuously, for example by reading a text aloud.
- Do not overlap.
- The other person stays unmuted but silent.
- Do not change the layout, pin a tile or resize the window.

### What comes out

The terminal prints a `Speech measurement` block after the "Speakers" block. The file holds the same verdicts under `measurements`. Each verdict is supported, excluded or inconclusive, with counts.

- Q1 supported: two different tiles were each the only active tile for at least 3 samples, and their source ids equal receiver source ids. Q1 excluded: no tile carried a source id, or the tile source ids never equalled a receiver source id. If tiles did carry a source id but the verdict is excluded, check the format of the `data-ssrc` value before taking it as final; the probe only matches a decimal number.
- Q2 supported: at least one class token or attribute toggled, or was present, with speech at least twice as often as in silence, in at least 3 samples. The report names up to 5 such indicators and says whether each was a toggle or a presence. Q2 excluded: no candidate qualified.
- Q3 supported: at least 90% of the judged source timestamps were within 1000 ms of the page clock. Q3 excluded: at most 10% were; the median age in the evidence shows the offset or scale.

An inconclusive verdict usually means too little speech (fewer than 3 samples with audible speech), only one person spoke so telling speakers apart was not tested, too few quiet samples for Q2, or a sample interval above 1000 ms, which can make Q3 read inconclusive.

### What the file holds about identity

Tiles are `tile-N`. Participant ids and audio source ids are 16-character hashes, and event source keys are `csrc:<hash>` or `ssrc:<hash>`. The salt is random for each run and is never written, so files from two runs cannot be joined and a hash cannot be turned back into an id.

### Results

| Item | Value |
|---|---|
| Date | 2026-10-10 |
| Operator | Piotr Chabros, from the deployment VPS |
| Chrome version (see `chrome://version`) | 155.0.8059.39, Linux, Xvfb 1280x720, account join mode, Meet in English |
| Run | 120 s window, 1 s page samples, 140 samples (126 with tiles), three tiles: two people and the probe's own account |
| Q1 verdict and counts | excluded: 3 of 3 tiles carried a `data-ssrc` in some sample, 0 matched a receiver source |
| Q2 verdict and counts | supported: `Oaajhc` 0.211 per speech tile-sample against 0.035 per quiet one; `BlxGDf` 0.325 against 0.154 |
| Q3 verdict and counts | supported: 114 of 114 source entries that carried speech were within 1000 ms of the page clock, median age 5 ms |
| Chosen signal order | contributing source linked by learning first, sustained tile indicator second |

Other verdicts of the same run: no element with an `aria-label` containing "speaking" existed during speech or silence (0 of 121 sweeps); sources carry levels (5 distinct sources rose above 0.05; 808 of 960 captured audio frames were non-silent); the leave click worked and the ended text appeared 211 ms after it.

The timeline was read by hand from the report file, which stays outside the repository (it holds hashes only). In this document the sources are called "source 1" and "source 2" (the contributing sources of the two speakers) and the "common source" (a contributing source that was audible with everybody).

- While person A spoke, source 1 (and one synchronization source) was active, and A's tile carried `BlxGDf` almost continuously and `Oaajhc` intermittently.
- While person B spoke, source 2 (and another synchronization source) was active, and B's tile carried the same two tokens in the same way.
- The common source was active whenever anyone spoke.
- Neither token appeared on two tiles in the same sample, and never on the probe's own tile.
- `BlxGDf` stays on the speaker's tile for a few seconds after the last sound, and was also on A's tile for parts of the first 19 s when no source level above 0.05 was sampled (a 1 s sample of an instantaneous level misses short sounds).
- `Oaajhc` is on only while sound is present and flickers within a turn.
- There were at most 4 audio receivers for 2 remote participants.

### What the measurement disproved

- The tile's `data-ssrc` is not an audio source id. `specs/002-speaker-names-team-sharing/research.md` ("What happens today" and Decision A2) assumed it was; the measurement showed otherwise, and that file is corrected separately. At the end of the run only the probe's own tile still carried a `data-ssrc`.
- No element carries an `aria-label` containing "speaking" (0 of 121 sweeps), so the old guess for the indicator is wrong.
- Audio is not one track per participant. Sources are per speaker, not per receiver.
- A contributing source can be audible with everybody (the common source). A source seen while anyone speaks identifies nobody.

### How the bot links a source to a participant

The page does not say which audio source belongs to which tile, so the bot learns it. Two class tokens on the top-level `[data-participant-id]` tile follow speech. They are kept as `GOOGLE_MEET_SPEAKING_INDICATORS` in `src/platform/GoogleMeetAdapter.ts`:

- `BlxGDf` is the sustained token. It is present almost all through a turn and trails a few seconds after it. It feeds the second signal, `UI_ACTIVE_SPEAKER`.
- `Oaajhc` is the instantaneous token. It is present only while sound is present. It feeds link learning only, because a vote cast while a trailing hold is still on would name the previous speaker.

A vote for (source, participant) is counted when the source is a contributing source (`csrc:`) with a level of at least `minSourceLevel`, a tile reading no older than `maxIndicatorAgeMs` exists, and exactly one non-self tile in it shows the instantaneous token. The link is computed from the votes whenever it is needed and is never latched, so it disappears if later votes contradict it. A source is linked to a participant when at least two participants are established, the source has at least `minLinkVotes` votes for that participant, and its normalised share for that participant is at least `minLinkShare`. The four values and why each exists:

- `minLinkVotes = 12`: at the production cadence (source activity every 250 ms, a tile poll about every 600 ms, the instantaneous token on in about 21% of speech polls) one turn of 20 s gives roughly 17 votes, so a speaker is established within about one turn. This is an estimate from the measurement, not an observation.
- `minLinkShare = 0.8`: the common source has equal presence for two speakers, so its share is 0.5 (0.33 with three); it never links. The share is normalised by each participant's talk time, because a raw vote share would link the common source to a speaker who talks much longer than the other. 0.8 tolerates about 25% cross-presence from noise.
- `maxIndicatorAgeMs = 1500`: a tile reading older than this no longer says who is speaking now.
- `learnableSourcePrefix = "csrc:"`: only contributing sources are learned. An SSRC is a stream slot that a selective forwarding server can give to another person later, and one two-speaker call cannot show otherwise.

At least two established participants are required because, while only one person has spoken, the common source and that person's own source cannot be told apart. Until then the sustained indicator names people. The bot's own tile never shows a token and has no source (its microphone is off); the tile is also marked as self by its label ("You") or by the display name typed on the guest join screen, and a participant once marked self stays self.

What was measured and what was only simulated: the tokens, the clock and the per-speaker sources were measured on the real page. The link rule, the four values and the whole attribution were run only against fakes, including a replay of the measurement's shape (`src/speakers/SpeakerAttributor.replay.test.ts`: two speakers, a common source, sparse instantaneous levels, a trailing sustained indicator). No bot run on a real call has used them.

### Measuring again when Meet changes its class names

The tokens are obfuscated Meet class names and can change with any Meet release.

1. Symptom: Meet sessions with speech end with `speakerNamesAvailable: false`, and the results page says that names were unavailable.
2. Run the protocol of this section again (schedule, command, rules while speaking).
3. Read the up to five class tokens the report names under verdict Q2.
4. Tell them apart by the timeline: a token present almost all through a turn and a few seconds after it is the sustained one; a token that flickers only while sound is present is the instantaneous one.
5. Put them into `GOOGLE_MEET_SPEAKING_INDICATORS` in `src/platform/GoogleMeetAdapter.ts`. If only one token exists, put it in both fields; link votes then include the trailing hold and are less reliable.
6. Run the adapter tests and the probe tests.
7. Run the probe once more and check that the `activeSpeakerName` sweep matches during speech. That selector is built from the sustained token and is read only by the probe; a renamed token shows there as zero matches during speech.
8. Record the date and the tokens in `verification-status.md`.

### Not measured

- More than two speakers: whether every speaker has a contributing source of their own, and whether the common source stays common.
- Overlapping speech: two tiles marked at once give no vote and usually no name; the share of unknown passages is not known.
- Whether a contributing source id is reused for another person later in a call, and whether it survives a reconnect of the bot or of a participant. A reused id would name the wrong person until the votes turn.
- A participant who renames: the participant id is assumed to stay the same.
- Two participants with one name: the numbering is tested with fakes only; that Meet gives them different `data-participant-id` values is assumed.
- The self rule: the label "You" was never read on the real page, and in account mode the account's name is unknown to the bot.
- A Polish or other non-English interface: the class tokens are expected to be language independent, the self label is not.
- The trailing hold of the sustained token when the next speaker starts at once, before links are learned: the indicator may name the previous speaker for a short passage.
- Participants without a tile (large calls show only some tiles): they can never be named.
- The real cadence of the instantaneous token at the 500 ms poll, and so the time until links are learned (estimated at about 14 s of speech per speaker).
- `readElements` in real Chrome, including the cost of one `evaluateAll` per poll and the test for a rendered name span.
- The 250 ms window of the timestamp filter in `src/audio/captureScript.ts`: the measurement judged against 1000 ms, with a median age of 5 ms.
- Microsoft Teams: unchanged behaviour, still unverified on the real page.
- The class tokens themselves can change with any Meet release; the only detection is `speakerNamesAvailable: false` and a probe run.
