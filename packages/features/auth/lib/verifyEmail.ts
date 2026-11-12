import { createHash, randomBytes } from "node:crypto";
import process from "node:process";
import {
  sendChangeOfEmailVerificationLink,
  sendEmailVerificationCode,
  sendEmailVerificationLink,
} from "@calcom/emails/auth-email-service";
import { FeaturesRepository } from "@calcom/features/flags/features.repository";
import { getOrganizationUrlService } from "@calcom/features/organizations/di/OrganizationUrlService.container";
import { sentrySpan } from "@calcom/features/watchlist/lib/telemetry";
import { checkIfEmailIsBlockedInWatchlistController } from "@calcom/features/watchlist/operations/check-if-email-in-watchlist.controller";
import { getTranslation } from "@calcom/i18n/server";
import { checkRateLimitAndThrowError } from "@calcom/lib/checkRateLimitAndThrowError";
import logger from "@calcom/lib/logger";
import { hashEmail } from "@calcom/lib/server/PiiHasher";
import { prisma } from "@calcom/prisma";
import { totp } from "otplib";

const log = logger.getSubLogger({ prefix: [`[[Auth] `] });

interface VerifyEmailType {
  username?: string;
  email: string;
  language?: string;
  secondaryEmailId?: number;
  userId?: number;
  isVerifyingEmail?: boolean;
  isPlatform?: boolean;
  extraParams?: Record<string, string>;
  hideBranding?: boolean;
  eventTypeId?: number;
}

export const sendEmailVerification = async ({
  email,
  language,
  username,
  secondaryEmailId,
  userId,
  isPlatform = false,
  extraParams,
}: VerifyEmailType) => {
  const token = randomBytes(32).toString("hex");
  const translation = await getTranslation(language ?? "en", "common");
  const featuresRepository = new FeaturesRepository(prisma);
  const emailVerification = await featuresRepository.checkIfFeatureIsEnabledGlobally("email-verification");

  if (!emailVerification) {
    log.warn("Email verification is disabled - Skipping");
    return { ok: true, skipped: true };
  }

  if (await checkIfEmailIsBlockedInWatchlistController({ email, organizationId: null, span: sentrySpan })) {
    log.warn("Email is blocked - not sending verification email", email);
    return { ok: false, skipped: false };
  }

  if (isPlatform) {
    log.warn("Skipping Email verification");
    return { ok: true, skipped: true };
  }

  await checkRateLimitAndThrowError({
    rateLimitingType: "core",
    identifier: `sendEmailVerification:${hashEmail(email)}`,
  });

  await prisma.verificationToken.create({
    data: {
      identifier: email,
      token,
      expires: new Date(Date.now() + 24 * 3600 * 1000), // +1 day
      secondaryEmailId: secondaryEmailId || null,
    },
  });

  const params = new URLSearchParams({
    token,
    ...extraParams,
  });

  // Secondary addresses aren't on a user record, so the email lookup can't find their organization.
  const baseUrl =
    userId !== undefined
      ? await getOrganizationUrlService().getBaseUrlForUser({ userId })
      : await getOrganizationUrlService().getBaseUrlForEmail({ email });

  await sendEmailVerificationLink({
    language: translation,
    verificationEmailLink: `${baseUrl}/api/auth/verify-email?${params.toString()}`,
    user: {
      email,
      name: username,
    },
    isSecondaryEmailVerification: !!secondaryEmailId,
    ...(userId !== undefined && { senderScope: { userId } }),
  });

  return { ok: true, skipped: false };
};

export const sendEmailVerificationByCode = async ({
  email,
  language,
  username,
  isVerifyingEmail,
  hideBranding,
  eventTypeId,
}: VerifyEmailType) => {
  if (await checkIfEmailIsBlockedInWatchlistController({ email, organizationId: null, span: sentrySpan })) {
    log.warn("Email is blocked - not sending verification email", email);
    return { ok: false, skipped: false };
  }

  const translation = await getTranslation(language ?? "en", "common");
  const secret = createHash("md5")
    .update(email + process.env.CALENDSO_ENCRYPTION_KEY)
    .digest("hex");

  totp.options = { step: 900 };
  const code = totp.generate(secret);

  await sendEmailVerificationCode({
    language: translation,
    verificationEmailCode: code,
    user: {
      email,
      name: username,
    },
    isVerifyingEmail,
    hideLogo: hideBranding,
    ...(eventTypeId !== undefined && { senderScope: { eventTypeId } }),
  });

  return { ok: true, skipped: false };
};

interface ChangeOfEmail {
  user: {
    username: string;
    emailFrom: string;
    emailTo: string;
  };
  language?: string;
}

export const sendChangeOfEmailVerification = async ({ user, language }: ChangeOfEmail) => {
  const token = randomBytes(32).toString("hex");
  const translation = await getTranslation(language ?? "en", "common");
  const featuresRepository = new FeaturesRepository(prisma);
  const emailVerification = await featuresRepository.checkIfFeatureIsEnabledGlobally("email-verification");

  if (!emailVerification) {
    log.warn("Email verification is disabled - Skipping");
    return { ok: true, skipped: true };
  }

  if (
    await checkIfEmailIsBlockedInWatchlistController({
      email: user.emailFrom,
      organizationId: null,
      span: sentrySpan,
    })
  ) {
    log.warn("Email is blocked - not sending verification email", user.emailFrom);
    return { ok: false, skipped: false };
  }

  await checkRateLimitAndThrowError({
    rateLimitingType: "core",
    identifier: hashEmail(user.emailFrom),
  });

  await prisma.verificationToken.create({
    data: {
      identifier: user.emailFrom, // We use from as this is the email use to get the metadata from
      token,
      expires: new Date(Date.now() + 24 * 3600 * 1000), // +1 day
    },
  });

  const params = new URLSearchParams({
    token,
  });

  await sendChangeOfEmailVerificationLink({
    language: translation,
    verificationEmailLink: `${await getOrganizationUrlService().getBaseUrlForEmail({ email: user.emailFrom })}/auth/verify-email-change?${params.toString()}`,
    user: {
      emailFrom: user.emailFrom,
      emailTo: user.emailTo,
      name: user.username,
    },
  });

  return { ok: true, skipped: false };
};
