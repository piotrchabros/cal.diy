"use client";

import type { AdHocMeetingUrlRejection } from "@calcom/features/notetaker/lib/adHocMeeting";
import { cleanMeetingLinkInput, parseAdHocMeetingUrl } from "@calcom/features/notetaker/lib/adHocMeeting";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { Button } from "@calcom/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
} from "@calcom/ui/components/dialog";
import { Input } from "@calcom/ui/components/form";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { getAdHocLinkCopyKeys, getAdHocLinkCopyVariant, useNotetakerAdHoc } from "../hooks/useNotetakerAdHoc";
import { useNotetakerFeatureEnabled } from "../lib/NotetakerFeatureContext";

const TITLE_MAX_LENGTH = 200;
const DURATION_CHOICES_MINUTES = [15, 30, 45, 60, 90, 120, 180, 240];
const ONLY_ME = "";

const SELECT_CLASS_NAME =
  "mt-1 block w-full rounded-md border border-default bg-default px-3 py-2 text-emphasis text-sm";

export function NotetakerAddToMeetingDialog(): JSX.Element | null {
  const { t } = useLocale();
  const enabled = useNotetakerFeatureEnabled();
  const [open, setOpen] = useState(false);

  if (!enabled) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button color="secondary" size="sm" data-testid="notetaker-add-to-meeting">
          {t("notetaker_add_to_meeting")}
        </Button>
      </DialogTrigger>
      <DialogContent enableOverflow>
        <AddToMeetingForm onClose={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function AddToMeetingForm({ onClose }: { onClose: () => void }): JSX.Element {
  const { t } = useLocale();
  const router = useRouter();
  const { options, dispatch, dispatchToMeeting } = useNotetakerAdHoc({ enabled: true });
  const [meetingUrl, setMeetingUrl] = useState("");
  const [title, setTitle] = useState("");
  const [durationMinutes, setDurationMinutes] = useState<number | null>(null);
  const [teamValue, setTeamValue] = useState(ONLY_ME);
  const [acknowledged, setAcknowledged] = useState(false);
  const [linkError, setLinkError] = useState<AdHocMeetingUrlRejection | null>(null);

  const data = options.data;
  const copyKeys = getAdHocLinkCopyKeys(getAdHocLinkCopyVariant(data?.enabledPlatforms));
  const linkErrorKeys: Record<AdHocMeetingUrlRejection, string> = {
    INVALID_MEETING_LINK: copyKeys.invalid,
    UNSUPPORTED_PLATFORM: copyKeys.unsupported,
    WRAPPED_MEETING_LINK: "notetaker_ad_hoc_wrapped_link",
  };
  const teamOptions = data?.teamOptions ?? [];
  const durationChoices = DURATION_CHOICES_MINUTES.filter(
    (minutes) => minutes <= (data?.maxDurationMinutes ?? 0)
  );
  const selectedDuration = durationMinutes ?? data?.defaultDurationMinutes;
  const sharingTeamId = teamValue === ONLY_ME ? null : Number(teamValue);
  const canSubmit =
    !!data && cleanMeetingLinkInput(meetingUrl) !== "" && acknowledged && !dispatchToMeeting.isPending;

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const cleanedUrl = cleanMeetingLinkInput(meetingUrl);
    // Gives instant feedback only: the server re-validates and stays authoritative.
    const link = parseAdHocMeetingUrl(cleanedUrl, data?.enabledPlatforms ?? []);
    if (!link.ok) {
      setLinkError(link.reason);
      return;
    }
    const trimmedTitle = title.trim();
    const bookingUid = await dispatch({
      meetingUrl: cleanedUrl,
      title: trimmedTitle === "" ? undefined : trimmedTitle,
      durationMinutes: selectedDuration,
      sharingTeamId,
      acknowledgedNotice: true,
    });
    if (!bookingUid) return;
    onClose();
    router.push(`/booking/${bookingUid}/notetaker`);
  };

  return (
    <form onSubmit={onSubmit} data-testid="notetaker-add-to-meeting-form">
      <DialogHeader title={t("notetaker_add_to_meeting_title")} subtitle={t(copyKeys.description)} />
      <div className="stack-y-4">
        <div>
          <label htmlFor="notetaker-ad-hoc-link" className="block font-medium text-emphasis text-sm">
            {t(copyKeys.label)}
          </label>
          <Input
            id="notetaker-ad-hoc-link"
            type="url"
            required
            className="mt-1"
            placeholder={copyKeys.placeholder}
            value={meetingUrl}
            onChange={(event) => {
              // Pasted links can carry zero-width marks that make the url input fail native
              // validation, which silently blocks the submit before onSubmit runs.
              setMeetingUrl(cleanMeetingLinkInput(event.target.value));
              setLinkError(null);
            }}
            data-testid="notetaker-ad-hoc-link"
          />
          {linkError ? (
            <p className="mt-1 text-error text-sm" data-testid="notetaker-ad-hoc-link-error">
              {t(linkErrorKeys[linkError])}
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor="notetaker-ad-hoc-title" className="block font-medium text-emphasis text-sm">
            {t("notetaker_ad_hoc_title_label")}
          </label>
          <Input
            id="notetaker-ad-hoc-title"
            type="text"
            className="mt-1"
            maxLength={TITLE_MAX_LENGTH}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            data-testid="notetaker-ad-hoc-title"
          />
        </div>

        <div>
          <label htmlFor="notetaker-ad-hoc-duration" className="block font-medium text-emphasis text-sm">
            {t("notetaker_ad_hoc_duration_label")}
          </label>
          <select
            id="notetaker-ad-hoc-duration"
            className={SELECT_CLASS_NAME}
            value={selectedDuration === undefined ? "" : String(selectedDuration)}
            onChange={(event) => setDurationMinutes(Number(event.target.value))}
            data-testid="notetaker-ad-hoc-duration">
            {durationChoices.map((minutes) => (
              <option key={minutes} value={String(minutes)}>
                {t("notetaker_ad_hoc_duration_option", { count: minutes })}
              </option>
            ))}
          </select>
        </div>

        {teamOptions.length > 0 ? (
          <div>
            <label htmlFor="notetaker-ad-hoc-team" className="block font-medium text-emphasis text-sm">
              {t("notetaker_ad_hoc_share_with_label")}
            </label>
            <select
              id="notetaker-ad-hoc-team"
              className={SELECT_CLASS_NAME}
              value={teamValue}
              onChange={(event) => setTeamValue(event.target.value)}
              data-testid="notetaker-ad-hoc-team">
              <option value={ONLY_ME}>{t("notetaker_ad_hoc_share_only_me")}</option>
              {teamOptions.map((option) => (
                <option key={option.teamId} value={String(option.teamId)}>
                  {option.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <p className="text-sm text-subtle" data-testid="notetaker-ad-hoc-notice-preview">
          {t(
            sharingTeamId === null
              ? "notetaker_ad_hoc_notice_preview"
              : "notetaker_ad_hoc_notice_preview_shared"
          )}
        </p>

        <label
          className="flex items-start gap-2 text-emphasis text-sm"
          htmlFor="notetaker-ad-hoc-acknowledge">
          <input
            id="notetaker-ad-hoc-acknowledge"
            type="checkbox"
            className="mt-0.5"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
            data-testid="notetaker-ad-hoc-acknowledge"
          />
          <span>{t("notetaker_ad_hoc_acknowledge_notice")}</span>
        </label>

        <p className="text-sm text-subtle" data-testid="notetaker-ad-hoc-admit-hint">
          {t("notetaker_ad_hoc_admit_hint")}
        </p>
      </div>
      <DialogFooter>
        <Button type="button" color="minimal" onClick={onClose}>
          {t("cancel")}
        </Button>
        <Button
          type="submit"
          disabled={!canSubmit}
          loading={dispatchToMeeting.isPending}
          data-testid="notetaker-ad-hoc-send">
          {t("notetaker_ad_hoc_send")}
        </Button>
      </DialogFooter>
    </form>
  );
}
