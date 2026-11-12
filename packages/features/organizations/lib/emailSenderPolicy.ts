import { ORGANIZATION_EMAIL_SENDER_NAME_MAX_LENGTH } from "@calcom/lib/dto/OrganizationEmailSenderDto";
import { ErrorWithCode } from "@calcom/lib/errors";

// Each value must exist in packages/i18n/locales/en/common.json
export const EMAIL_SENDER_ERRORS = {
  nameInvalid: "organization_email_sender_name_invalid",
  nameTooLong: "organization_email_sender_name_too_long",
  addressInvalid: "organization_email_sender_address_invalid",
  noDomain: "organization_email_sender_no_domain",
  domainNotAllowed: "organization_email_sender_domain_not_allowed",
} as const;

const MAX_ADDRESS_LENGTH = 254;
// Control characters allow header injection through CRLF; the rest would break the "Name <address>" form
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const FORBIDDEN_NAME_CHARACTERS = /[<>"\\;,:()]/;
const ADDRESS_PATTERN =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function parseSenderName(raw: string | null): string | null {
  if (raw === null) return null;
  // Checked before whitespace is collapsed, which would otherwise turn CR/LF into harmless-looking spaces
  if (CONTROL_CHARACTERS.test(raw)) {
    throw ErrorWithCode.Factory.BadRequest(EMAIL_SENDER_ERRORS.nameInvalid);
  }
  const name = raw.trim().replace(/\s+/g, " ");
  if (name === "") return null;
  if (FORBIDDEN_NAME_CHARACTERS.test(name)) {
    throw ErrorWithCode.Factory.BadRequest(EMAIL_SENDER_ERRORS.nameInvalid);
  }
  if (name.length > ORGANIZATION_EMAIL_SENDER_NAME_MAX_LENGTH) {
    throw ErrorWithCode.Factory.BadRequest(EMAIL_SENDER_ERRORS.nameTooLong);
  }
  return name;
}

export function parseSenderAddress(raw: string | null): string | null {
  if (raw === null) return null;
  const address = raw.trim().toLowerCase();
  if (address === "") return null;
  if (address.length > MAX_ADDRESS_LENGTH || !ADDRESS_PATTERN.test(address)) {
    throw ErrorWithCode.Factory.BadRequest(EMAIL_SENDER_ERRORS.addressInvalid);
  }
  return address;
}

// Only the organization's own domain or a parent of it (at least two labels) may send, so a custom
// domain can never vouch for an unrelated domain such as a bare TLD.
export function isSenderDomainAllowed(address: string, customDomain: string | null): boolean {
  if (customDomain === null) return false;
  const addressDomain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  const domain = customDomain.toLowerCase();
  if (addressDomain === domain) return true;
  return addressDomain.split(".").length >= 2 && domain.endsWith(`.${addressDomain}`);
}
