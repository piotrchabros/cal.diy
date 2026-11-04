"use client";

import type { NotetakerStateDto } from "@calcom/lib/dto/NotetakerStateDto";
import { useLocale } from "@calcom/lib/hooks/useLocale";
import { Button } from "@calcom/ui/components/button";
import { TextArea } from "@calcom/ui/components/form";
import { useState } from "react";
import { useNotetakerMeetingContacts } from "../hooks/useNotetakerMeetingContacts";
import { CONTACT_EMAIL_ERROR_KEYS, validateContactEmailInput } from "../lib/contactEmailInput";

export function NotetakerMeetingContactsEditor({
  bookingUid,
  state,
}: {
  bookingUid: string;
  state: NotetakerStateDto;
}): JSX.Element {
  const { t } = useLocale();
  const { setMeetingContacts } = useNotetakerMeetingContacts();
  const contacts = state.meetingContacts ?? [];
  const calendarContacts = contacts.filter((contact) => contact.source === "CALENDAR");
  const savedManualEmails = contacts.filter((contact) => contact.source === "MANUAL").map((c) => c.email);
  const [text, setText] = useState(savedManualEmails.join(", "));
  const [showError, setShowError] = useState(false);
  const { emails, error } = validateContactEmailInput(text);

  const onSave = (): void => {
    if (error) {
      setShowError(true);
      return;
    }
    setMeetingContacts.mutate({ bookingUid, emails });
  };

  return (
    <div className="mt-2 flex flex-col gap-2" data-testid="notetaker-meeting-contacts">
      <label htmlFor="notetaker-meeting-contacts-input" className="font-medium text-emphasis text-sm">
        {t("notetaker_contact_emails_label")}
      </label>
      {calendarContacts.length > 0 && (
        <div data-testid="notetaker-meeting-contacts-calendar">
          <p className="text-subtle text-xs">{t("notetaker_contact_emails_from_calendar")}</p>
          <ul className="text-default text-sm">
            {calendarContacts.map((contact) => (
              <li key={contact.email}>
                {contact.name ? `${contact.name} (${contact.email})` : contact.email}
              </li>
            ))}
          </ul>
        </div>
      )}
      <TextArea
        id="notetaker-meeting-contacts-input"
        rows={2}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setShowError(false);
        }}
        data-testid="notetaker-meeting-contacts-input"
      />
      {showError && error ? (
        <p className="text-error text-sm" data-testid="notetaker-meeting-contacts-error">
          {t(CONTACT_EMAIL_ERROR_KEYS[error])}
        </p>
      ) : null}
      <p className="text-sm text-subtle">{t("notetaker_contact_emails_hint")}</p>
      {state.transcriptWebhookSent ? (
        <p className="text-sm text-subtle" data-testid="notetaker-meeting-contacts-already-sent">
          {t("notetaker_contact_emails_already_sent")}
        </p>
      ) : null}
      <div className="flex">
        <Button
          type="button"
          size="sm"
          color="secondary"
          loading={setMeetingContacts.isPending}
          onClick={onSave}
          data-testid="notetaker-meeting-contacts-save">
          {t("save")}
        </Button>
      </div>
    </div>
  );
}
